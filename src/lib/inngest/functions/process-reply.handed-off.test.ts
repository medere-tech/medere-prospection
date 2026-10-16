/**
 * Tests PR-A-INBOUND-HANDED-OFF — pipeline process-reply, branche
 * "relayed_to_human" + opt-out sur conv `handed_off`.
 *
 * Objectifs couverts (cf. brief PR-A) :
 *   T1. handed_off + message normal → stocke, 0 generateReply, 0 send,
 *       1 DM Slack, 1 audit `inbound_relayed_to_human` (wasOptOut=false).
 *   T2. handed_off + "STOP" → markOptedOut appele + conv passe opted_out
 *       + DM Slack STOP, 1 audit avec wasOptOut=true + optOutVia="short_form".
 *   T3. handed_off + long-form opt-out ("Arretez de m'ecrire") →
 *       classifier Claude retourne STOP → markOptedOut + conv opted_out
 *       + DM Slack STOP + audit wasOptOut=true + optOutVia="classifier_long_form".
 *   T5. retry Inngest idempotence : 2 passes du handler sur le MEME event
 *       ne doivent produire qu'un seul effet metier (memoization simulee
 *       par step.run qui retourne le cache sur re-call).
 *   T6. conv active : comportement STRICTEMENT inchange (zero regression).
 *   T7. mutation guard : si on simule "pas d'opt-out check sur handed_off"
 *       alors T2 doit casser (cf. commentaire dans le test).
 *
 * Pattern injection de deps (pas d'emulator) — cohérent avec
 * process-reply.test.ts (S9.2.1 pattern). Les tests "e2e emulator"
 * (T4 — opt-out sur handed_off puis envoi admin bloque) vivent
 * cote tests Firestore (contacts.test.ts verifie deja la primitive
 * markOptedOut + sentinelle anti-drift closed/blocked).
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
// Helpers (dupliques du pattern de process-reply.test.ts — tests unit purs)
// ─────────────────────────────────────────────────────────────────────────────

function makeStepRun(): ProcessReplyHandlerContext["step"] {
  return {
    run: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
    sendEvent: vi.fn().mockResolvedValue({}),
  };
}

function makeFakeCtx(
  overrides: { phone?: string; body?: string; ovhMessageId?: string; eventId?: string } = {},
): ProcessReplyHandlerContext {
  return {
    event: {
      id: overrides.eventId ?? "evt-ho-test-1",
      name: "medere/sms.reply.received",
      data: {
        phone: overrides.phone ?? "+33775745453",
        body: overrides.body ?? "Je rappelle lundi matin",
        ovhMessageId: overrides.ovhMessageId ?? "ovh-ho-msg-1",
      },
    },
    step: makeStepRun(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

function makeFakeContact(hubspotId: string, firstName = "Pierre"): Contact {
  return {
    hubspotId,
    firstName,
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
      legitimateInterest: "Lead HubSpot Médéré importé 2026-06-01",
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

function makeHandedOffConversation(
  contactId: string,
  campaignId: string,
  assignedTo: string,
): Conversation {
  return {
    contactId,
    campaignId,
    channel: "sms",
    status: "handed_off",
    intent: "INTERESSE",
    messageCount: 4,
    outboundCount: 2,
    inboundCount: 2,
    followupCount: 0,
    handoff: {
      assignedTo,
      assignedAt: { toMillis: () => 0 } as unknown as Timestamp,
    },
    createdAt: { toMillis: () => 0 } as unknown as Timestamp,
    updatedAt: { toMillis: () => 0 } as unknown as Timestamp,
  };
}

function makeDeps(overrides: Partial<ProcessReplyDeps> = {}): ProcessReplyDeps {
  // BUG-DEDUP-RACE : `addInboundIdempotent` par defaut appelle en interne
  // le MEME mock `addInbound` pour que les assertions historiques
  // `expect(deps.addInbound).toHaveBeenCalledOnce()` restent vraies.
  const addInboundMock = overrides.addInbound ?? vi.fn().mockResolvedValue("msg-ho-firestore-id20");
  return {
    getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-ho-1")),
    getActiveConversationByContactId: vi.fn().mockResolvedValue(null),
    getHandedOffConversationByContactId: vi.fn().mockResolvedValue({
      conversationId: "hs-ho-1_camp-a",
      conversation: makeHandedOffConversation("hs-ho-1", "camp-a", "U05VANESSA"),
    }),
    getContact: vi.fn().mockResolvedValue(makeFakeContact("hs-ho-1")),
    findInboundByExternalId: vi.fn().mockResolvedValue(null),
    markOptedOut: vi.fn().mockResolvedValue(undefined),
    isOptOut: vi.fn().mockReturnValue(false),
    hashPii: vi.fn().mockReturnValue("hashed-pii-ho-abcd1234abcd1234abcd1234"),
    appendAuditLog: vi.fn().mockResolvedValue("audit-id-ho"),
    classifyReply: vi.fn().mockResolvedValue({
      intent: "NEUTRE",
      confidence: 0.8,
      reasoning: "default-neutre-should-not-leak",
      fallback: false,
    }),
    setConversationIntent: vi.fn().mockResolvedValue(undefined),
    listRecentMessages: vi.fn().mockResolvedValue([]),
    generateReply: vi.fn().mockResolvedValue({
      body: "SHOULD NEVER BE CALLED ON HANDED_OFF BRANCH",
      promptVersion: "0.0.0",
      model: "none",
      temperature: 0,
      tokensInput: 0,
      tokensOutput: 0,
      generationDurationMs: 0,
    }),
    addOutboundDraft: vi.fn().mockResolvedValue("SHOULD-NEVER-DRAFT"),
    sendInboundAfterHandoffNotification: vi.fn().mockResolvedValue({
      ts: "1700000000.900",
      channel: "D0VANESSA",
    }),
    getDashboardConversationUrl: vi
      .fn()
      .mockImplementation((convId: string) => `https://dashboard.test/conversations/${convId}`),
    ...overrides,
    addInbound: addInboundMock,
    addInboundIdempotent:
      overrides.addInboundIdempotent ??
      (vi.fn(async (convId: string, input) => {
        const messageId = (await addInboundMock(convId, input)) as string;
        return { messageId, created: true as const };
      }) as unknown as ProcessReplyDeps["addInboundIdempotent"]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// T1 — handed_off + message normal
// ─────────────────────────────────────────────────────────────────────────────

describe("PR-A T1 — handed_off + message normal", () => {
  it("stocke le message, 0 generateReply, 0 dispatch, 1 DM, 1 audit relay (wasOptOut=false)", async () => {
    const ctx = makeFakeCtx({ body: "Je rappelle lundi matin, merci." });
    const deps = makeDeps();

    const result = await processReplyHandler(ctx, deps);

    // Branche prise
    expect(result.status).toBe("relayed_to_human");
    if (result.status !== "relayed_to_human") throw new Error("branch mismatch");
    expect(result.conversationId).toBe("hs-ho-1_camp-a");
    expect(result.messageId).toBe("msg-ho-firestore-id20");
    expect(result.assignedTo).toBe("U05VANESSA");

    // Stockage inbound effectue
    expect(deps.addInbound).toHaveBeenCalledOnce();

    // ZERO generation, ZERO dispatch, ZERO draft, ZERO setConversationIntent
    expect(deps.generateReply).not.toHaveBeenCalled();
    expect(deps.addOutboundDraft).not.toHaveBeenCalled();
    expect(deps.setConversationIntent).not.toHaveBeenCalled();
    expect(ctx.step.sendEvent).not.toHaveBeenCalled();

    // ZERO markOptedOut (message normal, pas de STOP)
    expect(deps.markOptedOut).not.toHaveBeenCalled();

    // 1 DM Slack avec isOptOut=false
    expect(deps.sendInboundAfterHandoffNotification).toHaveBeenCalledOnce();
    const slackArgs = vi.mocked(deps.sendInboundAfterHandoffNotification!).mock.calls[0]![0];
    expect(slackArgs.isOptOut).toBe(false);
    expect(slackArgs.target).toEqual({ kind: "dm", slackUserId: "U05VANESSA" });

    // 1 audit `inbound_relayed_to_human` avec wasOptOut=false + pas d'optOutVia
    const relayAudit = vi
      .mocked(deps.appendAuditLog!)
      .mock.calls.find((c) => c[0].action === "inbound_relayed_to_human");
    expect(relayAudit).toBeDefined();
    const payload = relayAudit![0].payload as Record<string, unknown>;
    expect(payload.wasOptOut).toBe(false);
    expect(payload.optOutVia).toBeUndefined();
    expect(payload.assignedTo).toBe("U05VANESSA");
    expect(payload.messageId).toBe("msg-ho-firestore-id20");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T2 — handed_off + "STOP" (short-form)
// ─────────────────────────────────────────────────────────────────────────────

describe("PR-A T2 — handed_off + STOP (short-form)", () => {
  it("markOptedOut appele avec conversationId, DM STOP, audit relay wasOptOut=true + optOutVia=short_form", async () => {
    const ctx = makeFakeCtx({ body: "STOP" });
    const deps = makeDeps({
      isOptOut: vi.fn().mockReturnValue(true), // short-form STOP detecte
    });

    const result = await processReplyHandler(ctx, deps);

    expect(result.status).toBe("opt_out");
    if (result.status !== "opt_out") throw new Error("branch mismatch");
    expect(result.via).toBe("handed_off_short_form");
    expect(result.intent).toBe("STOP");

    // markOptedOut appele avec conversationId -> grace au fix PR-A du guard,
    // la tx reussit : contact.consent.optedOut + conv passe opted_out dans
    // la MEME tx + audit opt_out pose par markOptedOut lui-meme.
    expect(deps.markOptedOut).toHaveBeenCalledOnce();
    expect(deps.markOptedOut).toHaveBeenCalledWith("hs-ho-1", "sms", {
      conversationId: "hs-ho-1_camp-a",
      intent: "STOP",
    });

    // ZERO classifier Claude (short-form court-circuite)
    expect(deps.classifyReply).not.toHaveBeenCalled();

    // ZERO generation / dispatch / draft
    expect(deps.generateReply).not.toHaveBeenCalled();
    expect(deps.addOutboundDraft).not.toHaveBeenCalled();

    // 1 DM Slack avec isOptOut=true
    const slackArgs = vi.mocked(deps.sendInboundAfterHandoffNotification!).mock.calls[0]![0];
    expect(slackArgs.isOptOut).toBe(true);

    // 1 audit `inbound_relayed_to_human` avec wasOptOut=true + optOutVia=short_form
    const relayAudit = vi
      .mocked(deps.appendAuditLog!)
      .mock.calls.find((c) => c[0].action === "inbound_relayed_to_human");
    expect(relayAudit).toBeDefined();
    const payload = relayAudit![0].payload as Record<string, unknown>;
    expect(payload.wasOptOut).toBe(true);
    expect(payload.optOutVia).toBe("short_form");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T3 — handed_off + opt-out long-forme (via classifier)
// ─────────────────────────────────────────────────────────────────────────────

describe("PR-A T3 — handed_off + opt-out long-forme (classifier)", () => {
  it("classifier Claude retourne STOP → markOptedOut + DM STOP + audit wasOptOut=true + optOutVia=classifier_long_form", async () => {
    const ctx = makeFakeCtx({
      body: "Merci de bien vouloir arreter de m'ecrire a l'avenir, je ne suis pas interesse.",
    });
    const deps = makeDeps({
      isOptOut: vi.fn().mockReturnValue(false), // long-forme, pas de court-forme
      classifyReply: vi.fn().mockResolvedValue({
        intent: "STOP",
        confidence: 0.92,
        reasoning: "long-form-stop-detected",
        fallback: false,
      }),
    });

    const result = await processReplyHandler(ctx, deps);

    expect(result.status).toBe("opt_out");
    if (result.status !== "opt_out") throw new Error("branch mismatch");
    expect(result.via).toBe("handed_off_classifier_long_form");

    // markOptedOut doit avoir ete appele UNE FOIS (par la branche long-form,
    // pas la branche short-form).
    expect(deps.markOptedOut).toHaveBeenCalledOnce();
    expect(deps.markOptedOut).toHaveBeenCalledWith("hs-ho-1", "sms", {
      conversationId: "hs-ho-1_camp-a",
      intent: "STOP",
    });

    // Classifier a bien tourne
    expect(deps.classifyReply).toHaveBeenCalledOnce();

    // DM Slack STOP
    const slackArgs = vi.mocked(deps.sendInboundAfterHandoffNotification!).mock.calls[0]![0];
    expect(slackArgs.isOptOut).toBe(true);

    // Audit avec optOutVia=classifier_long_form
    const relayAudit = vi
      .mocked(deps.appendAuditLog!)
      .mock.calls.find((c) => c[0].action === "inbound_relayed_to_human");
    const payload = relayAudit![0].payload as Record<string, unknown>;
    expect(payload.wasOptOut).toBe(true);
    expect(payload.optOutVia).toBe("classifier_long_form");

    // ZERO generation / dispatch
    expect(deps.generateReply).not.toHaveBeenCalled();
    expect(deps.addOutboundDraft).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T6 — Non-régression : conv ACTIVE comportement inchangé
// ─────────────────────────────────────────────────────────────────────────────

describe("PR-A T6 — non-regression conversation active", () => {
  it("conv active (handed_off=null, active=awaiting_reply) → pipeline classique inchange", async () => {
    const activeConv: Conversation = {
      contactId: "hs-active-1",
      campaignId: "camp-a",
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
    const ctx = makeFakeCtx();
    const deps = makeDeps({
      getContactByPhone: vi.fn().mockResolvedValue(makeFakeContact("hs-active-1")),
      getActiveConversationByContactId: vi.fn().mockResolvedValue({
        conversationId: "hs-active-1_camp-a",
        conversation: activeConv,
      }),
      getHandedOffConversationByContactId: vi.fn(), // ne doit pas etre appele
      classifyReply: vi.fn().mockResolvedValue({
        intent: "INTERESSE",
        confidence: 0.9,
        reasoning: "interested",
        fallback: false,
      }),
    });

    const result = await processReplyHandler(ctx, deps);

    expect(result.status).toBe("classified");
    if (result.status !== "classified") throw new Error("branch mismatch");
    expect(result.conversationId).toBe("hs-active-1_camp-a");

    // getHandedOffConversationByContactId JAMAIS appele (fallback non atteint)
    expect(deps.getHandedOffConversationByContactId).not.toHaveBeenCalled();

    // Chemin classique : generateReply + addOutboundDraft + dispatch events
    expect(deps.generateReply).toHaveBeenCalledOnce();
    expect(deps.addOutboundDraft).toHaveBeenCalledOnce();
    expect(ctx.step.sendEvent).toHaveBeenCalled();

    // AUCUN DM Slack "inbound-after-handoff" (c'est le hand-off initial qui
    // sera eventuellement declenche en aval, pas le relais handed_off).
    expect(deps.sendInboundAfterHandoffNotification).not.toHaveBeenCalled();

    // AUCUN audit inbound_relayed_to_human
    const relayAudit = vi
      .mocked(deps.appendAuditLog!)
      .mock.calls.find((c) => c[0].action === "inbound_relayed_to_human");
    expect(relayAudit).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T5 — Idempotence Inngest (memoization simulee)
// ─────────────────────────────────────────────────────────────────────────────

describe("PR-A T5 — idempotence Inngest (retry simule)", () => {
  it("step.run avec cache (= 1er run commit) → 2eme passe ne re-execute pas les effets", async () => {
    // Simule le comportement memoization Inngest : chaque step.run stocke
    // son resultat par (eventId, stepName). Sur retry du handler avec le
    // meme event, chaque step precommit retourne son cache sans ré-exécuter.
    //
    // On modelise ca avec une Map<stepName, result> partagee entre deux
    // appels successifs du handler. Les effets de bord (DB mocks) sont
    // observes via les spies vi.fn qui comptent les CALLS reels.
    //
    // Attendu : apres 2 passes, chaque dep critique est appelee AU PLUS
    // 1 fois (addInbound, markOptedOut, sendInboundAfterHandoffNotification,
    // audit `inbound_relayed_to_human`).
    const stepCache = new Map<string, unknown>();
    const memoizedStep: ProcessReplyHandlerContext["step"] = {
      run: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        if (stepCache.has(name)) return stepCache.get(name) as T;
        const result = await fn();
        stepCache.set(name, result);
        return result;
      },
      sendEvent: vi.fn().mockResolvedValue({}),
    };

    const ctx: ProcessReplyHandlerContext = {
      event: {
        id: "evt-retry-ho-1",
        name: "medere/sms.reply.received",
        data: {
          phone: "+33775745453",
          body: "STOP",
          ovhMessageId: "ovh-ho-retry-1",
        },
      },
      step: memoizedStep,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    };
    const deps = makeDeps({
      isOptOut: vi.fn().mockReturnValue(true),
    });

    const r1 = await processReplyHandler(ctx, deps);
    const r2 = await processReplyHandler(ctx, deps);

    // Resultats identiques (idempotence)
    expect(r1).toEqual(r2);
    expect(r1.status).toBe("opt_out");

    // Effets reels : UNE SEULE FOIS pour chaque dep critique
    expect(deps.addInbound).toHaveBeenCalledOnce();
    expect(deps.markOptedOut).toHaveBeenCalledOnce();
    expect(deps.sendInboundAfterHandoffNotification).toHaveBeenCalledOnce();

    // Audit `inbound_relayed_to_human` : exactement 1
    const relayAudits = vi
      .mocked(deps.appendAuditLog!)
      .mock.calls.filter((c) => c[0].action === "inbound_relayed_to_human");
    expect(relayAudits).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T7 — Mutation guard : retirer l'opt-out du chemin handed_off casse T2
// ─────────────────────────────────────────────────────────────────────────────

describe("PR-A T7 — mutation guard (sentinelle)", () => {
  it("si markOptedOut n'est pas appele sur STOP handed_off → le test T2 casse (via DOIT etre handed_off_short_form)", async () => {
    // Ce test documente l'invariant : la branche handed_off DOIT invoquer
    // markOptedOut sur STOP. Si quelqu'un la retire par mutation (sabotage
    // + revert accidentel), T2 attend `via === "handed_off_short_form"`
    // ET `deps.markOptedOut` 1 appel. Les deux conditions sont strictement
    // couplees — mutation = test casse.
    //
    // Ici on prouve le couplage inverse : si on simule un markOptedOut qui
    // throw (= pipeline Firestore down), la branche DOIT remonter l'erreur
    // au lieu de passer en silence. Pas de catch magique qui masquerait le
    // trou.
    const ctx = makeFakeCtx({ body: "STOP" });
    const deps = makeDeps({
      isOptOut: vi.fn().mockReturnValue(true),
      markOptedOut: vi.fn().mockRejectedValue(new Error("firestore-5xx")),
    });

    await expect(processReplyHandler(ctx, deps)).rejects.toThrow("firestore-5xx");

    // La seule chose stockee avant la throw est l'inbound (preuve L.34-5
    // CPCE). Le DM Slack NE DOIT PAS avoir ete poste (le pipeline a
    // throw avant notify).
    expect(deps.addInbound).toHaveBeenCalledOnce();
    expect(deps.sendInboundAfterHandoffNotification).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sentinelle anti-PII logger (branche handed_off)
// ─────────────────────────────────────────────────────────────────────────────

describe("PR-A — anti-PII logger (branche handed_off)", () => {
  it("logger ne contient JAMAIS phone / body / ovhMessageId / reasoning", async () => {
    const ctx = makeFakeCtx({
      body: "Je rappelle au 06 78 90 12 34 lundi matin, merci.", // body avec numero perso
    });
    const deps = makeDeps();
    await processReplyHandler(ctx, deps);

    const serialized = JSON.stringify((ctx.logger.info as ReturnType<typeof vi.fn>).mock.calls);
    expect(serialized).not.toContain("+33775745453");
    expect(serialized).not.toContain("06 78 90 12 34");
    expect(serialized).not.toContain("Je rappelle au 06");
    expect(serialized).not.toContain("ovh-ho-msg-1");
    expect(serialized).not.toContain("default-neutre-should-not-leak");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Course STOP / statut terminal (MED compliance-auditor, fix PR-A)
// ─────────────────────────────────────────────────────────────────────────────

describe("PR-A — race conversation_became_terminal entre step 2 et markOptedOut", () => {
  it("markOptedOut throw ValidationError(currentStatus=closed) → audit reply_dropped + alerte Sentry + NonRetriableError", async () => {
    const { NonRetriableError } = await import("inngest");
    const { ValidationError } = await import("@/lib/utils/errors");
    const captureSpy = vi.fn();
    const ctx = makeFakeCtx({ body: "STOP" });
    const deps = makeDeps({
      isOptOut: vi.fn().mockReturnValue(true),
      markOptedOut: vi.fn().mockRejectedValue(
        new ValidationError({
          message: "Cannot mark opted_out, conversation in terminal state: closed",
          context: {
            conversationId: "hs-ho-1_camp-a",
            contactId: "hs-ho-1",
            currentStatus: "closed",
          },
        }),
      ),
      captureMonitoringWarning: captureSpy,
    });

    await expect(processReplyHandler(ctx, deps)).rejects.toBeInstanceOf(NonRetriableError);

    // Audit reply_dropped avec reason=conversation_became_terminal
    const dropAudit = vi
      .mocked(deps.appendAuditLog!)
      .mock.calls.find(
        (c) =>
          c[0].action === "reply_dropped" &&
          (c[0].payload as { reason?: string }).reason === "conversation_became_terminal",
      );
    expect(dropAudit).toBeDefined();
    const payload = dropAudit![0].payload as Record<string, unknown>;
    expect(payload.wasOptOut).toBe(true);
    expect(payload.optOutVia).toBe("short_form");
    expect(payload.currentStatus).toBe("closed");

    // Alerte Sentry explicite "was_opt_out: true"
    expect(captureSpy).toHaveBeenCalledOnce();
    const alert = captureSpy.mock.calls[0]!;
    expect(alert[0]).toBe("process_reply.handed_off_opt_out_terminal_race");
    const alertPayload = alert[1] as {
      tags: { was_opt_out: string; current_status: string };
      extra: { hint: string };
    };
    expect(alertPayload.tags.was_opt_out).toBe("true");
    expect(alertPayload.tags.current_status).toBe("closed");
    expect(alertPayload.extra.hint).toMatch(/humain/i);

    // Pas de DM Slack poste : la race est detectee AVANT notify.
    expect(deps.sendInboundAfterHandoffNotification).not.toHaveBeenCalled();
  });

  it("markOptedOut throw ValidationError sans currentStatus (autre erreur) → propagation telle quelle (retry Inngest classique)", async () => {
    const { ValidationError } = await import("@/lib/utils/errors");
    const captureSpy = vi.fn();
    const ctx = makeFakeCtx({ body: "STOP" });
    const deps = makeDeps({
      isOptOut: vi.fn().mockReturnValue(true),
      markOptedOut: vi.fn().mockRejectedValue(
        new ValidationError({
          message: "Something unrelated",
          context: { foo: "bar" },
        }),
      ),
      captureMonitoringWarning: captureSpy,
    });

    // Propage la ValidationError originale (= Inngest classique retry×3).
    await expect(processReplyHandler(ctx, deps)).rejects.toBeInstanceOf(ValidationError);
    // AUCUN audit reply_dropped car ce n'est pas la race geree.
    const dropAudit = vi
      .mocked(deps.appendAuditLog!)
      .mock.calls.find((c) => c[0].action === "reply_dropped");
    expect(dropAudit).toBeUndefined();
    // AUCUNE alerte Sentry
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it("race long-forme (classifier STOP + conv blocked) → meme traitement + optOutVia=classifier_long_form", async () => {
    const { NonRetriableError } = await import("inngest");
    const { ValidationError } = await import("@/lib/utils/errors");
    const captureSpy = vi.fn();
    const ctx = makeFakeCtx({ body: "Je ne veux plus recevoir de SMS, merci." });
    const deps = makeDeps({
      isOptOut: vi.fn().mockReturnValue(false),
      classifyReply: vi.fn().mockResolvedValue({
        intent: "STOP",
        confidence: 0.95,
        reasoning: "long-form-stop",
        fallback: false,
      }),
      markOptedOut: vi.fn().mockRejectedValue(
        new ValidationError({
          message: "Cannot mark opted_out, conversation in terminal state: blocked",
          context: {
            conversationId: "hs-ho-1_camp-a",
            contactId: "hs-ho-1",
            currentStatus: "blocked",
          },
        }),
      ),
      captureMonitoringWarning: captureSpy,
    });

    await expect(processReplyHandler(ctx, deps)).rejects.toBeInstanceOf(NonRetriableError);

    const dropAudit = vi
      .mocked(deps.appendAuditLog!)
      .mock.calls.find(
        (c) =>
          c[0].action === "reply_dropped" &&
          (c[0].payload as { reason?: string }).reason === "conversation_became_terminal",
      );
    const payload = dropAudit![0].payload as Record<string, unknown>;
    expect(payload.optOutVia).toBe("classifier_long_form");
    expect(payload.currentStatus).toBe("blocked");

    const alert = captureSpy.mock.calls[0]!;
    expect((alert[1] as { tags: { current_status: string } }).tags.current_status).toBe("blocked");
  });
});
