/**
 * Inngest function `send-first-sms` — orchestration de l'envoi du premier
 * SMS d'une campagne à un contact (Phase 1 MVP, S8.4).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INFRA-DETTE-001 + INFRA-DETTE-004 — PAYÉES par DEBT-001 (DEBT-001.5)
 *
 * L'implémentation Phase 1 S8 reposait sur **Inngest concurrency par
 * `event.data.contactId`** (limit 1) pour sérialiser les envois sur un
 * même contact. DEBT-001 (DEBT-001.1 → .5) a payé la dette en composant
 * une transaction Firestore unique via `sendOutboundWithLock` qui ferme
 * la race condition rate-limit by-construction côté Firestore :
 *
 *   - `addOutboundInTx` extrait de `addOutbound`          (DEBT-001.2)
 *   - `listRecentOutboundInTx`                            (DEBT-001.2)
 *   - `ComplianceConcurrencyError` retry-friendly         (DEBT-001.1)
 *   - `sendOutboundWithLock` (compose tout en 1 tx atomique) (DEBT-001.3)
 *   - Step 4 migré vers `sendOutboundWithLock`            (DEBT-001.5)
 *
 * Le concurrency Inngest `key=contactId, limit=1` (GF1) est **conservé**
 * en defense-in-depth : il évite de mobiliser Firestore pour rien quand
 * 2 events arrivent en burst sur le même contact (la 2ème queue côté
 * Inngest et lit l'état réel après commit de la 1ère). C'est une
 * optimisation, plus une exigence de correctness.
 *
 * INFRA-DETTE-004 (atomicité audit `sms_provider_dispatched`) est aussi
 * payée par DEBT-001.3 : `sendOutboundWithLock` pose le message + les
 * 2 audits (`sms_sent` interne + `sms_provider_dispatched`) DANS la
 * MÊME transaction Firestore. Plus de window de retry Inngest qui
 * laisserait un message orphelin sans audit dispatch.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * GARDE-FOUS S8 (conservés en defense-in-depth post-DEBT-001)
 *
 *   [GF1] `concurrency: { key: "event.data.contactId", limit: 1 }`
 *         → optimisation : évite un Firestore round-trip + retry pour
 *           rien quand 2 events arrivent en burst sur le même contact.
 *           POST-DEBT-001 : la correctness ne dépend plus de GF1, mais
 *           le retirer aurait un coût d'efficacité opérationnelle.
 *           Test sentinelle dans `send-first-sms.test.ts` verrouille la
 *           présence de cette config par inspection structurelle.
 *
 *   [GF2] JSDoc INFRA-DETTE-001 (ce bloc) explicite dans le code.
 *
 *   [GF3] Test sentinelle anti-régression — vérifie EXACTEMENT que
 *         `sendFirstSms.opts.concurrency.{key, limit}` ne sont pas
 *         retirés ou modifiés silencieusement (cf. `send-first-sms.test.ts`).
 *
 *   [GF4] Référence Notion `INFRA-DETTE-001` dans tous les commits S8+
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
 *   4. `record-outbound-message`  : `sendOutboundWithLock(args)` —
 *                                    composition tx atomique (DEBT-001.3).
 *                                    Acquiert lock contact, re-check
 *                                    rate-limit DANS la tx, write message
 *                                    (status="queued") + 2 audits
 *                                    (`sms_sent` interne + `sms_provider_
 *                                    dispatched`) → tout commit ou tout
 *                                    rollback. Si `ComplianceConcurrencyError`
 *                                    thrown (race au commit), audit
 *                                    `send_blocked` posé HORS tx pour
 *                                    forensique puis erreur re-thrown
 *                                    → Inngest retry naturel.
 *
 * En dry-run, `finalOvhMessageId = "dry-run-<firestoreMessageId>"` (le
 * messageId Firestore est `[A-Za-z0-9]{20}` → scrubber-safe) et
 * `sender = "DRY_RUN_SENDER"` (littéral neutre). En mode réel, `sender`
 * est lu via `getOvhEnv().OVH_SMS_SENDER` → reflète EXACTEMENT le sender
 * utilisé par OVH (cf. INFRA-FIX-AUDIT-SENDER, S8.10).
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
import { RATE_LIMIT_MAX_MESSAGES } from "@/lib/compliance/rate-limits";
import { appendAuditLog } from "@/lib/firestore/audit-log";
import { getContact } from "@/lib/firestore/contacts";
import { conversationDocId, getConversation } from "@/lib/firestore/conversations";
import { listRecentOutbound } from "@/lib/firestore/messages";
import { sendOutboundWithLock } from "@/lib/firestore/transactions";
import { getInngestClient } from "@/lib/inngest/client";
import { smsSendFirstRequested } from "@/lib/inngest/events";
import { sendSms } from "@/lib/ovh/send-sms";
import { getCoreEnv, getOvhEnv } from "@/lib/security/env";
import { ComplianceConcurrencyError, ConfigError, ValidationError } from "@/lib/utils/errors";

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
 * Sender symbolique posé dans l'audit `sms_provider_dispatched` lorsqu'on
 * tourne en DRY_RUN_SMS=true (aucun appel OVH réel n'est fait).
 *
 * Pourquoi un littéral et pas `getOvhEnv().OVH_SMS_SENDER` :
 * - Le dry-run doit pouvoir tourner en dev local SANS env OVH set
 *   (cf. `getCoreEnv().DRY_RUN_SMS` default `true`). Si on appelait
 *   `getOvhEnv()` ici, un dev sans `OVH_*` configuré crasherait sur un
 *   `ConfigError` au step 4 alors qu'aucun envoi réel n'a lieu.
 * - Le littéral choisi (`"DRY_RUN_SENDER"`) signale EXPLICITEMENT dans le
 *   forensic Firestore qu'aucun OVH dispatch n'a eu lieu (≠ d'un vrai
 *   sender alphanumérique qui aurait été utilisé côté OVH).
 *
 * En branche RÉELLE (`!DRY_RUN_SMS`), on lit `getOvhEnv().OVH_SMS_SENDER`
 * → l'audit reflète exactement le sender utilisé par OVH, par construction
 * (cf. INFRA-FIX-AUDIT-SENDER, S8.10 — bug initial : sender hardcoded
 * "MEDERE" alors que la config réelle peut différer, ex: "NESF").
 *
 * Test sentinelle :
 *   - "audit reflects env.OVH_SMS_SENDER (env-driven, non hardcoded)"
 *     verrouille le contrat env→audit en mode réel.
 *   - "getOvhEnv n'est pas appelé en branche DRY_RUN" verrouille la garde
 *     anti-crash dev local.
 */
