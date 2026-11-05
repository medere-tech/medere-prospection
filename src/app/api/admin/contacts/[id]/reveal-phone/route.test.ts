/**
 * Tests POST /api/admin/contacts/[id]/reveal-phone (PR3 tour 2a).
 *
 * Scope : wiring de route — RBAC admin-only, rate-limit, Zod, Cache-Control,
 * logs PII-free. La logique métier (rights, audit) est testée dans
 * `src/lib/contacts/reveal-contact-phone.test.ts` → `revealContactPhone`
 * est mocké pour n'inspecter que le wiring.
 *
 * Invariants vérifiés :
 *   - 401 si `requireRole("admin")` throw UnauthorizedError.
 *   - **403 si un commercial tente d'appeler cette route** : la page
 *     `/admin/contacts` n'est accessible qu'aux admins (cf.
 *     `src/app/api/admin/contacts/route.ts:48`), le reveal associé
 *     reprend cette règle via `requireRole("admin")` qui throw
 *     ForbiddenError pour un commercial.
 *   - 400 si le body est mal formé (Zod `{ method }`).
 *   - 429 avec header `Retry-After` quand le rate-limit renvoie une 429.
 *   - 200 + `Cache-Control: ... no-store ...` sur le happy path.
 *   - Ordre `requireRole → applyAdminRateLimit → Zod` : rôle refusé =
 *     quota non consommé.
 *   - Logs PII-free.
 */
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ForbiddenError, UnauthorizedError } from "@/lib/utils/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(),
}));

vi.mock("@/lib/security/admin-rate-limit", () => ({
  applyAdminRateLimit: vi.fn(),
}));

vi.mock("@/lib/contacts/reveal-contact-phone", () => ({
  revealContactPhone: vi.fn(),
}));

vi.mock("@/lib/utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Imports APRÈS les `vi.mock`.
import { requireRole } from "@/lib/auth/require-role";
import { revealContactPhone } from "@/lib/contacts/reveal-contact-phone";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";
import { logger } from "@/lib/utils/logger";

import { POST } from "./route";

const mockRequireRole = vi.mocked(requireRole);
const mockApplyAdminRateLimit = vi.mocked(applyAdminRateLimit);
const mockRevealContactPhone = vi.mocked(revealContactPhone);
const mockLogger = vi.mocked(logger);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function mockPost(id: string, body: unknown): NextRequest {
  return new NextRequest(`https://medere.example/api/admin/contacts/${id}/reveal-phone`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function assertNoPhoneInLogs(): void {
  const allCalls = [
    ...mockLogger.debug.mock.calls,
    ...mockLogger.info.mock.calls,
    ...mockLogger.warn.mock.calls,
    ...mockLogger.error.mock.calls,
  ];
  for (const call of allCalls) {
    const serialized = JSON.stringify(call);
    expect(serialized).not.toMatch(/\+33\d/);
    expect(serialized).not.toMatch(/0[1-9]\d{8}/);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/contacts/[id]/reveal-phone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue({
      userId: "clerk_admin_1",
      role: "admin",
      testAccount: false,
      firstName: "Déthié",
      lastName: "Faye",
    });
    mockApplyAdminRateLimit.mockResolvedValue(null);
    mockRevealContactPhone.mockResolvedValue({
      e164: "+33612345678",
      display: "06 12 34 56 78",
      optedOut: false,
    });
  });

  describe("RBAC admin-only", () => {
    it("401 si `requireRole` throw UnauthorizedError", async () => {
      mockRequireRole.mockRejectedValue(
        new UnauthorizedError({ message: "no session", clientMessage: "Connexion requise." }),
      );
      const res = await POST(mockPost("hs_abc", { method: "display" }), makeParams("hs_abc"));
      expect(res.status).toBe(401);
      // Quota non consommé.
      expect(mockApplyAdminRateLimit).not.toHaveBeenCalled();
      expect(mockRevealContactPhone).not.toHaveBeenCalled();
      assertNoPhoneInLogs();
    });

    it("403 quand `requireRole('admin')` refuse un commercial", async () => {
      // `requireRole("admin")` throw ForbiddenError pour un rôle commercial.
      mockRequireRole.mockRejectedValue(
        new ForbiddenError({
          message: "role 'commercial' is not allowed; required 'admin'",
          clientMessage: "Accès refusé.",
        }),
      );
      const res = await POST(mockPost("hs_abc", { method: "display" }), makeParams("hs_abc"));
      expect(res.status).toBe(403);
      // Rôle insuffisant → rate-limit JAMAIS consulté.
      expect(mockApplyAdminRateLimit).not.toHaveBeenCalled();
      expect(mockRevealContactPhone).not.toHaveBeenCalled();
      assertNoPhoneInLogs();
    });
  });

  describe("Zod — corps invalide", () => {
    it("400 si `method` absent", async () => {
      const res = await POST(mockPost("hs_abc", {}), makeParams("hs_abc"));
      expect(res.status).toBe(400);
      expect(mockRequireRole).toHaveBeenCalledTimes(1);
      expect(mockApplyAdminRateLimit).toHaveBeenCalledTimes(1);
      expect(mockRevealContactPhone).not.toHaveBeenCalled();
      assertNoPhoneInLogs();
    });

    it("400 si `method` inconnu (hors enum)", async () => {
      const res = await POST(mockPost("hs_abc", { method: "fax" }), makeParams("hs_abc"));
      expect(res.status).toBe(400);
      expect(mockRevealContactPhone).not.toHaveBeenCalled();
      assertNoPhoneInLogs();
    });
  });

  describe("rate-limit", () => {
    it("429 avec header `Retry-After` quand bloqué", async () => {
      const rl429 = NextResponse.json(
        { error: { code: "RATE_LIMITED", message: "Trop de requêtes." } },
        {
          status: 429,
          headers: {
            "Retry-After": "17",
            "X-RateLimit-Limit": "60",
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(Date.now() + 17_000),
          },
        },
      );
      mockApplyAdminRateLimit.mockResolvedValue(rl429);

      const res = await POST(mockPost("hs_abc", { method: "copy" }), makeParams("hs_abc"));

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("17");
      expect(mockRevealContactPhone).not.toHaveBeenCalled();
      assertNoPhoneInLogs();
    });
  });

  describe("happy path", () => {
    it("200 + Cache-Control no-store + payload complet", async () => {
      const res = await POST(mockPost("hs_abc", { method: "call" }), makeParams("hs_abc"));

      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("no-store");
      const body = (await res.json()) as { e164: string; display: string; optedOut: boolean };
      expect(body).toEqual({
        e164: "+33612345678",
        display: "06 12 34 56 78",
        optedOut: false,
      });
      // `requireRole("admin")` strict — pas "commercial".
      expect(mockRequireRole).toHaveBeenCalledWith("admin");
      expect(mockRevealContactPhone).toHaveBeenCalledWith(
        expect.objectContaining({
          contactId: "hs_abc",
          method: "call",
        }),
      );
      // Pas de `conversationId` — contexte liste /admin/contacts.
      const call = mockRevealContactPhone.mock.calls[0]?.[0];
      expect(call?.conversationId).toBeUndefined();
      assertNoPhoneInLogs();
    });
  });
});
