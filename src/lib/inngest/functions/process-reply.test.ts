/**
 * Tests process-reply.ts — pipeline déterministe 5 steps (S9.2.1).
 *
 * Structure :
 *   - Sentinelles structurelles (FUNCTION_ID, retries, DROP_REASONS)
 *   - Pipeline par step (5 describes)
 *   - Sentinelle anti-PII pipeline complet (logger.calls JSON.stringify
 *     ne contient JAMAIS phone, body, ovhMessageId)
 *
 * Pattern injection de dépendances (`deps`) — pas d'emulator. Cohérent
 * avec pre-send-check.test.ts (S5). Tests unit purs, ~80ms total.
 */
import type { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it, vi } from "vitest";

import type { Contact } from "@/types/contact";
import type { Conversation } from "@/types/conversation";
import type { Message } from "@/types/message";

import {
  __DROP_REASONS_FOR_TESTS,
  __FUNCTION_ID_FOR_TESTS,
  __PHONE_HASH_PREFIX_FOR_TESTS,
  processReply,
  type ProcessReplyDeps,
  processReplyHandler,
  type ProcessReplyHandlerContext,
} from "./process-reply";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — fake context + deps mocks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fake `step.run` qui exécute la fonction synchrone (pas de memoization)
 * — comportement OK pour tests unit. La memoization Inngest est testée en
 * S9.2.3 en intégration cloud.
 */
function makeStepRun() {
  return {
    run: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
  };
}

