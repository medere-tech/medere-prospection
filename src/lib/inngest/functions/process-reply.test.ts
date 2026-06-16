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

import { ExternalServiceError } from "@/lib/utils/errors";
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
function makeStepRun(): ProcessReplyHandlerContext["step"] {
  return {
    run: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
    // S9.4.3 — step.sendEvent fake : pas d'émission réelle, juste un
    // spy pour assertions (event name + data + id). mockResolvedValue
    // évite les warnings ESLint args unused (vi.fn ne propage pas le
    // prefix _ aux params).
    sendEvent: vi.fn().mockResolvedValue({}),
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
    // S9.2.2 — defaults : INTERESSE non-fallback → branche "classified"
    // (les tests step 1-4 qui ne mockent pas classifyReply atterrissent
    // ici par défaut au lieu de retourner pending_intent_classification).
    classifyReply: vi.fn().mockResolvedValue({
      intent: "INTERESSE",
      confidence: 0.85,
      // Sentinelle PII : reasoning est plausible mais ne doit JAMAIS
      // fuiter dans logs/audit (defense-in-depth).
      reasoning: "default-test-reasoning-must-not-leak",
      fallback: false,
    }),
    setConversationIntent: vi.fn().mockResolvedValue(undefined),
    // S9.3.3b — gen IA reply + stockage draft (defaults qui SUCCÈDENT,
    // chaque test branche INTERESSE/OBJECTION/NEUTRE atterrit ici).
    listRecentMessages: vi.fn().mockResolvedValue([
      {
        direction: "outbound",
        body: "Bonjour Dr Test, je suis Léa, assistante virtuelle de Médéré.",
      },
    ]),
    generateReply: vi.fn().mockResolvedValue({
      body: "Bonjour Docteur, quelle formation Médéré vous intéresse ?",
      promptVersion: "1.0.0",
      model: "claude-sonnet-4-6",
      temperature: 0.5,
      tokensInput: 540,
      tokensOutput: 38,
      generationDurationMs: 1234,
    }),
    addOutboundDraft: vi.fn().mockResolvedValue("draftfirestoreid20ch"),
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

  it("retries === 3 (S9.2.3 — choix explicite, pas default implicite)", () => {
    // S9.2.3 — relâché de 0 (S9.2.1/S9.2.2) à 3. Valeur EXPLICITE qui
    // matche le default Inngest v4.x mais documente le choix dans le
    // code (cf. process-reply.ts JSDoc retries section).
    //
    // La memoization step.run par (eventId, stepName) protège contre
    // double-commit Firestore + double-audit + double-facturation
    // Claude sur retry. Sentinelle anti-régression MED-1 dans
    // process-reply.memoization.test.ts (S9.2.3.2).
    const opts = (processReply as unknown as { opts: { retries?: number } }).opts;
    expect(opts.retries).toBe(3);
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
  it("contact trouvé → continue le pipeline (status classified, intent default INTERESSE)", async () => {
    // S9.2.2 — le pipeline va jusqu'au step 7 et retourne `classified`
    // avec l'intent par défaut du mock classifyReply (= INTERESSE).
    const ctx = makeFakeCtx();
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hubspot-123")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hubspot-123_camp-a",
        conversation: makeFakeConversation("hubspot-123", "camp-a"),
      }),
    });

    const result = await processReplyHandler(ctx, deps);

    expect(result.status).toBe("classified");
    if (result.status === "classified") {
      expect(result.contactId).toBe("hubspot-123");
      expect(result.intent).toBe("INTERESSE");
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

    // S9.2.3 — sentinelle négative : reply_processed JAMAIS posé sur
    // les drops. reply_dropped suffit (forensic complet via reason +
    // phoneHash). Éviter redondance + brouiller analytics "inbound
    // traités vs abandonnés".
    expect(deps.appendAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "reply_processed" }),
    );
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

    expect(result.status).toBe("classified");
    if (result.status === "classified") {
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

    // S9.2.3 — sentinelle négative reply_processed sur drop (cf. step 1).
    expect(deps.appendAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "reply_processed" }),
    );
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

    // S9.2.3 — sentinelle négative reply_processed sur drop (cf. step 1).
    expect(deps.appendAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "reply_processed" }),
    );
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

    expect(result.status).toBe("classified");
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

    expect(result.status).toBe("classified");
    if (result.status === "classified") {
      expect(result.messageId).toBe("fresh-msgid-xyz");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 5 — short-form-opt-out-check
// ─────────────────────────────────────────────────────────────────────────────

describe("Step 5 — short-form-opt-out-check (fast-path)", () => {
  it("isOptOut true → markOptedOut ÉTENDU + status opt_out via=short_form (PAS classify Claude)", async () => {
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
      intent: "STOP",
      via: "short_form",
    });
    // S9.2.2.2 amendement step 5 — markOptedOut variante étendue :
    // synchronise la conversation dans la même tx (ferme trou S9.2.1).
    expect(deps.markOptedOut).toHaveBeenCalledWith("hs-stop", "sms", {
      conversationId: "hs-stop_camp-z",
      intent: "STOP",
    });
    // Classifier NON appelé (économie d'un appel Claude sur STOP courts).
    expect(deps.classifyReply).not.toHaveBeenCalled();
    // setConversationIntent NON appelé (STOP passe par markOptedOut).
    expect(deps.setConversationIntent).not.toHaveBeenCalled();
    // S9.4.3 — sendEvent NON appelé sur branche STOP short_form (le PS a
    // dit stop, on respecte — pas de dispatch reply).
    expect(ctx.step.sendEvent).not.toHaveBeenCalled();

    // S9.2.3 — Step 8 audit-reply-processed posé en fin de branche.
    // PAS de classifierFallback (court-circuit avant Claude).
    expect(deps.appendAuditLog).toHaveBeenCalledWith({
      actorId: "system",
      actorType: "system",
      action: "reply_processed",
      targetType: "conversation",
      targetId: "hs-stop_camp-z",
      payload: expect.objectContaining({
        contactId: "hs-stop",
        conversationId: "hs-stop_camp-z",
        messageId: "msgid-stop-001",
        intent: "STOP",
        branchTaken: "opt_out_short_form",
        finalConversationStatus: "opted_out",
        pipelineDurationMs: expect.any(Number),
      }),
    });
    // Sentinelle distinctive short_form : pas de classifierFallback dans
    // le payload (la branche n'est jamais passée par Claude).
    const replyProcessedCall = (deps.appendAuditLog as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { action: string }).action === "reply_processed",
    );
    expect(replyProcessedCall).toBeDefined();
    expect(
      (replyProcessedCall?.[0] as { payload: Record<string, unknown> }).payload,
    ).not.toHaveProperty("classifierFallback");
  });

  it("isOptOut false → status classified (via classifier — S9.2.2 transition)", async () => {
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

    expect(result.status).toBe("classified");
    expect(deps.markOptedOut).not.toHaveBeenCalled();
    // Le classifier ET setConversationIntent sont appelés.
    expect(deps.classifyReply).toHaveBeenCalledWith("Bonjour, ça m'intéresse");
    expect(deps.setConversationIntent).toHaveBeenCalled();
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
// Step 6 — classify-intent (Claude + audit intent_classified)
// ─────────────────────────────────────────────────────────────────────────────

describe("Step 6 — classify-intent (Claude Haiku 4.5)", () => {
  it("audit intent_classified posé AVANT branche, payload scrubber-safe", async () => {
    const ctx = makeFakeCtx({ body: "Combien ça coûte ?" });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-clf-1")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-clf-1_camp-c",
        conversation: makeFakeConversation("hs-clf-1", "camp-c"),
      }),
      addInbound: vi.fn().mockResolvedValue("msgid-clf-1"),
      classifyReply: vi.fn().mockResolvedValue({
        intent: "INTERESSE",
        confidence: 0.85,
        reasoning: "question tarif factuelle = engagement actif",
        fallback: false,
      }),
    });

    await processReplyHandler(ctx, deps);

    // L'audit intent_classified DOIT être posé.
    expect(deps.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "system",
        actorType: "system",
        action: "intent_classified",
        targetType: "message",
        targetId: "msgid-clf-1",
        payload: {
          contactId: "hs-clf-1",
          conversationId: "hs-clf-1_camp-c",
          intent: "INTERESSE",
          confidence: 0.85,
          fallback: false,
          promptVersion: "1.0.1",
          model: "claude-haiku-4-5-20251001",
        },
      }),
    );
  });

  it("payload audit NE contient PAS reasoning/body/phone/tokens (defense-in-depth)", async () => {
    const ctx = makeFakeCtx({
      phone: "+33688889999",
      body: "Mon perso 0612345678 — pas intéressé",
      ovhMessageId: "ovh-secret-classifier-001",
    });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-clf-2")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-clf-2_camp-c",
        conversation: makeFakeConversation("hs-clf-2", "camp-c"),
      }),
      addInbound: vi.fn().mockResolvedValue("msgid-clf-2"),
      classifyReply: vi.fn().mockResolvedValue({
        intent: "OBJECTION",
        confidence: 0.88,
        reasoning: "PII-secret-reasoning-should-never-leak",
        fallback: false,
      }),
    });

    await processReplyHandler(ctx, deps);

    // Extraire spécifiquement l'appel `intent_classified`.
    const calls = (deps.appendAuditLog as ReturnType<typeof vi.fn>).mock.calls;
    const intentAuditCall = calls.find(
      (c) => (c[0] as { action: string }).action === "intent_classified",
    );
    expect(intentAuditCall).toBeDefined();
    const serialized = JSON.stringify(intentAuditCall);

    // Sentinelle anti-PII payload audit.
    expect(serialized).not.toContain("+33688889999");
    expect(serialized).not.toContain("688889999");
    expect(serialized).not.toContain("Mon perso");
    expect(serialized).not.toContain("0612345678");
    expect(serialized).not.toContain("ovh-secret-classifier-001");
    expect(serialized).not.toContain("PII-secret-reasoning-should-never-leak");
    // Q1 brief — tokens OMIS du payload (acceptable MVP).
    expect(serialized).not.toContain("tokensInput");
    expect(serialized).not.toContain("tokensOutput");
  });

  it("payload audit reply_processed NE contient PAS reasoning/body/phone (defense-in-depth S9.2.3)", async () => {
    // 🔒 Sentinelle CRITIQUE S9.2.3 — équivalente à la sentinelle
    // intent_classified ci-dessus, mais sur le NOUVEAU step 8
    // audit-reply-processed. Toute régression qui ferait fuiter
    // body/phone/ovhMessageId/reasoning Claude dans le payload final
    // doit casser ce test.
    const ctx = makeFakeCtx({
      phone: "+33688887777",
      body: "Mon perso 0612348888 — pas intéressé désolé",
      ovhMessageId: "ovh-secret-replyproc-001",
    });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-rp-leak")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-rp-leak_camp-r",
        conversation: makeFakeConversation("hs-rp-leak", "camp-r"),
      }),
      addInbound: vi.fn().mockResolvedValue("msgid-rp-leak"),
      classifyReply: vi.fn().mockResolvedValue({
        intent: "OBJECTION",
        confidence: 0.88,
        reasoning: "PII-reasoning-must-not-leak-into-reply-processed",
        fallback: false,
      }),
    });

    await processReplyHandler(ctx, deps);

    const calls = (deps.appendAuditLog as ReturnType<typeof vi.fn>).mock.calls;
    const replyProcessedCall = calls.find(
      (c) => (c[0] as { action: string }).action === "reply_processed",
    );
    expect(replyProcessedCall).toBeDefined();
    const serialized = JSON.stringify(replyProcessedCall);

    // Sentinelle anti-PII payload reply_processed (defense-in-depth).
    expect(serialized).not.toContain("+33688887777");
    expect(serialized).not.toContain("688887777");
    expect(serialized).not.toContain("Mon perso");
    expect(serialized).not.toContain("0612348888");
    expect(serialized).not.toContain("ovh-secret-replyproc-001");
    expect(serialized).not.toContain("PII-reasoning-must-not-leak-into-reply-processed");
    expect(serialized).not.toContain("reasoning");
    // Q1 brief — tokens OMIS du payload.
    expect(serialized).not.toContain("tokensInput");
    expect(serialized).not.toContain("tokensOutput");
    // Sentinelle positive : les champs scrubber-safe sont bien là.
    expect(serialized).toContain("hs-rp-leak");
    expect(serialized).toContain("hs-rp-leak_camp-r");
    expect(serialized).toContain("msgid-rp-leak");
    expect(serialized).toContain("OBJECTION");
    expect(serialized).toContain("classified");
    expect(serialized).toContain("in_dialogue");
    expect(serialized).toContain("pipelineDurationMs");
  });

  it("classifier fallback=true → logger.warn('classifier_fallback') posé", async () => {
    const ctx = makeFakeCtx({ body: "Bonjour" });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-fb-warn")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-fb-warn_camp-w",
        conversation: makeFakeConversation("hs-fb-warn", "camp-w"),
      }),
      addInbound: vi.fn().mockResolvedValue("msgid-fb-warn"),
      classifyReply: vi.fn().mockResolvedValue({
        intent: "STOP",
        confidence: 0,
        reasoning: "fallback: classifier failed, defaulting to STOP",
        fallback: true,
      }),
    });

    await processReplyHandler(ctx, deps);

    const warnCalls = (ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const fallbackWarn = warnCalls.find((c) => String(c[0]).includes("classifier_fallback"));
    expect(fallbackWarn).toBeDefined();
  });

  it("classifier fallback → audit intent_classified avec fallback: true (forensic)", async () => {
    const ctx = makeFakeCtx({ body: "Bonjour" });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-fb-aud")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-fb-aud_camp-w",
        conversation: makeFakeConversation("hs-fb-aud", "camp-w"),
      }),
      addInbound: vi.fn().mockResolvedValue("msgid-fb-aud"),
      classifyReply: vi.fn().mockResolvedValue({
        intent: "STOP",
        confidence: 0,
        reasoning: "fallback",
        fallback: true,
      }),
    });

    await processReplyHandler(ctx, deps);

    const calls = (deps.appendAuditLog as ReturnType<typeof vi.fn>).mock.calls;
    const intentAudit = calls.find(
      (c) => (c[0] as { action: string }).action === "intent_classified",
    );
    expect(intentAudit).toBeDefined();
    expect((intentAudit?.[0] as { payload: { fallback: boolean } }).payload.fallback).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 7 — branch-by-intent (4 branches)
