/**
 * Inngest function `send-reply` — dispatch OVH du draft réponse IA (S9.4.2).
 *
 * Trigger event `medere/sms.reply.send-requested` émis par
 * `process-reply.ts` step 8d (S9.4.3) après step 9 `audit-reply-processed`
 * sur la branche `classified`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * VUE D'ENSEMBLE
 *
 * Ferme la boucle "draft généré (S9.3.3b) → SMS reçu par le PS".
 *
 * Pipeline 3 steps + step conditionnel record-failure inline :
 *
 *   1. `commit-draft`        : `commitDraftToQueued(conversationId,
 *                              draftMessageId)` — tx atomique compliance
 *                              re-validation 9 rules + transition
 *                              draft→queued + audit `sms_sent` + audit
 *                              `compliance_check (allowed)`.
 *                              - Si rule fail → tx rollback + audits
 *                                blocked posés HORS tx par commitDraftToQueued.
 *                                Handler return early `blocked_by_compliance`.
 *                              - Si OK → continuer step 2.
 *
 *   2. `ovh-send`            : Lit body + phone INLINE (defense-in-depth
 *                              anti-PII : ne pas leak dans le step result
 *                              memoizé Inngest cloud) puis branche
 *                              `DRY_RUN_SMS` ou appel `sendSms` réel.
 *                              - DRY_RUN → return `{ovhMessageId: null,
 *                                dryRun: true, ...}`.
 *                              - OVH ack 200 → return `{ovhMessageId,
 *                                dryRun: false, creditsRemoved, bodyLength}`.
 *                              - ConfigError/ValidationError (noRetry)
 *                                → INLINE updateMessageStatus(failed) +
 *                                throw NonRetriableError (asymétrie S6 :
 *                                cf. caveat Option B ci-dessous).
 *                              - ExternalServiceError/Rate/Network → propage
 *                                tel quel → Inngest retry naturel.
 *
 *   3. `audit-dispatched`    : `appendAuditLog("sms_provider_dispatched",
 *                              payload)`. Forensic narratif sur même
 *                              messageId : reply_generated (S9.3.3b) →
 *                              sms_sent (S9.4.1) → sms_provider_dispatched
 *                              (ici).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 OPTION B — commit Firestore AVANT dispatch OVH (S9.4.0 Q-B arbitrage)
 *
 * Le draft est DÉJÀ en `status="queued"` (committed par
 * `commitDraftToQueued` step 1) AVANT l'appel `sendSms`. Si OVH succeed
 * → bien. Si OVH fail noRetry (ConfigError) → on a un message orphelin
 * en `queued`, qu'on DOIT transitionner à `"failed"` (sinon le cron
 * monitoring S9.4.4 lèvera une alerte orphan draft).
 *
 * **Asymétrie vs S6 send-first-sms.ts** :
 *   - S6 : OVH d'abord (step 3), Firestore créé en queued APRÈS (step 4
 *          via sendOutboundWithLock). Si OVH fail → le message N'EXISTE
 *          PAS encore → pas de transition à faire. NonRetriableError suffit.
 *   - S9.4.2 : Firestore committed en queued AVANT OVH. Si OVH fail
 *               noRetry → transition queued→failed + audit sms_failed
 *               POSÉ via updateMessageStatus. NonRetriableError ensuite.
 *
 * Cette asymétrie est due au pattern Option B (qui était lui-même imposé
 * par la fenêtre temporelle S9.3→S9.4 minutes/heures qui permet un consent
 * drift). Documentée en JSDoc de `commitDraftToQueued` (`send-reply.ts`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 PATTERN "queued en attente DLR" — VOLONTAIRE (cohérence S6)
 *
 * Sur le **happy path** (OVH ack 200), le message reste `status="queued"`
 * — PAS de transition `queued → sent` ici. Cohérent send-first-sms.ts
 * (cf. JSDoc messages.ts:42). La transition `queued → sent | delivered |
 * failed` est reportée au webhook DLR (S7 — non livré encore).
 *
 * Conséquence en prod actuelle : tous les SMS envoyés OVH OK ont
 * `messages.status = "queued"` indéfiniment (jusqu'au DLR webhook S7).
 *
 * Suivi : follow-up Notion `S7-POST-OVH-ACK-STATUS-001` — activer
 * `queued → sent` immédiatement post-OVH-ack symétriquement en
 * send-first-sms + send-reply. Pas dans le scope S9.4.
 *
 * Si bug rapporté "messages stuck in queued" → c'est probablement S7 qui
 * manque, pas S9.4.2. Vérifier la cron monitoring S9.4.4 d'abord (orphan
 * drafts) avant de chercher un bug dans ce handler.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * GARDE-FOUS
 *
 *   [GF1] `concurrency: { key: "event.data.contactId", limit: 1 }` —
 *         miroir send-first-sms.ts GF1 INFRA-DETTE-001. Sérialise les
 *         dispatch sur un même contact pour limiter la surface race
 *         (defense-in-depth ; la correctness vient de `withContactLock`
 *         Firestore via `commitDraftToQueued`).
 *
 *   [GF2] `retries: 3` — choix explicite (= default Inngest v4.x mais
 *         visible). Cohérent process-reply S9.3.1.
 *
 *   [GF3] Anti-PII strict :
 *         - body / phoneE164 jamais loggés (uniquement IDs opaques)
 *         - body / phoneE164 LU INLINE dans step 2 (pas via step retour)
 *         - payload audit sms_provider_dispatched = bodyLength (number),
 *           ovhMessageId, dryRun, creditsRemoved, sender, IDs opaques
 *
 *   [GF4] DRY_RUN_SMS env-driven via `getCoreEnv().DRY_RUN_SMS` (cohérent
 *         send-first-sms.ts S8.4). Pattern audit en dry-run : sender =
 *         "DRY_RUN_SENDER", ovhMessageId = "DRY_RUN_OVH_MESSAGE_ID".
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * RETOURS DU HANDLER (discriminés)
 *
 *   - `dispatched`           : OVH ack 200 + audit dispatched posé. Le
 *                              message Firestore reste `status="queued"`
 *                              (cf. caveat DLR ci-dessus).
 *   - `blocked_by_compliance`: rule compliance fail dans commitDraftToQueued.
 *                              Audit `reply_draft_dropped` + audit
 *                              `compliance_check (blocked)` déjà posés
 *                              HORS tx par commitDraftToQueued. Le draft
 *                              reste `status="draft"` (jamais committed).
 *                              Pas de retry (sortie propre).
 *
 * Cas OVH fail noRetry (ConfigError/ValidationError) → NonRetriableError
 * thrown au caller (Inngest cloud) → marqué "failed" dans dashboard
 * Inngest. Le message Firestore est `status="failed"` (transition posée
 * par updateMessageStatus DANS le step ovh-send).
 *
 * Cas OVH fail retry (ExternalServiceError/Network/Rate) → thrown tel
 * quel → Inngest retry naturel. Le message reste `status="queued"`. Si
 * retries épuisés, Inngest marque la function "failed" mais Firestore
 * reste "queued" → cron monitoring S9.4.4 catchera.
 */