const AUDIT_SENDER_DRY_RUN = "DRY_RUN_SENDER";

/**
 * `ovhMessageId` symbolique posé dans l'audit `sms_provider_dispatched`
 * lorsqu'on tourne en DRY_RUN_SMS=true (aucun appel OVH réel n'est fait).
 *
 * Post-DEBT-001.5 : la composition `dry-run-${messageId}` HORS tx n'est
 * plus possible car le messageId Firestore est généré DANS la tx atomique
 * (`sendOutboundWithLock`). Le littéral neutre `"DRY_RUN_OVH_MESSAGE_ID"`
 * signale EXPLICITEMENT côté forensic Firestore qu'aucun dispatch OVH
 * réel n'a eu lieu — corrélation préservée via `targetId` de l'audit qui
 * contient le messageId Firestore.
 *
 * Le RETOUR de la function (`sendFirstSmsHandler.result.ovhMessageId`)
 * continue d'exposer `dry-run-${messageId}` (back-compat S8.4).
 */
const AUDIT_OVH_MESSAGE_ID_DRY_RUN = "DRY_RUN_OVH_MESSAGE_ID";

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

  // ── Step 4 : record-outbound-message (DEBT-001.5 — sendOutboundWithLock) ──
  // Composition tx atomique unique :
  //   - withContactLock(contactId) — lock optimiste Firestore
  //   - re-check rate-limit DANS la tx via listRecentOutboundInTx
  //   - addOutboundInTx — message + audit sms_sent interne
  //   - appendAuditLogTx — audit sms_provider_dispatched
  // Tout commit OU tout rollback (DETTE-001 + DETTE-004 fermées).
  //
  // Si `ComplianceConcurrencyError` thrown DANS la tx (race au commit, autre
  // tx a saturé le plafond entre pre-check HORS tx et notre commit) :
  // on log audit `send_blocked` forensique HORS tx PUIS on re-throw pour
  // que Inngest retry naturellement (ComplianceConcurrencyError.noRetry=false).
  const recorded = await step.run("record-outbound-message", async () => {
    // Sender env-driven en mode réel, littéral neutre en dry-run.
    // Cf. INFRA-FIX-AUDIT-SENDER (S8.10) : on NE LIT PAS getOvhEnv() en
    // dry-run pour ne pas crasher en dev local sans config OVH.
    //
    // Contrat implicite step3 → step4 (security review S8.10) : si on
    // arrive ici en branche !dryRun, c'est que `sendSms()` (step 3) a
    // appelé `getOvhEnv()` avec succès AVANT — donc l'env OVH est
    // forcément valide à ce point.
    const sender = dispatch.dryRun ? AUDIT_SENDER_DRY_RUN : getOvhEnv().OVH_SMS_SENDER;

    // ovhMessageId à enregistrer dans l'audit `sms_provider_dispatched` :
    //   - mode réel : l'ID OVH renvoyé par sendSms() (step 3)
    //   - dry-run   : littéral neutre AUDIT_OVH_MESSAGE_ID_DRY_RUN
    //                 (cohérent avec AUDIT_SENDER_DRY_RUN — signale
    //                 EXPLICITEMENT côté forensic Firestore qu'aucun
    //                 dispatch OVH réel n'a eu lieu). Le targetId de
    //                 l'audit contient le messageId Firestore (posé par
    //                 addOutboundInTx) — corrélation forensique préservée
    //                 par cette voie.
    //
    // Pré-DEBT-001.5 : on composait `dry-run-${messageId}` HORS tx après
    // l'enqueue Firestore. Avec sendOutboundWithLock, le messageId est
    // généré DANS la tx — on ne le connaît pas au moment de construire
    // les args. Le passage à un littéral neutre est l'arbitrage le plus
    // simple (targetId de l'audit assure la corrélation).
    const auditOvhMessageId = dispatch.dryRun
      ? AUDIT_OVH_MESSAGE_ID_DRY_RUN
      : (dispatch.ovhMessageId ?? AUDIT_OVH_MESSAGE_ID_DRY_RUN);

    // Quota restant lu HORS tx par pre-send-check / get-contact-and-history
    // (step 1 + step 2). Hydratera ComplianceConcurrencyError.context si
    // la race est détectée DANS la tx. Décision Déthié Q-S5.1 DEBT-001.5 :
    // RATE_LIMIT_MAX_MESSAGES exporté de lib/compliance/rate-limits.ts —
    // single source of truth, anti-drift.
    const expectedRemainingQuota = RATE_LIMIT_MAX_MESSAGES - loaded.recentOutboundMessages.length;

    try {
      const result = await sendOutboundWithLock({
        contactId,
        campaignId,
        conversationId: loaded.conversationId,
        input: {
          body,
          channel: "sms",
          generatedBy: "ai",
          externalReceiver: loaded.contact.phone.e164,
        },
        dispatch: {
          ovhMessageId: auditOvhMessageId,
          sender,
          bodyLength: body.length,
          creditsRemoved: dispatch.creditsRemoved,
          dryRun: dispatch.dryRun,
        },
        expectedRemainingQuota,
      });

      // Pour le RETOUR de la function (consommé par tests + Inngest
      // dashboard), on expose le format historique :
      //   - mode réel : l'ID OVH réel
      //   - dry-run   : `dry-run-${messageId}` (back-compat S8.4 — le
      //                 messageId Firestore existe maintenant qu'addOutbound
      //                 a commit, donc on peut composer).
      const exposedOvhMessageId = dispatch.ovhMessageId ?? `dry-run-${result.messageId}`;

      return {
        messageId: result.messageId,
        auditId: result.auditId,
        finalOvhMessageId: exposedOvhMessageId,
      };
    } catch (err) {
      if (err instanceof ComplianceConcurrencyError) {
        // Forensique : on enregistre la race détectée AVANT de re-throw
        // pour Inngest retry. Le retry naturel relira l'état Firestore
        // mis à jour côté pre-check et soit passera, soit re-bloquera
        // proprement via ComplianceError("rate_limit_exceeded") HORS tx.
        logger.warn("[send-first-sms] rate_limit race detected — re-throw for Inngest retry", {
          eventId: event.id,
          contactId,
          conversationId: loaded.conversationId,
          ruleName: err.context.ruleName,
          // PAS de phone, PAS de body content — cf. règle CLAUDE.md.
        });

        // DEBT-001.7 security-reviewer MED-1 : best-effort autour de
        // l'audit `send_blocked`. Si `appendAuditLog` throw (Firestore
        // I/O transient, AuditPiiError sur un payload futur mal posé),
        // on DOIT toujours propager la `ComplianceConcurrencyError`
        // originale à Inngest pour déclencher le retry naturel — pas
        // remplacer la pile d'exception par l'erreur d'audit qui
        // masquerait la cause racine côté Sentry et empêcherait le
        // mapping retry-friendly correct. L'audit `send_blocked` est
        // forensiquement précieux mais NON essentiel à la correctness
        // (le retry naturel rejouera et convergera).
        try {
          await appendAuditLog({
            actorId: "system",
            actorType: "system",
            action: "send_blocked",
            targetType: "contact",
            targetId: contactId,
            payload: {
              rule: "rate_limit_concurrency",
              contactId: err.context.contactId,
              conversationId: loaded.conversationId,
              campaignId,
              ruleName: err.context.ruleName,
              attemptedAt: err.context.attemptedAt.toISOString(),
              expectedRemainingQuota: err.context.expectedRemainingQuota,
              observedRemainingQuota: err.context.observedRemainingQuota,
              // dryRun + ovhMessageId du dispatch HORS tx — corrélation
              // forensique : "OVH a déjà accepté l'envoi côté provider
              // (ou aurait dry-run) MAIS Firestore a rollback côté
              // persistance suite à la race".
              dryRun: dispatch.dryRun,
              ovhMessageIdAttempted: dispatch.ovhMessageId ?? null,
            },
          });
        } catch (auditErr) {
          // L'audit a fail — on log pour Sentry mais on continue le
          // re-throw de l'erreur originale (ComplianceConcurrencyError).
          // Cf. DEBT-001.7 MED-1 : trou forensique acceptable, la
          // correctness Firestore reste préservée par le retry naturel.
          logger.error("[send-first-sms] failed to write send_blocked audit", {
            eventId: event.id,
            contactId,
            // pas de phone/body — cf. CLAUDE.md règle sécurité #9.
            auditError: auditErr instanceof Error ? auditErr.message : "unknown",
          });
        }
      }
      // Re-throw : Inngest retry naturel pour ComplianceConcurrencyError
      // (noRetry=false) ; les autres erreurs (NotFoundError, ValidationError,
      // AuditPiiError) propagent selon leur noRetry respectif.
      throw err;
    }
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
export const __AUDIT_SENDER_DRY_RUN_FOR_TESTS = AUDIT_SENDER_DRY_RUN;

/** @internal */
export const __AUDIT_OVH_MESSAGE_ID_DRY_RUN_FOR_TESTS = AUDIT_OVH_MESSAGE_ID_DRY_RUN;
