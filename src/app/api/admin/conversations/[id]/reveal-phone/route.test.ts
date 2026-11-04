/**
 * Tests POST /api/admin/conversations/[id]/reveal-phone (PR3 tour 2a).
 *
 * Scope : wiring de route — RBAC, rate-limit, Zod, Cache-Control, logs
 * PII-free. La logique métier (admin / titulaire / anti-tamper) est
 * testée unitairement dans `src/lib/contacts/reveal-contact-phone.test.ts`,
 * donc on mocke `revealContactPhone` ici pour n'inspecter QUE la glue.
 *
 * Invariants vérifiés :
 *   - 401 si `requireRole` throw UnauthorizedError.
 *   - 403 si `requireRole` throw ForbiddenError (rôle insuffisant).
 *   - 400 si le body est mal formé (Zod `{ method }`).
 *   - 429 avec header `Retry-After` quand le rate-limit renvoie une 429.
 *   - 200 + `Cache-Control: ... no-store ...` sur le happy path.
 *   - **Ordre** `requireRole → applyAdminRateLimit → Zod` : un rôle
 *     refusé NE CONSOMME PAS le quota (mock rate-limit non appelé).
 *   - Logs : aucune trace d'E.164 ni de numéro FR national dans les
 *     appels passés au logger (sentinelle regex `/\+33\d/` + `/0[1-9]\d{8}/`).
 */
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ForbiddenError, UnauthorizedError } from "@/lib/utils/errors";
import type { Conversation } from "@/types/conversation";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(),
}));

vi.mock("@/lib/security/admin-rate-limit", () => ({
  applyAdminRateLimit: vi.fn(),
}));

