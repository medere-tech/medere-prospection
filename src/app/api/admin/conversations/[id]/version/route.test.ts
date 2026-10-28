/**
 * Tests GET /api/admin/conversations/[id]/version (VUE-CONVERSATION PR1
 * — polling économique).
 *
 * Vérifie :
 *   - rate-limit 429
 *   - 404 opaque (conv absente)
 *   - 403 avec assignedToName (commercial non-titulaire)
 *   - 200 happy path admin : lit UNIQUEMENT conversation (pas messages/audits/contact)
 *   - zéro PII dans la réponse (sentinelle)
 */
import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(),
}));

vi.mock("@/lib/security/admin-rate-limit", () => ({
  applyAdminRateLimit: vi.fn(),
}));

vi.mock("@/lib/firestore/conversations", () => ({
  getConversation: vi.fn(),
}));

vi.mock("@/lib/airtable/commerciaux", () => ({
  resolveCommercialBySlackUserId: vi.fn(),
}));

vi.mock("@/lib/utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { resolveCommercialBySlackUserId } from "@/lib/airtable/commerciaux";
import { requireRole } from "@/lib/auth/require-role";
import { getConversation } from "@/lib/firestore/conversations";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";

import { GET } from "./route";

const mockRequireRole = vi.mocked(requireRole);
const mockRateLimit = vi.mocked(applyAdminRateLimit);
const mockGetConv = vi.mocked(getConversation);
const mockResolve = vi.mocked(resolveCommercialBySlackUserId);

function makeFakeConv(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    contactId: "c1",
    campaignId: "camp1",
    channel: "sms",
    status: "handed_off",
    intent: "INTERESSE",
    messageCount: 2,
    outboundCount: 1,
    inboundCount: 1,
    followupCount: 0,
    assignedTo: "UOWNER12345",
    handoff: {
      assignedTo: "UOWNER12345",
      assignedAt: Timestamp.fromMillis(1_700_000_100_000),
    },
    createdAt: Timestamp.fromMillis(1_700_000_000_000),
    updatedAt: Timestamp.fromMillis(1_700_000_200_000),
    lastInboundAt: Timestamp.fromMillis(1_700_000_200_000),
    lastOutboundAt: Timestamp.fromMillis(1_700_000_150_000),
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("GET /api/admin/conversations/[id]/version", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue({
      userId: "user_admin",
      role: "admin",
      testAccount: false,
      slackUserId: "U05UVHGBURX",
    });
    mockRateLimit.mockResolvedValue(null);
  });

  it("rate-limit 429 — court-circuit AVANT getConversation (0 read Firestore)", async () => {
    const { NextResponse } = await import("next/server");
    mockRateLimit.mockResolvedValue(
      NextResponse.json(
        { error: { code: "RATE_LIMITED", message: "Trop de requêtes." } },
        { status: 429 },
      ),
    );

    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "abc" }) });
    expect(res.status).toBe(429);
    expect(mockGetConv).not.toHaveBeenCalled();
  });

  it("404 opaque si conv absente", async () => {
    mockGetConv.mockResolvedValue(null);
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "abc" }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "not_found" });
  });

  it("admin : 200 avec signature complète (7 champs techniques)", async () => {
    mockGetConv.mockResolvedValue(makeFakeConv());
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "abc" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      [
        "assignedTo",
        "inboundCount",
        "lastInboundAtIso",
        "lastOutboundAtIso",
        "outboundCount",
        "status",
        "updatedAtIso",
      ].sort(),
    );
    expect(body.status).toBe("handed_off");
    expect(body.assignedTo).toBe("UOWNER12345");
    expect(body.inboundCount).toBe(1);
    expect(body.outboundCount).toBe(1);
  });

  it("commercial titulaire : 200", async () => {
    mockRequireRole.mockResolvedValue({
      userId: "user_c",
      role: "commercial",
      testAccount: false,
      slackUserId: "UOWNER12345",
    });
    mockGetConv.mockResolvedValue(makeFakeConv());
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "abc" }) });
    expect(res.status).toBe(200);
  });

  it("commercial non-titulaire : 403 avec assignedToName (fuite voulue)", async () => {
    mockRequireRole.mockResolvedValue({
      userId: "user_intruder",
      role: "commercial",
      testAccount: false,
      slackUserId: "UINTRUDER99",
    });
    mockGetConv.mockResolvedValue(makeFakeConv());
    mockResolve.mockResolvedValue({
      slackUserId: "UOWNER12345",
      name: "Vanessa Rabba",
      active: true,
    });
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "abc" }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: "forbidden", assignedToName: "Vanessa Rabba" });
  });

  it("sentinelle anti-PII : aucun pattern téléphone/email dans la réponse 200", async () => {
    mockGetConv.mockResolvedValue(makeFakeConv());
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "abc" }) });
    const text = await res.text();
    expect(text).not.toMatch(/\+33\d{9}/);
    expect(text).not.toMatch(/\b0033\d{9}\b/);
    expect(text).not.toMatch(/\b0[1-9]\d{8}\b/);
    expect(text).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
  });

  it("conv sans handoff : assignedTo=null, pas de 403 pour admin", async () => {
    mockGetConv.mockResolvedValue(
      makeFakeConv({ handoff: undefined, assignedTo: null, status: "in_dialogue" }),
    );
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "abc" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assignedTo).toBeNull();
  });
});
