/**
 * Tests GET /api/admin/campaigns (S10.1.5 Phase 1).
 *
 * Scope : route handler unit (mocks Clerk + listSmsLists). Vérifie
 * auth/RBAC + happy path + propagation erreur HubSpot.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExternalServiceError, ForbiddenError, UnauthorizedError } from "@/lib/utils/errors";

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(),
}));

// S10.1.9 RATELIMIT-001 : mock le helper pour découpler les tests de route
// du wrapper Upstash. Par défaut (beforeEach) on retourne null = pass-through.
vi.mock("@/lib/security/admin-rate-limit", () => ({
  applyAdminRateLimit: vi.fn(),
}));

vi.mock("@/lib/hubspot/lists", () => ({
  listSmsLists: vi.fn(),
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
import { listSmsLists } from "@/lib/hubspot/lists";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";

import { GET } from "./route";

const mockRequireRole = vi.mocked(requireRole);
const mockListSmsLists = vi.mocked(listSmsLists);
const mockApplyAdminRateLimit = vi.mocked(applyAdminRateLimit);

const FAKE_CAMPAIGNS = [
  {
    listId: "200",
    name: "SMS Dentistes IDF",
    size: 200,
    processingType: "MANUAL",
    createdAt: "2026-05-29T12:00:00.000Z",
  },
  {
    listId: "201",
    name: "SMS Médecins PACA",
    size: 150,
    processingType: "MANUAL",
    createdAt: "2026-06-01T12:00:00.000Z",
  },
];

describe("GET /api/admin/campaigns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue({
      userId: "user_admin_xxx",
      role: "admin",
      firstName: "Déthié",
      lastName: "Faye",
    });
    // S10.1.9 RATELIMIT-001 : par défaut le rate-limit passe (null = OK).
    mockApplyAdminRateLimit.mockResolvedValue(null);
  });

  describe("rate-limit (S10.1.9 RATELIMIT-001)", () => {
    it("renvoie 429 + Retry-After + body RATE_LIMITED si rate-limit bloque", async () => {
      const { NextResponse } = await import("next/server");
      mockApplyAdminRateLimit.mockResolvedValue(
        NextResponse.json(
          { error: { code: "RATE_LIMITED", message: "Trop de requêtes. Réessayez plus tard." } },
          { status: 429, headers: { "Retry-After": "7" } },
        ),
      );

      const res = await GET();

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("7");
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("RATE_LIMITED");
      expect(mockListSmsLists).not.toHaveBeenCalled();
    });

    it("rate-limit appelé avec le Clerk userId extrait de requireRole", async () => {
      mockListSmsLists.mockResolvedValue(FAKE_CAMPAIGNS);
      await GET();
      expect(mockApplyAdminRateLimit).toHaveBeenCalledWith(expect.anything(), "user_admin_xxx");
    });
  });

  it("renvoie 200 + campaigns quand admin auth OK", async () => {
    mockListSmsLists.mockResolvedValue(FAKE_CAMPAIGNS);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { campaigns: typeof FAKE_CAMPAIGNS };
    expect(body.campaigns).toHaveLength(2);
    expect(body.campaigns[0]?.listId).toBe("200");
    expect(mockListSmsLists).toHaveBeenCalledWith("SMS");
  });

  it("renvoie 401 si UnauthorizedError throw", async () => {
    mockRequireRole.mockRejectedValue(new UnauthorizedError({ message: "no session" }));

    const res = await GET();

    expect(res.status).toBe(401);
    expect(mockListSmsLists).not.toHaveBeenCalled();
  });

  it("renvoie 403 si rôle insuffisant", async () => {
    mockRequireRole.mockRejectedValue(
      new ForbiddenError({ message: "role commercial insufficient" }),
    );

    const res = await GET();

    expect(res.status).toBe(403);
    expect(mockListSmsLists).not.toHaveBeenCalled();
  });

  it("renvoie 502 (ExternalServiceError statusCode) si listSmsLists throw AppError HubSpot", async () => {
    mockListSmsLists.mockRejectedValue(
      new ExternalServiceError({
        message: "listSmsLists: HubSpot 401 unauthorized",
        context: { service: "hubspot", op: "listSmsLists" },
      }),
    );

    const res = await GET();

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("EXTERNAL_SERVICE");
  });

  it("renvoie 500 générique si listSmsLists throw une erreur inattendue", async () => {
    mockListSmsLists.mockRejectedValue(new Error("Network timeout"));

    const res = await GET();

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).not.toContain("Network timeout");
  });
});
