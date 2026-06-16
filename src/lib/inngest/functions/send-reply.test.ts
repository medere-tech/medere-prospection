/**
 * Tests unitaires `send-reply.ts` handler (S9.4.2).
 *
 * Pattern miroir `send-first-sms.test.ts` — mocks de toutes les
 * dépendances Firestore/OVH/env, pas d'emulator. Tests d'intégration
 * Firestore vivent dans `send-reply.test.ts` (S9.4.1) +
 * `messages.test.ts` (updateMessageStatus, S9.4.2).
 *
 * Couverture cible :
 *   - Sentinelles : FUNCTION_ID + AUDIT_SENDER_DRY_RUN + concurrency
 *     (event.data.contactId limit 1)
 *   - Happy path DRY_RUN : OVH non appelé, ovhMessageId/sender = dry-run
 *     markers, audit dispatched posé, retour `dispatched dryRun: true`
 *   - Happy path RÉEL : sendSms appelé avec receivers + body, audit avec
 *     vraies valeurs, retour `dispatched dryRun: false`
 *   - Branche blocked compliance : commitDraftToQueued retourne
 *     {ok: false} → handler return early, PAS de step ovh-send, PAS d'audit
 *     dispatched
 *   - OVH ConfigError noRetry → updateMessageStatus(failed) + audit
 *     sms_failed (posé par updateMessageStatus) + NonRetriableError
 *   - OVH ExternalServiceError → propage tel quel (retry naturel Inngest)
 *   - Defense-in-depth : draft.status !== "queued" post-commit → NonRetriable
 *   - Anti-PII : payload audit dispatched ne contient pas phone/body brut
 */
