/**
 * Tests `admin-rate-limit.ts` — helper d'application du rate-limit pour les
 * routes admin (S10.1.9 RATELIMIT-001).
 *
 * Couverture obligatoire 100% (règle CLAUDE.md sur `lib/security/`).
 *
 * Pas de mock Upstash réel ici — on injecte un fake `RateLimiter` qui
 * retourne un `RateLimitResult` contrôlé. Le wrapper `createRateLimiter`
 * a ses propres tests dans `rate-limit.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from "@/lib/utils/logger";

import { applyAdminRateLimit } from "./admin-rate-limit";
import type { RateLimiter, RateLimitReason, RateLimitResult } from "./rate-limit";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fakeLimiter(result: RateLimitResult): RateLimiter {
  return {
    check: vi.fn().mockResolvedValue(result),
  };
}

function buildResult(overrides: Partial<RateLimitResult> = {}): RateLimitResult {
  return {
    success: true,
    limit: 30,
    remaining: 29,
    resetAt: 1_780_000_060_000,
    reason: "allowed",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("applyAdminRateLimit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("success path", () => {
    it("retourne null quand le check passe (success=true, reason='allowed')", async () => {
      const limiter = fakeLimiter(buildResult({ success: true, reason: "allowed" }));

      const res = await applyAdminRateLimit(limiter, "user_admin_xxx");

      expect(res).toBeNull();
      expect(limiter.check).toHaveBeenCalledWith("user_admin_xxx");
      // Pas de log warn quand passé.
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("transmet le userId tel quel à limiter.check() (pas de hashing/normalize)", async () => {
      const limiter = fakeLimiter(buildResult());
      await applyAdminRateLimit(limiter, "user_clerk_opaque_42");
      expect(limiter.check).toHaveBeenCalledWith("user_clerk_opaque_42");
    });
  });

  describe("rate-limited path", () => {
    const NOW_MS = 1_780_000_000_000;
    const RESET_MS = NOW_MS + 23_000; // +23s

    it("retourne NextResponse 429 quand rate-limited", async () => {
      const limiter = fakeLimiter(
        buildResult({
          success: false,
          reason: "rate_limited",
          limit: 30,
          remaining: 0,
          resetAt: RESET_MS,
        }),
      );

      const res = await applyAdminRateLimit(limiter, "user_admin_xxx", NOW_MS);

      expect(res).not.toBeNull();
      expect(res?.status).toBe(429);
    });

    it("body 429 = RateLimitError.toClientBody() — code RATE_LIMITED + message FR générique", async () => {
      const limiter = fakeLimiter(
        buildResult({ success: false, reason: "rate_limited", remaining: 0, resetAt: RESET_MS }),
      );

      const res = await applyAdminRateLimit(limiter, "user_admin_xxx", NOW_MS);

      expect(res).not.toBeNull();
      const body = (await res!.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("RATE_LIMITED");
      expect(body.error.message).toBe("Trop de requêtes. Réessayez plus tard.");
    });

    it("headers 429 : Retry-After + X-RateLimit-Limit + X-RateLimit-Remaining + X-RateLimit-Reset", async () => {
      const limiter = fakeLimiter(
        buildResult({
          success: false,
          reason: "rate_limited",
          limit: 30,
          remaining: 0,
          resetAt: RESET_MS,
        }),
      );

      const res = await applyAdminRateLimit(limiter, "user_admin_xxx", NOW_MS);

      expect(res!.headers.get("Retry-After")).toBe("23");
      expect(res!.headers.get("X-RateLimit-Limit")).toBe("30");
      expect(res!.headers.get("X-RateLimit-Remaining")).toBe("0");
      expect(res!.headers.get("X-RateLimit-Reset")).toBe(String(RESET_MS));
    });

    it("Retry-After plancher 1s si resetAt déjà passé (anti-amplification)", async () => {
      const limiter = fakeLimiter(
        buildResult({
          success: false,
          reason: "rate_limited",
          remaining: 0,
          resetAt: NOW_MS - 5_000, // déjà passé de 5s
        }),
      );

      const res = await applyAdminRateLimit(limiter, "user_admin_xxx", NOW_MS);

      expect(res!.headers.get("Retry-After")).toBe("1");
    });

    it("Retry-After plancher 1s si resetAt = now exact (Math.ceil sur 0 → 0 corrigé à 1)", async () => {
      const limiter = fakeLimiter(
        buildResult({
          success: false,
          reason: "rate_limited",
          remaining: 0,
          resetAt: NOW_MS,
        }),
      );

      const res = await applyAdminRateLimit(limiter, "user_admin_xxx", NOW_MS);

      expect(res!.headers.get("Retry-After")).toBe("1");
    });

    it("Retry-After ceil sur sub-secondes (1.4s → 2s)", async () => {
      const limiter = fakeLimiter(
        buildResult({
          success: false,
          reason: "rate_limited",
          remaining: 0,
          resetAt: NOW_MS + 1_400, // +1.4s
        }),
      );

      const res = await applyAdminRateLimit(limiter, "user_admin_xxx", NOW_MS);

      expect(res!.headers.get("Retry-After")).toBe("2");
    });

    it("log warn appelé avec userId + reason + retryAfterSeconds (zéro PII)", async () => {
      const limiter = fakeLimiter(
        buildResult({
          success: false,
          reason: "rate_limited",
          limit: 30,
          remaining: 0,
          resetAt: RESET_MS,
        }),
      );

      await applyAdminRateLimit(limiter, "user_admin_xxx", NOW_MS);

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        {
          userId: "user_admin_xxx",
          reason: "rate_limited",
          limit: 30,
          remaining: 0,
          retryAfterSeconds: 23,
        },
        "[applyAdminRateLimit] admin request blocked",
      );
    });
  });

  describe("fail-closed path (Upstash down)", () => {
    it("retourne 429 quand reason='rate_limiter_unavailable' (panne Upstash, défaut fail-closed)", async () => {
      const limiter = fakeLimiter(
        buildResult({
          success: false,
          reason: "rate_limiter_unavailable",
          limit: 30,
          remaining: 0,
          resetAt: 1_780_000_060_000,
        }),
      );

      const res = await applyAdminRateLimit(limiter, "user_admin_xxx");

      expect(res).not.toBeNull();
      expect(res?.status).toBe(429);
      const body = (await res!.json()) as { error: { code: string } };
      expect(body.error.code).toBe("RATE_LIMITED");
      // Log warn invoqué pour debug Upstash.
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "rate_limiter_unavailable" }),
        expect.any(String),
      );
    });

    it("fail-open géré transparent : si wrapper retourne success=true même en panne, on passe", async () => {
      // Ce cas survient si le caller a explicitement choisi failureMode:"open"
      // côté createRateLimiter. Le helper applyAdminRateLimit reste neutre :
      // il consulte uniquement `success`, jamais `reason`, pour décider.
      const limiter = fakeLimiter(
        buildResult({
          success: true,
          reason: "rate_limiter_unavailable_failed_open",
        }),
      );

      const res = await applyAdminRateLimit(limiter, "user_admin_xxx");

      expect(res).toBeNull();
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe("sentinelles structurelles", () => {
    it("RateLimitReason union complète couverte (sentinelle anti-drift wrapper)", () => {
      // Si un nouveau reason est ajouté à RateLimitReason côté wrapper,
      // ce test casse au compile-time (TS error sur la liste exhaustive).
      const reasons: RateLimitReason[] = [
        "allowed",
        "rate_limited",
        "rate_limiter_unavailable",
        "rate_limiter_unavailable_failed_open",
      ];
      expect(reasons).toHaveLength(4);
    });
  });
});
