/**
 * Tests `slack-handoff.ts` — S9.9-PR5b.
 *
 * Structure :
 *   - Sentinelles structurelles (FUNCTION_ID, retries, HANDOFF_NOTES,
 *     DASHBOARD_URL_FALLBACK, LAST_INBOUND_HISTORY_LIMIT)
 *   - `decideRoute` unit tests (fonction pure, matrice 6 branches)
 *   - Pipeline par step (0-2 + 3-4 catch INTERNE + 6-7 branches)
 *   - Happy DM + Happy orphan × 5 reasons
 *   - Ordre slack-notify AVANT setHandoff
 *   - ConflictError idempotent
 *   - Idempotence step 0 replay
 *   - ConfigError SLACK_ORPHAN_LEADS_CHANNEL_ID absent
 *   - dashboardUrl : env présent vs fallback + warn
 *   - Anti-PII logs (sentinelle JSON.stringify complète)
 *
 * Pattern injection de dépendances (`deps`) — pas d'emulator. Cohérent avec
 * process-reply.test.ts et pre-send-check.test.ts.
 */
import type { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it, vi } from "vitest";

import type { Commercial } from "@/lib/airtable/commerciaux";
import {
  ConfigError,
  ConflictError,
  ExternalServiceError,
  NotFoundError,
} from "@/lib/utils/errors";
import type { Contact } from "@/types/contact";
import type { Conversation, ConversationStatus } from "@/types/conversation";

import {
  __DASHBOARD_URL_FALLBACK_FOR_TESTS,
  __FUNCTION_ID_FOR_TESTS,
  __HANDOFF_NOTES_FOR_TESTS,
  __LAST_INBOUND_HISTORY_LIMIT_FOR_TESTS,
  decideRoute,
  slackHandoff,
  type SlackHandoffDeps,
  slackHandoffHandler,
  type SlackHandoffHandlerContext,
} from "./slack-handoff";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — fake context + deps mocks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fake `step.run` non-memoizé — exécute la closure immédiatement. La
 * memoization Inngest cloud est du ressort d'un futur test
 * `slack-handoff.memoization.test.ts` (non requis PR5b).
 */
function makeStepRun(): SlackHandoffHandlerContext["step"] {
  return {
    run: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
  };
}