vi.mock("@/lib/firestore/conversations", () => ({
  getConversation: vi.fn(),
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
import { getConversation } from "@/lib/firestore/conversations";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";
import { logger } from "@/lib/utils/logger";

import { POST } from "./route";

const mockRequireRole = vi.mocked(requireRole);
const mockApplyAdminRateLimit = vi.mocked(applyAdminRateLimit);
const mockGetConversation = vi.mocked(getConversation);
const mockRevealContactPhone = vi.mocked(revealContactPhone);
const mockLogger = vi.mocked(logger);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function mockPost(id: string, body: unknown): NextRequest {
  return new NextRequest(`https://medere.example/api/admin/conversations/${id}/reveal-phone`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function fakeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    contactId: "hs_abc",
    campaignId: "hubspot-list-200",
    channel: "sms",
    status: "in_dialogue",
    intent: "unknown",
    messageCount: 2,
    inboundCount: 1,
    outboundCount: 1,
    followupCount: 0,
    assignedTo: "U_TITULAIRE",
    handoff: {
      assignedTo: "U_TITULAIRE",
      assignedAt: { toMillis: () => 0 } as never,
    },
    createdAt: { toMillis: () => 0 } as never,
    updatedAt: { toMillis: () => 0 } as never,
    ...overrides,
  } as Conversation;
}

// Sentinelle : aucun argument passé au logger ne contient d'E.164 ni de
// numéro FR national complet. Appliqué sur tous les mocks du logger.
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

describe("POST /api/admin/conversations/[id]/reveal-phone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Par défaut : commercial titulaire authentifié, rate-limit passe.
    mockRequireRole.mockResolvedValue({
      userId: "clerk_commercial_1",
      role: "commercial",
      slackUserId: "U_TITULAIRE",
      testAccount: false,
      firstName: "Vanessa",
      lastName: "Rabba",
    });
    mockApplyAdminRateLimit.mockResolvedValue(null);
    mockGetConversation.mockResolvedValue(fakeConversation());
    mockRevealContactPhone.mockResolvedValue({
      e164: "+33612345678",
      display: "06 12 34 56 78",
      optedOut: false,
    });
  });

  describe("RBAC", () => {
    it("401 quand `requireRole` throw UnauthorizedError", async () => {
      mockRequireRole.mockRejectedValue(
        new UnauthorizedError({ message: "no session", clientMessage: "Connexion requise." }),
      );

      const res = await POST(mockPost("conv_1", { method: "display" }), makeParams("conv_1"));

      expect(res.status).toBe(401);
      // Rôle refusé → rate-limit JAMAIS consulté (ordre requireRole → rate-limit).
      expect(mockApplyAdminRateLimit).not.toHaveBeenCalled();
      expect(mockRevealContactPhone).not.toHaveBeenCalled();
      assertNoPhoneInLogs();
    });

    it("403 quand `requireRole` throw ForbiddenError (rôle insuffisant)", async () => {
      mockRequireRole.mockRejectedValue(
        new ForbiddenError({
          message: "role not allowed",
          clientMessage: "Accès refusé.",
        }),
      );

      const res = await POST(mockPost("conv_1", { method: "display" }), makeParams("conv_1"));

      expect(res.status).toBe(403);
      expect(mockApplyAdminRateLimit).not.toHaveBeenCalled();
      assertNoPhoneInLogs();
    });
  });

  describe("Zod — corps invalide", () => {
    it("400 si `method` absent", async () => {
      const res = await POST(mockPost("conv_1", {}), makeParams("conv_1"));
      expect(res.status).toBe(400);
      // Ordre : RBAC + rate-limit OK → Zod fail. revealContactPhone jamais appelé.
      expect(mockRequireRole).toHaveBeenCalledTimes(1);
      expect(mockApplyAdminRateLimit).toHaveBeenCalledTimes(1);
      expect(mockRevealContactPhone).not.toHaveBeenCalled();
      assertNoPhoneInLogs();
    });

    it("400 si `method` inconnu (hors enum)", async () => {
      const res = await POST(mockPost("conv_1", { method: "sms" }), makeParams("conv_1"));
      expect(res.status).toBe(400);
      expect(mockRevealContactPhone).not.toHaveBeenCalled();
      assertNoPhoneInLogs();
    });
  });

  describe("rate-limit", () => {
    it("429 avec header `Retry-After` quand le rate-limit bloque", async () => {
      // Simule la 429 forgée par `applyAdminRateLimit` (cf. admin-rate-limit.ts:106).
      const rl429 = NextResponse.json(
        { error: { code: "RATE_LIMITED", message: "Trop de requêtes." } },
        {
          status: 429,
          headers: {
            "Retry-After": "42",
            "X-RateLimit-Limit": "60",
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(Date.now() + 42_000),
          },
        },
      );
      mockApplyAdminRateLimit.mockResolvedValue(rl429);

      const res = await POST(mockPost("conv_1", { method: "display" }), makeParams("conv_1"));

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("42");
      // Short-circuit : Zod + logic jamais exécutés.
      expect(mockRevealContactPhone).not.toHaveBeenCalled();
      assertNoPhoneInLogs();
    });
  });

  describe("happy path", () => {
    it("200 + Cache-Control no-store + body { e164, display, optedOut }", async () => {
      const res = await POST(
        mockPost("hs_abc_hubspot-list-200", { method: "display" }),
        makeParams("hs_abc_hubspot-list-200"),
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("no-store");
      const body = (await res.json()) as { e164: string; display: string; optedOut: boolean };
      expect(body).toEqual({
        e164: "+33612345678",
        display: "06 12 34 56 78",
        optedOut: false,
      });
      // Ordre strict : requireRole → rate-limit → Zod → getConversation → logic.
      expect(mockRequireRole).toHaveBeenCalledWith("commercial");
      expect(mockApplyAdminRateLimit).toHaveBeenCalledTimes(1);
      expect(mockGetConversation).toHaveBeenCalledWith("hs_abc_hubspot-list-200");
      expect(mockRevealContactPhone).toHaveBeenCalledWith(
        expect.objectContaining({
          contactId: "hs_abc", // ← serveur-side depuis `conv.contactId` (anti-tamper).
          conversationId: "hs_abc_hubspot-list-200",
          method: "display",
        }),
      );
      // La payload-level sentinelle (e164 n'apparaît QUE dans le body
      // JSON — pas dans les logs).
      assertNoPhoneInLogs();
    });
  });

  describe("404", () => {
    it("404 si la conversation n'existe pas", async () => {
      mockGetConversation.mockResolvedValue(null);
      const res = await POST(
        mockPost("conv_absente", { method: "display" }),
        makeParams("conv_absente"),
      );
      expect(res.status).toBe(404);
      expect(mockRevealContactPhone).not.toHaveBeenCalled();
      assertNoPhoneInLogs();
    });
  });
});