import { NonRetriableError } from "inngest";

import { getAdminDb } from "@/lib/firestore/admin";
import { appendAuditLog } from "@/lib/firestore/audit-log";
import { getContact } from "@/lib/firestore/contacts";
import {
  _parseMessageOrThrow,
  type MessageFailureCode,
  updateMessageStatus,
} from "@/lib/firestore/messages";
import { commitDraftToQueued } from "@/lib/firestore/send-reply";
import { getInngestClient } from "@/lib/inngest/client";
import { smsReplySendRequested } from "@/lib/inngest/events";
import { sendSms } from "@/lib/ovh/send-sms";
import { getCoreEnv, getOvhEnv } from "@/lib/security/env";
import { ConfigError, ValidationError } from "@/lib/utils/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ID Inngest stable de la function. Apparaît dans le dashboard cloud et
 * dans les URLs d'exécution. NE PAS modifier après le premier déploiement
 * (perte d'historique côté Inngest).
 */
const FUNCTION_ID = "send-reply";

/**
 * Sender symbolique posé dans l'audit `sms_provider_dispatched` lorsqu'on
 * tourne en DRY_RUN_SMS=true. Identique pattern send-first-sms.ts S8.4 —
 * signale EXPLICITEMENT côté forensic Firestore qu'aucun dispatch OVH
 * réel n'a eu lieu.
 */
const AUDIT_SENDER_DRY_RUN = "DRY_RUN_SENDER";

/**
 * `ovhMessageId` symbolique posé dans l'audit `sms_provider_dispatched`
 * lorsqu'on tourne en DRY_RUN_SMS=true. Identique pattern send-first-sms.ts.
 */
const AUDIT_OVH_MESSAGE_ID_DRY_RUN = "DRY_RUN_OVH_MESSAGE_ID";

/**
 * Path Firestore collection conversations — aligné `conversations.ts`
 * pour lecture inline du draft dans le step ovh-send.
 */
const CONVERSATIONS_COLLECTION = "conversations";

const MESSAGES_SUBCOLLECTION = "messages";

// ─────────────────────────────────────────────────────────────────────────────
// Types de retour du handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Résultat discriminé sur `status`. Permet au caller (tests, dashboard
 * Inngest, futures invocations chaînées) un narrowing TS propre.
 */
