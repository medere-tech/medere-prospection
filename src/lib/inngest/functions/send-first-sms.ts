/**
 * Inngest function `send-first-sms` — orchestration de l'envoi du premier
 * SMS d'une campagne à un contact (Phase 1 MVP, S8.4).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ⚠️ DETTE TECHNIQUE INFRA-DETTE-001 — race condition rate-limit
 *
 * Cette implémentation MVP repose sur **Inngest concurrency par
 * `event.data.contactId`** (limit 1) pour sérialiser les envois sur un
 * même contact et ainsi éviter la race condition rate-limit 3 SMS / 30j.
 *
 * Pour scaler en prod >200 contacts simultanés et fermer la race
 * by-construction Firestore-side, PAYER la dette S6.6 AVANT de scaler :
 *
 *   1. Extraire `addOutboundInTx(tx, ...)` de `addOutbound`
 *      (`firestore/messages.ts` actuel = transaction enveloppante figée).
 *   2. Exposer `listRecentOutboundInTx(tx, conversationId)` (variant
 *      tx-aware de `listRecentOutbound`).
 *   3. Exposer `updateMessageStatus(conversationId, messageId, status,
 *      externalId?)` (mentionné `messages.ts:25-26` comme reporté S7).
 *   4. Migrer le pipeline 4 steps actuel vers le pattern 5 steps :
 *
 *        - get-contact-and-history       (HORS tx)
 *        - compliance-pre-send-check     (audit auto, HORS tx)
 *        - reserve-outbound-in-firestore (`withContactLock` PURE :
 *                                          re-check rate-limit + addOutboundInTx
 *                                          `status="queued"`)
 *        - ovh-send                      (HORS tx — DRY_RUN ou réel)
 *        - mark-message-sent             (updateMessageStatus → "sent",
 *                                          pose externalId = ovhMessageIds[0])
 *
 *   5. Retirer la dépendance à `concurrency: { key, limit: 1 }` SI la
 *      transaction Firestore garantit l'exclusion mutuelle (mais
 *      conserver `key` pour rate-limiting global Inngest reste prudent).
 *
 * Cf. Notion `INFRA-DETTE-001` (Backlog technique) pour le plan complet
 * de migration + critères Done.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * GARDE-FOUS S8 (non-négociables — modifier nécessite issue Notion)
 *
 *   [GF1] `concurrency: { key: "event.data.contactId", limit: 1 }`
 *         → sérialise les jobs d'un MÊME contact. C'est CE qui ferme la
 *           race condition rate-limit en l'absence de withContactLock.
 *           Test sentinelle dans `send-first-sms.test.ts` verrouille la
 *           présence de cette config par inspection structurelle.
 *
 *   [GF2] JSDoc INFRA-DETTE-001 (ce bloc) explicite dans le code.
 *
 *   [GF3] Test sentinelle anti-régression — vérifie EXACTEMENT que
 *         `sendFirstSms.opts.concurrency.{key, limit}` ne sont pas
 *         retirés ou modifiés silencieusement (cf. `send-first-sms.test.ts`).
 *
 *   [GF4] Référence Notion `INFRA-DETTE-001` dans tous les commits S8
 *         qui touchent ce fichier.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * PIPELINE 4 STEPS (Voie 2 minimaliste — Q2 arbitrée par Déthié S8)
 *
 *   1. `get-contact-and-history`  : `getContact(contactId)` + lookup
 *                                    `getConversation` + `listRecentOutbound`.
 *                                    Throws `NonRetriableError` si contact
 *                                    ou conversation absents (config morte).
 *
 *   2. `compliance-pre-send-check`: `preSendCheckWithAudit({contact, message,
 *                                    conversation, recentOutboundMessages})`.
 *                                    Pose audit `compliance_check` AUTO
 *                                    (cf. wrapper S6.6 GUARD-002).
 *                                    Si blocked → early return `{status:
 *                                    "blocked", code, rule}`.
 *
 *   3. `ovh-send`                 : branche DRY_RUN_SMS :
 *                                    - true → log + return `{ovhMessageId:
 *                                      null, dryRun: true}` (aucun appel
 *                                      OVH réel)
 *                                    - false → `sendSms({receivers, message})`
 *                                      OVH. `ConfigError`/`ValidationError`
 *                                      → `NonRetriableError` (noRetry).
 *                                      Autres erreurs (5xx, network) →
 *                                      propagées telles quelles → retry
 *                                      Inngest par défaut.
 *
 *   4. `record-outbound-message`  : `addOutbound()` enqueue Firestore
 *                                    (status="queued" FIGÉ par S6.5 — OK
 *                                    pour MVP, fix sémantique en S9 via
 *                                    `updateMessageStatus`). Puis pose
 *                                    audit `sms_provider_dispatched` avec
 *                                    `{ovhMessageId, conversationId,
 *                                    contactId, campaignId, sender,
 *                                    bodyLength, dryRun, creditsRemoved}`.
 *                                    Tous les champs scrubber-safe par
 *                                    construction (vérifié S8.4 pré-flight).
 *
 * En dry-run, `finalOvhMessageId = "dry-run-<firestoreMessageId>"` (le
 * messageId Firestore est `[A-Za-z0-9]{20}` → scrubber-safe).
 *
 * Forensic disponible côté Firestore :
 *   - Doc `messages/{messageId}` : body, createdAt, status="queued"
 *   - Audit `sms_sent` (par addOutbound) : `{direction, messageId}`
 *   - Audit `compliance_check` (par preSendCheckWithAudit) : résultat
 *   - Audit `sms_provider_dispatched` (par ce code) : corrélation
 *     `messageId ↔ ovhMessageId ↔ contactId ↔ campaignId`
 */