function makeFakeCtx(
  overrides: { phone?: string; body?: string; ovhMessageId?: string; eventId?: string } = {},
): ProcessReplyHandlerContext {
  return {
    event: {
      id: overrides.eventId ?? "evt-reply-test-1",
      name: "medere/sms.reply.received",
      data: {
        phone: overrides.phone ?? "+33775745453",
        body: overrides.body ?? "Bonjour, ça m'intéresse",
        ovhMessageId: overrides.ovhMessageId ?? "ovh-msg-789",
      },
    },
    step: makeStepRun(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

/**
 * Builder d'un Contact minimal pour tests. Pas besoin de tous les champs
 * — le handler ne consomme que `contact.hubspotId`.
 */
function makeFakeContact(hubspotId: string): Contact {
  return {
    hubspotId,
    firstName: "Jean",
    lastName: "Dupont",
    speciality: "dentiste",
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

/**
 * Builder d'une Conversation minimale pour tests.
 */
function makeFakeConversation(contactId: string, campaignId: string): Conversation {
  return {
    contactId,
    campaignId,
    channel: "sms",
    status: "awaiting_reply",
    intent: "unknown",
    messageCount: 1,
    outboundCount: 1,
    inboundCount: 0,
    followupCount: 0,
    createdAt: { toMillis: () => 0 } as unknown as Timestamp,
    updatedAt: { toMillis: () => 0 } as unknown as Timestamp,
  };
}

/**
 * Builder d'un Message inbound pour tests dédup.
 */
function makeFakeInboundMessage(externalId: string, body: string): Message {
  return {
    direction: "inbound",
    body,
    status: "received",
    channel: "sms",
    externalId,
    externalReceiver: "+33775745453",
    generatedBy: "human",
    createdAt: { toMillis: () => 0 } as unknown as Timestamp,
    receivedAt: { toMillis: () => 0 } as unknown as Timestamp,
  };
}

/**
 * Pack `ProcessReplyDeps` avec defaults vi.fn() — chaque test override
 * ce dont il a besoin.
 */
function makeDeps(overrides: Partial<ProcessReplyDeps> = {}): ProcessReplyDeps {
  return {
    getContactByPhone: vi.fn(),
    getActiveConversationByContactId: vi.fn(),
    findInboundByExternalId: vi.fn().mockResolvedValue(null),
    addInbound: vi.fn().mockResolvedValue("msg-firestore-id-20ch"),
    markOptedOut: vi.fn().mockResolvedValue(undefined),
    isOptOut: vi.fn().mockReturnValue(false),
    hashPii: vi.fn().mockReturnValue("hashed-pii-abcd1234abcd1234abcd1234"),
    appendAuditLog: vi.fn().mockResolvedValue("audit-id"),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sentinelles structurelles
// ─────────────────────────────────────────────────────────────────────────────

describe("sentinelles structurelles process-reply (S9.2.1)", () => {
  it("FUNCTION_ID est figé à 'process-reply'", () => {
    // Modifier cet ID = nouvelle function côté Inngest cloud + perte
    // d'historique d'exécution. Sentinelle stable depuis S8.
    expect(__FUNCTION_ID_FOR_TESTS).toBe("process-reply");
  });

  it("retries === 0 (relâchement prévu S9.2.3)", () => {
    // S9.2.1 — pipeline déterministe pas encore validé en intégration
    // sur la memoization step.run. Sentinelle bloquera la régression
    // accidentelle qui relâcherait sans le test memoization.
    const opts = (processReply as unknown as { opts: { retries?: number } }).opts;
    expect(opts.retries).toBe(0);
  });

  it("DROP_REASONS verrouillé à ['contact_unknown', 'no_active_conversation', 'duplicate']", () => {
    // 🔒 Sentinelle anti-régression : ajouter une raison de drop sans
    // miroir dans le pipeline (et inversement) = bug forensic / audit.
    expect([...__DROP_REASONS_FOR_TESTS].sort()).toEqual([
      "contact_unknown",
      "duplicate",
      "no_active_conversation",
    ]);
  });

  it("PHONE_HASH_PREFIX === 'hph_' (fix HIGH-1 security-reviewer S9.2.1)", () => {
    // 🔒 Sentinelle anti-régression : ce préfixe casse les frontières
    // anti-digit du scrubber RE_FR_NATIONAL et évite les ~0.3% de
    // collisions hex pur qui généraient des AuditPiiError silencieux.
    // Cf. process-reply.ts PHONE_HASH_PREFIX JSDoc + sentinelle dans
    // pii-detector.test.ts qui prouve la protection contre un hash
    // pathologique connu.
    expect(__PHONE_HASH_PREFIX_FOR_TESTS).toBe("hph_");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — resolve-contact
// ─────────────────────────────────────────────────────────────────────────────

describe("Step 1 — resolve-contact", () => {
  it("contact trouvé → continue le pipeline (status pending_intent_classification)", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hubspot-123")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hubspot-123_camp-a",
        conversation: makeFakeConversation("hubspot-123", "camp-a"),
      }),
    });

    const result = await processReplyHandler(ctx, deps);

    expect(result.status).toBe("pending_intent_classification");
    if (result.status === "pending_intent_classification") {
      expect(result.contactId).toBe("hubspot-123");
    }
    expect(deps.getContactByPhone).toHaveBeenCalledWith("+33775745453");
  });

  it("contact inconnu → drop avec audit reply_dropped + phoneHash préfixé (hph_), JAMAIS phone en clair", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(null),
    });

    const result = await processReplyHandler(ctx, deps);

    expect(result).toEqual({ status: "dropped", reason: "contact_unknown" });
    expect(deps.hashPii).toHaveBeenCalledWith("+33775745453");
    // Fix HIGH-1 security-reviewer S9.2.1 : préfixe `hph_` casse les
    // frontières anti-digit du scrubber RE_FR_NATIONAL, prévient les
    // ~0.3% de collisions hex pur.
    const expectedHash = "hph_hash_ed-p_ii-a_bcd1_234a_bcd1_234a_bcd1_234";
    expect(deps.appendAuditLog).toHaveBeenCalledWith({
      actorId: "system",
      actorType: "system",
      action: "reply_dropped",
      targetType: "contact",
      targetId: expectedHash,
      payload: {
        reason: "contact_unknown",
        phoneHash: expectedHash,
      },
    });
    // Pas de message stocké, pas de conv résolue.
    expect(deps.addInbound).not.toHaveBeenCalled();
    expect(deps.getActiveConversationByContactId).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — resolve-conversation
// ─────────────────────────────────────────────────────────────────────────────

describe("Step 2 — resolve-conversation", () => {
  it("conv active trouvée → continue", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hubspot-456")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hubspot-456_camp-b",
        conversation: makeFakeConversation("hubspot-456", "camp-b"),
      }),
    });

    const result = await processReplyHandler(ctx, deps);

    expect(result.status).toBe("pending_intent_classification");
    if (result.status === "pending_intent_classification") {
      expect(result.conversationId).toBe("hubspot-456_camp-b");
    }
    expect(deps.getActiveConversationByContactId).toHaveBeenCalledWith("hubspot-456");
  });

  it("aucune conv active → drop reply_dropped no_active_conversation + audit avec contactId comme targetId", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hubspot-789")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue(null),
    });

    const result = await processReplyHandler(ctx, deps);

    expect(result).toEqual({ status: "dropped", reason: "no_active_conversation" });
    // Fix HIGH-1 : phoneHash préfixé `hph_` (cf. test step 1 contact_unknown).
    expect(deps.appendAuditLog).toHaveBeenCalledWith({
      actorId: "system",
      actorType: "system",
      action: "reply_dropped",
      targetType: "contact",
      targetId: "hubspot-789",
      payload: {
        reason: "no_active_conversation",
        phoneHash: "hph_hash_ed-p_ii-a_bcd1_234a_bcd1_234a_bcd1_234",
      },
    });
    expect(deps.addInbound).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — dedup-by-external-id
// ─────────────────────────────────────────────────────────────────────────────

describe("Step 3 — dedup-by-external-id", () => {
  it("doublon détecté → drop reply_dropped duplicate avec duplicateOfMessageId forensic", async () => {
    const ctx = makeFakeCtx({ ovhMessageId: "ovh-dup-001" });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hubspot-dup")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hubspot-dup_camp-d",
        conversation: makeFakeConversation("hubspot-dup", "camp-d"),
      }),
      findInboundByExternalId: vi.fn().mockResolvedValue({
        messageId: "existing-msgid-abc123",
        message: makeFakeInboundMessage("ovh-dup-001", "previous body"),
      }),
    });

    const result = await processReplyHandler(ctx, deps);

    expect(result).toEqual({ status: "dropped", reason: "duplicate" });
    expect(deps.appendAuditLog).toHaveBeenCalledWith({
      actorId: "system",
      actorType: "system",
      action: "reply_dropped",
      targetType: "message",
      targetId: "existing-msgid-abc123",
      payload: {
        reason: "duplicate",
        contactId: "hubspot-dup",
        conversationId: "hubspot-dup_camp-d",
        duplicateOfMessageId: "existing-msgid-abc123",
      },
    });
    // store-inbound JAMAIS appelé sur doublon.
    expect(deps.addInbound).not.toHaveBeenCalled();
  });

  it("pas de doublon → continue le pipeline", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hubspot-fresh")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hubspot-fresh_camp-e",
        conversation: makeFakeConversation("hubspot-fresh", "camp-e"),
      }),
      findInboundByExternalId: vi.fn().mockResolvedValue(null),
    });

    const result = await processReplyHandler(ctx, deps);

    expect(result.status).toBe("pending_intent_classification");
    expect(deps.addInbound).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 4 — store-inbound
