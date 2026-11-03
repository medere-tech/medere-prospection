/**
 * Tests GET /api/admin/conversations/[id] (VUE-CONVERSATION PR1).
 *
 * Scope : route handler unit (mocks Clerk + loadConversationDetail + rate-limit).
 * Vérifie :
 *   - rate-limit 429
 *   - 404 / 403 / 500 opaques
 *   - 200 happy path
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(),
}));

vi.mock("@/lib/security/admin-rate-limit", () => ({
  applyAdminRateLimit: vi.fn(),
}));

vi.mock("@/lib/conversations/load-conversation-detail", () => ({
  loadConversationDetail: vi.fn(),
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
import { loadConversationDetail } from "@/lib/conversations/load-conversation-detail";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";

import { GET } from "./route";

const mockRequireRole = vi.mocked(requireRole);
const mockApplyAdminRateLimit = vi.mocked(applyAdminRateLimit);
const mockLoad = vi.mocked(loadConversationDetail);

describe("GET /api/admin/conversations/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue({
      userId: "user_admin_xxx",
      role: "admin",
      testAccount: false,
      firstName: "Déthié",
      lastName: "Faye",
      slackUserId: "U05UVHGBURX",
    });
    mockApplyAdminRateLimit.mockResolvedValue(null);
  });

  it("rate-limit 429 — court-circuit AVANT loadConversationDetail", async () => {
    const { NextResponse } = await import("next/server");
    mockApplyAdminRateLimit.mockResolvedValue(
      NextResponse.json(
        { error: { code: "RATE_LIMITED", message: "Trop de requêtes. Réessayez plus tard." } },
        { status: 429, headers: { "Retry-After": "7" } },
      ),
    );

    const res = await GET(new Request("http://x/api/admin/conversations/abc"), {
      params: Promise.resolve({ id: "abc" }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("7");
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("not_found → 404 opaque", async () => {
    mockLoad.mockResolvedValue({ kind: "not_found" });
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "abc" }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "not_found" });
  });

  it("not_mine → 403 avec assignedToName (fuite voulue documentée)", async () => {
    mockLoad.mockResolvedValue({ kind: "not_mine", assignedToName: "Vanessa Rabba" });
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "abc" }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: "forbidden", assignedToName: "Vanessa Rabba" });
  });

  it("error → 500 opaque sans détail serveur", async () => {
    mockLoad.mockResolvedValue({ kind: "error", code: "something-internal" });
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "abc" }) });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "internal_error" });
    expect(JSON.stringify(body)).not.toContain("something-internal");
  });

  it("ok → 200 avec data complète", async () => {
    const fakeData = {
      conversationId: "abc",
      contactId: "c1",
      status: "in_dialogue",
      intent: "INTERESSE",
      campaignId: "camp1",
      createdAtIso: "2026-01-01T00:00:00.000Z",
      updatedAtIso: "2026-01-01T00:00:00.000Z",
      lastInboundAtIso: null,
      lastOutboundAtIso: null,
      inboundCount: 0,
      outboundCount: 0,
      summary: null,
      handoff: null,
      contact: {
        contactId: "c1",
        civilite: "Dr",
        firstName: "Jean",
        lastName: "Dupont",
        speciality: "Dentiste",
        city: "Paris",
        optedOut: false,
      },
      messages: [],
      journal: [],
      viewerIsOwner: true,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockLoad.mockResolvedValue({ kind: "ok", data: fakeData as any });
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "abc" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conversationId).toBe("abc");
  });
});
