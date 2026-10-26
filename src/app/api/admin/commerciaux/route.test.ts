/**
 * Tests GET /api/admin/commerciaux (PR2b-2 round 3 R3-P3).
 *
 * Scope : route handler unit (mocks Clerk + listCommerciauxForFilter).
 * Pattern miroir de `/api/admin/campaigns/route.test.ts`. Vérifie auth
 * (401/403), happy path admin, rate-limit, et absence de PII (téléphone /
 * email) dans la payload.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExternalServiceError, ForbiddenError, UnauthorizedError } from "@/lib/utils/errors";

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(),
}));

vi.mock("@/lib/security/admin-rate-limit", () => ({
  applyAdminRateLimit: vi.fn(),
}));

vi.mock("@/lib/airtable/commerciaux", () => ({
  listCommerciauxForFilter: vi.fn(),
}));

vi.mock("@/lib/utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { listCommerciauxForFilter } from "@/lib/airtable/commerciaux";
import { requireRole } from "@/lib/auth/require-role";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";

import { GET } from "./route";

const mockRequireRole = vi.mocked(requireRole);
const mockListCommerciaux = vi.mocked(listCommerciauxForFilter);
const mockApplyAdminRateLimit = vi.mocked(applyAdminRateLimit);

const FAKE_COMMERCIAUX = [
  { slackUserId: "U05UVHGBURX", name: "Dethie Faye", active: true },
  { slackUserId: "U01DPF08TQV", name: "Harry Lambert", active: true },
  { slackUserId: "UINACTIVE42", name: "Ancien Commercial", active: false },
];

describe("GET /api/admin/commerciaux", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue({
      userId: "user_admin_xxx",
      role: "admin",
      firstName: "Déthié",
      lastName: "Faye",
    });
    mockApplyAdminRateLimit.mockResolvedValue(null);
  });

  describe("rate-limit", () => {
    it("renvoie 429 + Retry-After si rate-limit bloque", async () => {
      const { NextResponse } = await import("next/server");
      mockApplyAdminRateLimit.mockResolvedValue(
        NextResponse.json(
          { error: { code: "RATE_LIMITED", message: "Trop de requêtes." } },
          { status: 429, headers: { "Retry-After": "7" } },
        ),
      );

      const res = await GET();

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("7");
      expect(mockListCommerciaux).not.toHaveBeenCalled();
    });

    it("rate-limit appelé avec le Clerk userId extrait de requireRole", async () => {
      mockListCommerciaux.mockResolvedValue(FAKE_COMMERCIAUX);
      await GET();
      expect(mockApplyAdminRateLimit).toHaveBeenCalledWith(expect.anything(), "user_admin_xxx");
    });
  });

  it("renvoie 200 + commerciaux projetés (slackUserId/name/active) pour admin", async () => {
    mockListCommerciaux.mockResolvedValue(FAKE_COMMERCIAUX);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      commerciaux: Array<{ slackUserId: string; name: string; active: boolean }>;
    };
    expect(body.commerciaux).toHaveLength(3);
    expect(body.commerciaux[0]).toEqual({
      slackUserId: "U05UVHGBURX",
      name: "Dethie Faye",
      active: true,
    });
    // Inactif inclus (le filtre côté UI décide, pas la route).
    expect(body.commerciaux.find((c) => !c.active)?.slackUserId).toBe("UINACTIVE42");
  });

  it("renvoie UNIQUEMENT la projection minimale (pas de champs Airtable supplémentaires)", async () => {
    mockListCommerciaux.mockResolvedValue(FAKE_COMMERCIAUX);
    const res = await GET();
    const body = (await res.json()) as {
      commerciaux: Array<Record<string, unknown>>;
    };
    const first = body.commerciaux[0];
    expect(first).toBeDefined();
    // Exactement ces 3 clés, pas plus (évite de leak un champ Airtable
    // sensible ajouté plus tard sans review).
    expect(Object.keys(first!).sort()).toEqual(["active", "name", "slackUserId"]);
  });

  it("renvoie 401 si UnauthorizedError (session absente)", async () => {
    mockRequireRole.mockRejectedValue(new UnauthorizedError({ message: "no session" }));

    const res = await GET();

    expect(res.status).toBe(401);
    expect(mockListCommerciaux).not.toHaveBeenCalled();
  });

  it("renvoie 403 si rôle insuffisant (sans role OU commercial)", async () => {
    mockRequireRole.mockRejectedValue(
      new ForbiddenError({ message: "role commercial insufficient" }),
    );

    const res = await GET();

    expect(res.status).toBe(403);
    expect(mockListCommerciaux).not.toHaveBeenCalled();
  });

  it("renvoie l'ExternalServiceError statusCode si Airtable throw AppError", async () => {
    mockListCommerciaux.mockRejectedValue(
      new ExternalServiceError({
        message: "listCommerciauxForFilter: Airtable 503",
        context: { service: "airtable", op: "listCommerciauxForFilter" },
      }),
    );

    const res = await GET();

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("EXTERNAL_SERVICE");
  });

  it("renvoie 500 générique si throw inattendu — message serveur NON exposé", async () => {
    mockListCommerciaux.mockRejectedValue(new Error("Network timeout to Airtable"));

    const res = await GET();

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).not.toContain("Network timeout");
    expect(body.error.message).not.toContain("Airtable");
  });

  describe("défense anti-PII (compliance-auditor R3)", () => {
    it("aucun numéro FR dans la payload — même si Airtable renvoyait un numéro, il est strippé par la projection", async () => {
      // Même si une version future de `listCommerciauxForFilter` ajoutait
      // un champ `phone` sur `Commercial`, la projection route ne garde
      // que 3 clés — ce test force la propriété au niveau de la route.
      // Cast défensif : la projection route ne doit garder que les 3 clés
      // typées. On force un champ hypothétique pour vérifier qu'il DISPARAÎT.
      mockListCommerciaux.mockResolvedValue([
        {
          slackUserId: "U05UVHGBURX",
          name: "Dethie Faye",
          active: true,
          phone: "+33612345678",
          email: "dethie@example.com",
        } as unknown as { slackUserId: string; name: string; active: boolean },
      ]);
      const res = await GET();
      const text = JSON.stringify(await res.json());
      expect(text).not.toMatch(/\+33\d{9}/);
      expect(text).not.toMatch(/\b0[1-9](?:\d{2}){4}\b/);
      expect(text).not.toContain("example.com");
      expect(text).not.toContain("@");
    });
  });
});