// ─────────────────────────────────────────────────────────────────────────────

describe("Step 7 — branch-by-intent", () => {
  it("INTERESSE → setConversationIntent(convId, 'INTERESSE', {nextStatus: 'in_dialogue'}) + status classified", async () => {
    const ctx = makeFakeCtx({ body: "C'est combien ?" });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-i")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-i_camp-i",
        conversation: makeFakeConversation("hs-i", "camp-i"),
      }),
      addInbound: vi.fn().mockResolvedValue("msgid-i"),
      classifyReply: vi.fn().mockResolvedValue({
        intent: "INTERESSE",
        confidence: 0.9,
        reasoning: "demande tarif",
        fallback: false,
      }),
    });

    const result = await processReplyHandler(ctx, deps);

    // S9.3.3b — ProcessReplyResult.classified étendu avec draftMessageId.
    // toMatchObject (vs toEqual strict) car nouveau champ peut bouger.
    expect(result).toMatchObject({
      status: "classified",
      contactId: "hs-i",
      conversationId: "hs-i_camp-i",
      messageId: "msgid-i",
      intent: "INTERESSE",
    });
    if (result.status === "classified") {
      expect(result.draftMessageId).toBeDefined();
    }
    expect(deps.setConversationIntent).toHaveBeenCalledWith("hs-i_camp-i", "INTERESSE", {
      nextStatus: "in_dialogue",
    });
    expect(deps.markOptedOut).not.toHaveBeenCalled();

    // S9.2.3 — Step 8 audit-reply-processed posé en fin de branche.
    // classifierFallback: false présent car branche passée par Claude.
    expect(deps.appendAuditLog).toHaveBeenCalledWith({
      actorId: "system",
      actorType: "system",
      action: "reply_processed",
      targetType: "conversation",
      targetId: "hs-i_camp-i",
      payload: expect.objectContaining({
        contactId: "hs-i",
        conversationId: "hs-i_camp-i",
        messageId: "msgid-i",
        intent: "INTERESSE",
        branchTaken: "classified",
        finalConversationStatus: "in_dialogue",
        classifierFallback: false,
        pipelineDurationMs: expect.any(Number),
      }),
    });

    // S9.4.3 — Step 8d dispatch-reply-event émet l'event jumeau
    // medere/sms.reply.send-requested vers le handler send-reply.ts.
    // eventId déterministe `reply.send.${draftMessageId}` pour
    // déduplication 60s Inngest (defense-in-depth).
    const sendEventSpy = ctx.step.sendEvent as ReturnType<typeof vi.fn>;
    expect(sendEventSpy).toHaveBeenCalledTimes(1);
    expect(sendEventSpy).toHaveBeenCalledWith("dispatch-reply-event", {
      name: "medere/sms.reply.send-requested",
      data: {
        contactId: "hs-i",
        conversationId: "hs-i_camp-i",
        draftMessageId: expect.any(String),
      },
      id: expect.stringMatching(/^reply\.send\.[A-Za-z0-9]+$/),
    });
  });

  it("OBJECTION → setConversationIntent('OBJECTION', in_dialogue) + classified", async () => {
    const ctx = makeFakeCtx({ body: "Pas intéressé pour l'instant" });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-o")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-o_camp-o",
        conversation: makeFakeConversation("hs-o", "camp-o"),
      }),
      addInbound: vi.fn().mockResolvedValue("msgid-o"),
      classifyReply: vi.fn().mockResolvedValue({
        intent: "OBJECTION",
        confidence: 0.9,
        reasoning: "refus poli temporel",
        fallback: false,
      }),
    });

    const result = await processReplyHandler(ctx, deps);

    expect(result.status).toBe("classified");
    if (result.status === "classified") {
      expect(result.intent).toBe("OBJECTION");
    }
    expect(deps.setConversationIntent).toHaveBeenCalledWith("hs-o_camp-o", "OBJECTION", {
      nextStatus: "in_dialogue",
    });

    // S9.2.3 — Step 8 audit-reply-processed
    expect(deps.appendAuditLog).toHaveBeenCalledWith({
      actorId: "system",
      actorType: "system",
      action: "reply_processed",
      targetType: "conversation",
      targetId: "hs-o_camp-o",
      payload: expect.objectContaining({
        contactId: "hs-o",
        conversationId: "hs-o_camp-o",
        messageId: "msgid-o",
        intent: "OBJECTION",
        branchTaken: "classified",
        finalConversationStatus: "in_dialogue",
        classifierFallback: false,
        pipelineDurationMs: expect.any(Number),
      }),
    });

    // S9.4.3 — Step 8d dispatch-reply-event sur branche OBJECTION
    const sendEventSpyO = ctx.step.sendEvent as ReturnType<typeof vi.fn>;
    expect(sendEventSpyO).toHaveBeenCalledTimes(1);
    expect(sendEventSpyO).toHaveBeenCalledWith("dispatch-reply-event", {
      name: "medere/sms.reply.send-requested",
      data: {
        contactId: "hs-o",
        conversationId: "hs-o_camp-o",
        draftMessageId: expect.any(String),
      },
      id: expect.stringMatching(/^reply\.send\.[A-Za-z0-9]+$/),
    });
  });

  it("NEUTRE → setConversationIntent('NEUTRE', in_dialogue) + classified", async () => {
    const ctx = makeFakeCtx({ body: "OK" });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-n")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-n_camp-n",
        conversation: makeFakeConversation("hs-n", "camp-n"),
      }),
      addInbound: vi.fn().mockResolvedValue("msgid-n"),
      classifyReply: vi.fn().mockResolvedValue({
        intent: "NEUTRE",
        confidence: 0.7,
        reasoning: "accusé réception ambigu",
        fallback: false,
      }),
    });

    const result = await processReplyHandler(ctx, deps);

    expect(result.status).toBe("classified");
    if (result.status === "classified") {
      expect(result.intent).toBe("NEUTRE");
    }
    expect(deps.setConversationIntent).toHaveBeenCalledWith("hs-n_camp-n", "NEUTRE", {
      nextStatus: "in_dialogue",
    });

    // S9.2.3 — Step 8 audit-reply-processed
    expect(deps.appendAuditLog).toHaveBeenCalledWith({
      actorId: "system",
      actorType: "system",
      action: "reply_processed",
      targetType: "conversation",
      targetId: "hs-n_camp-n",
      payload: expect.objectContaining({
        contactId: "hs-n",
        conversationId: "hs-n_camp-n",
        messageId: "msgid-n",
        intent: "NEUTRE",
        branchTaken: "classified",
        finalConversationStatus: "in_dialogue",
        classifierFallback: false,
        pipelineDurationMs: expect.any(Number),
      }),
    });

    // S9.4.3 — Step 8d dispatch-reply-event sur branche NEUTRE
    const sendEventSpyN = ctx.step.sendEvent as ReturnType<typeof vi.fn>;
    expect(sendEventSpyN).toHaveBeenCalledTimes(1);
    expect(sendEventSpyN).toHaveBeenCalledWith("dispatch-reply-event", {
      name: "medere/sms.reply.send-requested",
      data: {
        contactId: "hs-n",
        conversationId: "hs-n_camp-n",
        draftMessageId: expect.any(String),
      },
      id: expect.stringMatching(/^reply\.send\.[A-Za-z0-9]+$/),
    });
  });

  it("STOP via classifier → markOptedOut ÉTENDU + status opt_out via=classifier_long_form", async () => {
    const ctx = makeFakeCtx({ body: "Foutez-moi la paix" });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-clf-stop-1")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-clf-stop-1_camp-x",
        conversation: makeFakeConversation("hs-clf-stop-1", "camp-x"),
      }),
      addInbound: vi.fn().mockResolvedValue("msgid-clf-stop-1"),
      // isOptOut=false : le short-form ne détecte pas (long-form ou nuance)
      isOptOut: vi.fn().mockReturnValue(false),
      classifyReply: vi.fn().mockResolvedValue({
        intent: "STOP",
        confidence: 0.95,
        reasoning: "hostilité = opt-out",
        fallback: false,
      }),
    });

    const result = await processReplyHandler(ctx, deps);

    expect(result).toEqual({
      status: "opt_out",
      contactId: "hs-clf-stop-1",
      conversationId: "hs-clf-stop-1_camp-x",
      messageId: "msgid-clf-stop-1",
      intent: "STOP",
      via: "classifier_long_form", // ← discriminant distinct du short-form
    });
    expect(deps.markOptedOut).toHaveBeenCalledWith("hs-clf-stop-1", "sms", {
      conversationId: "hs-clf-stop-1_camp-x",
      intent: "STOP",
    });
    expect(deps.setConversationIntent).not.toHaveBeenCalled();
    // S9.4.3 — sendEvent NON appelé sur branche STOP classifier_long_form
    // (le PS a dit stop via Claude, on respecte — pas de dispatch reply).
    expect(ctx.step.sendEvent).not.toHaveBeenCalled();

    // S9.2.3 — Step 8 audit-reply-processed sur branche classifier_long_form.
    // classifierFallback: false présent.
    expect(deps.appendAuditLog).toHaveBeenCalledWith({
      actorId: "system",
      actorType: "system",
      action: "reply_processed",
      targetType: "conversation",
      targetId: "hs-clf-stop-1_camp-x",
      payload: expect.objectContaining({
        contactId: "hs-clf-stop-1",
        conversationId: "hs-clf-stop-1_camp-x",
        messageId: "msgid-clf-stop-1",
        intent: "STOP",
        branchTaken: "opt_out_classifier_long_form",
        finalConversationStatus: "opted_out",
        classifierFallback: false,
        pipelineDurationMs: expect.any(Number),
      }),
    });
  });

  it("STORE-INBOUND avant classifier long-form opt-out (forensic L.34-5 CPCE — J1 compliance-auditor)", async () => {
    // 🔒 Sentinelle CRITIQUE — équivalente au "STORE-INBOUND avant
    // opt-out check" du step 5, étendue à la branche long-form du
    // classifier (step 7 STOP). Si quelqu'un déplace `store-inbound`
    // après `classify-intent`, le test casse et empêche la perte de
    // la preuve écrite L.34-5 CPCE pour les opt-out longs.
    const ctx = makeFakeCtx({
      body: "Bonjour, je préfère ne plus recevoir de messages, merci de me retirer.",
    });
    const callOrder: string[] = [];
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-ord-lf")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-ord-lf_camp-lf",
        conversation: makeFakeConversation("hs-ord-lf", "camp-lf"),
      }),
      addInbound: vi.fn().mockImplementation(async () => {
        callOrder.push("addInbound");
        return "msgid-ord-lf";
      }),
      isOptOut: vi.fn().mockReturnValue(false), // short-form ne détecte pas
      classifyReply: vi.fn().mockImplementation(async () => {
        callOrder.push("classifyReply");
        return {
          intent: "STOP",
          confidence: 0.9,
          reasoning: "demande retrait polie",
          fallback: false,
        };
      }),
      markOptedOut: vi.fn().mockImplementation(async () => {
        callOrder.push("markOptedOut");
      }),
    });

    await processReplyHandler(ctx, deps);

    // L'ordre exact : addInbound DOIT précéder classifyReply ET markOptedOut.
    expect(callOrder).toEqual(["addInbound", "classifyReply", "markOptedOut"]);
  });

  it("STOP via classifier — l'audit intent_classified est posé AVANT markOptedOut", async () => {
    const ctx = makeFakeCtx({ body: "Bonjour merci de me retirer de votre liste" });
    const callOrder: string[] = [];
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-ord-stop")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-ord-stop_camp-z",
        conversation: makeFakeConversation("hs-ord-stop", "camp-z"),
      }),
      addInbound: vi.fn().mockResolvedValue("msgid-ord-stop"),
      isOptOut: vi.fn().mockReturnValue(false),
      classifyReply: vi.fn().mockResolvedValue({
        intent: "STOP",
        confidence: 0.9,
        reasoning: "demande retrait explicite",
        fallback: false,
      }),
      appendAuditLog: vi.fn().mockImplementation(async (entry: { action: string }) => {
        if (entry.action === "intent_classified") {
          callOrder.push("audit:intent_classified");
        }
        return "audit-id";
      }),
      markOptedOut: vi.fn().mockImplementation(async () => {
        callOrder.push("markOptedOut");
      }),
    });

    await processReplyHandler(ctx, deps);

    // Sentinelle ordre forensic : on audit le verdict AVANT de l'appliquer.
    const intentIdx = callOrder.indexOf("audit:intent_classified");
    const markIdx = callOrder.indexOf("markOptedOut");
    expect(intentIdx).toBeGreaterThanOrEqual(0);
    expect(markIdx).toBeGreaterThan(intentIdx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 8 — generate-reply (S9.3.3b — sub-steps 8a/8b/8c)
// ─────────────────────────────────────────────────────────────────────────────

describe("Step 8 — generate-reply (S9.3.3b)", () => {
  it("happy path INTERESSE : listRecentMessages + generateReply + addOutboundDraft + audit reply_generated appelés", async () => {
    const ctx = makeFakeCtx({ body: "ça m'intéresse, c'est combien ?" });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-8a-1")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-8a-1_camp",
        conversation: makeFakeConversation("hs-8a-1", "camp"),
      }),
      addInbound: vi.fn().mockResolvedValue("msg-inbound-8a-1"),
      classifyReply: vi.fn().mockResolvedValue({
        intent: "INTERESSE",
        confidence: 0.9,
        reasoning: "ok",
        fallback: false,
      }),
    });

    const result = await processReplyHandler(ctx, deps);

    expect(result.status).toBe("classified");
    if (result.status === "classified") {
      expect(result.intent).toBe("INTERESSE");
      expect(result.draftMessageId).toBe("draftfirestoreid20ch");
    }

    // Sentinelle dispatch S9.3.3b
    expect(deps.listRecentMessages).toHaveBeenCalledWith("hs-8a-1_camp");
    expect(deps.generateReply).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "INTERESSE",
        rawMessage: "ça m'intéresse, c'est combien ?",
      }),
    );
    expect(deps.addOutboundDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: "hs-8a-1",
        conversationId: "hs-8a-1_camp",
        body: "Bonjour Docteur, quelle formation Médéré vous intéresse ?",
        aiModel: "claude-sonnet-4-6",
        aiPromptVersion: "1.0.0",
        aiTemperature: 0.5,
        aiTokensInput: 540,
        aiTokensOutput: 38,
        aiGenerationDurationMs: 1234,
      }),
    );

    // Audit reply_generated posé avec payload scrubber-safe (PAS de body).
    const replyGeneratedCall = (deps.appendAuditLog as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { action: string }).action === "reply_generated",
    );
    expect(replyGeneratedCall).toBeDefined();
    const auditEntry = replyGeneratedCall![0] as {
      action: string;
      targetType: string;
      targetId: string;
      payload: Record<string, unknown>;
    };
    expect(auditEntry.targetType).toBe("message");
    expect(auditEntry.targetId).toBe("draftfirestoreid20ch");
    expect(auditEntry.payload).toMatchObject({
      contactId: "hs-8a-1",
      conversationId: "hs-8a-1_camp",
      draftMessageId: "draftfirestoreid20ch",
      intent: "INTERESSE",
      promptVersion: "1.0.0",
      model: "claude-sonnet-4-6",
      temperature: 0.5,
      tokensInput: 540,
      tokensOutput: 38,
      bodyLength: expect.any(Number),
      generationDurationMs: 1234,
    });
    // 🚨 INVARIANT ANTI-PII (LOW-4 + NIT-1 compliance-auditor) : pas de body.
    expect(auditEntry.payload).not.toHaveProperty("body");
  });

  it("contactCivility passé undefined en MVP (S9.5-CONTACT-CIVILITY-IN-REPLY-001)", async () => {
    const ctx = makeFakeCtx({ body: "OK je vais voir" });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-civ")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-civ_camp",
        conversation: makeFakeConversation("hs-civ", "camp"),
      }),
      addInbound: vi.fn().mockResolvedValue("msg-civ"),
      classifyReply: vi.fn().mockResolvedValue({
        intent: "NEUTRE",
        confidence: 0.7,
        reasoning: "ok",
        fallback: false,
      }),
    });

    await processReplyHandler(ctx, deps);

    const generateReplyCall = (deps.generateReply as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as {
      contactCivility?: string;
    };
    // MVP : contactCivility absent du payload (Z arbitrage S9.3.3b — étape
    // 0 sous-question civilité, follow-up S9.5).
    expect(generateReplyCall.contactCivility).toBeUndefined();
  });

  it("payload reply_processed étendu avec draftMessageId sur branche classified", async () => {
    const ctx = makeFakeCtx({ body: "Trop cher !" });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-rp")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-rp_camp",
        conversation: makeFakeConversation("hs-rp", "camp"),
      }),
      addInbound: vi.fn().mockResolvedValue("msg-rp"),
      classifyReply: vi.fn().mockResolvedValue({
        intent: "OBJECTION",
        confidence: 0.85,
        reasoning: "ok",
        fallback: false,
      }),
      addOutboundDraft: vi.fn().mockResolvedValue("draft-rp-id20ch"),
    });

    await processReplyHandler(ctx, deps);

    const replyProcessedCall = (deps.appendAuditLog as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { action: string }).action === "reply_processed",
    );
    expect(replyProcessedCall).toBeDefined();
    const payload = (replyProcessedCall![0] as { payload: Record<string, unknown> }).payload;
    expect(payload).toMatchObject({
      branchTaken: "classified",
      draftMessageId: "draft-rp-id20ch",
    });
  });

  it("Branche STOP short-form : step 8 ENTIER skippé (no generateReply, no addOutboundDraft, no audit reply_generated)", async () => {
    const ctx = makeFakeCtx({ body: "STOP" });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-stop-sf")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-stop-sf_camp",
        conversation: makeFakeConversation("hs-stop-sf", "camp"),
      }),
      addInbound: vi.fn().mockResolvedValue("msg-stop-sf"),
      isOptOut: vi.fn().mockReturnValue(true),
    });

    const result = await processReplyHandler(ctx, deps);

    expect(result.status).toBe("opt_out");
    expect(deps.generateReply).not.toHaveBeenCalled();
    expect(deps.addOutboundDraft).not.toHaveBeenCalled();
    expect(deps.listRecentMessages).not.toHaveBeenCalled();
    // Pas de reply_generated dans les audits posés.
    const replyGeneratedCalls = (deps.appendAuditLog as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => (c[0] as { action: string }).action === "reply_generated",
    );
    expect(replyGeneratedCalls.length).toBe(0);
  });

  it("Branche STOP classifier_long_form : step 8 ENTIER skippé", async () => {
    const ctx = makeFakeCtx({
      body: "Je vous remercie mais je préfère ne plus recevoir de messages de votre part",
    });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-stop-lf")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-stop-lf_camp",
        conversation: makeFakeConversation("hs-stop-lf", "camp"),
      }),
      addInbound: vi.fn().mockResolvedValue("msg-stop-lf"),
      isOptOut: vi.fn().mockReturnValue(false),
      classifyReply: vi.fn().mockResolvedValue({
        intent: "STOP",
        confidence: 0.92,
        reasoning: "ok",
        fallback: false,
      }),
    });

    const result = await processReplyHandler(ctx, deps);

    expect(result.status).toBe("opt_out");
    if (result.status === "opt_out") {
      expect(result.via).toBe("classifier_long_form");
    }
    expect(deps.generateReply).not.toHaveBeenCalled();
    expect(deps.addOutboundDraft).not.toHaveBeenCalled();
  });

  it("Step 8a generateReply throw ExternalServiceError → propagé, step 8b/8c PAS exécutés", async () => {
    // 🔒 Sentinelle pas de fallback artificiel — décision Déthié S9.3.0.
    // Inngest retry naturel (ExternalServiceError noRetry=false).
    const sdkErr = new ExternalServiceError({
      message: "Anthropic API connection failure",
      context: { kind: "APIConnectionError" },
    });
    const ctx = makeFakeCtx({ body: "ça m'intéresse" });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-8a-err")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-8a-err_camp",
        conversation: makeFakeConversation("hs-8a-err", "camp"),
      }),
      addInbound: vi.fn().mockResolvedValue("msg-8a-err"),
      generateReply: vi.fn().mockRejectedValue(sdkErr),
    });

    await expect(processReplyHandler(ctx, deps)).rejects.toBe(sdkErr);

    expect(deps.generateReply).toHaveBeenCalledTimes(1);
    expect(deps.addOutboundDraft).not.toHaveBeenCalled();
    // Pas d'audit reply_generated ni reply_processed posé.
    const auditActions = (deps.appendAuditLog as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as { action: string }).action,
    );
    expect(auditActions).not.toContain("reply_generated");
    expect(auditActions).not.toContain("reply_processed");
  });

  it("Step 8b addOutboundDraft throw → propagé, step 8c PAS exécuté", async () => {
    const ctx = makeFakeCtx({ body: "Trop cher !" });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-8b-err")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-8b-err_camp",
        conversation: makeFakeConversation("hs-8b-err", "camp"),
      }),
      addInbound: vi.fn().mockResolvedValue("msg-8b-err"),
      classifyReply: vi.fn().mockResolvedValue({
        intent: "OBJECTION",
        confidence: 0.85,
        reasoning: "ok",
        fallback: false,
      }),
      addOutboundDraft: vi.fn().mockRejectedValue(new Error("Firestore 5xx")),
    });

    await expect(processReplyHandler(ctx, deps)).rejects.toThrow("Firestore 5xx");

    expect(deps.generateReply).toHaveBeenCalledTimes(1);
    expect(deps.addOutboundDraft).toHaveBeenCalledTimes(1);
    // Pas d'audit reply_generated ni reply_processed posé.
    const auditActions = (deps.appendAuditLog as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as { action: string }).action,
    );
    expect(auditActions).not.toContain("reply_generated");
    expect(auditActions).not.toContain("reply_processed");
  });

  it("ProcessReplyResult.classified expose draftMessageId (typage strict)", async () => {
    const ctx = makeFakeCtx({ body: "OK je vais voir" });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-typed")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-typed_camp",
        conversation: makeFakeConversation("hs-typed", "camp"),
      }),
      addInbound: vi.fn().mockResolvedValue("msg-typed"),
      classifyReply: vi.fn().mockResolvedValue({
        intent: "NEUTRE",
        confidence: 0.7,
        reasoning: "ok",
        fallback: false,
      }),
      addOutboundDraft: vi.fn().mockResolvedValue("draft-typed-id"),
    });

    const result = await processReplyHandler(ctx, deps);

    expect(result.status).toBe("classified");
    if (result.status === "classified") {
      // TS narrow : draftMessageId est un champ requis du variant.
      expect(result.draftMessageId).toBe("draft-typed-id");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔒 GUARD-001 — sentinelle anti-régression CRITIQUE
// Long-form opt-out rattrapé par classifier
// ─────────────────────────────────────────────────────────────────────────────

describe("🔒 GUARD-001 — long-form opt-out rattrapé par classifier (anti-régression CRITIQUE)", () => {
  it("body >50 chars sans keyword STOP + classifier intent=STOP → branche STOP empruntée", async () => {
    // 🔒 Sentinelle CRITIQUE compliance L.34-5 CPCE (sanction CNIL 20 M€) :
    // un PS qui écrit une demande d'arrêt longue, polie, sans mot-clé
    // STOP/ARRET DOIT être traité comme un opt-out. C'est le rôle du
    // classifier Claude (S7a.2). Le pipeline S9.2.2 doit emprunter la
    // branche STOP via classifier_long_form.
    const LONG_FORM_OPT_OUT =
      "Arrêtez de me déranger je ne suis vraiment pas intéressé par cette formation merci";
    expect(LONG_FORM_OPT_OUT.length).toBeGreaterThan(50);

    // Sentinelle setup : isOptOut() court-form DOIT retourner false sur
    // cet input (sinon le test ne stresse pas GUARD-001).
    // On mock isOptOut=false explicitement pour ne pas dépendre de
    // l'implémentation réelle (testée séparément).
    const ctx = makeFakeCtx({ body: LONG_FORM_OPT_OUT });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-guard001")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-guard001_camp-g",
        conversation: makeFakeConversation("hs-guard001", "camp-g"),
      }),
      addInbound: vi.fn().mockResolvedValue("msgid-guard001"),
      isOptOut: vi.fn().mockReturnValue(false), // ← rattrapé par classifier
      classifyReply: vi.fn().mockResolvedValue({
        intent: "STOP",
        confidence: 0.92,
        reasoning: "demande arrêt explicite polie",
        fallback: false,
      }),
    });

    const result = await processReplyHandler(ctx, deps);

    // Sentinelle 1 — verdict
    expect(result).toEqual({
      status: "opt_out",
      contactId: "hs-guard001",
      conversationId: "hs-guard001_camp-g",
      messageId: "msgid-guard001",
      intent: "STOP",
      via: "classifier_long_form",
    });

    // Sentinelle 2 — markOptedOut étendu appelé avec conversationId
    expect(deps.markOptedOut).toHaveBeenCalledWith("hs-guard001", "sms", {
      conversationId: "hs-guard001_camp-g",
      intent: "STOP",
    });

    // Sentinelle 3 — le classifier a bien été appelé
    expect(deps.classifyReply).toHaveBeenCalledWith(LONG_FORM_OPT_OUT);

    // Sentinelle 4 — audit intent_classified posé avec intent=STOP
    expect(deps.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "intent_classified",
        payload: expect.objectContaining({ intent: "STOP", fallback: false }),
      }),
    );

    // Sentinelle 5 — S9.2.3 : audit reply_processed posé en fin de pipeline
    // sur la branche classifier_long_form. Verrouille bout-en-bout le
    // forensic L.34-5 CPCE pour les opt-out longs rattrapés par Claude.
    expect(deps.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "reply_processed",
        targetType: "conversation",
        targetId: "hs-guard001_camp-g",
        payload: expect.objectContaining({
          intent: "STOP",
          branchTaken: "opt_out_classifier_long_form",
          finalConversationStatus: "opted_out",
          classifierFallback: false,
        }),
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ordre des steps — sentinelle invocation
// ─────────────────────────────────────────────────────────────────────────────

describe("Ordre invocation steps (sentinelle pipeline)", () => {
  it("intent non-STOP : steps 1→2→3→4→5(no-op)→6→7 dans l'ordre", async () => {
    const callOrder: string[] = [];
    const ctx = makeFakeCtx({ body: "OK je vais voir" });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockImplementation(async () => {
        callOrder.push("1:resolve-contact");
        return makeFakeContact("hs-ord");
      }),
      getActiveConversationByContactId: vi.fn().mockImplementation(async () => {
        callOrder.push("2:resolve-conversation");
        return {
          conversationId: "hs-ord_camp-o",
          conversation: makeFakeConversation("hs-ord", "camp-o"),
        };
      }),
      findInboundByExternalId: vi.fn().mockImplementation(async () => {
        callOrder.push("3:dedup");
        return null;
      }),
      addInbound: vi.fn().mockImplementation(async () => {
        callOrder.push("4:store-inbound");
        return "msgid-ord";
      }),
      isOptOut: vi.fn().mockImplementation(() => {
        callOrder.push("5:isOptOut(false)");
        return false;
      }),
      classifyReply: vi.fn().mockImplementation(async () => {
        callOrder.push("6:classify-intent");
        return {
          intent: "NEUTRE",
          confidence: 0.7,
          reasoning: "ambigu",
          fallback: false,
        };
      }),
      setConversationIntent: vi.fn().mockImplementation(async () => {
        callOrder.push("7:setConversationIntent");
      }),
    });

    await processReplyHandler(ctx, deps);

    expect(callOrder).toEqual([
      "1:resolve-contact",
      "2:resolve-conversation",
      "3:dedup",
      "4:store-inbound",
      "5:isOptOut(false)",
      "6:classify-intent",
      "7:setConversationIntent",
    ]);
  });

  it("STOP short-form : steps 1→2→3→4→5(STOP) ; 6+7 PAS appelés (économie Claude)", async () => {
    const callOrder: string[] = [];
    const ctx = makeFakeCtx({ body: "STOP" });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockImplementation(async () => {
        callOrder.push("1");
        return makeFakeContact("hs-ord-sf");
      }),
      getActiveConversationByContactId: vi.fn().mockImplementation(async () => {
        callOrder.push("2");
        return {
          conversationId: "hs-ord-sf_camp-s",
          conversation: makeFakeConversation("hs-ord-sf", "camp-s"),
        };
      }),
      findInboundByExternalId: vi.fn().mockImplementation(async () => {
        callOrder.push("3");
        return null;
      }),
      addInbound: vi.fn().mockImplementation(async () => {
        callOrder.push("4");
        return "msgid-ord-sf";
      }),
      isOptOut: vi.fn().mockImplementation(() => {
        callOrder.push("5");
        return true;
      }),
      markOptedOut: vi.fn().mockImplementation(async () => {
        callOrder.push("5-markOptedOut");
      }),
      classifyReply: vi.fn().mockImplementation(async () => {
        callOrder.push("6-SHOULD-NOT-RUN");
        return {
          intent: "INTERESSE",
          confidence: 0,
          reasoning: "",
          fallback: false,
        };
      }),
      setConversationIntent: vi.fn().mockImplementation(async () => {
        callOrder.push("7-SHOULD-NOT-RUN");
      }),
    });

    await processReplyHandler(ctx, deps);

    expect(callOrder).toEqual(["1", "2", "3", "4", "5", "5-markOptedOut"]);
    expect(callOrder).not.toContain("6-SHOULD-NOT-RUN");
    expect(callOrder).not.toContain("7-SHOULD-NOT-RUN");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sentinelle anti-PII — pipeline complet
// ─────────────────────────────────────────────────────────────────────────────

describe("Anti-PII pipeline complet (sentinelle critique L.34-5 CPCE)", () => {
  /**
   * 🔒 Sentinelle CRITIQUE — étendue S9.2.2 aux 7 steps.
   * Vérifie qu'AUCUN champ PII (phone, body, ovhMessageId, reasoning
   * classifier) n'apparaît dans AUCUN appel logger sur AUCUNE branche.
   * Si quelqu'un ajoute par mégarde `phone`/`body`/`reasoning` dans un
   * `logger.X(...)`, ce test casse — c'est l'objectif explicite.
   */
  const SECRET_PHONE = "+33687654321";
  const SECRET_BODY = "Mon numéro perso est 0612345678";
  const SECRET_OVH_MSGID = "ovh-secret-id-XYZ123";
  // S9.2.2 — reasoning Claude pour stress-test fuite : contient un
  // patronyme + une ville (semi-identifiants). Le prompt classifier
  // interdit ces éléments, mais defense-in-depth : si pour une raison
  // X le pipeline forwardait le reasoning vers logs/audit, ce test
  // casse.
  const SECRET_REASONING = "Dr Dupont à Lyon — refus poli explicite";
  // S9.3.3b — fix MED-2 security-reviewer + LOW-3 compliance-auditor :
  // body DRAFT généré par Claude qui aurait MIROIRÉ une PII du PS (cas
  // pathologique mais possible). Le code production NE log PAS ce body
  // au step 8c "reply draft stored" (vérifié par security-reviewer),
  // mais defense-in-depth : si quelqu'un ajoute par mégarde
  // `body: generationResult.body` dans `logger.info`, ce stress-test
  // casse → forcera la régression à devenir explicite.
  const SECRET_DRAFT_BODY = "Bonjour Médéré, j'ai vu votre numéro +33799887766 pour le rappel.";

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
    // S9.2.2 — reasoning Claude ne doit jamais apparaître.
    expect(serialized).not.toContain(SECRET_REASONING);
    expect(serialized).not.toContain("Dr Dupont");
    expect(serialized).not.toContain("Lyon");
    // S9.3.3b — draft body avec PII miroirée ne doit jamais apparaître.
    expect(serialized).not.toContain(SECRET_DRAFT_BODY);
    expect(serialized).not.toContain("+33799887766");
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

  it("branche classified — aucune fuite (phone/body/ovh/reasoning/draft body)", async () => {
    // S9.2.2 — pipeline va jusqu'au classifier + branch-by-intent.
    // Mock reasoning enrichi pour stress-test : Dr Dupont à Lyon ne
    // doit jamais arriver dans les logs même si Claude le posait
    // (defense-in-depth contre une régression prompt classifier).
    //
    // S9.3.3b fix MED-2 security-reviewer + LOW-3 compliance-auditor :
    // pipeline va aussi jusqu'aux sub-steps 8a/8b/8c. Mock generateReply
    // override avec SECRET_DRAFT_BODY (body LLM qui miroir un E.164
    // pathologique) → vérifie que le `logger.info "reply draft stored"`
    // step 8c (process-reply.ts:920-928) ne forward jamais
    // `generationResult.body` dans les logs.
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
      classifyReply: vi.fn().mockResolvedValue({
        intent: "INTERESSE",
        confidence: 0.85,
        reasoning: SECRET_REASONING, // ← stress reasoning leak
        fallback: false,
      }),
      // S9.3.3b — body LLM contenant un E.164 miroirée. Le code prod
      // log uniquement IDs opaques au step 8c — assertNoLeak verrouille
      // que ce body ne fuit JAMAIS dans les logs, même si Claude
      // mirroir une PII du PS.
      generateReply: vi.fn().mockResolvedValue({
        body: SECRET_DRAFT_BODY,
        promptVersion: "1.0.0",
        model: "claude-sonnet-4-6",
        temperature: 0.5,
        tokensInput: 540,
        tokensOutput: 38,
        generationDurationMs: 1234,
      }),
    });
    await processReplyHandler(ctx, deps);
    assertNoLeak(ctx.logger);
  });

  it("branche classifier_long_form opt_out — aucune fuite reasoning STOP", async () => {
    // S9.2.2 — branche STOP rattrapé par classifier. Le reasoning
    // Claude (e.g. "Dr Dupont à Lyon refus explicite") ne doit jamais
    // remonter dans les logs, même si le fallback warn est posé.
    const ctx = makeFakeCtx({
      phone: SECRET_PHONE,
      body:
        "Je vous remercie mais je préfère ne plus recevoir de messages de votre part — " +
        SECRET_BODY,
      ovhMessageId: SECRET_OVH_MSGID,
    });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-clf-stop")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-clf-stop_camp-x",
        conversation: makeFakeConversation("hs-clf-stop", "camp-x"),
      }),
      isOptOut: vi.fn().mockReturnValue(false), // long-form échappe au short-form
      classifyReply: vi.fn().mockResolvedValue({
        intent: "STOP",
        confidence: 0.92,
        reasoning: SECRET_REASONING,
        fallback: false,
      }),
    });
    await processReplyHandler(ctx, deps);
    assertNoLeak(ctx.logger);
  });

  it("branche classifier fallback STOP — aucune fuite même sur log warn", async () => {
    // S9.2.2 — fallback=true déclenche logger.warn("classifier_fallback").
    // Le warn ne doit contenir AUCUNE PII (ni phone, ni body, ni reasoning).
    const ctx = makeFakeCtx({
      phone: SECRET_PHONE,
      body: SECRET_BODY,
      ovhMessageId: SECRET_OVH_MSGID,
    });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-fb")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-fb_camp-f",
        conversation: makeFakeConversation("hs-fb", "camp-f"),
      }),
      isOptOut: vi.fn().mockReturnValue(false),
      classifyReply: vi.fn().mockResolvedValue({
        intent: "STOP",
        confidence: 0,
        reasoning: SECRET_REASONING,
        fallback: true,
      }),
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

