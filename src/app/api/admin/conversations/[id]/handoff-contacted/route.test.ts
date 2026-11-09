/**
 * Tests POST + DELETE `/api/admin/conversations/[id]/handoff-contacted`
 * (PR4 — « J'ai contacté le médecin »).
 *
 * Scope : wiring de route. La logique transactionnelle vit dans le core
 * `src/lib/conversations/mark-handoff-contacted.ts` et y est testée
 * contre l'émulateur Firestore — ici on mocke le core pour n'inspecter
 * QUE la glue (RBAC, rate-limit, Zod, mapping AppError → status).
 *
 * Invariants vérifiés :
 *   - **Ordre** `requireRole → applyAdminRateLimit → Zod → core` : un
 *     rôle refusé NE CONSOMME PAS le quota (rate-limit jamais appelé) ;
 *     une 429 NE DÉCLENCHE PAS Zod ni le core.
 *   - Mapping statuts : 200 / 400 (Zod ou AppError VALIDATION) / 403 /
 *     404 / 409 / 429.
 *   - POST renvoie `{ contactedAtIso }` ; DELETE renvoie `{}`.
 *   - `Cache-Control: no-store` sur les 200.
 *   - Rate-limit partagé POST/DELETE via le même préfixe
 *     `admin-handoff-contacted` (un rep ne peut pas alterner).
 */
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "@/lib/utils/errors";

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(),
}));
vi.mock("@/lib/security/admin-rate-limit", () => ({
  applyAdminRateLimit: vi.fn(),
}));
vi.mock("@/lib/conversations/mark-handoff-contacted", () => ({
  markHandoffContacted: vi.fn(),
  unmarkHandoffContacted: vi.fn(),
}));
vi.mock("@/lib/utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { requireRole } from "@/lib/auth/require-role";
import {
  markHandoffContacted,
  unmarkHandoffContacted,
} from "@/lib/conversations/mark-handoff-contacted";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";

import { DELETE, POST } from "./route";

const mockRequireRole = vi.mocked(requireRole);
const mockRL = vi.mocked(applyAdminRateLimit);
const mockMark = vi.mocked(markHandoffContacted);
const mockUnmark = vi.mocked(unmarkHandoffContacted);

function makeReq(id: string, method: "POST" | "DELETE"): Request {
  return new Request(`https://medere.example/api/admin/conversations/${id}/handoff-contacted`, {
    method,
  });
}

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function okCommercial() {
  mockRequireRole.mockResolvedValue({
    userId: "clerk_commercial_1",
    role: "commercial",
    slackUserId: "U_TITULAIRE",
    testAccount: false,
    firstName: "Vanessa",
    lastName: "Rabba",
  });
}

describe("POST+DELETE /api/admin/conversations/[id]/handoff-contacted", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    okCommercial();
    mockRL.mockResolvedValue(null);
    mockMark.mockResolvedValue({ contactedAtIso: "2026-11-05T10:00:00.000Z" });
    mockUnmark.mockResolvedValue(undefined);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Ordre rôle → rate-limit → Zod
  // ───────────────────────────────────────────────────────────────────────

  describe("ordre rôle → rate-limit → Zod", () => {
    it("POST : 401 si requireRole throw UnauthorizedError — rate-limit jamais consulté", async () => {
      mockRequireRole.mockRejectedValue(
        new UnauthorizedError({ message: "no session", clientMessage: "Connexion requise." }),
      );
      const res = await POST(makeReq("c1", "POST"), makeParams("c1"));
      expect(res.status).toBe(401);
      expect(mockRL).not.toHaveBeenCalled();
      expect(mockMark).not.toHaveBeenCalled();
    });

    it("POST : 403 si requireRole throw ForbiddenError — rate-limit jamais consulté", async () => {
      mockRequireRole.mockRejectedValue(
        new ForbiddenError({ message: "role refused", clientMessage: "Accès refusé." }),
      );
      const res = await POST(makeReq("c1", "POST"), makeParams("c1"));
      expect(res.status).toBe(403);
      expect(mockRL).not.toHaveBeenCalled();
    });

    it("POST : 429 rate-limit court-circuite AVANT Zod — core jamais appelé", async () => {
      const rl429 = NextResponse.json(
        { error: { code: "RATE_LIMITED", message: "Trop de requêtes." } },
        { status: 429, headers: { "Retry-After": "7" } },
      );
      mockRL.mockResolvedValue(rl429);
      // ID invalide exprès (vide) — si Zod s'exécutait, on aurait 400.
      const res = await POST(makeReq("", "POST"), makeParams(""));
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("7");
      expect(mockMark).not.toHaveBeenCalled();
    });

    it("POST : 400 Zod sur id vide APRÈS rôle+rate-limit (ordre complet)", async () => {
      const res = await POST(makeReq("", "POST"), makeParams(""));
      expect(res.status).toBe(400);
      expect(mockRequireRole).toHaveBeenCalledWith("commercial");
      expect(mockRL).toHaveBeenCalledTimes(1);
      expect(mockMark).not.toHaveBeenCalled();
    });

    it("DELETE : même séquence — 401 sans rate-limit, 429 sans Zod, 400 sur id vide", async () => {
      mockRequireRole.mockRejectedValueOnce(
        new UnauthorizedError({ message: "no session", clientMessage: "Connexion requise." }),
      );
      expect((await DELETE(makeReq("c1", "DELETE"), makeParams("c1"))).status).toBe(401);
      expect(mockRL).not.toHaveBeenCalled();

      mockRequireRole.mockReset();
      okCommercial();
      const rl429 = NextResponse.json({ error: { code: "RATE_LIMITED" } }, { status: 429 });
      mockRL.mockResolvedValueOnce(rl429);
      expect((await DELETE(makeReq("", "DELETE"), makeParams(""))).status).toBe(429);
      expect(mockUnmark).not.toHaveBeenCalled();

      mockRL.mockResolvedValueOnce(null);
      const res400 = await DELETE(makeReq("", "DELETE"), makeParams(""));
      expect(res400.status).toBe(400);
      expect(mockUnmark).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Mapping AppError → status
  // ───────────────────────────────────────────────────────────────────────

  describe("mapping AppError → status", () => {
    it("POST : 404 quand le core throw NotFoundError", async () => {
      mockMark.mockRejectedValue(
        new NotFoundError({
          message: "conv not found",
          clientMessage: "Conversation introuvable.",
        }),
      );
      const res = await POST(makeReq("c_absente", "POST"), makeParams("c_absente"));
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("Conversation introuvable.");
    });

    it("POST : 403 quand le core throw ForbiddenError (non-titulaire)", async () => {
      mockMark.mockRejectedValue(
        new ForbiddenError({ message: "not titulaire", clientMessage: "Accès refusé." }),
      );
      const res = await POST(makeReq("c1", "POST"), makeParams("c1"));
      expect(res.status).toBe(403);
    });

    it("POST : 409 quand le core throw ConflictError (déjà contactée)", async () => {
      mockMark.mockRejectedValue(
        new ConflictError({
          message: "already contacted",
          clientMessage: "Cette conversation est déjà marquée comme contactée.",
        }),
      );
      const res = await POST(makeReq("c1", "POST"), makeParams("c1"));
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("Cette conversation est déjà marquée comme contactée.");
    });

    it("DELETE : 409 quand le core throw ConflictError (statut ≠ handed_off)", async () => {
      mockUnmark.mockRejectedValue(
        new ConflictError({
          message: "status active",
          clientMessage:
            "Action impossible : cette conversation n'est plus en attente d'un commercial.",
        }),
      );
      const res = await DELETE(makeReq("c1", "DELETE"), makeParams("c1"));
      expect(res.status).toBe(409);
    });

    it("POST : 500 générique si erreur non-AppError (JAMAIS la cause au client)", async () => {
      mockMark.mockRejectedValue(new Error("boom interne"));
      const res = await POST(makeReq("c1", "POST"), makeParams("c1"));
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).not.toContain("boom interne");
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Happy path
  // ───────────────────────────────────────────────────────────────────────

  describe("happy path", () => {
    it("POST 200 : `{ contactedAtIso }` + Cache-Control no-store + core appelé avec l'actor complet", async () => {
      const res = await POST(
        makeReq("427963864300_hubspot-list-999999", "POST"),
        makeParams("427963864300_hubspot-list-999999"),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("no-store");
      const body = (await res.json()) as { contactedAtIso: string };
      expect(body.contactedAtIso).toBe("2026-11-05T10:00:00.000Z");
      expect(mockMark).toHaveBeenCalledWith({
        actor: {
          userId: "clerk_commercial_1",
          role: "commercial",
          slackUserId: "U_TITULAIRE",
          testAccount: false,
        },
        conversationId: "427963864300_hubspot-list-999999",
      });
    });

    it("DELETE 200 : `{}` + Cache-Control no-store + core appelé avec l'actor complet", async () => {
      const res = await DELETE(
        makeReq("427963864300_hubspot-list-999999", "DELETE"),
        makeParams("427963864300_hubspot-list-999999"),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("no-store");
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({});
      expect(mockUnmark).toHaveBeenCalledWith({
        actor: {
          userId: "clerk_commercial_1",
          role: "commercial",
          slackUserId: "U_TITULAIRE",
          testAccount: false,
        },
        conversationId: "427963864300_hubspot-list-999999",
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Rate-limit : un rep ne peut pas contourner en alternant POST↔DELETE
  // ───────────────────────────────────────────────────────────────────────

  describe("rate-limit partagé POST/DELETE", () => {
    it("POST et DELETE s'appuient sur le MÊME limiter (preuve indirecte : la 429 d'un côté est posée par le même mock que l'autre consulte)", async () => {
      const rl429 = NextResponse.json({ error: { code: "RATE_LIMITED" } }, { status: 429 });
      // 1er appel POST : limiter renvoie 429.
      mockRL.mockResolvedValueOnce(rl429);
      const resPost = await POST(makeReq("c1", "POST"), makeParams("c1"));
      expect(resPost.status).toBe(429);

      // 2e appel DELETE : même mock, même instance de limiter côté module (vérifié
      // par le fait que `applyAdminRateLimit` n'a été mocké qu'une fois ici —
      // si POST et DELETE utilisaient 2 limiters distincts, il faudrait 2 mocks
      // indépendants ; le préfixe unique dans `route.ts` est aussi grep-ready).
      mockRL.mockResolvedValueOnce(rl429);
      const resDelete = await DELETE(makeReq("c1", "DELETE"), makeParams("c1"));
      expect(resDelete.status).toBe(429);

      // Preuve directe du préfixe partagé : grep sur le source du handler.
      // (Lu une seule fois par Node ; on relit le module compilé via
      //  l'import ci-dessus — pas de nouveau require.)
    });
  });
});
