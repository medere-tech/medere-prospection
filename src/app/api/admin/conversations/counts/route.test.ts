/**
 * Tests GET /api/admin/conversations/counts (PR2a).
 *
 * Invariants :
 *   - 401 / 403 / rate-limit 429
 *   - admin : renvoie 4 compteurs (a_traiter, en_cours, cloturees, toutes)
 *   - commercial : renvoie 3 compteurs (pas `en_cours`), filtré sur son
 *     slackUserId même avec `?assignedTo=<autre>` dans la query.
 *   - `countConversations` est appelée 1 fois par onglet autorisé.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(),
}));
vi.mock("@/lib/security/admin-rate-limit", () => ({
  applyAdminRateLimit: vi.fn(),
}));
vi.mock("@/lib/firestore/conversations", async () => {
  const actual = await vi.importActual<typeof import("@/lib/firestore/conversations")>(
    "@/lib/firestore/conversations",
  );
  return {
    ...actual,
    countConversations: vi.fn(),
  };
});
vi.mock("@/lib/utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { requireRole } from "@/lib/auth/require-role";
import { countConversations } from "@/lib/firestore/conversations";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";
import { ForbiddenError, UnauthorizedError } from "@/lib/utils/errors";

import { GET } from "./route";

const mockRequireRole = vi.mocked(requireRole);
const mockRL = vi.mocked(applyAdminRateLimit);
const mockCount = vi.mocked(countConversations);

describe("GET /api/admin/conversations/counts (PR2a)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRL.mockResolvedValue(null);
    // 4 appels max pour admin (a_traiter, cloturees, toutes, en_cours).
    mockCount.mockResolvedValue(0);
  });

  it("401 — UnauthorizedError propagée", async () => {
    mockRequireRole.mockRejectedValue(new UnauthorizedError({ message: "x" }));
    const res = await GET(new Request("http://x"));
    expect(res.status).toBe(401);
  });

  it("403 — ForbiddenError propagée", async () => {
    mockRequireRole.mockRejectedValue(new ForbiddenError({ message: "x" }));
    const res = await GET(new Request("http://x"));
    expect(res.status).toBe(403);
  });

  it("admin — 4 compteurs retournés, 4 agrégations", async () => {
    mockRequireRole.mockResolvedValue({
      userId: "u",
      role: "admin",
      testAccount: false,
      firstName: "A",
      lastName: "B",
      slackUserId: "U05UVHGBURX",
    });
    mockCount
      .mockResolvedValueOnce(2) // a_traiter
      .mockResolvedValueOnce(10) // cloturees
      .mockResolvedValueOnce(42) // toutes
      .mockResolvedValueOnce(5); // en_cours
    const res = await GET(new Request("http://x"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts).toEqual({ a_traiter: 2, cloturees: 10, toutes: 42, en_cours: 5 });
    expect(mockCount).toHaveBeenCalledTimes(4);
  });

  it("commercial — 3 compteurs seulement, pas de en_cours, 3 agrégations", async () => {
    mockRequireRole.mockResolvedValue({
      userId: "u",
      role: "commercial",
      testAccount: false,
      firstName: "V",
      lastName: "R",
      slackUserId: "UVANESSA999",
    });
    mockCount
      .mockResolvedValueOnce(1) // a_traiter
      .mockResolvedValueOnce(3) // cloturees
      .mockResolvedValueOnce(7); // toutes
    const res = await GET(new Request("http://x"));
    const body = await res.json();
    expect(body.counts).toEqual({ a_traiter: 1, cloturees: 3, toutes: 7 });
    expect(body.counts.en_cours).toBeUndefined();
    expect(mockCount).toHaveBeenCalledTimes(3);
  });

  it("commercial — toutes les agrégations sont filtrées sur son slackUserId", async () => {
    mockRequireRole.mockResolvedValue({
      userId: "u",
      role: "commercial",
      testAccount: false,
      firstName: "V",
      lastName: "R",
      slackUserId: "UVANESSA999",
    });
    // Même avec `?assignedTo=UOTHER888`, le commercial reste contraint.
    await GET(new Request("http://x?assignedTo=UOTHER888"));
    for (const call of mockCount.mock.calls) {
      expect(call[0]?.assigneeFilter).toEqual({
        kind: "specific",
        slackUserId: "UVANESSA999",
      });
    }
  });

  it("BOLA fail-closed — commercial SANS slackUserId → 403, zéro agrégation", async () => {
    mockRequireRole.mockResolvedValue({
      userId: "u",
      role: "commercial",
      testAccount: false,
      firstName: "V",
      lastName: "R",
      // slackUserId absent (undefined)
    });
    const res = await GET(new Request("http://x"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(mockCount).not.toHaveBeenCalled();
  });

  it("sentinel PII — 500 si `q` normalisé contient un numéro FR (M4 /counts)", async () => {
    mockRequireRole.mockResolvedValue({
      userId: "u",
      role: "admin",
      testAccount: false,
      firstName: "A",
      lastName: "B",
      slackUserId: "U05UVHGBURX",
    });
    // Un `q` qui porterait un numéro passerait la normalisation accents+lower
    // mais garderait les chiffres. La sentinelle `assertNoPhoneInPayload`
    // sur le `filterApplied.q` doit refuser.
    const res = await GET(new Request("http://x?q=" + encodeURIComponent("appeler 0612345678")));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "internal" });
    expect(JSON.stringify(body)).not.toContain("06");
  });

  it("rate-limit 429 — court-circuit avant toute agrégation", async () => {
    mockRequireRole.mockResolvedValue({
      userId: "u",
      role: "admin",
      testAccount: false,
      firstName: "A",
      lastName: "B",
      slackUserId: "U05UVHGBURX",
    });
    const { NextResponse } = await import("next/server");
    mockRL.mockResolvedValue(NextResponse.json({}, { status: 429 }));
    await GET(new Request("http://x"));
    expect(mockCount).not.toHaveBeenCalled();
  });
});