export type SendReplyResult =
  | {
      status: "dispatched";
      contactId: string;
      conversationId: string;
      draftMessageId: string;
      /**
       * ID OVH renvoyé en mode réel (HTTP 200), `null` en dry-run.
       * Côté audit forensique, on a `AUDIT_OVH_MESSAGE_ID_DRY_RUN` dans
       * le payload (signal explicite vs un ID OVH réel).
       */
      ovhMessageId: string | null;
      dryRun: boolean;
      auditId: string;
    }
  | {
      status: "blocked_by_compliance";
      contactId: string;
      conversationId: string;
      draftMessageId: string;
      blockedRule: string;
      blockedCode: string;
    };

/** Résultat interne du step `ovh-send` — exposé en retour de step.run. */
interface DispatchResult {
  ovhMessageId: string | null;
  dryRun: boolean;
  creditsRemoved: number;
  /** Longueur du body (scrubber-safe number). JAMAIS le body lui-même. */
  bodyLength: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler — exporté pour tests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Forme minimale du contexte que Inngest passe au handler. Sert au typage
 * du `sendReplyHandler` exporté et à la fabrication d'un fake context en
 * tests (pattern miroir `InngestHandlerContext` de send-first-sms.ts).
 */
export interface SendReplyHandlerContext {
  event: {
    id?: string;
    name: string;
    data: {
      contactId: string;
      conversationId: string;
      draftMessageId: string;
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

/**
 * Handler du job Inngest `send-reply`. Extrait en fonction nommée pour
 * faciliter les tests (peut être invoqué avec un fake `step`).
 *
 * Cf. JSDoc en-tête du fichier pour le détail du pipeline.
 */
export async function sendReplyHandler(ctx: SendReplyHandlerContext): Promise<SendReplyResult> {
  const { event, step, logger } = ctx;
  const { contactId, conversationId, draftMessageId } = event.data;

  // ── Step 1 : commit-draft ─────────────────────────────────────────────
  // Tx atomique : compliance re-validation (9 rules) + transition
  // draft→queued + audits sms_sent + compliance_check (allowed). Si rule
  // fail → tx rollback + commitDraftToQueued pose HORS tx les 2 audits
  // best-effort (compliance_check blocked + reply_draft_dropped). On
  // détecte via {ok: false} et on return early.
  const commitResult = await step.run("commit-draft", async () => {
    return commitDraftToQueued({
      conversationId,
      draftMessageId,
      now: new Date(),
    });
  });

  if (!commitResult.ok) {
    // Pas de dispatch OVH. Audits déjà posés par commitDraftToQueued
    // (cf. send-reply.ts:432-508). Log applicatif pour observabilité.
    logger.warn("[send-reply] blocked by compliance", {
      eventId: event.id,
      contactId,
      conversationId,
      draftMessageId,
      blockedRule: commitResult.failure.rule,
      blockedCode: commitResult.failure.code,
      // PAS de blockedContext dans le log Pino (defense-in-depth — il vit
      // dans l'audit_log reply_draft_dropped pour forensic).
    });
    return {
      status: "blocked_by_compliance",
      contactId,
      conversationId,
      draftMessageId,
      blockedRule: commitResult.failure.rule,
      blockedCode: commitResult.failure.code,
    };
  }

  // ── Step 2 : ovh-send (dry-run ou réel) ───────────────────────────────
  // Lecture body + phoneE164 INLINE pour ne PAS leak ces PII dans le
  // step.run result memoizé par Inngest cloud (cf. GF3 anti-PII).
  // Le retour du step.run ne contient QUE des données scrubber-safe
  // (number bodyLength, string ovhMessageId, boolean dryRun).
  const dispatch = await step.run("ovh-send", async (): Promise<DispatchResult> => {
    // Re-lecture du draft (maintenant en status="queued" post-step 1) +
    // contact pour le dispatch OVH. Cohérent send-first-sms.ts step 1 +
    // step 3 (load + dispatch).
    const messageDoc = await getAdminDb()
      .collection(CONVERSATIONS_COLLECTION)
      .doc(conversationId)
      .collection(MESSAGES_SUBCOLLECTION)
      .doc(draftMessageId)
      .get();
    if (!messageDoc.exists) {
      // Cas pathologique : le message a disparu entre commit-draft et
      // ovh-send (purge manuelle, race admin). NonRetriableError —
      // pas la peine de retry, le doc ne va pas réapparaître.
      throw new NonRetriableError(
        `Message vanished after commit: ${draftMessageId} in ${conversationId}`,
      );
    }
    const message = _parseMessageOrThrow(messageDoc.data(), conversationId, draftMessageId);

    // Defense-in-depth : commitDraftToQueued a posé status="queued" mais
    // on re-vérifie ici. Si quelqu'un a écrit autre chose entre temps
    // (race admin, bug code futur), on bail propre.
    if (message.status !== "queued") {
      throw new NonRetriableError(
        `Expected message status "queued" post-commit, got "${message.status}"`,
      );
    }

    const contact = await getContact(contactId);
    if (!contact) {
      // Contact supprimé entre commitDraftToQueued (qui a lu via
      // withContactLock) et maintenant. Cas pathologique anormal.
      throw new NonRetriableError(`Contact not found post-commit: ${contactId}`);
    }

    const { DRY_RUN_SMS } = getCoreEnv();
    if (DRY_RUN_SMS) {
      logger.info("[send-reply] DRY_RUN — would send", {
        eventId: event.id,
        contactId,
        conversationId,
        draftMessageId,
        bodyLength: message.body.length,
        // PAS de phone, PAS de body content (PII).
      });
      return {
        ovhMessageId: null,
        dryRun: true,
        creditsRemoved: 0,
        bodyLength: message.body.length,
      };
    }

    // Mode réel — appel OVH.
    try {
      const result = await sendSms({
        receivers: [contact.phone.e164],
        message: message.body,
      });
      return {
        ovhMessageId: result.messageIds[0] ?? null,
        dryRun: false,
        creditsRemoved: result.creditsRemoved,
        bodyLength: message.body.length,
      };
    } catch (err) {
      // ── ASYMÉTRIE OPTION B — transition queued → failed sur noRetry ──
      // En S6 (send-first-sms.ts:282), ConfigError/ValidationError sont
      // wrappés en NonRetriableError sans toucher Firestore (le message
      // n'est pas encore créé). En S9.4.2, le message EXISTE en queued
      // depuis le step 1 — on DOIT le transitionner à failed pour pas
      // laisser un orphelin queued qui ne sera jamais envoyé.
      if (err instanceof ConfigError || err instanceof ValidationError) {
        const failureCode: MessageFailureCode =
          err instanceof ConfigError ? "config_error" : "validation_error";

        // Best-effort updateMessageStatus — pattern miroir S6 MED-1
        // (`send_blocked` posé HORS tx en best-effort). Si update fail,
        // on log mais on propage l'erreur ORIGINALE pour ne pas masquer
        // la cause racine côté Sentry.
        try {
          await updateMessageStatus({
            conversationId,
            messageId: draftMessageId,
            status: "failed",
            failureReason: {
              code: failureCode,
              // err.message est sanitized par le wrapper OVH (jamais
              // receivers/body dans AppError.message — cf. send-sms.ts
              // l.91-102 anti-fuite credentials & PII).
              detail: err.message,
              retryCount: 0,
            },
          });
        } catch (updateErr) {
          // Trou forensique acceptable (correctness compliance préservée :
          // OVH a refusé, aucun SMS envoyé). Cron monitoring S9.4.4 listera
          // l'orphan queued si la transition fail.
          logger.error(
            {
              eventId: event.id,
              contactId,
              conversationId,
              draftMessageId,
              failureCode,
              updateError: updateErr instanceof Error ? updateErr.message : "unknown",
            },
            "[send-reply] failed to update message status to failed (best-effort)",
          );
        }

        // Re-throw NonRetriableError — Inngest marque la function failed
        // sans retry (cohérent send-first-sms.ts:282-285).
        throw new NonRetriableError(err.message, { cause: err });
      }

      // ExternalServiceError, RateLimitError, network — propage tel quel
      // pour Inngest retry naturel (4 tentatives par défaut + backoff
      // exponentiel). Le message reste status="queued" entre les retries.
      throw err;
    }
  });

  // ── Step 3 : audit-dispatched ─────────────────────────────────────────
  // Audit forensique OVH dispatch. Pattern miroir send-first-sms.ts step 4
  // (sendOutboundWithLock pose `sms_provider_dispatched` DANS sa tx). En
  // S9.4.2, l'audit est posé HORS tx car le message est déjà committed
  // (status="queued") via commitDraftToQueued step 1.
  //
  // Forensic narratif complet sur même messageId :
  //   reply_generated (S9.3.3b création draft, payload sans body)
  //     ↓
  //   sms_sent (S9.4.1 commitDraftToQueued transition draft→queued)
  //     ↓
  //   sms_provider_dispatched (S9.4.2 OVH ack 200) ← ICI
  //     ↓
  //   sms_delivered | sms_failed (S7 webhook DLR — futur)
  const sender = dispatch.dryRun ? AUDIT_SENDER_DRY_RUN : getOvhEnv().OVH_SMS_SENDER;
  // En dry-run et en mode réel sans ovhMessageId retourné par OVH (cas
  // rare), on pose le marqueur symbolique pour signaler EXPLICITEMENT
  // qu'aucun ID OVH effectif n'est disponible. Le `targetId` de l'audit
  // contient `draftMessageId` qui assure la corrélation forensique.
  const auditOvhMessageId = dispatch.dryRun
    ? AUDIT_OVH_MESSAGE_ID_DRY_RUN
    : (dispatch.ovhMessageId ?? AUDIT_OVH_MESSAGE_ID_DRY_RUN);

  const auditId = await step.run("audit-dispatched", async () => {
    return appendAuditLog({
      actorId: "system",
      actorType: "system",
      action: "sms_provider_dispatched",
      targetType: "message",
      targetId: draftMessageId,
      // Payload anti-PII strict : bodyLength (number) + IDs opaques +
      // marqueurs scrubber-safe. JAMAIS le body, JAMAIS le phone.
      payload: {
        direction: "outbound",
        messageId: draftMessageId,
        ovhMessageId: auditOvhMessageId,
        sender,
        bodyLength: dispatch.bodyLength,
        dryRun: dispatch.dryRun,
        creditsRemoved: dispatch.creditsRemoved,
        contactId,
        conversationId,
      },
    });
  });

  logger.info("[send-reply] dispatched", {
    eventId: event.id,
    contactId,
    conversationId,
    draftMessageId,
    dryRun: dispatch.dryRun,
    // PAS d'ovhMessageId en log applicatif (semi-sensible cf. messages.ts:36-54).
  });

  return {
    status: "dispatched",
    contactId,
    conversationId,
    draftMessageId,
    ovhMessageId: dispatch.ovhMessageId,
    dryRun: dispatch.dryRun,
    auditId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Inngest function — wrap autour du handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inngest function `send-reply`.
 *
 * **Trigger** : event `medere/sms.reply.send-requested` (`SmsReplySendRequestedDataSchema`
 * = `{contactId, conversationId, draftMessageId}` strict).
 *
 * **Concurrency** [GF1] : `{ key: "event.data.contactId", limit: 1 }`.
 * Miroir send-first-sms.ts INFRA-DETTE-001 — sérialise les dispatch sur
 * un même contact pour limiter la surface race rate-limit
 * (defense-in-depth, la correctness vient de `withContactLock` Firestore
 * via `commitDraftToQueued`).
 *
 * **Retries** [GF2] : `3` (= default Inngest v4.x mais choix EXPLICITE
 * pour visibilité). Cohérent process-reply S9.3.1.
 */
export const sendReply = getInngestClient().createFunction(
  {
    id: FUNCTION_ID,
    triggers: [{ event: smsReplySendRequested }],
    concurrency: {
      key: "event.data.contactId",
      limit: 1,
    },
    retries: 3,
  },
  sendReplyHandler,
);

// ─────────────────────────────────────────────────────────────────────────────
// Exposés pour tests sentinelles
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export const __FUNCTION_ID_FOR_TESTS = FUNCTION_ID;

/** @internal */
export const __AUDIT_SENDER_DRY_RUN_FOR_TESTS = AUDIT_SENDER_DRY_RUN;

/** @internal */
export const __AUDIT_OVH_MESSAGE_ID_DRY_RUN_FOR_TESTS = AUDIT_OVH_MESSAGE_ID_DRY_RUN;

/** @internal */
export const __CONVERSATIONS_COLLECTION_FOR_TESTS = CONVERSATIONS_COLLECTION;

/** @internal */
export const __MESSAGES_SUBCOLLECTION_FOR_TESTS = MESSAGES_SUBCOLLECTION;