import { NonRetriableError } from "inngest";

import { preSendCheckWithAudit } from "@/lib/compliance/pre-send-check-with-audit";
import { appendAuditLog } from "@/lib/firestore/audit-log";
import { getContact } from "@/lib/firestore/contacts";
import { conversationDocId, getConversation } from "@/lib/firestore/conversations";
import { addOutbound, listRecentOutbound } from "@/lib/firestore/messages";
import { getInngestClient } from "@/lib/inngest/client";
import { smsSendFirstRequested } from "@/lib/inngest/events";
import { sendSms } from "@/lib/ovh/send-sms";
import { getCoreEnv } from "@/lib/security/env";
import { ConfigError, ValidationError } from "@/lib/utils/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ID Inngest stable de la function. Apparaît dans le dashboard cloud et
 * dans les URLs d'exécution. NE PAS modifier après le premier déploiement
 * — perte d'historique côté Inngest.
 */
const FUNCTION_ID = "send-first-sms";

/**
 * Nom de l'émetteur (sender ID OVH) capturé dans l'audit pour forensic.
 * Aligné `CLAUDE.md > Sender alphanumérique cible : MEDERE` + skill
 * `medere-ovh-sms`.
 *
 * Pourquoi hardcoded plutôt que `getOvhEnv().OVH_SMS_SENDER` :
 * - Dev local peut être en dry-run sans env OVH set → `getOvhEnv()`
 *   throw ConfigError, ferait planter le step 4 même en dry-run.
 * - L'env OVH_SMS_SENDER est figée à "MEDERE" pour le MVP. Quand on
 *   bascule sur un autre sender (S9+ avec INFRA-SMS-001), mettre à jour
 *   les 2 endroits en cohérence (env + cette constante).
 */
const AUDIT_SENDER_NAME = "MEDERE";

// ─────────────────────────────────────────────────────────────────────────────
// Types de retour du handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Résultat de la function. Discriminé sur `status` pour permettre au
 * caller (Inngest dashboard, tests, futures invocations chaînées) un
 * narrowing TS propre.
 */
