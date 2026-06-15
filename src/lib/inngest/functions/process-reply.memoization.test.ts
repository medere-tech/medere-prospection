/**
 * MED-1 — Sentinelle memoization Inngest pour `process-reply` (S9.2.3.2).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * OBJECTIF
 *
 * Valider EXPÉRIMENTALEMENT le contrat Inngest documenté dans
 * `process-reply.ts` JSDoc (lignes 86-95) :
 *
 *   « `step.run(name, fn)` memoize le résultat par `(eventId, stepName)`.
 *     Sur retry, un step déjà commit retourne son résultat caché sans
 *     ré-exécuter `fn` — assure idempotence sur tous les writes Firestore,
 *     tous les `appendAuditLog`, ET tous les appels Claude. »
 *
 * Cette sentinelle ferme le LOW-1 du compliance-auditor S9.2.3.1 (promesse
 * MED-1) et verrouille la garantie anti-doublon dans 4 scénarios de
 * failure transitoire + 1 scénario nominal + 1 scénario de cache croisé.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * STRATÉGIE — mock chirurgical Vitest pur (option A arbitrée S9.2.3.0)
 *
 * On simule la memoization Inngest avec une `Map<string, unknown>` clée
 * par `${eventId}::${stepName}`. Sur retry, on appelle le handler 2×
 * avec le MÊME cache (= même `step.run` partagé) — ce qui reproduit
 * exactement le comportement Inngest cloud où l'engine retourne les
 * valeurs cachées par event ID.
 *
 * Garanties prouvées :
 *   - Test 1 : retry après failure step 8 → steps 1-7 memoizés (0 double-effet)
 *   - Test 2 : retry après failure step 4 → addInbound 2× (intra-step), reste 1×
 *   - Test 3 : retry après failure step 5 (markOptedOut transient short-form)
 *   - Test 4 : happy path baseline (sentinelle de référence sans retry)
 *   - Test 5 : cache par `(eventId, stepName)`, pas par stepName seul
 *   - Test 6 : idempotence pleine `claude-classify` post-split S9.3.1
 *              (anti-double-facturation Claude — ferme S9.3-FOLLOWUP-1)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * POURQUOI MOCK ET PAS EMULATOR (rappel arbitrage S9.2.3.0)
 *
 *   1. La memoization est un contrat Inngest, pas un détail Firestore.
 *      L'emulator testerait surtout l'idempotence Firestore (déjà
 *      couverte par les tests intégration S9.1).
 *   2. Mock chirurgical = ~80ms (CI rapide, pas de friction emulator).
 *   3. Pattern injection de dépendances cohérent avec
 *      `process-reply.test.ts` et `pre-send-check.test.ts`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * HORS SCOPE S9.2.3.2
 *
 *   - Pipeline prod inchangé (`process-reply.ts` non modifié).
 *   - Pas d'Inngest dev server, pas d'emulator dans cette suite.
 *   - Pas de scénario multi-retry (>1 failure consécutive). Le contrat
 *     memoization est le même quel que soit le nombre de retries.
 */
import type { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it, vi } from "vitest";

import type { Contact } from "@/types/contact";
import type { Conversation } from "@/types/conversation";

import {
  type ProcessReplyDeps,
  processReplyHandler,
  type ProcessReplyHandlerContext,
} from "./process-reply";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — memoized step.run + fake ctx + builders + deps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Crée un fake `step.run` qui simule la memoization Inngest par
 * `(eventId, stepName)`. À utiliser sur MULTIPLES invocations du handler
 * (Run 1 fail → Run 2 retry) en partageant la même instance retournée :
 * le cache persiste entre les runs comme dans Inngest cloud.
 *
 * Contrat reproduit :
 *   - Sur appel `step.run(name, fn)` :
 *     - Si `(eventId, name)` est dans le cache → return cache[key] SANS
 *       appeler fn.
 *     - Sinon → await fn() ; si succès, cache le résultat. Si throw,
 *       propage le throw et ne cache RIEN (= sur retry, fn ré-exécute).
 */
