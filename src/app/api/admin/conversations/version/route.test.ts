/**
 * Tests GET /api/admin/conversations/version (PR2a polling).
 *
 * Invariants :
 *   - 401 / 403 / 429
 *   - commercial sur tab admin-only (`en_cours`) → 403 forbidden_tab
 *   - La version embarque `topUpdatedAtMs` et `topConversationId`
 *   - Si aucun doc, version = "0_" (stable)
 *   - updatedAt est bien la clé de tri (vérifié via spy Firestore)
 */
import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(),
}));
vi.mock("@/lib/security/admin-rate-limit", () => ({
  applyAdminRateLimit: vi.fn(),
}));
vi.mock("@/lib/firestore/admin", () => ({
  getAdminDb: vi.fn(),
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
import { getAdminDb } from "@/lib/firestore/admin";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";
import { UnauthorizedError } from "@/lib/utils/errors";

import { GET } from "./route";

const mockRequireRole = vi.mocked(requireRole);
const mockRL = vi.mocked(applyAdminRateLimit);
const mockGetDb = vi.mocked(getAdminDb);

function buildMockQuery(topDoc: { id: string; updatedAt: Timestamp } | null) {
  const chain = {
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    get: vi.fn(),
  };
  // self-chainable
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.get.mockResolvedValue({
    docs: topDoc ? [{ id: topDoc.id, data: () => ({ updatedAt: topDoc.updatedAt }) }] : [],
  });
  const collection = { ...chain };
  const db = { collection: vi.fn().mockReturnValue(collection) };
  mockGetDb.mockReturnValue(db as unknown as ReturnType<typeof getAdminDb>);
  return { chain, collection };
}

describe("GET /api/admin/conversations/version (PR2a)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRL.mockResolvedValue(null);
  });

  it("401 — UnauthorizedError propagée", async () => {
    mockRequireRole.mockRejectedValue(new UnauthorizedError({ message: "x" }));
    const res = await GET(new Request("http://x"));
    expect(res.status).toBe(401);
  });

  it("commercial sur tab=en_cours → 403 forbidden_tab", async () => {
    mockRequireRole.mockResolvedValue({
      userId: "u",
      role: "commercial",
      testAccount: false,
      firstName: "V",
      lastName: "R",
      slackUserId: "UVANESSA999",
    });
    const res = await GET(new Request("http://x?tab=en_cours"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden_tab" });
  });

  it("admin — version embarque topUpdatedAtMs + id", async () => {
    mockRequireRole.mockResolvedValue({
      userId: "u",
      role: "admin",
      testAccount: false,
      firstName: "A",
      lastName: "B",
      slackUserId: "U05UVHGBURX",
    });
    const ms = 1_700_000_000_000;
    buildMockQuery({ id: "c_top", updatedAt: Timestamp.fromMillis(ms) });
    const res = await GET(new Request("http://x"));
    const body = await res.json();
    expect(body).toEqual({
      version: `${ms}_c_top`,
      topUpdatedAtMs: ms,
      topConversationId: "c_top",
    });
  });

  it("empty state — version 0_ stable", async () => {
    mockRequireRole.mockResolvedValue({
      userId: "u",
      role: "admin",
      testAccount: false,
      firstName: "A",
      lastName: "B",
      slackUserId: "U05UVHGBURX",
    });
    buildMockQuery(null);
    const res = await GET(new Request("http://x"));
    const body = await res.json();
    expect(body.version).toBe("0_");
    expect(body.topConversationId).toBeNull();
  });

  it("tri sur updatedAt desc (preuve mock Firestore)", async () => {
    mockRequireRole.mockResolvedValue({
      userId: "u",
      role: "admin",
      testAccount: false,
      firstName: "A",
      lastName: "B",
      slackUserId: "U05UVHGBURX",
    });
    const { chain } = buildMockQuery(null);
    await GET(new Request("http://x"));
    // Au moins un orderBy sur updatedAt desc avant .limit(1).
    const orderByCalls = chain.orderBy.mock.calls;
    expect(orderByCalls.length).toBeGreaterThanOrEqual(1);
    const lastOrder = orderByCalls[orderByCalls.length - 1];
    expect(lastOrder).toEqual(["updatedAt", "desc"]);
    expect(chain.limit).toHaveBeenCalledWith(1);
  });

  it("commercial — WHERE assignedTo FORCÉ sur son slackUserId", async () => {
    mockRequireRole.mockResolvedValue({
      userId: "u",
      role: "commercial",
      testAccount: false,
      firstName: "V",
      lastName: "R",
      slackUserId: "UVANESSA999",
    });
    const { chain } = buildMockQuery(null);
    // Essaie d'injecter un autre slackUserId.
    await GET(new Request("http://x?assignedTo=UOTHER888"));
    const whereCalls = chain.where.mock.calls;
    const assignedToCall = whereCalls.find((c) => c[0] === "assignedTo");
    expect(assignedToCall).toEqual(["assignedTo", "==", "UVANESSA999"]);
  });

  it("BOLA fail-closed — commercial SANS slackUserId → 403, zéro query Firestore", async () => {
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
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it("sentinel PII — 500 si `topConversationId` contient un numéro FR (M4 /version)", async () => {
    mockRequireRole.mockResolvedValue({
      userId: "u",
      role: "admin",
      testAccount: false,
      firstName: "A",
      lastName: "B",
      slackUserId: "U05UVHGBURX",
    });
    // On force un docId qui match un numéro FR national : si quelqu'un
    // retire assertNoPhoneInPayload de /version, ce test tombe.
    buildMockQuery({
      id: "x_0612345678_camp",
      updatedAt: Timestamp.fromMillis(1_700_000_000_000),
    });
    const res = await GET(new Request("http://x"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "internal" });
    expect(JSON.stringify(body)).not.toContain("0612345678");
  });

  it("rate-limit 429 — court-circuit avant la query", async () => {
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
    expect(mockGetDb).not.toHaveBeenCalled();
  });
});