export type SendFirstSmsResult =
  | {
      status: "blocked";
      code: string;
      rule: string;
    }
  | {
      status: "sent";
      messageId: string;
      ovhMessageId: string;
      auditId: string;
      dryRun: boolean;
    };

// ─────────────────────────────────────────────────────────────────────────────
// Handler — exporté pour tests unitaires
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handler du job Inngest `send-first-sms`. Extrait en fonction nommée
 * pour faciliter les tests (peut être invoqué avec un fake `step`).
 *
 * Le typage du `ctx` est volontairement large (`InngestHandlerContext`
 * minimal) — Inngest type-check au site de `createFunction()`.
 *
 * @see JSDoc en-tête du fichier pour le détail du pipeline 4 steps.
 */
export async function sendFirstSmsHandler(ctx: InngestHandlerContext): Promise<SendFirstSmsResult> {
  const { event, step, logger } = ctx;
  const { contactId, campaignId, body } = event.data;

  // ── Step 1 : get-contact-and-history ──────────────────────────────────
  const loaded = await step.run("get-contact-and-history", async () => {
    const contact = await getContact(contactId);
    if (!contact) {
      throw new NonRetriableError(`Contact not found: ${contactId}`);
    }
    const cid = conversationDocId(contactId, campaignId);
    const conversation = await getConversation(cid);
    if (!conversation) {
      throw new NonRetriableError(`Conversation not found: ${cid}`);
    }
    const recentOutboundMessages = await listRecentOutbound(cid);
    return {
      contact,
      conversation,
      recentOutboundMessages,
      conversationId: cid,
    };
  });

  // ── Step 2 : compliance-pre-send-check ────────────────────────────────
  // L'audit `compliance_check` est posé AUTO par le wrapper S6.6 dans
  // les 2 branches (allowed / blocked). Pas de duplicate à gérer ici.
  const check = await step.run("compliance-pre-send-check", async () =>
    preSendCheckWithAudit({
      contact: loaded.contact,
      message: body,
      conversation: loaded.conversation,
      recentOutboundMessages: loaded.recentOutboundMessages,
    }),
  );
  if (!check.ok) {
    logger.info("[send-first-sms] compliance blocked", {
      eventId: event.id,
      contactId,
      conversationId: loaded.conversationId,
      code: check.failure.code,
      rule: check.failure.rule,
    });
    return { status: "blocked", code: check.failure.code, rule: check.failure.rule };
  }

  // ── Step 3 : ovh-send (dry-run ou réel) ───────────────────────────────
  const dispatch = await step.run("ovh-send", async (): Promise<DispatchResult> => {
    const { DRY_RUN_SMS } = getCoreEnv();
    if (DRY_RUN_SMS) {
      logger.info("[send-first-sms] DRY_RUN — would send", {
        eventId: event.id,
        contactId,
        conversationId: loaded.conversationId,
        bodyLength: body.length,
        // PAS de phone, PAS de body content (PII) — cf. CLAUDE.md règle
        // sécurité #9 "Logs sans PII".
      });
      return { ovhMessageId: null, dryRun: true, creditsRemoved: 0 };
    }
    try {
      const result = await sendSms({
        receivers: [loaded.contact.phone.e164],
        message: body,
      });
      return {
        ovhMessageId: result.messageIds[0] ?? null,
        dryRun: false,
        creditsRemoved: result.creditsRemoved,
      };
    } catch (err) {
      // ConfigError / ValidationError sont marquées noRetry=true côté
      // AppError. On les wrappe en NonRetriableError Inngest pour
      // bloquer le retry du step (sinon retry inutile).
      if (err instanceof ConfigError || err instanceof ValidationError) {
        throw new NonRetriableError(err.message, { cause: err });
      }
      // ExternalServiceError, RateLimitError, etc. = retry-friendly →
      // propage l'erreur native, Inngest retry par défaut (4 tentatives).
      throw err;
    }
  });

  // ── Step 4 : record-outbound-message ──────────────────────────────────
  // 4a. Enqueue Firestore via addOutbound (status="queued" figé S6.5).
  //     Pose AUSSI audit "sms_sent" {direction, messageId} (S6.5 contract).
  // 4b. Pose audit "sms_provider_dispatched" avec corrélation forensic
  //     ovhMessageId ↔ messageId Firestore ↔ contact ↔ campagne.
  const recorded = await step.run("record-outbound-message", async () => {
    const messageId = await addOutbound(loaded.conversationId, {
      body,
      channel: "sms",
      generatedBy: "ai",
      externalReceiver: loaded.contact.phone.e164,
    });

    // En dry-run, on construit un id stable basé sur le messageId Firestore
    // (qui est `[A-Za-z0-9]{20}` → scrubber-safe par construction, proba
    // de faux positif RE_FR_NATIONAL ~0.00002%).
    const finalOvhMessageId = dispatch.ovhMessageId ?? `dry-run-${messageId}`;

    const auditId = await appendAuditLog({
      actorId: "system",
      actorType: "system",
      action: "sms_provider_dispatched",
      targetType: "message",
      targetId: messageId,
      payload: {
        ovhMessageId: finalOvhMessageId,
        conversationId: loaded.conversationId,
        contactId,
        campaignId,
        sender: AUDIT_SENDER_NAME,
        bodyLength: body.length,
        dryRun: dispatch.dryRun,
        creditsRemoved: dispatch.creditsRemoved,
      },
    });

    return { messageId, auditId, finalOvhMessageId };
  });

  return {
    status: "sent",
    messageId: recorded.messageId,
    ovhMessageId: recorded.finalOvhMessageId,
    auditId: recorded.auditId,
    dryRun: dispatch.dryRun,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Function Inngest — wrap autour du handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inngest function.
 *
 * **Trigger** : event `medere/sms.send-first.requested` (Zod-validated
 * via `events.ts` — `{contactId, campaignId, body}`).
 *
 * **Concurrency** [GF1] : `{ key: "event.data.contactId", limit: 1 }`.
 *   - 2 jobs simultanés sur le même `contactId` → 2ème enqueued, exécuté
 *     APRÈS la fin du 1er. Pas de race rate-limit possible.
 *   - Jobs sur des `contactId` différents → parallèles (pas de blocage
 *     global). Limit total = quota plan Inngest, hors-scope S8.
 *
 * **Handler** : `sendFirstSmsHandler` (exporté pour tests).
 */
export const sendFirstSms = getInngestClient().createFunction(
  {
    id: FUNCTION_ID,
    triggers: [{ event: smsSendFirstRequested }],
    // [GF1] Verrouillé par test sentinelle (cf. `send-first-sms.test.ts`).
    // Ne PAS retirer ni modifier sans payer la dette INFRA-DETTE-001
    // (cf. JSDoc en-tête de ce fichier).
    concurrency: {
      key: "event.data.contactId",
      limit: 1,
    },
  },
  sendFirstSmsHandler,
);

// ─────────────────────────────────────────────────────────────────────────────
// Types internes (exportés pour tests)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Forme minimale du contexte que Inngest passe au handler. Sert au
 * typage du `sendFirstSmsHandler` exporté et à la fabrication d'un
 * fake context en tests.
 */
export interface InngestHandlerContext {
  event: {
    id?: string;
    name: string;
    data: {
      contactId: string;
      campaignId: string;
      body: string;
    };
  };
  step: {
    run: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  };
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
  };
}

/** Résultat interne du step `ovh-send`. */
interface DispatchResult {
  ovhMessageId: string | null;
  dryRun: boolean;
  creditsRemoved: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exposés pour tests sentinelles
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export const __FUNCTION_ID_FOR_TESTS = FUNCTION_ID;

/** @internal */
export const __AUDIT_SENDER_NAME_FOR_TESTS = AUDIT_SENDER_NAME;