function makeFakeCtx(
  overrides: {
    contactId?: string;
    conversationId?: string;
    draftMessageId?: string;
    eventId?: string;
  } = {},
): SlackHandoffHandlerContext {
  return {
    event: {
      id: overrides.eventId ?? "evt-handoff-test-1",
      name: "medere/handoff.requested",
      data: {
        contactId: overrides.contactId ?? "hs-contact-123",
        conversationId: overrides.conversationId ?? "hs-contact-123_camp-a",
        draftMessageId: overrides.draftMessageId ?? "draftfirestoreid20ch",
      },
    },
    step: makeStepRun(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

function makeFakeContact(hubspotId: string): Contact {
  return {
    hubspotId,
    firstName: "Jean",
    lastName: "Dupont",
    speciality: "Chirurgien-dentiste",
    city: "Paris",
    postalCode: "75001",
    phone: {
      e164: "+33775745453",
      raw: "0775745453",
      type: "mobile",
      valid: true,
      lookupAt: { toMillis: () => 0 } as unknown as Timestamp,
    },
    segment: "b2b_cabinet",
    bloctelChecked: true,
    bloctelOptOut: false,
    consent: {
      legitimateInterest: "Lead HubSpot Médéré importé 2026-06-01 dentiste IDF",
      optedOut: false,
    },
    enrichment: {
      source: "hubspot",
      enrichedAt: { toMillis: () => 0 } as unknown as Timestamp,
    },
    status: "ready",
    campaignId: "dentistes-idf-mai-2026",
    createdAt: { toMillis: () => 0 } as unknown as Timestamp,
    updatedAt: { toMillis: () => 0 } as unknown as Timestamp,
  };
}

function makeFakeConversation(
  contactId: string,
  campaignId: string,
  status: ConversationStatus = "in_dialogue",
): Conversation {
  return {
    contactId,
    campaignId,
    channel: "sms",
    status,
    intent: "INTERESSE",
    messageCount: 3,
    outboundCount: 2,
    inboundCount: 1,
    followupCount: 0,
    createdAt: { toMillis: () => 0 } as unknown as Timestamp,
    updatedAt: { toMillis: () => 0 } as unknown as Timestamp,
  };
}

function makeFakeCommercial(overrides: Partial<Commercial> = {}): Commercial {
  return {
    slackUserId: "U01ABC123",
    name: "Vanessa Rabba",
    active: true,
    ...overrides,
  };
}

/** Pack `SlackHandoffDeps` avec defaults happy DM. */
function makeDeps(overrides: Partial<SlackHandoffDeps> = {}): SlackHandoffDeps {
  return {
    getConversation: vi.fn().mockResolvedValue(makeFakeConversation("hs-contact-123", "camp-a")),
    getContact: vi.fn().mockResolvedValue(makeFakeContact("hs-contact-123")),
    listRecentMessages: vi.fn().mockResolvedValue([
      { direction: "outbound", body: "Bonjour, Léa de Médéré..." },
      { direction: "inbound", body: "Oui ça m'intéresse, rappelez-moi." },
    ]),
    getContactOwnerId: vi.fn().mockResolvedValue("477507801"),
    resolveCommercialByOwnerId: vi.fn().mockResolvedValue(makeFakeCommercial()),
    sendHandoffNotification: vi
      .fn()
      .mockResolvedValue({ ts: "1234567890.123456", channel: "D01DM123" }),
    setHandoff: vi.fn().mockResolvedValue(undefined),
    appendAuditLog: vi.fn().mockResolvedValue("audit-id"),
    getOrphanChannelId: () => "C01ORPHAN",
    getDashboardBaseUrl: () => "https://medere-prospection.vercel.app",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sentinelles structurelles
// ─────────────────────────────────────────────────────────────────────────────

describe("sentinelles structurelles slack-handoff (S9.9-PR5b)", () => {
  it("FUNCTION_ID est figé à 'slack-handoff'", () => {
    expect(__FUNCTION_ID_FOR_TESTS).toBe("slack-handoff");
  });

  it("retries === 3 (choix explicite = default Inngest v4.x)", () => {
    const opts = (slackHandoff as unknown as { opts: { retries?: number } }).opts;
    expect(opts.retries).toBe(3);
  });

  it("HANDOFF_NOTES respecte la contrainte setHandoff (length >= 10)", () => {
    expect(__HANDOFF_NOTES_FOR_TESTS.length).toBeGreaterThanOrEqual(10);
  });

  it("HANDOFF_NOTES est la constante figée (D7 — pas de PII, pas d'injection)", () => {
    expect(__HANDOFF_NOTES_FOR_TESTS).toBe("Hand-off auto INTERESSE via Léa (S9.9)");
  });

  it("DASHBOARD_URL_FALLBACK figé à l'URL Vercel prod (D5)", () => {
    expect(__DASHBOARD_URL_FALLBACK_FOR_TESTS).toBe("https://medere-prospection.vercel.app");
  });

  it("LAST_INBOUND_HISTORY_LIMIT === 5", () => {
    expect(__LAST_INBOUND_HISTORY_LIMIT_FOR_TESTS).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// decideRoute — matrice complète (fonction pure)
// ─────────────────────────────────────────────────────────────────────────────

describe("decideRoute — matrice 6 branches (fonction pure)", () => {
  it("HubSpot ko → orphan reason=hubspot_unavailable", () => {
    expect(
      decideRoute({
        ownerStep: { ok: false },
        commercialStep: { ok: true, commercial: null },
      }),
    ).toEqual({ type: "orphan", reason: "hubspot_unavailable" });
  });

  it("ownerId=null → orphan reason=no_owner (priorité sur commercialStep)", () => {
    expect(
      decideRoute({
        ownerStep: { ok: true, ownerId: null },
        commercialStep: { ok: true, commercial: null },
      }),
    ).toEqual({ type: "orphan", reason: "no_owner" });
  });

  it("Airtable ko → orphan reason=airtable_unavailable", () => {
    expect(
      decideRoute({
        ownerStep: { ok: true, ownerId: "477" },
        commercialStep: { ok: false },
      }),
    ).toEqual({ type: "orphan", reason: "airtable_unavailable" });
  });

  it("commercial=null → orphan reason=commercial_not_found", () => {
    expect(
      decideRoute({
        ownerStep: { ok: true, ownerId: "477" },
        commercialStep: { ok: true, commercial: null },
      }),
    ).toEqual({ type: "orphan", reason: "commercial_not_found" });
  });

  it("commercial.active=false → orphan reason=commercial_inactive", () => {
    const commercial = makeFakeCommercial({ active: false });
    expect(
      decideRoute({
        ownerStep: { ok: true, ownerId: "477" },
        commercialStep: { ok: true, commercial },
      }),
    ).toEqual({ type: "orphan", reason: "commercial_inactive" });
  });

  it("commercial actif → DM avec l'objet Commercial", () => {
    const commercial = makeFakeCommercial({ active: true });
    expect(
      decideRoute({
        ownerStep: { ok: true, ownerId: "477" },
        commercialStep: { ok: true, commercial },
      }),
    ).toEqual({ type: "dm", commercial });
  });

  it("ordre de priorité STRICT : hubspot_unavailable > tout le reste", () => {
    // Sentinelle anti-régression : si HubSpot ko, on ne doit PAS scruter
    // commercialStep (qui est logiquement null puisque le short-circuit
    // step 4 court-circuite tôt). Garantit la lisibilité de la trace.
    const commercial = makeFakeCommercial({ active: true });
    expect(
      decideRoute({
        ownerStep: { ok: false },
        commercialStep: { ok: true, commercial },
      }),
    ).toEqual({ type: "orphan", reason: "hubspot_unavailable" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 0 — check-already-handoff
// ─────────────────────────────────────────────────────────────────────────────

describe("Step 0 — check-already-handoff", () => {
  it("conv absente → throw NotFoundError", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({ getConversation: vi.fn().mockResolvedValue(null) });

    await expect(slackHandoffHandler(ctx, deps)).rejects.toBeInstanceOf(NotFoundError);
    expect(deps.getContact).not.toHaveBeenCalled();
    expect(deps.sendHandoffNotification).not.toHaveBeenCalled();
  });

  it("conv.status === 'handed_off' → early return {status:'already_handed_off'}, aucun step aval", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({
      getConversation: vi
        .fn()
        .mockResolvedValue(makeFakeConversation("hs-contact-123", "camp-a", "handed_off")),
    });

    const result = await slackHandoffHandler(ctx, deps);

    expect(result).toEqual({ status: "already_handed_off" });
    // Sentinelle : aucun step aval n'est exécuté.
    expect(deps.getContact).not.toHaveBeenCalled();
    expect(deps.listRecentMessages).not.toHaveBeenCalled();
    expect(deps.getContactOwnerId).not.toHaveBeenCalled();
    expect(deps.resolveCommercialByOwnerId).not.toHaveBeenCalled();
    expect(deps.sendHandoffNotification).not.toHaveBeenCalled();
    expect(deps.setHandoff).not.toHaveBeenCalled();
    expect(deps.appendAuditLog).not.toHaveBeenCalled();
  });

  it("conv.status !== 'handed_off' → continue pipeline", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({
      getConversation: vi
        .fn()
        .mockResolvedValue(makeFakeConversation("hs-contact-123", "camp-a", "in_dialogue")),
    });

    const result = await slackHandoffHandler(ctx, deps);
    expect(result.status).toBe("dm"); // default happy path
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — load-contact
// ─────────────────────────────────────────────────────────────────────────────

describe("Step 1 — load-contact", () => {
  it("contact absent → throw NotFoundError (anomalie, retry Inngest)", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({ getContact: vi.fn().mockResolvedValue(null) });

    await expect(slackHandoffHandler(ctx, deps)).rejects.toBeInstanceOf(NotFoundError);
    // Ni Slack ni setHandoff appelés.
    expect(deps.sendHandoffNotification).not.toHaveBeenCalled();
    expect(deps.setHandoff).not.toHaveBeenCalled();
  });

  it("contact présent → passe firstName/speciality/city à Slack", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps();

    await slackHandoffHandler(ctx, deps);

    expect(deps.sendHandoffNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        firstName: "Jean",
        speciality: "Chirurgien-dentiste",
        city: "Paris",
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — load-last-inbound
// ─────────────────────────────────────────────────────────────────────────────

describe("Step 2 — load-last-inbound", () => {
  it("inbound présent → body passé à Slack", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({
      listRecentMessages: vi.fn().mockResolvedValue([
        { direction: "outbound", body: "SMS auto Médéré" },
        { direction: "inbound", body: "Oui, quel tarif ?" },
      ]),
    });

    await slackHandoffHandler(ctx, deps);

    expect(deps.sendHandoffNotification).toHaveBeenCalledWith(
      expect.objectContaining({ lastInboundBody: "Oui, quel tarif ?" }),
    );
  });

  it("plusieurs inbounds → prend le DERNIER", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({
      listRecentMessages: vi.fn().mockResolvedValue([
        { direction: "inbound", body: "premier PS" },
        { direction: "outbound", body: "réponse IA" },
        { direction: "inbound", body: "dernier PS" },
      ]),
    });

    await slackHandoffHandler(ctx, deps);

    expect(deps.sendHandoffNotification).toHaveBeenCalledWith(
      expect.objectContaining({ lastInboundBody: "dernier PS" }),
    );
  });

  it("aucun inbound → '' + logger.warn (dégradé, pas bloquant)", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({
      listRecentMessages: vi
        .fn()
        .mockResolvedValue([{ direction: "outbound", body: "SMS auto seulement" }]),
    });

    await slackHandoffHandler(ctx, deps);

    expect(deps.sendHandoffNotification).toHaveBeenCalledWith(
      expect.objectContaining({ lastInboundBody: "" }),
    );
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no inbound found"),
      expect.any(Object),
    );
  });

  it("appelle listRecentMessages avec LAST_INBOUND_HISTORY_LIMIT (=5)", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps();

    await slackHandoffHandler(ctx, deps);
    expect(deps.listRecentMessages).toHaveBeenCalledWith("hs-contact-123_camp-a", 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — resolve-owner-hubspot (catch INTERNE)
// ─────────────────────────────────────────────────────────────────────────────

describe("Step 3 — resolve-owner-hubspot (catch INTERNE, pas de retry Inngest)", () => {
  it("HubSpot throw → catch, log error, route orphan reason=hubspot_unavailable", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({
      getContactOwnerId: vi
        .fn()
        .mockRejectedValue(new ExternalServiceError({ message: "HubSpot 500" })),
    });

    const result = await slackHandoffHandler(ctx, deps);

    expect(result).toEqual({
      status: "orphan",
      reason: "hubspot_unavailable",
      slackTs: "1234567890.123456",
      slackChannel: "D01DM123",
    });
    // Le throw HubSpot est catch → Airtable N'EST PAS appelé (court-circuit
    // step 4 sur ownerStep.ok === false).
    expect(deps.resolveCommercialByOwnerId).not.toHaveBeenCalled();
    // Notif orphelin postée.
    expect(deps.sendHandoffNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "channel", channelId: "C01ORPHAN" },
        isOrphan: true,
      }),
    );
    expect(deps.setHandoff).not.toHaveBeenCalled();
    // Audit handoff_unassigned posé.
    expect(deps.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "handoff_unassigned",
        payload: expect.objectContaining({ reason: "hubspot_unavailable" }),
      }),
    );
    // Log error tracé.
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("HubSpot unavailable"),
      expect.objectContaining({ service: "hubspot" }),
    );
  });

  it("HubSpot retourne null → route orphan reason=no_owner", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({ getContactOwnerId: vi.fn().mockResolvedValue(null) });

    const result = await slackHandoffHandler(ctx, deps);

    expect(result.status).toBe("orphan");
    if (result.status === "orphan") {
      expect(result.reason).toBe("no_owner");
    }
    // no_owner court-circuite step 4 : Airtable pas appelé (le ownerId
    // est null, resolveCommercialByOwnerId n'a rien à chercher).
    expect(deps.resolveCommercialByOwnerId).not.toHaveBeenCalled();
    expect(deps.setHandoff).not.toHaveBeenCalled();
    expect(deps.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "handoff_unassigned",
        payload: expect.objectContaining({ reason: "no_owner" }),
      }),
    );
  });

  it("HubSpot retourne ownerId → passe à Airtable", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({ getContactOwnerId: vi.fn().mockResolvedValue("461430496") });

    await slackHandoffHandler(ctx, deps);

    expect(deps.resolveCommercialByOwnerId).toHaveBeenCalledWith("461430496");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 4 — resolve-commercial-airtable (catch INTERNE)
// ─────────────────────────────────────────────────────────────────────────────

describe("Step 4 — resolve-commercial-airtable (catch INTERNE)", () => {
  it("Airtable throw → catch, log error, route orphan reason=airtable_unavailable", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({
      resolveCommercialByOwnerId: vi
        .fn()
        .mockRejectedValue(new ExternalServiceError({ message: "Airtable 502" })),
    });

    const result = await slackHandoffHandler(ctx, deps);

    expect(result.status).toBe("orphan");
    if (result.status === "orphan") {
      expect(result.reason).toBe("airtable_unavailable");
    }
    expect(deps.setHandoff).not.toHaveBeenCalled();
    expect(deps.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "handoff_unassigned",
        payload: expect.objectContaining({ reason: "airtable_unavailable" }),
      }),
    );
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Airtable unavailable"),
      expect.objectContaining({ service: "airtable" }),
    );
  });

  it("commercial=null → route orphan reason=commercial_not_found", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({ resolveCommercialByOwnerId: vi.fn().mockResolvedValue(null) });

    const result = await slackHandoffHandler(ctx, deps);

    expect(result.status).toBe("orphan");
    if (result.status === "orphan") {
      expect(result.reason).toBe("commercial_not_found");
    }
    expect(deps.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "handoff_unassigned",
        payload: expect.objectContaining({ reason: "commercial_not_found" }),
      }),
    );
  });

  it("commercial inactif → route orphan reason=commercial_inactive", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({
      resolveCommercialByOwnerId: vi.fn().mockResolvedValue(makeFakeCommercial({ active: false })),
    });

    const result = await slackHandoffHandler(ctx, deps);

    expect(result.status).toBe("orphan");
    if (result.status === "orphan") {
      expect(result.reason).toBe("commercial_inactive");
    }
    expect(deps.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "handoff_unassigned",
        payload: expect.objectContaining({ reason: "commercial_inactive" }),
      }),
    );
  });

  it("commercial actif → route DM", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps();

    const result = await slackHandoffHandler(ctx, deps);

    expect(result.status).toBe("dm");
    if (result.status === "dm") {
      expect(result.slackUserId).toBe("U01ABC123");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Branche DM — happy path complet + assertions Slack + setHandoff
// ─────────────────────────────────────────────────────────────────────────────

describe("Branche DM — happy path complet", () => {
  it("Slack DM appelé avec target.kind='dm' + slackUserId + isOrphan=false", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps();

    await slackHandoffHandler(ctx, deps);

    expect(deps.sendHandoffNotification).toHaveBeenCalledWith({
      target: { kind: "dm", slackUserId: "U01ABC123" },
      firstName: "Jean",
      speciality: "Chirurgien-dentiste",
      city: "Paris",
      lastInboundBody: "Oui ça m'intéresse, rappelez-moi.",
      conversationId: "hs-contact-123_camp-a",
      isOrphan: false,
      dashboardUrl: "https://medere-prospection.vercel.app/conversations/hs-contact-123_camp-a",
    });
  });

  it("setHandoff appelé avec slackUserId + HANDOFF_NOTES", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps();

    await slackHandoffHandler(ctx, deps);

    expect(deps.setHandoff).toHaveBeenCalledWith(
      "hs-contact-123_camp-a",
      "U01ABC123",
      "Hand-off auto INTERESSE via Léa (S9.9)",
    );
  });

  it("audit handoff_unassigned N'EST PAS posé sur branche DM", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps();

    await slackHandoffHandler(ctx, deps);

    expect(deps.appendAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "handoff_unassigned" }),
    );
  });

  it("résultat = {status:'dm', slackUserId, slackTs, slackChannel}", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps();

    const result = await slackHandoffHandler(ctx, deps);

    expect(result).toEqual({
      status: "dm",
      slackUserId: "U01ABC123",
      slackTs: "1234567890.123456",
      slackChannel: "D01DM123",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Branche orphan — payload audit + assertions Slack channel
// ─────────────────────────────────────────────────────────────────────────────

describe("Branche orphan — payload audit + Slack channel", () => {
  it("Slack channel appelé avec target.kind='channel' + orphanChannelId + isOrphan=true", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({ getContactOwnerId: vi.fn().mockResolvedValue(null) });

    await slackHandoffHandler(ctx, deps);

    expect(deps.sendHandoffNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "channel", channelId: "C01ORPHAN" },
        isOrphan: true,
      }),
    );
  });

  it("payload handoff_unassigned = {contactId, conversationId, draftMessageId, reason, slackTs, slackChannel}", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({ getContactOwnerId: vi.fn().mockResolvedValue(null) });

    await slackHandoffHandler(ctx, deps);

    expect(deps.appendAuditLog).toHaveBeenCalledWith({
      actorId: "system",
      actorType: "system",
      action: "handoff_unassigned",
      targetType: "conversation",
      targetId: "hs-contact-123_camp-a",
      payload: {
        contactId: "hs-contact-123",
        conversationId: "hs-contact-123_camp-a",
        draftMessageId: "draftfirestoreid20ch",
        reason: "no_owner",
        slackTs: "1234567890.123456",
        slackChannel: "D01DM123",
      },
    });
  });

  it("setHandoff N'EST PAS appelé sur branche orphan", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({ getContactOwnerId: vi.fn().mockResolvedValue(null) });

    await slackHandoffHandler(ctx, deps);

    expect(deps.setHandoff).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ordre — slack-notify AVANT persist-handoff-dm (D1)
// ─────────────────────────────────────────────────────────────────────────────

describe("Ordre — slack-notify AVANT persist-handoff-dm (D1)", () => {
  it("🔒 SENTINELLE — sendHandoffNotification appelé AVANT setHandoff", async () => {
    // Invariant produit : le commercial est notifié AVANT que la conv ne
    // soit persistée handed_off. Si on inverse, on peut avoir un handoff
    // persisté sans notif (Slack down) → commercial owns a lead sans le
    // savoir. UX terrible.
    const ctx = makeFakeCtx();
    const callOrder: string[] = [];
    const deps = makeDeps({
      sendHandoffNotification: vi.fn().mockImplementation(async () => {
        callOrder.push("slack-notify");
        return { ts: "ts1", channel: "D01" };
      }),
      setHandoff: vi.fn().mockImplementation(async () => {
        callOrder.push("setHandoff");
      }),
    });

    await slackHandoffHandler(ctx, deps);

    const notifyIdx = callOrder.indexOf("slack-notify");
    const setHandoffIdx = callOrder.indexOf("setHandoff");
    expect(notifyIdx).toBeGreaterThanOrEqual(0);
    expect(setHandoffIdx).toBeGreaterThan(notifyIdx);
  });

  it("🔒 SENTINELLE — sendHandoffNotification appelé AVANT audit orphan", async () => {
    // Miroir pour la branche orphelins : Slack post AVANT audit handoff_unassigned.
    const ctx = makeFakeCtx();
    const callOrder: string[] = [];
    const deps = makeDeps({
      getContactOwnerId: vi.fn().mockResolvedValue(null),
      sendHandoffNotification: vi.fn().mockImplementation(async () => {
        callOrder.push("slack-notify");
        return { ts: "ts1", channel: "C01ORPHAN" };
      }),
      appendAuditLog: vi.fn().mockImplementation(async () => {
        callOrder.push("audit");
        return "audit-id";
      }),
    });

    await slackHandoffHandler(ctx, deps);

    expect(callOrder).toEqual(["slack-notify", "audit"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ConflictError setHandoff — idempotent no-op
// ─────────────────────────────────────────────────────────────────────────────

describe("ConflictError setHandoff — idempotent no-op", () => {
  it("setHandoff throw ConflictError → catch, log, return {status:'dm'}", async () => {
    // Cas : race concurrente OU re-livraison event >60s après step 0 passe
    // mais setHandoff commit d'une exec précédente. On catch et on renvoie
    // succès (le commercial a bien été notifié).
    const ctx = makeFakeCtx();
    const deps = makeDeps({
      setHandoff: vi.fn().mockRejectedValue(new ConflictError({ message: "already handed off" })),
    });

    const result = await slackHandoffHandler(ctx, deps);

    expect(result.status).toBe("dm");
    expect(ctx.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("handoff already exists"),
      expect.any(Object),
    );
    // Slack a bien été notifié (avant setHandoff).
    expect(deps.sendHandoffNotification).toHaveBeenCalled();
  });

  it("setHandoff throw autre erreur (NotFoundError) → propage → retry Inngest", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({
      setHandoff: vi.fn().mockRejectedValue(new NotFoundError({ message: "conv not found" })),
    });

    await expect(slackHandoffHandler(ctx, deps)).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Slack throw — propage (pas de fallback local)
// ─────────────────────────────────────────────────────────────────────────────

describe("Slack throw — propage (pas de catch INTERNE)", () => {
  it("sendHandoffNotification throw → propage ExternalServiceError → retry Inngest", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({
      sendHandoffNotification: vi
        .fn()
        .mockRejectedValue(new ExternalServiceError({ message: "Slack 502" })),
    });

    await expect(slackHandoffHandler(ctx, deps)).rejects.toBeInstanceOf(ExternalServiceError);
    // setHandoff jamais atteint.
    expect(deps.setHandoff).not.toHaveBeenCalled();
    expect(deps.appendAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "handoff_unassigned" }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ConfigError — SLACK_ORPHAN_LEADS_CHANNEL_ID absent
// ─────────────────────────────────────────────────────────────────────────────

describe("ConfigError — SLACK_ORPHAN_LEADS_CHANNEL_ID absent", () => {
  it("route=orphan + orphanChannelId=undefined → throw ConfigError AVANT slack-notify", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({
      getContactOwnerId: vi.fn().mockResolvedValue(null), // → orphan no_owner
      getOrphanChannelId: () => undefined,
    });

    await expect(slackHandoffHandler(ctx, deps)).rejects.toBeInstanceOf(ConfigError);
    // Slack pas appelé (fail-fast avant step 6).
    expect(deps.sendHandoffNotification).not.toHaveBeenCalled();
  });

  it("route=orphan + orphanChannelId='' → throw ConfigError", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({
      getContactOwnerId: vi.fn().mockResolvedValue(null),
      getOrphanChannelId: () => "",
    });

    await expect(slackHandoffHandler(ctx, deps)).rejects.toBeInstanceOf(ConfigError);
  });

  it("route=dm + orphanChannelId=undefined → PAS de throw (channelId inutilisé)", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({ getOrphanChannelId: () => undefined });

    const result = await slackHandoffHandler(ctx, deps);
    expect(result.status).toBe("dm");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dashboardUrl — env vs fallback + warn
// ─────────────────────────────────────────────────────────────────────────────

describe("dashboardUrl — env vs fallback (D5)", () => {
  it("NEXT_PUBLIC_APP_URL présent → utilisé sans warn", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({ getDashboardBaseUrl: () => "https://custom.example.com" });

    await slackHandoffHandler(ctx, deps);

    expect(deps.sendHandoffNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        dashboardUrl: "https://custom.example.com/conversations/hs-contact-123_camp-a",
      }),
    );
    // Pas de warn NEXT_PUBLIC_APP_URL.
    const warnCalls = (ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls.some((c) => JSON.stringify(c).includes("NEXT_PUBLIC_APP_URL missing"))).toBe(
      false,
    );
  });

  it("NEXT_PUBLIC_APP_URL absent → fallback Vercel + logger.warn", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({ getDashboardBaseUrl: () => undefined });

    await slackHandoffHandler(ctx, deps);

    expect(deps.sendHandoffNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        dashboardUrl: "https://medere-prospection.vercel.app/conversations/hs-contact-123_camp-a",
      }),
    );
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("NEXT_PUBLIC_APP_URL missing"),
      expect.any(Object),
    );
  });

  it("NEXT_PUBLIC_APP_URL = '' → fallback (traité comme absent)", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({ getDashboardBaseUrl: () => "" });

    await slackHandoffHandler(ctx, deps);

    expect(deps.sendHandoffNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        dashboardUrl: "https://medere-prospection.vercel.app/conversations/hs-contact-123_camp-a",
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Anti-PII logs — sentinelle stricte
// ─────────────────────────────────────────────────────────────────────────────

describe("Anti-PII logs (strict)", () => {
  it("aucune PII (firstName/speciality/city/lastInboundBody) dans logger.info/warn/error", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({
      getContact: vi.fn().mockResolvedValue(makeFakeContact("hs-contact-123")),
      listRecentMessages: vi.fn().mockResolvedValue([
        {
          direction: "inbound",
          body: "PII-SENSITIVE-BODY-oui je suis intéressé rappelez-moi",
        },
      ]),
    });

    await slackHandoffHandler(ctx, deps);

    // Serialize TOUS les logger calls (info + warn + error + debug).
    const allCalls = [
      ...(ctx.logger.info as ReturnType<typeof vi.fn>).mock.calls,
      ...(ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(ctx.logger.error as ReturnType<typeof vi.fn>).mock.calls,
      ...(ctx.logger.debug as ReturnType<typeof vi.fn>).mock.calls,
    ];
    const serialized = JSON.stringify(allCalls);

    // PII interdite (Contact fields).
    expect(serialized).not.toContain("Jean");
    expect(serialized).not.toContain("Dupont");
    expect(serialized).not.toContain("Chirurgien-dentiste");
    expect(serialized).not.toContain("Paris");
    expect(serialized).not.toContain("75001");
    expect(serialized).not.toContain("+33775745453");
    expect(serialized).not.toContain("0775745453");
    // Body inbound (sensible).
    expect(serialized).not.toContain("PII-SENSITIVE-BODY");
    expect(serialized).not.toContain("intéressé rappelez-moi");
  });

  it("IDs opaques + Slack IDs présents dans les logs (loggables)", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps();

    await slackHandoffHandler(ctx, deps);

    const infoCalls = (ctx.logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const serialized = JSON.stringify(infoCalls);

    expect(serialized).toContain("hs-contact-123");
    expect(serialized).toContain("hs-contact-123_camp-a");
    expect(serialized).toContain("draftfirestoreid20ch");
    expect(serialized).toContain("evt-handoff-test-1");
    // slackTs + slackChannel loggés (ID Slack workspace, opaques).
    expect(serialized).toContain("1234567890.123456");
    expect(serialized).toContain("D01DM123");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sentinelle event name (contrat émetteur PR4 ↔ trigger PR5b)
// ─────────────────────────────────────────────────────────────────────────────

describe("Sentinelle event name (contrat émetteur PR4 ↔ trigger)", () => {
  it("event.name === 'medere/handoff.requested' (default fake ctx)", async () => {
    // Sentinelle : le trigger de slackHandoff est handoffRequested (PR4).
    // Le nom du même event doit être stable des 2 côtés (émetteur
    // process-reply step 8e + consumer slack-handoff).
    const ctx = makeFakeCtx();
    expect(ctx.event.name).toBe("medere/handoff.requested");
  });
});
