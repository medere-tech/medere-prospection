/**
 * Tests GET /api/admin/conversations (PR2a liste).
 *
 * Scope : route handler unit (mocks Clerk + listConversations* + rate-limit).
 * Invariants vérifiés :
 *   - 401 unauthenticated / 403 wrong role
 *   - 403 si commercial demande un onglet admin-only (`en_cours`)
 *   - commercial FORCÉ sur son slackUserId (ignore `?assignedTo` dans query)
 *   - Zod stricte sur tous les params
 *   - rate-limit 429 court-circuit avant Firestore
 *   - sentinel PII refuse une payload portant un numéro FR (500)
 *   - champs `lastHumanOutboundAt` + `waitingForHumanReply` dérivés serveur
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
    listConversations: vi.fn(),
    listConversationsByAssignee: vi.fn(),
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
import { listConversations, listConversationsByAssignee } from "@/lib/firestore/conversations";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";
import { ForbiddenError, UnauthorizedError } from "@/lib/utils/errors";

import { GET } from "./route";

const mockRequireRole = vi.mocked(requireRole);
const mockRL = vi.mocked(applyAdminRateLimit);
const mockList = vi.mocked(listConversations);
const mockListByAssignee = vi.mocked(listConversationsByAssignee);

function okAdmin() {
  mockRequireRole.mockResolvedValue({
    userId: "user_admin",
    role: "admin",
    firstName: "Dethie",
    lastName: "Faye",
    slackUserId: "U05UVHGBURX",
  });
}

function okCommercial(slackUserId = "UVANESSA999") {
  mockRequireRole.mockResolvedValue({
    userId: "user_commercial",
    role: "commercial",
    firstName: "Vanessa",
    lastName: "Rabba",
    slackUserId,
  });
}

function emptyList(): Awaited<ReturnType<typeof listConversations>> {
  return { conversations: [], nextCursor: null, hasMore: false };
}

describe("GET /api/admin/conversations (PR2a)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRL.mockResolvedValue(null);
    mockList.mockResolvedValue(emptyList());
    mockListByAssignee.mockResolvedValue(emptyList());
  });

  it("401 — UnauthorizedError propagée", async () => {
    mockRequireRole.mockRejectedValue(new UnauthorizedError({ message: "no session" }));
    const res = await GET(new Request("http://x/api/admin/conversations"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("403 — ForbiddenError propagée (sans rôle)", async () => {
    mockRequireRole.mockRejectedValue(new ForbiddenError({ message: "no role" }));
    const res = await GET(new Request("http://x/api/admin/conversations"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("rate-limit 429 — court-circuit AVANT Firestore", async () => {
    okAdmin();
    const { NextResponse } = await import("next/server");
    mockRL.mockResolvedValue(
      NextResponse.json({ error: { code: "RATE_LIMITED" } }, { status: 429 }),
    );
    const res = await GET(new Request("http://x/api/admin/conversations"));
    expect(res.status).toBe(429);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockListByAssignee).not.toHaveBeenCalled();
  });

  it("Zod rejette un tab inconnu (400)", async () => {
    okAdmin();
    const res = await GET(new Request("http://x/api/admin/conversations?tab=yolo"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_error");
  });

  it("Zod rejette un slackUserId mal formé (400)", async () => {
    okAdmin();
    const res = await GET(new Request("http://x/api/admin/conversations?assignedTo=not-slack-id"));
    expect(res.status).toBe(400);
  });

  it("Zod rejette un limit hors bornes (400)", async () => {
    okAdmin();
    const res = await GET(new Request("http://x/api/admin/conversations?limit=0"));
    expect(res.status).toBe(400);
    const res2 = await GET(new Request("http://x/api/admin/conversations?limit=101"));
    expect(res2.status).toBe(400);
  });

  it("Zod rejette un q trop long (400)", async () => {
    okAdmin();
    const long = "a".repeat(81);
    const res = await GET(
      new Request(`http://x/api/admin/conversations?q=${encodeURIComponent(long)}`),
    );
    expect(res.status).toBe(400);
  });

  it("BOLA fail-closed — commercial SANS slackUserId → 403, zéro appel Firestore", async () => {
    // Régression security-reviewer C-1 (PR2a) : si un compte commercial
    // est provisionné dans Clerk mais le claim `publicMetadata.slackUserId`
    // n'a pas encore été seedé, `slackUserId` est undefined. L'ancien code
    // basculait `effectiveAssignedTo = null` → `listConversations()` sans
    // filtre → fuite horizontale complète. Fail-closed.
    mockRequireRole.mockResolvedValue({
      userId: "user_new_commercial",
      role: "commercial",
      firstName: "V",
      lastName: "R",
      // slackUserId absent (undefined, propre Zod sur `.optional()`)
    });
    const res = await GET(new Request("http://x/api/admin/conversations?tab=toutes"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(mockList).not.toHaveBeenCalled();
    expect(mockListByAssignee).not.toHaveBeenCalled();
  });

  it("commercial sur onglet admin-only (en_cours) → 403 forbidden_tab", async () => {
    okCommercial();
    const res = await GET(new Request("http://x/api/admin/conversations?tab=en_cours"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden_tab" });
    // Zéro appel Firestore sur un tab interdit.
    expect(mockList).not.toHaveBeenCalled();
    expect(mockListByAssignee).not.toHaveBeenCalled();
  });

  it("admin sur `en_cours` → listConversations avec statusIn des 4 statuts non terminaux", async () => {
    okAdmin();
    await GET(new Request("http://x/api/admin/conversations?tab=en_cours"));
    expect(mockList).toHaveBeenCalledTimes(1);
    const arg = mockList.mock.calls[0]![0];
    expect(arg?.filters?.statusIn).toEqual([
      "active",
      "awaiting_reply",
      "in_dialogue",
      "qualified",
    ]);
  });

  it("commercial FORCÉ sur son slackUserId — ignore `?assignedTo` dans la query", async () => {
    okCommercial("UVANESSA999");
    await GET(new Request("http://x/api/admin/conversations?tab=toutes&assignedTo=UOTHER888"));
    expect(mockListByAssignee).toHaveBeenCalledTimes(1);
    expect(mockListByAssignee.mock.calls[0]![0]).toBe("UVANESSA999");
    expect(mockList).not.toHaveBeenCalled();
  });

  it("admin + ?assignedTo=X → listConversationsByAssignee(X)", async () => {
    okAdmin();
    await GET(new Request("http://x/api/admin/conversations?tab=toutes&assignedTo=UZACH1234"));
    expect(mockListByAssignee).toHaveBeenCalledTimes(1);
    expect(mockListByAssignee.mock.calls[0]![0]).toBe("UZACH1234");
  });

  it("admin sans ?assignedTo → listConversations (pas de filtre commercial)", async () => {
    okAdmin();
    await GET(new Request("http://x/api/admin/conversations?tab=toutes"));
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockListByAssignee).not.toHaveBeenCalled();
  });

  it("q normalisé serveur (accents + case) avant d'être passé à Firestore", async () => {
    okAdmin();
    await GET(new Request("http://x/api/admin/conversations?q=" + encodeURIComponent("Déthié")));
    const arg = mockList.mock.calls[0]![0];
    // La normalisation strippe les accents + lower.
    expect(arg?.filters?.contactNameSearch).toBe("dethie");
  });

  it("pagination — passe le cursor au backend", async () => {
    okAdmin();
    await GET(new Request("http://x/api/admin/conversations?cursor=hs_abc_camp1"));
    expect(mockList.mock.calls[0]![0]?.cursor).toBe("hs_abc_camp1");
  });

  it("payload — `waitingForHumanReply` true si inbound > lastHumanOutboundAt", async () => {
    const { Timestamp } = await import("firebase-admin/firestore");
    okAdmin();
    const inboundMs = 1_700_000_200_000;
    const humanMs = 1_700_000_100_000;
    mockList.mockResolvedValueOnce({
      conversations: [
        {
          conversationId: "c_x",
          contactId: "c",
          campaignId: "x",
          channel: "sms",
          status: "in_dialogue",
          intent: "INTERESSE",
          messageCount: 2,
          outboundCount: 1,
          inboundCount: 1,
          followupCount: 0,
          assignedTo: "UVANESSA999",
          lastInboundAt: Timestamp.fromMillis(inboundMs),
          lastOutboundAt: Timestamp.fromMillis(humanMs),
          lastMessageAt: Timestamp.fromMillis(inboundMs),
          lastHumanOutboundAt: Timestamp.fromMillis(humanMs),
          createdAt: Timestamp.fromMillis(0),
          updatedAt: Timestamp.fromMillis(inboundMs),
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
    const res = await GET(new Request("http://x/api/admin/conversations"));
    const body = await res.json();
    expect(body.items[0].waitingForHumanReply).toBe(true);
  });

  it("payload — `waitingForHumanReply` false si lastHumanOutboundAt > lastInboundAt", async () => {
    const { Timestamp } = await import("firebase-admin/firestore");
    okAdmin();
    const inboundMs = 1_700_000_100_000;
    const humanMs = 1_700_000_200_000;
    mockList.mockResolvedValueOnce({
      conversations: [
        {
          conversationId: "c_x",
          contactId: "c",
          campaignId: "x",
          channel: "sms",
          status: "in_dialogue",
          intent: "INTERESSE",
          messageCount: 2,
          outboundCount: 1,
          inboundCount: 1,
          followupCount: 0,
          assignedTo: "UVANESSA999",
          lastInboundAt: Timestamp.fromMillis(inboundMs),
          lastOutboundAt: Timestamp.fromMillis(humanMs),
          lastMessageAt: Timestamp.fromMillis(humanMs),
          lastHumanOutboundAt: Timestamp.fromMillis(humanMs),
          createdAt: Timestamp.fromMillis(0),
          updatedAt: Timestamp.fromMillis(humanMs),
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
    const res = await GET(new Request("http://x/api/admin/conversations"));
    const body = await res.json();
    expect(body.items[0].waitingForHumanReply).toBe(false);
  });

  it("sentinel PII — 500 si la liste rend un numéro FR non scrubé", async () => {
    const { Timestamp } = await import("firebase-admin/firestore");
    okAdmin();
    // Régression : un `lastMessagePreview.text` qui aurait leaké un numéro
    // malgré `sanitizeLastMessageText` à l'écriture. La sentinel refuse.
    mockList.mockResolvedValueOnce({
      conversations: [
        {
          conversationId: "c_leak",
          contactId: "c",
          campaignId: "x",
          channel: "sms",
          status: "active",
          intent: "unknown",
          messageCount: 1,
          outboundCount: 1,
          inboundCount: 0,
          followupCount: 0,
          assignedTo: null,
          lastMessageAt: Timestamp.fromMillis(1_700_000_000_000),
          createdAt: Timestamp.fromMillis(0),
          updatedAt: Timestamp.fromMillis(1_700_000_000_000),
          lastMessagePreview: {
            direction: "inbound",
            authorKind: "contact",
            text: "Mon numero: 06 12 34 56 78",
            at: Timestamp.fromMillis(1_700_000_000_000),
          },
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
    const res = await GET(new Request("http://x/api/admin/conversations"));
    expect(res.status).toBe(500);
    const body = await res.json();
    // Message d'erreur générique, pas de leak du numéro dans la réponse.
    expect(body).toEqual({ error: "internal" });
    expect(JSON.stringify(body)).not.toContain("06");
  });
});
