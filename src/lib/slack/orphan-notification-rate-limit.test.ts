/**
 * Tests `decideOrphanAlert` (MED-1 PR-NO-DROPPED-SMS).
 *
 * Scope — fonction PURE (via injection `countLimiter` / `digestLimiter`).
 * Pas d'emulator Upstash.
 */
import { describe, expect, it, vi } from "vitest";

import type { RateLimiter, RateLimitResult } from "@/lib/security/rate-limit";

import { decideOrphanAlert } from "./orphan-notification-rate-limit";

function makeLimiter(responses: boolean[], remainingFloor: number[] = []): RateLimiter {
  let i = 0;
  return {
    check: vi.fn(async (): Promise<RateLimitResult> => {
      const success = responses[i] ?? true;
      const remaining = remainingFloor[i] ?? (success ? 10 : 0);
      i++;
      return {
        success,
        limit: 20,
        remaining,
        resetAt: Date.now() + 60_000,
        reason: success ? "allowed" : "rate_limited",
      };
    }),
  };
}

describe("decideOrphanAlert — wasOptOut court-circuit", () => {
  it("wasOptOut=true -> send toujours (sans toucher aux limiters)", async () => {
    const count = makeLimiter([]);
    const digest = makeLimiter([]);
    const decision = await decideOrphanAlert(
      { reason: "parse_failed", wasOptOut: true },
      { countLimiter: count, digestLimiter: digest },
    );
    expect(decision).toEqual({ kind: "send" });
    expect(count.check).not.toHaveBeenCalled();
    expect(digest.check).not.toHaveBeenCalled();
  });
});

describe("decideOrphanAlert — compteur primaire", () => {
  it("count.success=true -> send", async () => {
    const count = makeLimiter([true]);
    const digest = makeLimiter([]);
    const decision = await decideOrphanAlert(
      { reason: "unknown_contact", wasOptOut: false },
      { countLimiter: count, digestLimiter: digest },
    );
    expect(decision.kind).toBe("send");
    expect(count.check).toHaveBeenCalledWith("reason:unknown_contact");
    expect(digest.check).not.toHaveBeenCalled();
  });

  it("count.success=false + digest.success=true -> send_digest avec suppressed_in_window", async () => {
    const count = makeLimiter([false], [0]); // consumed 20
    const digest = makeLimiter([true]);
    const decision = await decideOrphanAlert(
      { reason: "closed", wasOptOut: false },
      { countLimiter: count, digestLimiter: digest },
    );
    expect(decision).toEqual({ kind: "send_digest", suppressed_in_window: 20 });
    expect(digest.check).toHaveBeenCalledWith("reason:closed");
  });

  it("count.success=false + digest.success=false -> suppress", async () => {
    const count = makeLimiter([false], [0]);
    const digest = makeLimiter([false]);
    const decision = await decideOrphanAlert(
      { reason: "no_conversation", wasOptOut: false },
      { countLimiter: count, digestLimiter: digest },
    );
    expect(decision.kind).toBe("suppress");
    if (decision.kind === "suppress") {
      expect(decision.suppressed_in_window).toBe(20);
    }
  });
});

describe("decideOrphanAlert — fail-OPEN infrastructure", () => {
  it("count fail-open (reason=rate_limiter_unavailable_failed_open) renvoie success=true -> send", async () => {
    // La fausse implementation renvoie success=true malgre une panne
    // simulee ; c'est le comportement de createRateLimiter({failureMode:"open"}).
    const count: RateLimiter = {
      check: vi.fn(async () => ({
        success: true,
        limit: 20,
        remaining: 20,
        resetAt: Date.now(),
        reason: "rate_limiter_unavailable_failed_open" as const,
      })),
    };
    const digest = makeLimiter([]);
    const decision = await decideOrphanAlert(
      { reason: "parse_failed", wasOptOut: false },
      { countLimiter: count, digestLimiter: digest },
    );
    expect(decision.kind).toBe("send");
    expect(digest.check).not.toHaveBeenCalled();
  });

  it("MED-1 scellee : wasOptOut=true + Upstash HS -> envoyer quand meme", async () => {
    const count: RateLimiter = {
      check: vi.fn(async () => {
        throw new Error("should never be called");
      }),
    };
    const digest = makeLimiter([]);
    const decision = await decideOrphanAlert(
      { reason: "parse_failed", wasOptOut: true },
      { countLimiter: count, digestLimiter: digest },
    );
    expect(decision.kind).toBe("send");
  });
});