// ─────────────────────────────────────────────────────────────────────────────

describe("Step 4 — store-inbound", () => {
  it("appelle addInbound avec externalReceiver = phone (PS = expéditeur)", async () => {
    // Sentinelle anti-régression du sketch initial qui mettait
    // externalReceiver: "OVH" — incorrect, le champ doit être le phone
    // E.164 du PS (cf. JSDoc messages.ts:234-239).
    const ctx = makeFakeCtx({
      phone: "+33611112222",
      body: "Hello",
      ovhMessageId: "ovh-store-001",
    });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-store")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-store_camp-s",
        conversation: makeFakeConversation("hs-store", "camp-s"),
      }),
      addInbound: vi.fn().mockResolvedValue("new-msgid-store-001"),
    });

    await processReplyHandler(ctx, deps);

    expect(deps.addInbound).toHaveBeenCalledWith("hs-store_camp-s", {
      body: "Hello",
      channel: "sms",
      externalId: "ovh-store-001",
      externalReceiver: "+33611112222", // = phone, PAS "OVH"
    });
  });

  it("messageId retourné par addInbound propagé dans le résultat", async () => {
    const ctx = makeFakeCtx();
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-msg")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-msg_camp-m",
        conversation: makeFakeConversation("hs-msg", "camp-m"),
      }),
      addInbound: vi.fn().mockResolvedValue("fresh-msgid-xyz"),
    });

    const result = await processReplyHandler(ctx, deps);

    expect(result.status).toBe("pending_intent_classification");
    if (result.status === "pending_intent_classification") {
      expect(result.messageId).toBe("fresh-msgid-xyz");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 5 — short-form-opt-out-check
// ─────────────────────────────────────────────────────────────────────────────

describe("Step 5 — short-form-opt-out-check (fast-path)", () => {
  it("isOptOut true → markOptedOut + status opt_out (PAS classify Claude)", async () => {
    const ctx = makeFakeCtx({ body: "STOP" });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-stop")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-stop_camp-z",
        conversation: makeFakeConversation("hs-stop", "camp-z"),
      }),
      addInbound: vi.fn().mockResolvedValue("msgid-stop-001"),
      isOptOut: vi.fn().mockReturnValue(true),
    });

    const result = await processReplyHandler(ctx, deps);

    expect(result).toEqual({
      status: "opt_out",
      contactId: "hs-stop",
      conversationId: "hs-stop_camp-z",
      messageId: "msgid-stop-001",
    });
    // markOptedOut appelé avec channel "sms"
    expect(deps.markOptedOut).toHaveBeenCalledWith("hs-stop", "sms");
  });

  it("isOptOut false → status pending_intent_classification (transition S9.2.2)", async () => {
    const ctx = makeFakeCtx({ body: "Bonjour, ça m'intéresse" });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-noop")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-noop_camp-n",
        conversation: makeFakeConversation("hs-noop", "camp-n"),
      }),
      addInbound: vi.fn().mockResolvedValue("msgid-noop-001"),
      isOptOut: vi.fn().mockReturnValue(false),
    });

    const result = await processReplyHandler(ctx, deps);

    expect(result.status).toBe("pending_intent_classification");
    expect(deps.markOptedOut).not.toHaveBeenCalled();
  });

  it("STORE-INBOUND avant opt-out check (forensic L.34-5 CPCE)", async () => {
    // Sentinelle invariant : un STOP doit être stocké en base MÊME si
    // on bascule en branche opt_out. Le forensic juridique exige la
    // preuve écrite que le PS a bien dit STOP.
    const ctx = makeFakeCtx({ body: "STOP" });
    const callOrder: string[] = [];
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-order")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-order_camp-o",
        conversation: makeFakeConversation("hs-order", "camp-o"),
      }),
      addInbound: vi.fn().mockImplementation(async () => {
        callOrder.push("addInbound");
        return "msgid-order-001";
      }),
      isOptOut: vi.fn().mockImplementation((body: string) => {
        callOrder.push("isOptOut");
        return body === "STOP";
      }),
      markOptedOut: vi.fn().mockImplementation(async () => {
        callOrder.push("markOptedOut");
      }),
    });

    await processReplyHandler(ctx, deps);

    // L'ordre exact : addInbound DOIT précéder markOptedOut.
    expect(callOrder).toEqual(["addInbound", "isOptOut", "markOptedOut"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sentinelle anti-PII — pipeline complet
// ─────────────────────────────────────────────────────────────────────────────

describe("Anti-PII pipeline complet (sentinelle critique L.34-5 CPCE)", () => {
  /**
   * 🔒 Sentinelle CRITIQUE — étendue du test S8 stub aux 5 steps.
   * Vérifie que ni phone, ni body, ni ovhMessageId n'apparaissent dans
   * AUCUN appel logger sur AUCUNE branche du pipeline. Si quelqu'un
   * ajoute par mégarde `phone` ou `body` dans un `logger.X(...)`, ce
   * test casse — c'est l'objectif explicite.
   */
  const SECRET_PHONE = "+33687654321";
  const SECRET_BODY = "Mon numéro perso est 0612345678";
  const SECRET_OVH_MSGID = "ovh-secret-id-XYZ123";

  function assertNoLeak(logger: ProcessReplyHandlerContext["logger"]) {
    const allCalls = [
      ...(logger.info as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.debug as ReturnType<typeof vi.fn>).mock.calls,
    ];
    const serialized = JSON.stringify(allCalls);
    expect(serialized).not.toContain(SECRET_PHONE);
    expect(serialized).not.toContain("687654321");
    expect(serialized).not.toContain(SECRET_BODY);
    expect(serialized).not.toContain("Mon numéro");
    expect(serialized).not.toContain("0612345678");
    expect(serialized).not.toContain(SECRET_OVH_MSGID);
  }

  it("branche contact_unknown — aucune fuite phone/body/ovhMessageId", async () => {
    const ctx = makeFakeCtx({
      phone: SECRET_PHONE,
      body: SECRET_BODY,
      ovhMessageId: SECRET_OVH_MSGID,
    });
    const deps = makeDeps({ getContactByPhone: vi.fn().mockResolvedValue(null) });
    await processReplyHandler(ctx, deps);
    assertNoLeak(ctx.logger);
  });

  it("branche no_active_conversation — aucune fuite", async () => {
    const ctx = makeFakeCtx({
      phone: SECRET_PHONE,
      body: SECRET_BODY,
      ovhMessageId: SECRET_OVH_MSGID,
    });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-nac")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue(null),
    });
    await processReplyHandler(ctx, deps);
    assertNoLeak(ctx.logger);
  });

  it("branche duplicate — aucune fuite", async () => {
    const ctx = makeFakeCtx({
      phone: SECRET_PHONE,
      body: SECRET_BODY,
      ovhMessageId: SECRET_OVH_MSGID,
    });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-dup")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-dup_camp-d",
        conversation: makeFakeConversation("hs-dup", "camp-d"),
      }),
      findInboundByExternalId: vi.fn().mockResolvedValue({
        messageId: "existing-id",
        message: makeFakeInboundMessage(SECRET_OVH_MSGID, "ignored"),
      }),
    });
    await processReplyHandler(ctx, deps);
    assertNoLeak(ctx.logger);
  });

  it("branche opt_out — aucune fuite (STOP body en clair masqué)", async () => {
    const ctx = makeFakeCtx({
      phone: SECRET_PHONE,
      body: "STOP " + SECRET_BODY, // STOP courte + suite PII pour stresser
      ovhMessageId: SECRET_OVH_MSGID,
    });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-stop-leak")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-stop-leak_camp-o",
        conversation: makeFakeConversation("hs-stop-leak", "camp-o"),
      }),
      isOptOut: vi.fn().mockReturnValue(true),
    });
    await processReplyHandler(ctx, deps);
    assertNoLeak(ctx.logger);
  });

  it("branche pending_intent_classification — aucune fuite", async () => {
    const ctx = makeFakeCtx({
      phone: SECRET_PHONE,
      body: SECRET_BODY,
      ovhMessageId: SECRET_OVH_MSGID,
    });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-pic")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-pic_camp-p",
        conversation: makeFakeConversation("hs-pic", "camp-p"),
      }),
      isOptOut: vi.fn().mockReturnValue(false),
    });
    await processReplyHandler(ctx, deps);
    assertNoLeak(ctx.logger);
  });

  it("logue uniquement eventId/name/contactId/conversationId/messageId (scrubber-safe)", async () => {
    // Sentinelle positive : on vérifie que les champs SAFE remontent
    // bien dans les logs (= forensic non-PII présent + observable).
    const ctx = makeFakeCtx({ eventId: "evt-positive-001" });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-positive")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-positive_camp-pos",
        conversation: makeFakeConversation("hs-positive", "camp-pos"),
      }),
      addInbound: vi.fn().mockResolvedValue("msgid-positive-001"),
    });
    await processReplyHandler(ctx, deps);

    const calls = (ctx.logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const serialized = JSON.stringify(calls);
    expect(serialized).toContain("evt-positive-001");
    expect(serialized).toContain("medere/sms.reply.received");
    expect(serialized).toContain("hs-positive");
    expect(serialized).toContain("hs-positive_camp-pos");
    expect(serialized).toContain("msgid-positive-001");
  });
});