import { NonRetriableError } from "inngest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigError, ExternalServiceError, ValidationError } from "@/lib/utils/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks (DOIVENT être déclarés AVANT l'import de send-reply).
// ─────────────────────────────────────────────────────────────────────────────
vi.mock("@/lib/firestore/admin", () => ({
  getAdminDb: vi.fn(),
}));
vi.mock("@/lib/firestore/contacts", () => ({ getContact: vi.fn() }));
vi.mock("@/lib/firestore/messages", () => ({
  _parseMessageOrThrow: vi.fn(),
  updateMessageStatus: vi.fn(),
}));
vi.mock("@/lib/firestore/send-reply", () => ({ commitDraftToQueued: vi.fn() }));
vi.mock("@/lib/firestore/audit-log", () => ({ appendAuditLog: vi.fn() }));
vi.mock("@/lib/ovh/send-sms", () => ({ sendSms: vi.fn() }));
vi.mock("@/lib/security/env", () => ({ getCoreEnv: vi.fn(), getOvhEnv: vi.fn() }));

// Imports AFTER mocks
import { getAdminDb } from "@/lib/firestore/admin";
import { appendAuditLog } from "@/lib/firestore/audit-log";
import { getContact } from "@/lib/firestore/contacts";
import { _parseMessageOrThrow, updateMessageStatus } from "@/lib/firestore/messages";
import { commitDraftToQueued } from "@/lib/firestore/send-reply";
import { sendSms } from "@/lib/ovh/send-sms";
import { getCoreEnv, getOvhEnv } from "@/lib/security/env";

import {
  __AUDIT_OVH_MESSAGE_ID_DRY_RUN_FOR_TESTS,
  __AUDIT_SENDER_DRY_RUN_FOR_TESTS,
  __CONVERSATIONS_COLLECTION_FOR_TESTS,
  __FUNCTION_ID_FOR_TESTS,
  __MESSAGES_SUBCOLLECTION_FOR_TESTS,
  sendReply,
  sendReplyHandler,
  type SendReplyHandlerContext,
} from "./send-reply";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const CONTACT_ID = "hs_test_dent_01";
const CONV_ID = "hs_test_dent_01_camp_test";
const DRAFT_MSG_ID = "draft_FirestoreAutoId20a";
const BODY = "Bonjour, voici les infos demandées. Répondez STOP pour ne plus être contacté.";

function makeContext(): SendReplyHandlerContext {
  // step.run mock : exécute le callback immédiatement (pas de mémoisation
  // Inngest). Le typage generic `<T>` est incompatible avec
  // `vi.fn(...)` directement → on wrap dans un `vi.fn()` qui défère
  // au `realRun` typé proprement. Cela permet de spy les calls tout en
  // gardant la signature attendue par sendReplyHandler.
  const realRun = async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn();
  const runSpy = vi.fn(realRun);

  return {
    event: {
      id: "evt-test-1",
      name: "medere/sms.reply.send-requested",
      data: {
        contactId: CONTACT_ID,
        conversationId: CONV_ID,
        draftMessageId: DRAFT_MSG_ID,
      },
    },
    step: {
      run: runSpy as SendReplyHandlerContext["step"]["run"],
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

function makeFakeContact(overrides: Record<string, unknown> = {}) {
  return {
    hubspotId: CONTACT_ID,
    firstName: "Jean",
    lastName: "Dupont",
    speciality: "dentiste",
    phone: {
      e164: "+33612345678",
      raw: "06 12 34 56 78",
      type: "mobile",
      valid: true,
      lookupAt: { toMillis: () => Date.now() },
    },
    segment: "b2b_cabinet",
    bloctelChecked: true,
    bloctelOptOut: false,
    consent: {
      legitimateInterest: "Prospection commerciale dentaire conforme RGPD article 6.1.f",
      optedOut: false,
    },
    enrichment: { source: "hubspot", enrichedAt: { toMillis: () => Date.now() } },
    status: "ready",
    campaignId: "camp_test",
    createdAt: { toMillis: () => Date.now() },
    updatedAt: { toMillis: () => Date.now() },
    ...overrides,
  };
}

function makeFakeMessage(overrides: Record<string, unknown> = {}) {
  return {
    direction: "outbound",
    body: BODY,
    status: "queued",
    channel: "sms",
    generatedBy: "ai",
    aiModel: "claude-sonnet-4-6",
    aiPromptVersion: "1.0.0",
    aiTemperature: 0.5,
    aiTokens: { input: 540, output: 38 },
    createdAt: { toMillis: () => Date.now() },
    queuedAt: { toMillis: () => Date.now() },
    ...overrides,
  };
}

/**
 * Configure le mock getAdminDb pour retourner un doc Firestore lisible
 * via la chaîne `.collection().doc().collection().doc().get()`.
 */
function setupAdminDbReadMessage(messageData: Record<string, unknown> | null) {
  const docGet = vi.fn(async () => ({
    exists: messageData !== null,
    data: () => messageData,
  }));
  const docMethod = vi.fn(() => ({ get: docGet }));
  const subcollMethod = vi.fn(() => ({ doc: docMethod }));
  const parentDocMethod = vi.fn(() => ({ collection: subcollMethod }));
  const collMethod = vi.fn(() => ({ doc: parentDocMethod }));

  vi.mocked(getAdminDb).mockReturnValue({
    collection: collMethod,
  } as unknown as ReturnType<typeof getAdminDb>);

  return { docGet, docMethod, subcollMethod, parentDocMethod, collMethod };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe("sendReplyHandler — S9.4.2", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Defaults : DRY_RUN false, sender env, _parseMessageOrThrow identity
    vi.mocked(getCoreEnv).mockReturnValue({ DRY_RUN_SMS: false } as ReturnType<typeof getCoreEnv>);
    vi.mocked(getOvhEnv).mockReturnValue({
      OVH_SMS_SENDER: "Medere",
    } as ReturnType<typeof getOvhEnv>);
    vi.mocked(_parseMessageOrThrow).mockImplementation(
      (raw) => raw as ReturnType<typeof _parseMessageOrThrow>,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Sentinelles structurelles
  // ───────────────────────────────────────────────────────────────────────

  describe("sentinelles structurelles", () => {
    it("FUNCTION_ID === 'send-reply' (stable Inngest dashboard)", () => {
      expect(__FUNCTION_ID_FOR_TESTS).toBe("send-reply");
    });

    it("AUDIT_SENDER_DRY_RUN === 'DRY_RUN_SENDER' (aligné send-first-sms.ts)", () => {
      expect(__AUDIT_SENDER_DRY_RUN_FOR_TESTS).toBe("DRY_RUN_SENDER");
    });

    it("AUDIT_OVH_MESSAGE_ID_DRY_RUN === 'DRY_RUN_OVH_MESSAGE_ID' (aligné send-first-sms.ts)", () => {
      expect(__AUDIT_OVH_MESSAGE_ID_DRY_RUN_FOR_TESTS).toBe("DRY_RUN_OVH_MESSAGE_ID");
    });

    it("CONVERSATIONS_COLLECTION === 'conversations' (aligné conversations.ts)", () => {
      expect(__CONVERSATIONS_COLLECTION_FOR_TESTS).toBe("conversations");
    });

    it("MESSAGES_SUBCOLLECTION === 'messages' (aligné messages.ts)", () => {
      expect(__MESSAGES_SUBCOLLECTION_FOR_TESTS).toBe("messages");
    });

    it("function.concurrency : key event.data.contactId, limit 1 (GF1 INFRA-DETTE-001)", () => {
      // Sentinelle anti-régression : si quelqu'un retire le concurrency
      // ou le change vers `conversationId`, ce test casse — protection
      // contre la dérive du pattern S6.
      const opts = (
        sendReply as unknown as {
          opts: { concurrency: { key: string; limit: number } };
        }
      ).opts;
      expect(opts.concurrency.key).toBe("event.data.contactId");
      expect(opts.concurrency.limit).toBe(1);
    });

    it("function.retries === 3 (cohérent process-reply S9.3.1)", () => {
      const opts = (sendReply as unknown as { opts: { retries: number } }).opts;
      expect(opts.retries).toBe(3);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Branche blocked compliance — commitDraftToQueued retourne {ok: false}
  // ───────────────────────────────────────────────────────────────────────

  describe("branche blocked_by_compliance", () => {
    it("commitDraftToQueued {ok: false} → retour blocked + PAS de step ovh-send", async () => {
      vi.mocked(commitDraftToQueued).mockResolvedValue({
        ok: false,
        failure: {
          rule: "opt_out",
          code: "opted_out",
          context: {},
        },
      });

      const ctx = makeContext();
      const result = await sendReplyHandler(ctx);

      expect(result).toEqual({
        status: "blocked_by_compliance",
        contactId: CONTACT_ID,
        conversationId: CONV_ID,
        draftMessageId: DRAFT_MSG_ID,
        blockedRule: "opt_out",
        blockedCode: "opted_out",
      });

      // PAS d'OVH dispatch
      expect(sendSms).not.toHaveBeenCalled();
      // PAS de read Firestore inline (step ovh-send pas atteint)
      expect(getAdminDb).not.toHaveBeenCalled();
      expect(getContact).not.toHaveBeenCalled();
      // PAS d'audit sms_provider_dispatched
      expect(appendAuditLog).not.toHaveBeenCalled();
      // updateMessageStatus pas appelé (le draft reste status="draft")
      expect(updateMessageStatus).not.toHaveBeenCalled();
    });

    it("blocked → 1 seul step.run appelé (commit-draft), pas ovh-send", async () => {
      vi.mocked(commitDraftToQueued).mockResolvedValue({
        ok: false,
        failure: { rule: "rate_limit", code: "rate_limit_exceeded", context: {} },
      });

      const ctx = makeContext();
      await sendReplyHandler(ctx);

      const stepRun = ctx.step.run as ReturnType<typeof vi.fn>;
      expect(stepRun).toHaveBeenCalledTimes(1);
      expect(stepRun.mock.calls[0]?.[0]).toBe("commit-draft");
    });

    it("blocked rule='hours' → logger.warn avec blockedRule + blockedCode, PAS de blockedContext", async () => {
      vi.mocked(commitDraftToQueued).mockResolvedValue({
        ok: false,
        failure: {
          rule: "hours",
          code: "sunday",
          context: { isoDate: "2026-05-10" },
        },
      });

      const ctx = makeContext();
      await sendReplyHandler(ctx);

      const warnCalls = (ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
      expect(warnCalls.length).toBeGreaterThan(0);
      const firstCallArg = warnCalls[0]?.[1] as Record<string, unknown>;
      expect(firstCallArg.blockedRule).toBe("hours");
      expect(firstCallArg.blockedCode).toBe("sunday");
      // PAS de blockedContext dans le log Pino (defense-in-depth — vit dans
      // l'audit_log reply_draft_dropped pour forensic).
      expect(firstCallArg).not.toHaveProperty("blockedContext");
      expect(firstCallArg).not.toHaveProperty("isoDate");
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Happy path DRY_RUN
  // ───────────────────────────────────────────────────────────────────────

  describe("happy path DRY_RUN", () => {
    it("DRY_RUN=true → OVH non appelé, ovhMessageId=null, dryRun=true", async () => {
      vi.mocked(commitDraftToQueued).mockResolvedValue({
        ok: true,
        messageId: DRAFT_MSG_ID,
        conversationId: CONV_ID,
        contactId: CONTACT_ID,
        auditId: "audit-sms-sent-1",
      });
      vi.mocked(getCoreEnv).mockReturnValue({ DRY_RUN_SMS: true } as ReturnType<typeof getCoreEnv>);
      setupAdminDbReadMessage(makeFakeMessage());
      vi.mocked(getContact).mockResolvedValue(
        makeFakeContact() as ReturnType<typeof getContact> extends Promise<infer T> ? T : never,
      );
      vi.mocked(appendAuditLog).mockResolvedValue("audit-dispatched-1");

      const ctx = makeContext();
      const result = await sendReplyHandler(ctx);

      expect(result).toEqual({
        status: "dispatched",
        contactId: CONTACT_ID,
        conversationId: CONV_ID,
        draftMessageId: DRAFT_MSG_ID,
        ovhMessageId: null,
        dryRun: true,
        auditId: "audit-dispatched-1",
      });

      // OVH non appelé
      expect(sendSms).not.toHaveBeenCalled();
      // getOvhEnv non appelé en dry-run (anti-crash dev local)
      expect(getOvhEnv).not.toHaveBeenCalled();
    });

    it("DRY_RUN=true → audit dispatched avec sender + ovhMessageId markers + bodyLength", async () => {
      vi.mocked(commitDraftToQueued).mockResolvedValue({
        ok: true,
        messageId: DRAFT_MSG_ID,
        conversationId: CONV_ID,
        contactId: CONTACT_ID,
        auditId: "audit-sms-sent-1",
      });
      vi.mocked(getCoreEnv).mockReturnValue({ DRY_RUN_SMS: true } as ReturnType<typeof getCoreEnv>);
      setupAdminDbReadMessage(makeFakeMessage());
      vi.mocked(getContact).mockResolvedValue(
        makeFakeContact() as ReturnType<typeof getContact> extends Promise<infer T> ? T : never,
      );
      vi.mocked(appendAuditLog).mockResolvedValue("audit-dispatched-1");

      const ctx = makeContext();
      await sendReplyHandler(ctx);

      expect(appendAuditLog).toHaveBeenCalledTimes(1);
      const auditCall = vi.mocked(appendAuditLog).mock.calls[0]?.[0];
      expect(auditCall?.action).toBe("sms_provider_dispatched");
      expect(auditCall?.targetType).toBe("message");
      expect(auditCall?.targetId).toBe(DRAFT_MSG_ID);

      const payload = auditCall?.payload as Record<string, unknown>;
      expect(payload.sender).toBe(__AUDIT_SENDER_DRY_RUN_FOR_TESTS);
      expect(payload.ovhMessageId).toBe(__AUDIT_OVH_MESSAGE_ID_DRY_RUN_FOR_TESTS);
      expect(payload.dryRun).toBe(true);
      expect(payload.creditsRemoved).toBe(0);
      expect(payload.bodyLength).toBe(BODY.length);
      expect(payload.messageId).toBe(DRAFT_MSG_ID);
      expect(payload.direction).toBe("outbound");
      expect(payload.contactId).toBe(CONTACT_ID);
      expect(payload.conversationId).toBe(CONV_ID);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Happy path RÉEL — OVH ack 200
  // ───────────────────────────────────────────────────────────────────────

  describe("happy path RÉEL", () => {
    it("sendSms appelé avec receivers + body + retour ovhMessageId", async () => {
      vi.mocked(commitDraftToQueued).mockResolvedValue({
        ok: true,
        messageId: DRAFT_MSG_ID,
        conversationId: CONV_ID,
        contactId: CONTACT_ID,
        auditId: "audit-sms-sent-1",
      });
      setupAdminDbReadMessage(makeFakeMessage());
      vi.mocked(getContact).mockResolvedValue(
        makeFakeContact() as ReturnType<typeof getContact> extends Promise<infer T> ? T : never,
      );
      vi.mocked(sendSms).mockResolvedValue({
        messageIds: ["ovh-real-msg-9876"],
        creditsRemoved: 1,
      });
      vi.mocked(appendAuditLog).mockResolvedValue("audit-dispatched-1");

      const ctx = makeContext();
      const result = await sendReplyHandler(ctx);

      expect(sendSms).toHaveBeenCalledWith({
        receivers: ["+33612345678"],
        message: BODY,
      });

      expect(result).toEqual({
        status: "dispatched",
        contactId: CONTACT_ID,
        conversationId: CONV_ID,
        draftMessageId: DRAFT_MSG_ID,
        ovhMessageId: "ovh-real-msg-9876",
        dryRun: false,
        auditId: "audit-dispatched-1",
      });
    });

    it("audit dispatched en mode réel → sender env, ovhMessageId réel, bodyLength scrubber-safe", async () => {
      vi.mocked(commitDraftToQueued).mockResolvedValue({
        ok: true,
        messageId: DRAFT_MSG_ID,
        conversationId: CONV_ID,
        contactId: CONTACT_ID,
        auditId: "audit-sms-sent-1",
      });
      setupAdminDbReadMessage(makeFakeMessage());
      vi.mocked(getContact).mockResolvedValue(
        makeFakeContact() as ReturnType<typeof getContact> extends Promise<infer T> ? T : never,
      );
      vi.mocked(sendSms).mockResolvedValue({
        messageIds: ["ovh-real-msg-9876"],
        creditsRemoved: 1,
      });
      vi.mocked(appendAuditLog).mockResolvedValue("audit-dispatched-1");

      const ctx = makeContext();
      await sendReplyHandler(ctx);

      const auditCall = vi.mocked(appendAuditLog).mock.calls[0]?.[0];
      const payload = auditCall?.payload as Record<string, unknown>;
      expect(payload.sender).toBe("Medere"); // env-driven, pas dry-run
      expect(payload.ovhMessageId).toBe("ovh-real-msg-9876");
      expect(payload.dryRun).toBe(false);
      expect(payload.creditsRemoved).toBe(1);
      expect(payload.bodyLength).toBe(BODY.length);

      // Sentinelle anti-PII : payload ne contient pas body brut ni phone
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain(BODY);
      expect(serialized).not.toContain("+33612345678");
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // OVH ConfigError noRetry — asymétrie Option B
  // ───────────────────────────────────────────────────────────────────────

  describe("OVH failure noRetry (ConfigError/ValidationError) — asymétrie Option B", () => {
    it("ConfigError → updateMessageStatus(failed) + NonRetriableError", async () => {
      vi.mocked(commitDraftToQueued).mockResolvedValue({
        ok: true,
        messageId: DRAFT_MSG_ID,
        conversationId: CONV_ID,
        contactId: CONTACT_ID,
        auditId: "audit-sms-sent-1",
      });
      setupAdminDbReadMessage(makeFakeMessage());
      vi.mocked(getContact).mockResolvedValue(
        makeFakeContact() as ReturnType<typeof getContact> extends Promise<infer T> ? T : never,
      );
      vi.mocked(sendSms).mockRejectedValue(
        new ConfigError({ message: "OVH 401 auth denied", context: { status: 401 } }),
      );
      vi.mocked(updateMessageStatus).mockResolvedValue(undefined);

      const ctx = makeContext();
      await expect(sendReplyHandler(ctx)).rejects.toBeInstanceOf(NonRetriableError);

      expect(updateMessageStatus).toHaveBeenCalledWith({
        conversationId: CONV_ID,
        messageId: DRAFT_MSG_ID,
        status: "failed",
        failureReason: {
          code: "config_error",
          detail: "OVH 401 auth denied",
          retryCount: 0,
        },
      });
      // Pas d'audit dispatched (le step n'est pas atteint après throw)
      expect(appendAuditLog).not.toHaveBeenCalled();
    });

    it("ValidationError → updateMessageStatus(failed, code='validation_error') + NonRetriable", async () => {
      vi.mocked(commitDraftToQueued).mockResolvedValue({
        ok: true,
        messageId: DRAFT_MSG_ID,
        conversationId: CONV_ID,
        contactId: CONTACT_ID,
        auditId: "audit-sms-sent-1",
      });
      setupAdminDbReadMessage(makeFakeMessage());
      vi.mocked(getContact).mockResolvedValue(
        makeFakeContact() as ReturnType<typeof getContact> extends Promise<infer T> ? T : never,
      );
      vi.mocked(sendSms).mockRejectedValue(
        new ValidationError({
          message: "OVH rejected receivers",
          context: { reason: "ovh_rejected_receivers" },
        }),
      );
      vi.mocked(updateMessageStatus).mockResolvedValue(undefined);

      const ctx = makeContext();
      await expect(sendReplyHandler(ctx)).rejects.toBeInstanceOf(NonRetriableError);

      const updateCall = vi.mocked(updateMessageStatus).mock.calls[0]?.[0];
      expect(updateCall?.failureReason?.code).toBe("validation_error");
    });

    it("failureReason.detail propage un err.message SAIN du wrapper OVH actuel (defense-in-depth pour S9.4.2-FOLLOWUP-SANITIZE-DETAIL-HANDLER)", async () => {
      // 🔒 Sentinelle documentaire : prouve que le wrapper OVH actuel
      // (`send-sms.ts:256-311 mapOvhError`) produit des messages
      // littéraux sans PII (`"OVH API auth denied"`, `"OVH rejected one
      // or more receivers"`, etc.) que le handler peut copier dans
      // `failureReason.detail` sans risque.
      //
      // ⚠️ LIMITATION : ce test passe trivialement car on mock un
      // wrapper sain. Si un futur dev change le wrapper pour leak un
      // E.164 dans err.message (ex: JSON.stringify(context) qui contient
      // invalidReceivers), CE TEST NE LE DÉTECTERA PAS.
      //
      // Follow-up Notion `S9.4.2-FOLLOWUP-SANITIZE-DETAIL-HANDLER` :
      // sanitize `err.message` côté handler send-reply.ts via regex
      // E.164/FR avant copy dans `failureReason.detail` (defense-in-depth
      // indépendante du wrapper en aval). Pas implémenté en S9.4.2 car
      // hors scope MVP — le wrapper OVH est l'autorité actuelle anti-PII.
      vi.mocked(commitDraftToQueued).mockResolvedValue({
        ok: true,
        messageId: DRAFT_MSG_ID,
        conversationId: CONV_ID,
        contactId: CONTACT_ID,
        auditId: "audit-sms-sent-1",
      });
      setupAdminDbReadMessage(makeFakeMessage());
      vi.mocked(getContact).mockResolvedValue(
        makeFakeContact() as ReturnType<typeof getContact> extends Promise<infer T> ? T : never,
      );
      // Reflète le comportement RÉEL du wrapper OVH (cf. send-sms.ts:256-311
      // qui produit des messages littéraux constants sans PII).
      vi.mocked(sendSms).mockRejectedValue(
        new ConfigError({
          message: "OVH API rejected request (bad input)",
          context: { status: 400 },
        }),
      );
      vi.mocked(updateMessageStatus).mockResolvedValue(undefined);

      const ctx = makeContext();
      await expect(sendReplyHandler(ctx)).rejects.toBeInstanceOf(NonRetriableError);

      // Verrouille que le message littéral du wrapper ne contient pas
      // d'E.164/FR — preuve documentaire que le contrat actuel send-sms.ts
      // est respecté côté handler.
      const updateCall = vi.mocked(updateMessageStatus).mock.calls[0]?.[0];
      const serializedDetail = JSON.stringify(updateCall?.failureReason);
      expect(serializedDetail).not.toMatch(/\+\d{10,15}/);
      expect(serializedDetail).not.toMatch(/0[1-9]\d{8}/);
    });

    it("updateMessageStatus throw lui-même → log.error best-effort + NonRetriable original propagé", async () => {
      vi.mocked(commitDraftToQueued).mockResolvedValue({
        ok: true,
        messageId: DRAFT_MSG_ID,
        conversationId: CONV_ID,
        contactId: CONTACT_ID,
        auditId: "audit-sms-sent-1",
      });
      setupAdminDbReadMessage(makeFakeMessage());
      vi.mocked(getContact).mockResolvedValue(
        makeFakeContact() as ReturnType<typeof getContact> extends Promise<infer T> ? T : never,
      );
      const ovhErr = new ConfigError({ message: "OVH 400", context: { status: 400 } });
      vi.mocked(sendSms).mockRejectedValue(ovhErr);
      vi.mocked(updateMessageStatus).mockRejectedValue(new Error("Firestore I/O timeout"));

      const ctx = makeContext();
      // L'erreur ORIGINALE (NonRetriableError wrap ConfigError) doit être
      // propagée, pas l'erreur updateMessageStatus interne (MED-1 pattern).
      try {
        await sendReplyHandler(ctx);
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(NonRetriableError);
      }

      // Log error best-effort sur updateMessageStatus fail
      expect(ctx.logger.error).toHaveBeenCalled();
      const errCalls = (ctx.logger.error as ReturnType<typeof vi.fn>).mock.calls;
      expect(errCalls[0]?.[0]).toMatchObject({
        failureCode: "config_error",
        updateError: "Firestore I/O timeout",
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // OVH retryable — propagation sans transition status
  // ───────────────────────────────────────────────────────────────────────

  describe("OVH failure retry-friendly", () => {
    it("ExternalServiceError → propage tel quel (retry Inngest), PAS d'updateMessageStatus", async () => {
      vi.mocked(commitDraftToQueued).mockResolvedValue({
        ok: true,
        messageId: DRAFT_MSG_ID,
        conversationId: CONV_ID,
        contactId: CONTACT_ID,
        auditId: "audit-sms-sent-1",
      });
      setupAdminDbReadMessage(makeFakeMessage());
      vi.mocked(getContact).mockResolvedValue(
        makeFakeContact() as ReturnType<typeof getContact> extends Promise<infer T> ? T : never,
      );
      const extErr = new ExternalServiceError({
        message: "OVH 503",
        context: { status: 503 },
      });
      vi.mocked(sendSms).mockRejectedValue(extErr);

      const ctx = makeContext();
      await expect(sendReplyHandler(ctx)).rejects.toBe(extErr);

      // PAS de transition status=failed (le message reste queued pour retry).
      expect(updateMessageStatus).not.toHaveBeenCalled();
      // PAS d'audit dispatched
      expect(appendAuditLog).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Defense-in-depth — assertions post-commit
  // ───────────────────────────────────────────────────────────────────────

  describe("defense-in-depth post-commit", () => {
    it("draft.status !== 'queued' post-commit → NonRetriableError", async () => {
      vi.mocked(commitDraftToQueued).mockResolvedValue({
        ok: true,
        messageId: DRAFT_MSG_ID,
        conversationId: CONV_ID,
        contactId: CONTACT_ID,
        auditId: "audit-sms-sent-1",
      });
      // Cas pathologique : commitDraftToQueued a posé queued mais le doc lu
      // ici a status="failed" (race admin / bug futur).
      setupAdminDbReadMessage(makeFakeMessage({ status: "failed" }));
      vi.mocked(getContact).mockResolvedValue(
        makeFakeContact() as ReturnType<typeof getContact> extends Promise<infer T> ? T : never,
      );

      const ctx = makeContext();
      await expect(sendReplyHandler(ctx)).rejects.toBeInstanceOf(NonRetriableError);

      // PAS d'OVH appelé (assertion défense pré-OVH)
      expect(sendSms).not.toHaveBeenCalled();
    });

    it("message disparu entre commit et ovh-send → NonRetriableError", async () => {
      vi.mocked(commitDraftToQueued).mockResolvedValue({
        ok: true,
        messageId: DRAFT_MSG_ID,
        conversationId: CONV_ID,
        contactId: CONTACT_ID,
        auditId: "audit-sms-sent-1",
      });
      // Doc inexistant (purge manuelle, race admin).
      setupAdminDbReadMessage(null);

      const ctx = makeContext();
      await expect(sendReplyHandler(ctx)).rejects.toBeInstanceOf(NonRetriableError);
      expect(sendSms).not.toHaveBeenCalled();
    });

    it("contact disparu entre commit et ovh-send → NonRetriableError", async () => {
      vi.mocked(commitDraftToQueued).mockResolvedValue({
        ok: true,
        messageId: DRAFT_MSG_ID,
        conversationId: CONV_ID,
        contactId: CONTACT_ID,
        auditId: "audit-sms-sent-1",
      });
      setupAdminDbReadMessage(makeFakeMessage());
      vi.mocked(getContact).mockResolvedValue(null);

      const ctx = makeContext();
      await expect(sendReplyHandler(ctx)).rejects.toBeInstanceOf(NonRetriableError);
      expect(sendSms).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Anti-PII strict sur logs et retours
  // ───────────────────────────────────────────────────────────────────────

  describe("anti-PII strict", () => {
    it("logger.info DRY_RUN ne contient pas body ni phone", async () => {
      vi.mocked(commitDraftToQueued).mockResolvedValue({
        ok: true,
        messageId: DRAFT_MSG_ID,
        conversationId: CONV_ID,
        contactId: CONTACT_ID,
        auditId: "audit-sms-sent-1",
      });
      vi.mocked(getCoreEnv).mockReturnValue({ DRY_RUN_SMS: true } as ReturnType<typeof getCoreEnv>);
      setupAdminDbReadMessage(makeFakeMessage());
      vi.mocked(getContact).mockResolvedValue(
        makeFakeContact() as ReturnType<typeof getContact> extends Promise<infer T> ? T : never,
      );
      vi.mocked(appendAuditLog).mockResolvedValue("audit-dispatched-1");

      const ctx = makeContext();
      await sendReplyHandler(ctx);

      const allLogCalls = [
        ...(ctx.logger.info as ReturnType<typeof vi.fn>).mock.calls,
        ...(ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls,
        ...(ctx.logger.error as ReturnType<typeof vi.fn>).mock.calls,
      ];
      const serialized = JSON.stringify(allLogCalls);
      expect(serialized).not.toContain(BODY);
      expect(serialized).not.toContain("+33612345678");
      expect(serialized).not.toContain("0612345678");
    });

    it("logger.info dispatched ne contient pas ovhMessageId (semi-sensible)", async () => {
      vi.mocked(commitDraftToQueued).mockResolvedValue({
        ok: true,
        messageId: DRAFT_MSG_ID,
        conversationId: CONV_ID,
        contactId: CONTACT_ID,
        auditId: "audit-sms-sent-1",
      });
      setupAdminDbReadMessage(makeFakeMessage());
      vi.mocked(getContact).mockResolvedValue(
        makeFakeContact() as ReturnType<typeof getContact> extends Promise<infer T> ? T : never,
      );
      vi.mocked(sendSms).mockResolvedValue({
        messageIds: ["ovh-secret-id-XYZ"],
        creditsRemoved: 1,
      });
      vi.mocked(appendAuditLog).mockResolvedValue("audit-dispatched-1");

      const ctx = makeContext();
      await sendReplyHandler(ctx);

      const infoCalls = (ctx.logger.info as ReturnType<typeof vi.fn>).mock.calls;
      const serialized = JSON.stringify(infoCalls);
      expect(serialized).not.toContain("ovh-secret-id-XYZ");
    });
  });
});