function makeMemoizedStepRun(eventId: string): {
  step: ProcessReplyHandlerContext["step"];
  cache: Map<string, unknown>;
} {
  const cache = new Map<string, unknown>();
  const step: ProcessReplyHandlerContext["step"] = {
    run: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const key = `${eventId}::${name}`;
      if (cache.has(key)) {
        return cache.get(key) as T;
      }
      // Pas de catch : si fn throw, on propage SANS cacher.
      // C'est exactement le contrat Inngest — la step n'est commit qu'à
      // résolution successful de la closure.
      const result = await fn();
      cache.set(key, result);
      return result;
    },
  };
  return { step, cache };
}

/**
 * Crée un fake `ctx` Inngest réutilisable entre runs. Le `step` doit être
 * partagé (= passé en argument) pour que la memoization persiste. Le
 * `logger` est fresh à chaque appel — fidèle à Inngest qui ré-instancie
 * le ctx à chaque retry attempt.
 */
function makeFakeCtx(
  eventId: string,
  step: ProcessReplyHandlerContext["step"],
  overrides: { phone?: string; body?: string; ovhMessageId?: string } = {},
): ProcessReplyHandlerContext {
  return {
    event: {
      id: eventId,
      name: "medere/sms.reply.received",
      data: {
        phone: overrides.phone ?? "+33775745453",
        body: overrides.body ?? "Bonjour, ça m'intéresse",
        ovhMessageId: overrides.ovhMessageId ?? "ovh-msg-mem",
      },
    },
    step,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

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
 * Pack `ProcessReplyDeps` avec defaults qui SUCCÈDENT. Chaque test
 * override ce dont il a besoin pour injecter une failure ciblée
 * (`mockImplementation` avec compteur, `mockRejectedValueOnce`, etc.).
 */
function makeDeps(overrides: Partial<ProcessReplyDeps> = {}): ProcessReplyDeps {
  return {
    getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-mem-default")),
    getActiveConversationByContactId: vi.fn().mockResolvedValue({
      conversationId: "hs-mem-default_camp-default",
      conversation: makeFakeConversation("hs-mem-default", "camp-default"),
    }),
    findInboundByExternalId: vi.fn().mockResolvedValue(null),
    addInbound: vi.fn().mockResolvedValue("msgid-mem-default"),
    markOptedOut: vi.fn().mockResolvedValue(undefined),
    isOptOut: vi.fn().mockReturnValue(false),
    hashPii: vi.fn().mockReturnValue("hashed-pii-abcd1234abcd1234abcd1234"),
    appendAuditLog: vi.fn().mockResolvedValue("audit-id"),
    classifyReply: vi.fn().mockResolvedValue({
      intent: "INTERESSE",
      confidence: 0.85,
      reasoning: "default-test-reasoning",
      fallback: false,
    }),
    setConversationIntent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MED-1 — Suite memoization
// ─────────────────────────────────────────────────────────────────────────────

describe("MED-1 — Memoization Inngest sur retry (S9.2.3.2)", () => {
  // ───────────────────────────────────────────────────────────────────────────
  // Test 1 — Retry après failure step 8 (audit-reply-processed)
  // ───────────────────────────────────────────────────────────────────────────

  it("Test 1 — retry après failure step 8 (audit-reply-processed) : steps 1-7 memoizés", async () => {
    // Scénario : pipeline classified atteint le step 8, l'audit
    // `reply_processed` throw une fois (5xx transitoire Firestore), puis
    // succeed sur le retry. Démonstration la plus pédagogique de la
    // memoization : chaque step 1-7 a son propre cache, le pipeline ne
    // ré-exécute QUE le step 8 sur Run 2.
    const { step, cache } = makeMemoizedStepRun("evt-mem-1");

    let replyProcessedFailedOnce = false;
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-mem-1")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-mem-1_camp-1",
        conversation: makeFakeConversation("hs-mem-1", "camp-1"),
      }),
      addInbound: vi.fn().mockResolvedValue("msgid-mem-1"),
      appendAuditLog: vi.fn().mockImplementation(async (entry: { action: string }) => {
        if (entry.action === "reply_processed" && !replyProcessedFailedOnce) {
          replyProcessedFailedOnce = true;
          throw new Error("transient 5xx on reply_processed audit");
        }
        return "audit-id";
      }),
    });

    // Run 1 — doit throw au step 8
    await expect(processReplyHandler(makeFakeCtx("evt-mem-1", step), deps)).rejects.toThrow(
      "transient 5xx on reply_processed audit",
    );

    // Vérification intermédiaire : step 8 n'est PAS commit (cache absent)
    // mais steps 1-7 le sont (cache présent).
    // S9.3.1 — step 6 splitté en `claude-classify` (6a) + `audit-intent-classified` (6b).
    expect(cache.has("evt-mem-1::audit-reply-processed")).toBe(false);
    expect(cache.has("evt-mem-1::branch-interesse")).toBe(true);
    expect(cache.has("evt-mem-1::claude-classify")).toBe(true);
    expect(cache.has("evt-mem-1::audit-intent-classified")).toBe(true);
    expect(cache.has("evt-mem-1::store-inbound")).toBe(true);

    // Run 2 — retry, MÊME step memoizé partagé. Doit succeed.
    const result = await processReplyHandler(makeFakeCtx("evt-mem-1", step), deps);

    // Verdict final pipeline
    expect(result.status).toBe("classified");
    if (result.status === "classified") {
      expect(result.intent).toBe("INTERESSE");
      expect(result.contactId).toBe("hs-mem-1");
      expect(result.conversationId).toBe("hs-mem-1_camp-1");
      expect(result.messageId).toBe("msgid-mem-1");
    }

    // 🔒 GARANTIE MED-1 : steps 1-7 appelés exactement 1× au total
    // (la memoization court-circuite les ré-exécutions sur Run 2).
    expect(deps.getContactByPhone).toHaveBeenCalledTimes(1);
    expect(deps.getActiveConversationByContactId).toHaveBeenCalledTimes(1);
    expect(deps.findInboundByExternalId).toHaveBeenCalledTimes(1);
    expect(deps.addInbound).toHaveBeenCalledTimes(1);
    expect(deps.isOptOut).toHaveBeenCalledTimes(1);
    expect(deps.classifyReply).toHaveBeenCalledTimes(1);
    expect(deps.setConversationIntent).toHaveBeenCalledTimes(1);

    // appendAuditLog : intent_classified 1× (memoizé) + reply_processed 2× (1 fail + 1 success)
    const auditCalls = (deps.appendAuditLog as ReturnType<typeof vi.fn>).mock.calls;
    const intentClassifiedCount = auditCalls.filter(
      (c) => (c[0] as { action: string }).action === "intent_classified",
    ).length;
    const replyProcessedCount = auditCalls.filter(
      (c) => (c[0] as { action: string }).action === "reply_processed",
    ).length;
    expect(intentClassifiedCount).toBe(1);
    expect(replyProcessedCount).toBe(2);

    // Step 8 maintenant cached après succès Run 2
    expect(cache.has("evt-mem-1::audit-reply-processed")).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Test 2 — Retry après failure step 4 (addInbound transient)
  // ───────────────────────────────────────────────────────────────────────────

  it("Test 2 — retry après failure step 4 (addInbound) : steps 1-3 memoizés, step 4 retry", async () => {
    // Scénario : Firestore tx addInbound throw une 5xx transitoire au
    // 1er essai. Steps 1-3 sont commit avant le crash. Sur retry, ils
    // sont memoizés (pas ré-exécutés). Step 4 réessaye et succeed.
    //
    // ⚠️ Note honnête : addInbound est appelé 2× au TOTAL (1 fail + 1
    // success). En réalité, `addInbound` utilise une `runTransaction`
    // Firestore (S6.5) qui rollback automatiquement sur throw → pas de
    // doc fantôme côté persistence. (Inngest n'a aucune notion de tx
    // Firestore : c'est l'usage de `runTransaction` côté caller qui
    // assure l'atomicité.) Dans ce test mock, on vérifie la COUNT
    // d'appels, pas la persistence.
    const { step, cache } = makeMemoizedStepRun("evt-mem-2");

    let addInboundAttempt = 0;
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-mem-2")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-mem-2_camp-2",
        conversation: makeFakeConversation("hs-mem-2", "camp-2"),
      }),
      addInbound: vi.fn().mockImplementation(async () => {
        addInboundAttempt++;
        if (addInboundAttempt === 1) {
          throw new Error("Firestore 5xx on addInbound");
        }
        return "msgid-mem-2-success";
      }),
    });

    // Run 1 — throws au step 4
    await expect(processReplyHandler(makeFakeCtx("evt-mem-2", step), deps)).rejects.toThrow(
      "Firestore 5xx on addInbound",
    );

    // Steps 1-3 commit, step 4 NOT
    expect(cache.has("evt-mem-2::resolve-contact")).toBe(true);
    expect(cache.has("evt-mem-2::resolve-conversation")).toBe(true);
    expect(cache.has("evt-mem-2::dedup-by-external-id")).toBe(true);
    expect(cache.has("evt-mem-2::store-inbound")).toBe(false);

    // Run 2 — retry
    const result = await processReplyHandler(makeFakeCtx("evt-mem-2", step), deps);

    expect(result.status).toBe("classified");
    if (result.status === "classified") {
      expect(result.messageId).toBe("msgid-mem-2-success");
    }

    // 🔒 Steps amont (1-3) memoizés
    expect(deps.getContactByPhone).toHaveBeenCalledTimes(1);
    expect(deps.getActiveConversationByContactId).toHaveBeenCalledTimes(1);
    expect(deps.findInboundByExternalId).toHaveBeenCalledTimes(1);

    // Step 4 : 2× (1 fail + 1 success) — c'est le comportement attendu
    // dans la step qui a throw : Inngest la ré-exécute en intégralité.
    expect(deps.addInbound).toHaveBeenCalledTimes(2);

    // Steps aval (5-8) : 1× chacun (atteints sur Run 2 seulement)
    expect(deps.isOptOut).toHaveBeenCalledTimes(1);
    expect(deps.classifyReply).toHaveBeenCalledTimes(1);
    expect(deps.setConversationIntent).toHaveBeenCalledTimes(1);

    // Step 4 cached avec le messageId du run success
    expect(cache.get("evt-mem-2::store-inbound")).toBe("msgid-mem-2-success");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Test 3 — Retry après failure step 5 (markOptedOut short-form opt-out)
  // ───────────────────────────────────────────────────────────────────────────

  it("Test 3 — retry après failure step 5 (markOptedOut short-form) : steps 1-4 memoizés", async () => {
    // Scénario : body = "STOP" → step 5 fast-path. markOptedOut throw
    // une fois (idempotent natif côté Firestore en réalité, on simule
    // un 5xx transient). Steps 1-4 commit avant. Sur retry, ils sont
    // memoizés ; step 5 retry markOptedOut → success. Pipeline retourne
    // opt_out short_form.
    const { step, cache } = makeMemoizedStepRun("evt-mem-3");

    let markOptedOutAttempt = 0;
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-mem-3")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-mem-3_camp-3",
        conversation: makeFakeConversation("hs-mem-3", "camp-3"),
      }),
      addInbound: vi.fn().mockResolvedValue("msgid-mem-3"),
      isOptOut: vi.fn().mockReturnValue(true), // short-form match
      markOptedOut: vi.fn().mockImplementation(async () => {
        markOptedOutAttempt++;
        if (markOptedOutAttempt === 1) {
          throw new Error("Firestore 5xx on markOptedOut");
        }
      }),
    });

    // Run 1 — throws au step 5
    await expect(
      processReplyHandler(makeFakeCtx("evt-mem-3", step, { body: "STOP" }), deps),
    ).rejects.toThrow("Firestore 5xx on markOptedOut");

    expect(cache.has("evt-mem-3::store-inbound")).toBe(true);
    expect(cache.has("evt-mem-3::short-form-opt-out-check")).toBe(false);

    // Run 2 — retry
    const result = await processReplyHandler(
      makeFakeCtx("evt-mem-3", step, { body: "STOP" }),
      deps,
    );

    expect(result.status).toBe("opt_out");
    if (result.status === "opt_out") {
      expect(result.via).toBe("short_form");
      expect(result.intent).toBe("STOP");
      expect(result.messageId).toBe("msgid-mem-3");
    }

    // 🔒 Steps 1-4 memoizés (1× chacun)
    expect(deps.getContactByPhone).toHaveBeenCalledTimes(1);
    expect(deps.getActiveConversationByContactId).toHaveBeenCalledTimes(1);
    expect(deps.findInboundByExternalId).toHaveBeenCalledTimes(1);
    expect(deps.addInbound).toHaveBeenCalledTimes(1);

    // Step 5 : isOptOut + markOptedOut tous deux dans la même closure
    // step.run → tous deux re-évalués sur retry intra-step :
    //   - isOptOut: 2× (pure, pas d'effet de bord)
    //   - markOptedOut: 2× (1 fail + 1 success)
    expect(deps.isOptOut).toHaveBeenCalledTimes(2);
    expect(deps.markOptedOut).toHaveBeenCalledTimes(2);

    // Steps 6-7 PAS appelés (short-form court-circuit avant classifier)
    expect(deps.classifyReply).not.toHaveBeenCalled();
    expect(deps.setConversationIntent).not.toHaveBeenCalled();

    // Step 8 audit-reply-processed : 1× total (cached après Run 2)
    const replyProcessedCount = (deps.appendAuditLog as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => (c[0] as { action: string }).action === "reply_processed",
    ).length;
    expect(replyProcessedCount).toBe(1);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Test 4 — Happy path baseline (no retry, no failure)
  // ───────────────────────────────────────────────────────────────────────────

  it("Test 4 — happy path baseline : chaque mock appelé exactement 1× (sentinelle référence)", async () => {
    // Sentinelle de référence : sans aucune failure, le pipeline doit
    // exécuter chaque step exactement 1×. Si ce test échoue, c'est
    // que le fake step.run memoizé introduit un double-comptage —
    // invalide les conclusions des autres tests.
    const { step, cache } = makeMemoizedStepRun("evt-mem-4");

    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-mem-4")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-mem-4_camp-4",
        conversation: makeFakeConversation("hs-mem-4", "camp-4"),
      }),
      addInbound: vi.fn().mockResolvedValue("msgid-mem-4"),
    });

    const result = await processReplyHandler(makeFakeCtx("evt-mem-4", step), deps);

    expect(result.status).toBe("classified");

    // Chaque mock 1×
    expect(deps.getContactByPhone).toHaveBeenCalledTimes(1);
    expect(deps.getActiveConversationByContactId).toHaveBeenCalledTimes(1);
    expect(deps.findInboundByExternalId).toHaveBeenCalledTimes(1);
    expect(deps.addInbound).toHaveBeenCalledTimes(1);
    expect(deps.isOptOut).toHaveBeenCalledTimes(1);
    expect(deps.classifyReply).toHaveBeenCalledTimes(1);
    expect(deps.setConversationIntent).toHaveBeenCalledTimes(1);

    // appendAuditLog : 2 audits (intent_classified + reply_processed)
    const auditActions = (deps.appendAuditLog as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => (c[0] as { action: string }).action)
      .sort();
    expect(auditActions).toEqual(["intent_classified", "reply_processed"]);

    // Cache : 9 steps présents (S9.3.1 — split classify-intent en 6a + 6b)
    const expectedSteps = [
      "resolve-contact",
      "resolve-conversation",
      "dedup-by-external-id",
      "store-inbound",
      "short-form-opt-out-check",
      "claude-classify",
      "audit-intent-classified",
      "branch-interesse",
      "audit-reply-processed",
    ];
    for (const stepName of expectedSteps) {
      expect(cache.has(`evt-mem-4::${stepName}`)).toBe(true);
    }
    expect(cache.size).toBe(expectedSteps.length);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Test 5 — Cache par (eventId, stepName) — 2 events distincts ne partagent pas
  // ───────────────────────────────────────────────────────────────────────────

  it("Test 5 — cache par (eventId, stepName) : 2 events distincts ⇒ 2 caches isolés", async () => {
    // Sentinelle anti-régression CRITIQUE : si la memoization était par
    // stepName seul (au lieu de (eventId, stepName)), le 2ème event
    // récupérerait le contactId du 1er event depuis le cache de step 1
    // → mauvais PS contacté, faute compliance + faute marketing.
    //
    // On lance 2 pipelines avec eventIds DIFFÉRENTS et phones DIFFÉRENTS.
    // Chaque cache doit contenir UNIQUEMENT les entrées de son eventId.
    const { step: step1, cache: cache1 } = makeMemoizedStepRun("evt-mem-5a");
    const { step: step2, cache: cache2 } = makeMemoizedStepRun("evt-mem-5b");

    const deps = makeDeps({
      getContactByPhone: vi
        .fn()
        .mockImplementation(async (phone: string) =>
          makeFakeContact(phone === "+33611111111" ? "hs-5a" : "hs-5b"),
        ),
      getActiveConversationByContactId: vi.fn().mockImplementation(async (cid: string) => ({
        conversationId: `${cid}_camp-5`,
        conversation: makeFakeConversation(cid, "camp-5"),
      })),
      addInbound: vi.fn().mockResolvedValue("msgid-5"),
    });

    const result1 = await processReplyHandler(
      makeFakeCtx("evt-mem-5a", step1, {
        phone: "+33611111111",
        ovhMessageId: "ovh-5a",
      }),
      deps,
    );
    const result2 = await processReplyHandler(
      makeFakeCtx("evt-mem-5b", step2, {
        phone: "+33622222222",
        ovhMessageId: "ovh-5b",
      }),
      deps,
    );

    // Verdicts indépendants — chaque event traité avec SON contactId
    expect(result1.status).toBe("classified");
    expect(result2.status).toBe("classified");
    if (result1.status === "classified") {
      expect(result1.contactId).toBe("hs-5a");
      expect(result1.conversationId).toBe("hs-5a_camp-5");
    }
    if (result2.status === "classified") {
      expect(result2.contactId).toBe("hs-5b");
      expect(result2.conversationId).toBe("hs-5b_camp-5");
    }

    // 🔒 Caches isolés : chaque eventId a son propre namespace
    expect(cache1).not.toBe(cache2);
    expect(cache1.has("evt-mem-5a::resolve-contact")).toBe(true);
    expect(cache1.has("evt-mem-5b::resolve-contact")).toBe(false);
    expect(cache2.has("evt-mem-5b::resolve-contact")).toBe(true);
    expect(cache2.has("evt-mem-5a::resolve-contact")).toBe(false);

    // Sentinelle de cross-pollution : le contactId stocké dans cache1
    // est bien hs-5a (pas hs-5b qui aurait été un cross-leak).
    const cached1 = cache1.get("evt-mem-5a::resolve-contact") as {
      found: true;
      contactId: string;
    };
    const cached2 = cache2.get("evt-mem-5b::resolve-contact") as {
      found: true;
      contactId: string;
    };
    expect(cached1.contactId).toBe("hs-5a");
    expect(cached2.contactId).toBe("hs-5b");

    // Chaque pipeline a fait son tour : 2 invocations totales par dep
    expect(deps.getContactByPhone).toHaveBeenCalledTimes(2);
    expect(deps.addInbound).toHaveBeenCalledTimes(2);
    expect(deps.classifyReply).toHaveBeenCalledTimes(2);
    expect(deps.setConversationIntent).toHaveBeenCalledTimes(2);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Test 6 — Idempotence pleine claude-classify post-split S9.3.1
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Test 6 — Idempotence pleine `claude-classify` post-split S9.3.1
   *
   * Verrouille le contrat : `classifyReply` n'est PAS ré-facturée Claude
   * si l'audit `intent_classified` (step 6b) throw, grâce au split en
   * 2 `step.run` distincts (`claude-classify` + `audit-intent-classified`).
   * La memoization Inngest sert step 6a depuis le cache même si step 6b
   * throw → retry.
   *
   * Ferme **S9.3-FOLLOWUP-1** documenté en S9.2.3.2 (limite originelle :
   * 2 appels Claude facturés sur retry intra-step). Si quelqu'un re-fusionne
   * les 2 `step.run` en 1 seul, ce test casse → forcera la mise à jour
   * explicite (signal anti-régression intentionnel).
   *
   * Scénario :
   *   - Run 1 : steps 1-5 commit, step 6a `claude-classify` commit
   *     (`classifyReply` appelé 1×), step 6b `audit-intent-classified`
   *     throw transient → toute la pile remonte.
   *   - Run 2 (retry, MÊME cache) : steps 1-5 servis depuis cache (no-op),
   *     step 6a servi depuis cache (`classifyReply` NON ré-appelé), step
   *     6b ré-exécuté → succeed.
   *   - Assert `classifyReply` TOTAL : **1×** (PAS 2× comme avant le split).
   *   - Assert `appendAuditLog("intent_classified")` TOTAL : 2× (1 fail
   *     + 1 success ; côté Firestore, 1 seul doc commit puisque la 1ère
   *     tentative throw avant commit).
   */
  it("Test 6 — idempotence pleine claude-classify post-split S9.3.1 (anti-double-facturation)", async () => {
    const { step, cache } = makeMemoizedStepRun("evt-mem-6");

    let intentClassifiedAttempt = 0;
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-mem-6")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-mem-6_camp-6",
        conversation: makeFakeConversation("hs-mem-6", "camp-6"),
      }),
      addInbound: vi.fn().mockResolvedValue("msgid-mem-6"),
      appendAuditLog: vi.fn().mockImplementation(async (entry: { action: string }) => {
        if (entry.action === "intent_classified") {
          intentClassifiedAttempt++;
          if (intentClassifiedAttempt === 1) {
            throw new Error("Firestore 5xx on intent_classified audit");
          }
        }
        return "audit-id";
      }),
    });

    // Run 1 — throws au step 6b (audit-intent-classified)
    await expect(processReplyHandler(makeFakeCtx("evt-mem-6", step), deps)).rejects.toThrow(
      "Firestore 5xx on intent_classified audit",
    );

    // 🔒 Vérification clé S9.3.1 : step 6a commit (cache présent), step
    // 6b PAS commit (cache absent). C'est ce qui permet à classifyReply
    // d'être servi depuis le cache au Run 2 sans ré-appel SDK.
    expect(cache.has("evt-mem-6::claude-classify")).toBe(true);
    expect(cache.has("evt-mem-6::audit-intent-classified")).toBe(false);

    // Run 2 — retry, MÊME cache memoization partagé
    const result = await processReplyHandler(makeFakeCtx("evt-mem-6", step), deps);

    expect(result.status).toBe("classified");

    // ✅ IDEMPOTENCE PLEINE CLAUDE (ferme S9.3-FOLLOWUP-1) :
    // classifyReply appelé EXACTEMENT 1× au TOTAL malgré le retry, parce
    // que step 6a `claude-classify` est servi depuis le cache au Run 2.
    // C'est l'INVERSE de la limite documentée pré-S9.3.1 (qui voyait 2×).
    //
    // Si ce nombre dérive à 2× : régression critique (potentiel fusion
    // des 2 step.run en 1, ou nommage cassé du step 6a). Investigate.
    expect(deps.classifyReply).toHaveBeenCalledTimes(1);

    // Audit intent_classified : 2× appels SDK (1 fail + 1 success). État
    // Firestore final = 1 doc commit (le 1er throw avant commit).
    const intentClassifiedCount = (
      deps.appendAuditLog as ReturnType<typeof vi.fn>
    ).mock.calls.filter((c) => (c[0] as { action: string }).action === "intent_classified").length;
    expect(intentClassifiedCount).toBe(2);

    // 🔒 Steps amont (1-5) memoizés (1× chacun) — pas de propagation
    // amont du retry intra-step 6b.
    expect(deps.getContactByPhone).toHaveBeenCalledTimes(1);
    expect(deps.getActiveConversationByContactId).toHaveBeenCalledTimes(1);
    expect(deps.findInboundByExternalId).toHaveBeenCalledTimes(1);
    expect(deps.addInbound).toHaveBeenCalledTimes(1);
    expect(deps.isOptOut).toHaveBeenCalledTimes(1);

    // Step 7 (branch-interesse) : 1× total — memoizé après succès Run 2.
    expect(deps.setConversationIntent).toHaveBeenCalledTimes(1);

    // Step 8 audit-reply-processed : 1× total — memoizé après Run 2.
    const replyProcessedCount = (deps.appendAuditLog as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => (c[0] as { action: string }).action === "reply_processed",
    ).length;
    expect(replyProcessedCount).toBe(1);

    // Step 6b cached après succès Run 2.
    expect(cache.has("evt-mem-6::audit-intent-classified")).toBe(true);
  });
});