// ─────────────────────────────────────────────────────────────────────────────
// S9.4.3 — Sentinelles anti-PII dispatch-reply-event (step 8d)
//
// 🔒 Verrouille les invariants de l'émission d'event jumeau vers
// send-reply.ts (S9.4.2) :
//   - event.id format strict `reply.send.${draftMessageId}` —
//     scrubber-safe par construction (draftMessageId = Firestore auto-ID
//     `[A-Za-z0-9]{20}`)
//   - event.data minimaliste {contactId, conversationId, draftMessageId} —
//     pas de body/phone/intent/ovhMessageId
//   - event name figé `medere/sms.reply.send-requested`
// ─────────────────────────────────────────────────────────────────────────────

describe("S9.4.3 — sentinelles anti-PII dispatch-reply-event", () => {
  it("event.id format strict /^reply\\.send\\.[A-Za-z0-9]+$/ + absence PII (phone/email)", async () => {
    const ctx = makeFakeCtx({ body: "Je suis intéressé" });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-sentinel-id")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-sentinel-id_camp-si",
        conversation: makeFakeConversation("hs-sentinel-id", "camp-si"),
      }),
      addInbound: vi.fn().mockResolvedValue("msgid-sentinel-id"),
      classifyReply: vi.fn().mockResolvedValue({
        intent: "INTERESSE",
        confidence: 0.9,
        reasoning: "tarif demandé",
        fallback: false,
      }),
    });

    await processReplyHandler(ctx, deps);

    const sendEventSpy = ctx.step.sendEvent as ReturnType<typeof vi.fn>;
    expect(sendEventSpy).toHaveBeenCalledTimes(1);

    const callArgs = sendEventSpy.mock.calls[0];
    expect(callArgs).toBeDefined();
    // callArgs[1] = payload { name, data, id }
    const payload = callArgs![1] as { name: string; data: unknown; id: string };

    // Format strict scrubber-safe.
    expect(payload.id).toMatch(/^reply\.send\.[A-Za-z0-9]+$/);

    // Aucune PII dans event.id (defense-in-depth contre fuite Inngest cloud).
    expect(payload.id).not.toMatch(/\+33\d{9}/); // E.164 FR
    expect(payload.id).not.toMatch(/0[1-9]\d{8}/); // FR national
    expect(payload.id).not.toMatch(/\S+@\S+\.\S+/); // email
    // ovhMessageId NE DOIT PAS apparaître (semi-sensible cf. messages.ts:36-54).
    expect(payload.id).not.toContain("ovh-msg-789");
  });

  it("event.data minimaliste : uniquement {contactId, conversationId, draftMessageId}", async () => {
    const ctx = makeFakeCtx({ body: "Pas dispo" });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-sentinel-data")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-sentinel-data_camp-sd",
        conversation: makeFakeConversation("hs-sentinel-data", "camp-sd"),
      }),
      addInbound: vi.fn().mockResolvedValue("msgid-sentinel-data"),
      classifyReply: vi.fn().mockResolvedValue({
        intent: "OBJECTION",
        confidence: 0.8,
        reasoning: "report poli",
        fallback: false,
      }),
    });

    await processReplyHandler(ctx, deps);

    const sendEventSpy = ctx.step.sendEvent as ReturnType<typeof vi.fn>;
    const payload = sendEventSpy.mock.calls[0]![1] as {
      name: string;
      data: Record<string, unknown>;
      id: string;
    };

    // Exactement 3 clés dans data (anti-bypass : pas de champ en plus).
    expect(Object.keys(payload.data).sort()).toEqual([
      "contactId",
      "conversationId",
      "draftMessageId",
    ]);

    // Aucun champ PII attendu.
    expect(payload.data).not.toHaveProperty("phone");
    expect(payload.data).not.toHaveProperty("body");
    expect(payload.data).not.toHaveProperty("email");
    expect(payload.data).not.toHaveProperty("ovhMessageId");
    expect(payload.data).not.toHaveProperty("intent");
    expect(payload.data).not.toHaveProperty("reasoning");

    // Pas de PII brute dans les valeurs sérialisées.
    const serializedData = JSON.stringify(payload.data);
    expect(serializedData).not.toMatch(/\+33\d{9}/);
    expect(serializedData).not.toMatch(/0[1-9]\d{8}/);
    expect(serializedData).not.toMatch(/\S+@\S+\.\S+/);
  });

  it("event name figé 'medere/sms.reply.send-requested' (sentinelle anti-drift)", async () => {
    // Si quelqu'un renomme l'event côté events.ts SANS amender ce test,
    // le test casse. Force la cohérence émetteur (process-reply.ts) ↔
    // schema (events.ts) ↔ handler (send-reply.ts S9.4.2).
    const ctx = makeFakeCtx({ body: "OK noté" });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-sentinel-name")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-sentinel-name_camp-sn",
        conversation: makeFakeConversation("hs-sentinel-name", "camp-sn"),
      }),
      addInbound: vi.fn().mockResolvedValue("msgid-sentinel-name"),
      classifyReply: vi.fn().mockResolvedValue({
        intent: "NEUTRE",
        confidence: 0.6,
        reasoning: "accusé réception",
        fallback: false,
      }),
    });

    await processReplyHandler(ctx, deps);

    const sendEventSpy = ctx.step.sendEvent as ReturnType<typeof vi.fn>;
    const payload = sendEventSpy.mock.calls[0]![1] as { name: string };
    expect(payload.name).toBe("medere/sms.reply.send-requested");
  });

  it("step nommé 'dispatch-reply-event' (sentinelle anti-drift step name)", async () => {
    // Force la stabilité du nom du step (utilisé pour la memoization
    // Inngest par eventId,stepName et pour expectedSteps des tests
    // memoization).
    const ctx = makeFakeCtx({ body: "intéressant à creuser" });
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-sentinel-step")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-sentinel-step_camp-st",
        conversation: makeFakeConversation("hs-sentinel-step", "camp-st"),
      }),
      addInbound: vi.fn().mockResolvedValue("msgid-sentinel-step"),
      classifyReply: vi.fn().mockResolvedValue({
        intent: "INTERESSE",
        confidence: 0.85,
        reasoning: "curiosité",
        fallback: false,
      }),
    });

    await processReplyHandler(ctx, deps);

    const sendEventSpy = ctx.step.sendEvent as ReturnType<typeof vi.fn>;
    const stepName = sendEventSpy.mock.calls[0]![0] as string;
    expect(stepName).toBe("dispatch-reply-event");
  });
});
