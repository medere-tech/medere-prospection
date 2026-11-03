/**
 * Inngest function `process-reply` — pipeline déterministe steps 1-9 avec sub-divisions 6a/6b + 8a/8b/8c/8d (S9.4.3).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * VUE D'ENSEMBLE
 *
 * Traite un SMS inbound (réponse PS) livré par event Inngest typé
 * `medere/sms.reply.received` (`SmsReplyReceivedDataSchema` =
 * `{phone E.164, body 1-1600, ovhMessageId string≥1}`).
 *
 * **Invariance au transport amont** : le contrat d'interface est l'event
 * Inngest. Le câblage webhook OVH (S9.6, INFRA-SMS-001) émettra ce
 * même event. Ce handler ne dépend ni d'OVH, ni d'un endpoint HTTP.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * PIPELINE 12 STEPS (S9.3.3b câblage gen IA + draft Firestore + audit)
 *
 *   1. `resolve-contact`            : `getContactByPhone(phone)` (S9.1).
 *                                     - found → `{contactId: hubspotId}`
 *                                     - not found → audit `reply_dropped`
 *                                       `{reason: "contact_unknown",
 *                                        phoneHash}` + return drop.
 *
 *   2. `resolve-conversation`       : `getActiveConversationByContactId`
 *                                     (S9.2.1).
 *                                     - found → `{conversationId}`
 *                                     - not found → audit `reply_dropped`
 *                                       `{reason: "no_active_conversation",
 *                                        phoneHash}` + return drop.
 *
 *   3. `dedup-by-external-id`       : `findInboundByExternalId(convId,
 *                                      ovhMessageId)` (S9.1).
 *                                     - duplicate → audit `reply_dropped`
 *                                       `{reason: "duplicate",
 *                                        duplicateOfMessageId}` + return.
 *                                     - new → continue.
 *
 *   4. `store-inbound`              : `addInbound(convId, ...)` (S6.5).
 *                                     - Pose le doc message + audit
 *                                       `sms_received` AUTO dans la tx.
 *                                     - Retourne `messageId` Firestore.
 *
 *   5. `short-form-opt-out-check`   : `isOptOut(body)` (S4, GUARD-001
 *                                      short-form ≤ 50 chars).
 *                                     - true → `markOptedOut` ÉTENDU
 *                                       (S9.2.2.1 : `{conversationId,
 *                                       intent:"STOP"}`) → conv synchro
 *                                       intent=STOP, status=opted_out
 *                                       dans la MÊME tx que contact +
 *                                       return `{status:"opt_out", via:
 *                                       "short_form"}`.
 *                                     - false → continue step 6.
 *
 *   6a. `claude-classify`           : `classifyReply(body)` (S7a.2,
 *                                      Claude Haiku 4.5 + tool use).
 *                                     - Toujours retourne un résultat
 *                                       (fail-safe STOP avec fallback=
 *                                       true sur erreur SDK).
 *                                     - `logger.warn` si fallback=true
 *                                       (observabilité S9.6 monitoring).
 *                                     - 🔒 ISOLÉ de l'audit (step 6b) →
 *                                       idempotence pleine Claude sur
 *                                       retry après failure step 6b.
 *                                       Ferme S9.3-FOLLOWUP-1 (limite
 *                                       documentée pré-S9.3).
 *
 *   6b. `audit-intent-classified`   : `appendAuditLog(intent_classified,
 *                                      payload scrubber-safe)`. Posé
 *                                      AVANT branch (Q1 brief Déthié).
 *                                     - Sur retry après failure ici,
 *                                       step 6a est servi depuis cache
 *                                       memoization → 0 ré-appel Claude.
 *
 *   7. `branch-by-intent`           : 5 valeurs, 2 branches :
 *                                     - STOP → `markOptedOut` étendu
 *                                       (ferme GUARD-001 long-form
 *                                       opt-out >50 chars rattrapé) +
 *                                       SKIP step 8 entier + return
 *                                       `{status:"opt_out", via:
 *                                       "classifier_long_form"}`.
 *                                     - INTERESSE/OBJECTION/NEUTRE/
 *                                       AUTO_REPLY →
 *                                       `setConversationIntent(convId,
 *                                       effectiveIntent, {nextStatus:
 *                                       "in_dialogue"})` puis enchaîne
 *                                       les sub-steps 8a/8b/8c.
 *                                     - ⚠️ PR1-AUTO-REPLY-OBSERVE :
 *                                       `AUTO_REPLY` est remappé sur
 *                                       `NEUTRE` (`effectiveIntent`) →
 *                                       comportement STRICTEMENT
 *                                       inchangé, l'IA répond quand même.
 *                                       Seul l'audit `intent_classified`
 *                                       (step 6b) garde la valeur brute.
 *                                       La PR d'activation y posera
 *                                       l'early return.
 *
 *   7bis. `observe-auto-reply`      : alerte Sentry/Pino via
 *                                     `captureMonitoringWarning` sur
 *                                     CHAQUE `AUTO_REPLY` détecté
 *                                     (PR-AUTO-REPLY-OBSERVABILITE).
 *                                     🔒 N'INTERROMPT RIEN — pure
 *                                     observabilité. Produit l'échantillon
 *                                     à examiner manuellement avant de
 *                                     décider l'activation de la coupure.
 *
 *   8a. `claude-generate-{intent}`  : `generateReply({intent, rawMessage,
 *                                      history})` (S9.3.2 Sonnet 4.6).
 *                                     - Charge l'historique 3 derniers
 *                                       messages (drafts exclus, S9.3.3a)
 *                                       via `listRecentMessages`.
 *                                     - Triple garde Médéré (S9.3.2) :
 *                                       prompt instruit + assertion code
 *                                       `hasAdvertiserIdentification` +
 *                                       preSendCheck rule 4 (S9.4).
 *                                     - 🔒 ISOLÉ des steps 8b/8c →
 *                                       idempotence pleine Claude sur
 *                                       retry. Pas de fallback artificiel
 *                                       — AppError propagée, Inngest
 *                                       retry naturel.
 *
 *   8b. `store-draft`               : `addOutboundDraft({contactId,
 *                                      conversationId, body, aiModel,
 *                                      aiPromptVersion, aiTemperature,
 *                                      aiTokens*, aiGenerationDurationMs})`
 *                                      (S9.3.3a addOutboundDraftInTx).
 *                                     - Pose doc `messages/{id}` avec
 *                                       `status="draft"`.
 *                                     - NE BUMP PAS counters conversation,
 *                                       NE POSE PAS audit `sms_sent`
 *                                       (S9.3.3a invariants).
 *                                     - Retourne `draftMessageId`.
 *                                     - 🔒 ISOLÉ du step 8a → si Firestore
 *                                       throw, Claude pas ré-appelé sur retry.
 *
 *   8c. `audit-reply-generated`     : `appendAuditLog({action:
 *                                      "reply_generated", targetType:
 *                                      "message", targetId: draftMessageId,
 *                                      payload: ReplyGeneratedPayload})`.
 *                                     - 🚨 INVARIANT ANTI-PII (LOW-4
 *                                       compliance-auditor S9.3.2 +
 *                                       NIT-1 S9.3.3a) : le `body` brut
 *                                       JAMAIS dans payload. Seul
 *                                       `bodyLength` exposé. Le body
 *                                       vit dans `messages/{id}`.
 *                                     - 🔒 ISOLÉ des steps 8a/8b →
 *                                       retry sur audit fail = 0 ré-appel
 *                                       Claude + 0 double-doc Firestore.
 *
 *   8d. `dispatch-reply-event`      : `step.sendEvent({name:
 *                                      smsReplySendRequested.name, data:
 *                                      {contactId, conversationId,
 *                                      draftMessageId}, id:
 *                                      `reply.send.${draftMessageId}`})`
 *                                      (S9.4.3 — branches non-STOP only).
 *                                     - Émet l'event consommé par le
 *                                       handler `send-reply.ts` (S9.4.2)
 *                                       pour dispatch OVH. Le draft est
 *                                       déjà queued (S9.4.1).
 *                                     - 🚨 IDEMPOTENCE eventId déterministe
 *                                       `reply.send.${draftMessageId}` :
 *                                       déduplication 60s native Inngest
 *                                       en defense-in-depth (memoization
 *                                       step.sendEvent couvre déjà 95%).
 *                                       Filet ultime côté handler S9.4.2 :
 *                                       commitDraftToQueued assert
 *                                       `status === "draft"` DANS tx →
 *                                       ValidationError si déjà queued.
 *                                     - 🚨 ANTI-PII payload minimaliste
 *                                       (cf. Q-B3 S9.4.0) + event.id
 *                                       scrubber-safe par construction
 *                                       (Firestore auto-ID `[A-Za-z0-9]{20}`).
 *                                     - 🔒 ISOLÉ des steps 8a/8b/8c →
 *                                       retry sur sendEvent fail = 0
 *                                       ré-appel Claude + 0 double-doc.
 *
 *   9. `audit-reply-processed`      : `appendAuditLog({action:
 *                                      "reply_processed", targetType:
 *                                      "conversation", targetId:
 *                                      conversationId, payload})`. Posé
 *                                      UNIQUEMENT sur les branches non-drop
 *                                      (4 short_form, 5 long_form, 6
 *                                      classified). Forensic L.34-5 CPCE
 *                                      bout-en-bout + observabilité P95
 *                                      via `pipelineDurationMs`. PAS posé
 *                                      sur les drops (reply_dropped suffit).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * RETRIES — relâchés à 3 en S9.2.3 (= default Inngest v4.x explicite)
 *
 * `retries: 3` est choisi EXPLICITEMENT (= default Inngest v4.x, cf.
 * `InngestFunction.d.ts:334`) pour garder la visibilité du choix dans
 * le code. Permet à Inngest de retenter automatiquement en cas d'erreur
 * transitoire (Firestore 5xx, Claude SDK timeout absorbé puis
 * appendAuditLog fail post-classifier, etc.).
 *
 * Note Inngest : `step.run(name, fn)` memoize le résultat par
 * `(eventId, stepName)`. Sur retry, un step déjà commit retourne son
 * résultat caché sans ré-exécuter `fn` — assure idempotence sur tous
 * les writes Firestore, tous les `appendAuditLog`, ET tous les appels
 * Claude (pas de double facturation). Test sentinelle anti-régression
 * MED-1 dans `process-reply.memoization.test.ts` (S9.2.3.2).
 *
 * S9.3.1 split classify-intent en `step.run("claude-classify")` +
 * `step.run("audit-intent-classified")` pour atteindre l'idempotence
 * pleine sur Claude (anti-double-facturation, ferme S9.3-FOLLOWUP-1
 * documenté en S9.2.3.2). Si l'audit `intent_classified` throw → retry
 * → step 6a `claude-classify` est servi depuis le cache memoization →
 * `classifyReply` n'est PAS ré-appelé. Verrouillé par Test 6
 * (`process-reply.memoization.test.ts`) qui prouve `classifyReply ===
 * 1×` même en présence d'un fail transient sur l'audit step 6b.
 *
 * S9.3.3b applique le MÊME pattern au step 8 generate-reply : split en
 * 3 sub-steps distincts `claude-generate-{intent}` + `store-draft` +
 * `audit-reply-generated`. Si step 8b (Firestore) ou step 8c (audit)
 * throw → retry → step 8a (Claude) servi depuis cache → 0 ré-appel
 * SDK Anthropic. Si step 8c throw → retry → step 8b servi depuis cache
 * → pas de double-doc Firestore créé. Verrouillé par Test 7
 * (`process-reply.memoization.test.ts`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 CAVEAT S9.5+ (AI Act Article 50.1) — Fix LOW-2 compliance-auditor S9.3.3b
 *
 * Le verdict 3.F S9.3.0 = "PAS de mention IA dans les replies S9.3"
 * repose sur l'INVARIANT que le 1er SMS prod identifie EXPLICITEMENT
 * "Léa, assistante virtuelle de Médéré" (garde code structurelle :
 * `pre-send-check.ts:479` rule 2 `ai_disclosure` REFUSE tout 1er SMS
 * sans cette mention). La continuation de la conversation par la même
 * IA est alors "évidente" au sens AI Act 50.1 ("sauf si évident à un
 * observateur raisonnablement informé").
 *
 * **Si en S9.5+ le 1er SMS devient génératif** (via Claude prompt
 * `first-sms-*.ts` à créer) et glisse vers une mention moins explicite
 * (ex: "Bonjour de Médéré" sans "assistante virtuelle"), la décision
 * 3.F DOIT être RÉÉVALUÉE :
 *
 *   1. Soit ré-introduire une mention IA dans les replies S9.3
 *      (modifier les 3 SYSTEM prompts `generate-reply-{intent}.ts` +
 *      bump VERSION).
 *   2. Soit verrouiller le 1er SMS génératif avec une garde code
 *      équivalente (rule 2 `ai_disclosure` reste effective).
 *
 * Action concrète si réévaluation déclenchée : re-passer par
 * compliance-auditor avec verdict 3.F mis à jour + sentinelles tests
 * SYSTEM prompts amendées.
 *
 * Cf. JSDoc en-tête `src/lib/claude/prompts/generate-reply-interesse.ts`
 * (lignes 20-26) pour le caveat miroir côté prompts.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ANTI-PII — logger strict
 *
 * Champs scrubber-safe loggables par TOUS les steps :
 *
 *   - `eventId`        : Inngest event ID (UUID v4 ou hash HMAC côté caller)
 *   - `name`           : event name (`medere/sms.reply.received`)
 *   - `contactId`      : = hubspotId (string opaque interne)
 *   - `conversationId` : = `${contactId}_${campaignId}` (opaque par construction)
 *   - `messageId`      : Firestore auto-ID `[A-Za-z0-9]{20}`
 *   - `step`           : nom du step en cours
 *   - `intent`         : enum fermé (`INTENT_VALUES`), pas PII
 *   - `classifierFallback` : boolean (S9.2.2)
 *
 * Champs INTERDITS dans les logs (PII / semi-sensibles) :
 *
 *   - `phone`          : E.164 du PS → hasher via `safePhoneHash()` pour
 *                        audit (PAS hashPii brut, cf. HIGH-1 S9.2.1)
 *   - `body`           : peut contenir n° perso, infos médicales
 *   - `ovhMessageId`   : identifiant externe semi-sensible (cf.
 *                        invariants `messages.ts:36-54`)
 *   - `reasoning`      : reasoning Claude — defense-in-depth, le prompt
 *                        l'interdit mais on ne fait pas confiance
 *
 * Sentinelle anti-PII pipeline complet : `process-reply.test.ts` couvre
 * chaque step (1-7) et vérifie via `JSON.stringify(logger.mock.calls)`
 * que phone/body/ovhMessageId/reasoning n'apparaissent JAMAIS.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * AUDITS POSÉS (S9.2.2)
 *
 * Pattern uniforme `{actorId: "system", actorType: "system"}`.
 *
 *   | Action               | targetType    | targetId                  | payload                                                      |
 *   |----------------------|---------------|---------------------------|--------------------------------------------------------------|
 *   | `reply_dropped`      | `contact`     | `phoneHash` (safePhone)   | `{reason: "contact_unknown", phoneHash}`                     |
 *   | `reply_dropped`      | `contact`     | `contactId`               | `{reason: "no_active_conversation", phoneHash}`              |
 *   | `reply_dropped`      | `message`     | `duplicateOfMessageId`    | `{reason: "duplicate", contactId, conversationId,            |
 *   |                      |               |                           |    duplicateOfMessageId}`                                    |
 *   | `sms_received` (auto)| `message`     | `messageId` (nouveau)     | `{direction: "inbound", messageId}` (par `addInbound`)       |
 *   | `opt_out` (auto)     | `contact`     | `contactId`               | `{channel: "sms", conversationId}` (markOptedOut étendu)     |
 *   | `intent_classified`  | `message`     | `messageId`               | `{contactId, conversationId, intent, confidence, fallback,   |
 *   |                      |               |                           |    promptVersion, model}` — PAS body/reasoning/tokens        |
 *   | `reply_generated`    | `message`     | `draftMessageId`          | `ReplyGeneratedPayload` (S9.3.3a) — PAS body brut, seul      |
 *   |                      |               |                           |    `bodyLength` exposé. Branche `classified` uniquement.     |
 *   | `reply_processed`    | `conversation`| `conversationId`          | `{contactId, conversationId, messageId, intent, branchTaken, |
 *   |                      |               |                           |    finalConversationStatus, classifierFallback?,             |
 *   |                      |               |                           |    draftMessageId? (classified), pipelineDurationMs}`        |
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INJECTION DE DÉPENDANCES (`deps`)
 *
 * Pattern S5 (`pre-send-check`) : second argument optionnel `deps` pour
 * permettre aux tests unit d'injecter des mocks sans `vi.mock()` global.
 * En production, ne pas fournir `deps` — les implémentations réelles
 * sont utilisées.
 *
 * @see `processReplyHandler` ci-dessous pour le typage.
 */
import { classifyReply } from "@/lib/claude/intent-classifier";
import {
  CLASSIFY_INTENT_MODEL,
  CLASSIFY_INTENT_PROMPT_VERSION,
} from "@/lib/claude/prompts/classify-intent";
import { generateReply, type GenerateReplyIntent } from "@/lib/claude/reply-generator";
import type { Intent } from "@/lib/claude/types";
import { isOptOut } from "@/lib/compliance/opt-out";
import { appendAuditLog } from "@/lib/firestore/audit-log";
import { getContact, getContactByPhone, markOptedOut } from "@/lib/firestore/contacts";
import {
  getActiveConversationByContactId,
  getHandedOffConversationByContactId,
  getLatestConversationByContactId,
  setConversationIntent,
} from "@/lib/firestore/conversations";
import {
  addInbound,
  addInboundIdempotent,
  addOutboundDraft,
  findInboundByExternalId,
  listRecentMessages,
} from "@/lib/firestore/messages";
import { addOrphanInboundIdempotent } from "@/lib/firestore/orphan-inbounds";
import { getInngestClient } from "@/lib/inngest/client";
import { handoffRequested, smsReplyReceived, smsReplySendRequested } from "@/lib/inngest/events";
import { getSlackEnv } from "@/lib/security/env";
import { getDashboardConversationUrl } from "@/lib/slack/dashboard-url";
import { sendInboundAfterHandoffNotification } from "@/lib/slack/notify-inbound-after-handoff";
import { sendInboundOnInactiveConversationNotification } from "@/lib/slack/notify-inbound-on-inactive-conversation";
import { ValidationError } from "@/lib/utils/errors";
import { captureMonitoringWarning } from "@/lib/utils/observability";
import { hashPii, PHONE_HASH_PREFIX, safePhoneHash } from "@/lib/utils/pii-detector";
import { shortFingerprint } from "@/lib/utils/short-fingerprint";
import type {
  InboundOnInactiveConversationPayload,
  InboundOnInactiveConversationReason,
  InboundOnInactiveNotifiedVia,
  InboundRelayedOptOutVia,
  InboundRelayedToHumanPayload,
  ReplyGeneratedPayload,
} from "@/types/audit-log";
import type { ConversationStatus } from "@/types/conversation";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ID Inngest stable de la function. NE PAS modifier après le premier
 * déploiement (perte d'historique côté cloud). Verrouillé par sentinelle
 * dans `process-reply.test.ts`.
 */
const FUNCTION_ID = "process-reply";

/**
 * Raisons de drop encore valides apres PR-NO-DROPPED-SMS. SEUL `duplicate`
 * reste : les anciens `contact_unknown` / `no_active_conversation` basculent
 * sur l'action d'audit `inbound_on_inactive_conversation` + stockage orphelins
 * + notif Slack (DM titulaire ou canal orphelins). Sentinelle test verrouille
 * cette union — modifier cette liste = modifier le contrat forensic L.34-5
 * CPCE, decision explicite.
 */
const DROP_REASONS = ["duplicate"] as const;
type DropReason = (typeof DROP_REASONS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Types de retour du handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Résultat du pipeline `process-reply`. Discriminé sur `status`.
 *
 *   - `dropped`     : pipeline court-circuité pour duplicate UNIQUEMENT
 *                     (vrai doublon atomique detecte par
 *                     `addInboundIdempotent` ou dedup `findInbound`).
 *
 *   - `stored_on_inactive_conversation` (PR-NO-DROPPED-SMS) :
 *                     SMS entrant qu'aucune branche active ne gere. Le
 *                     message est TOUJOURS persiste (sur la conv la plus
 *                     recente du contact, OU dans `inbound_messages_orphans/`
 *                     si pas de conv), un humain est TOUJOURS notifie
 *                     (DM titulaire ou canal orphelins), un audit
 *                     `inbound_on_inactive_conversation` est pose, et une
 *                     alerte Sentry est emise. Lea reste muette.
 *
 *   - `opt_out`     : STOP appliqué. Discriminant `via` :
 *                     - `"short_form"` : détecté par `isOptOut(body)` au
 *                       step 5 fast-path (STOP, ARRET, ≤ 50 chars).
 *                     - `"classifier_long_form"` : détecté par le classifier
 *                       Claude au step 6 (long-form opt-out > 50 chars,
 *                       ferme GUARD-001).
 *                     `intent` toujours `"STOP"` dans cette branche.
 *
 *   - `classified`  : classifier Claude a posé un intent non-STOP
 *                     (INTERESSE / OBJECTION / NEUTRE). La conversation
 *                     est mise à `status="in_dialogue"` + l'intent posé.
 *                     S9.3 reprendra le relais pour la gen IA + envoi.
 *
 * Note : `pending_intent_classification` (S9.2.1) est SUPPRIMÉ — remplacé
 * par `classified` qui acte la décision Claude au lieu d'attendre.
 */
export type ProcessReplyResult =
  | { status: "dropped"; reason: DropReason }
  | {
      /**
       * PR-NO-DROPPED-SMS — branche "aucun chemin actif ne gere ce SMS",
       * mais le message a ete stocke (sur conv la plus recente OU en
       * orphelins), notifie et audite. `reason` discrimine le cas forensique.
       */
      status: "stored_on_inactive_conversation";
      reason: InboundOnInactiveConversationReason;
      /** Present SSI on a resolu un contact. */
      contactId?: string;
      /** Present SSI on a rattache a une conv existante. */
      conversationId?: string;
      /** Present SSI on a persiste un doc `messages/{id}` sur une conv. */
      messageId?: string;
      /** Present SSI on a persiste un doc `inbound_messages_orphans/{id}`. */
      orphanDocId?: string;
      /** `true` si opt-out detecte dans le body. */
      wasOptOut: boolean;
    }
  | {
      status: "opt_out";
      contactId: string;
      conversationId: string;
      messageId: string;
      intent: "STOP";
      /**
       * Discriminant analytics + forensic L.34-5 CPCE :
       *   - `"short_form"` : fast-path déterministe (step 5) sur conv active.
       *   - `"classifier_long_form"` : rattrapé par Claude (step 7) sur conv active.
       *   - `"handed_off_short_form"` (PR-A) : fast-path déterministe sur
       *     conv `handed_off`. La conv transitionne de `handed_off` →
       *     `opted_out` dans la même tx que le flip contact.
       *   - `"handed_off_classifier_long_form"` (PR-A) : rattrapé par Claude
       *     sur conv `handed_off`. Même transition conv.
       * Permet de mesurer en prod le ratio des 4 voies (vérifier que le
       * classifier ne capture pas trop de faux positifs côté GUARD-001 ET
       * mesurer le volume d'opt-out post-handoff — signal commercial).
       */
      via:
        | "short_form"
        | "classifier_long_form"
        | "handed_off_short_form"
        | "handed_off_classifier_long_form";
    }
  | {
      /**
       * PR-A-INBOUND-HANDED-OFF — SMS entrant arrivé sur conv `handed_off`
       * SANS être un opt-out (ni court-forme ni long-forme). Léa muette.
       * Le message est stocké, le commercial titulaire reçoit un DM Slack,
       * un audit `inbound_relayed_to_human` est posé avec `wasOptOut: false`.
       */
      status: "relayed_to_human";
      contactId: string;
      conversationId: string;
      messageId: string;
      /** Slack user ID du commercial titulaire (`handoff.assignedTo`). */
      assignedTo: string;
    }
  | {
      status: "classified";
      contactId: string;
      conversationId: string;
      messageId: string;
      intent: "INTERESSE" | "OBJECTION" | "NEUTRE";
      /**
       * S9.3.3b — ID Firestore (auto-ID 20 chars `[A-Za-z0-9]{20}`) du
       * draft outbound créé par `addOutboundDraft` au step 8b. Le draft
       * a `status="draft"` (pas envoyé OVH — sera transitionné en S9.4
       * via `commitDraftToQueued`). Présent UNIQUEMENT sur branche
       * `classified` (les branches `opt_out` skip step 8 entier).
       */
      draftMessageId: string;
    };

// ─────────────────────────────────────────────────────────────────────────────
// Injection de dépendances (pattern S5 pre-send-check)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Injection optionnelle des dépendances pour tests unit. En production,
 * ne pas fournir — les implémentations réelles sont utilisées.
 *
 * @internal Public uniquement pour le testing.
 */
export interface ProcessReplyDeps {
  getContactByPhone?: typeof getContactByPhone;
  getActiveConversationByContactId?: typeof getActiveConversationByContactId;
  findInboundByExternalId?: typeof findInboundByExternalId;
  addInbound?: typeof addInbound;
  // BUG-DEDUP-RACE (B) — docId Firestore deterministe + tx.create atomique.
  addInboundIdempotent?: typeof addInboundIdempotent;
  markOptedOut?: typeof markOptedOut;
  isOptOut?: typeof isOptOut;
  captureMonitoringWarning?: typeof captureMonitoringWarning;
  hashPii?: typeof hashPii;
  appendAuditLog?: typeof appendAuditLog;
  // S9.2.2 — classifier + post-classification mutation
  classifyReply?: typeof classifyReply;
  setConversationIntent?: typeof setConversationIntent;
  // S9.3.3b — gen IA reply + stockage draft
  listRecentMessages?: typeof listRecentMessages;
  generateReply?: typeof generateReply;
  addOutboundDraft?: typeof addOutboundDraft;
  // PR-A-INBOUND-HANDED-OFF — branche "relayed_to_human"
  getHandedOffConversationByContactId?: typeof getHandedOffConversationByContactId;
  getContact?: typeof getContact;
  sendInboundAfterHandoffNotification?: typeof sendInboundAfterHandoffNotification;
  getDashboardConversationUrl?: typeof getDashboardConversationUrl;
  // PR-NO-DROPPED-SMS — branche "stored_on_inactive_conversation"
  getLatestConversationByContactId?: typeof getLatestConversationByContactId;
  addOrphanInboundIdempotent?: typeof addOrphanInboundIdempotent;
  sendInboundOnInactiveConversationNotification?: typeof sendInboundOnInactiveConversationNotification;
  /**
   * Lecture optionnelle du canal Slack orphelins. Injectable pour tests
   * sans mocker `getSlackEnv` global. Null/undefined accepte : le caller
   * aiguille en consequence (si DM pas disponible et channel absent, log
   * error + Sentry mais ne throw pas pour pas perdre l'audit).
   *
   * Point 5 round 3 : depuis Finding 5 PR-NO-DROPPED-SMS,
   * `SLACK_ORPHAN_LEADS_CHANNEL_ID` est REQUIRED dans getSlackEnv() —
   * ce dep retourne donc TOUJOURS une string Zod-validee. Les tests
   * doivent passer un string valide (format regex `/^[CG][A-Z0-9]+$/`).
   */
  getOrphanChannelId?: () => string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Forme du contexte Inngest reçu par le handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Forme minimale du contexte Inngest passé au handler. Typage volontairement
 * large — Inngest type-check au site de `createFunction()`. Permet la
 * fabrication d'un fake context en tests.
 */
export interface ProcessReplyHandlerContext {
  event: {
    id?: string;
    name: string;
    data: {
      phone: string;
      body: string;
      ovhMessageId: string;
    };
  };
  step: {
    run: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
    /**
     * Émet un event Inngest depuis un step nommé (memoizable comme
     * `step.run`). Pattern S9.4.3 `dispatch-reply-event` qui chaîne le
     * pipeline `process-reply` → handler `send-reply` (S9.4.2). Le
     * `payload.id` (optionnel) permet d'imposer un eventId déterministe
     * pour la déduplication 60s native Inngest (defense-in-depth).
     */
    sendEvent: (
      stepName: string,
      payload: { name: string; data: Record<string, unknown>; id?: string },
    ) => Promise<unknown>;
  };
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler — exporté pour tests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handler du pipeline `process-reply`. Voir JSDoc en-tête du fichier
 * pour le détail des 5 steps.
 */
export async function processReplyHandler(
  ctx: ProcessReplyHandlerContext,
  deps: ProcessReplyDeps = {},
): Promise<ProcessReplyResult> {
  const _getContactByPhone = deps.getContactByPhone ?? getContactByPhone;
  const _getActiveConv = deps.getActiveConversationByContactId ?? getActiveConversationByContactId;
  const _findInbound = deps.findInboundByExternalId ?? findInboundByExternalId;
  // BUG-DEDUP-RACE : le pipeline consomme maintenant `addInboundIdempotent`.
  // `deps.addInbound` reste exposé via la signature `ProcessReplyDeps` pour
  // que les tests historiques puissent le mocker et que `addInboundIdempotent`
  // par defaut delegue au MEME mock (cf. makeDeps des tests). On ne resout
  // donc pas `_addInbound` ici — il n'est plus appelé directement.
  const _addInboundIdempotent = deps.addInboundIdempotent ?? addInboundIdempotent;
  const _markOptedOut = deps.markOptedOut ?? markOptedOut;
  const _isOptOut = deps.isOptOut ?? isOptOut;
  const _captureMonitoringWarning = deps.captureMonitoringWarning ?? captureMonitoringWarning;
  const _hashPii = deps.hashPii ?? hashPii;
  const _appendAuditLog = deps.appendAuditLog ?? appendAuditLog;
  const _classifyReply = deps.classifyReply ?? classifyReply;
  const _setConversationIntent = deps.setConversationIntent ?? setConversationIntent;
  // S9.3.3b — gen IA reply + stockage draft
  const _listRecentMessages = deps.listRecentMessages ?? listRecentMessages;
  const _generateReply = deps.generateReply ?? generateReply;
  const _addOutboundDraft = deps.addOutboundDraft ?? addOutboundDraft;
  // PR-A-INBOUND-HANDED-OFF — branche "relayed_to_human"
  const _getHandedOffConv =
    deps.getHandedOffConversationByContactId ?? getHandedOffConversationByContactId;
  const _getContact = deps.getContact ?? getContact;
  const _sendInboundAfterHandoff =
    deps.sendInboundAfterHandoffNotification ?? sendInboundAfterHandoffNotification;
  const _getDashboardUrl = deps.getDashboardConversationUrl ?? getDashboardConversationUrl;
  // PR-NO-DROPPED-SMS — branche "stored_on_inactive_conversation"
  const _getLatestConv = deps.getLatestConversationByContactId ?? getLatestConversationByContactId;
  const _addOrphan = deps.addOrphanInboundIdempotent ?? addOrphanInboundIdempotent;
  const _sendInactiveNotif =
    deps.sendInboundOnInactiveConversationNotification ??
    sendInboundOnInactiveConversationNotification;
  const _getOrphanChannelId =
    deps.getOrphanChannelId ?? (() => getSlackEnv().SLACK_ORPHAN_LEADS_CHANNEL_ID);

  const { event, step, logger } = ctx;
  const { phone, body, ovhMessageId } = event.data;

  // S9.2.3 — marqueur de début pour `pipelineDurationMs` du step 8
  // `audit-reply-processed`. Capturé HORS de `step.run` pour mesurer
  // bien la durée bout-en-bout du pipeline. Sur retry Inngest, ce
  // marqueur est re-capturé à chaque attempt — la valeur committée par
  // `step.run("audit-reply-processed", ...)` reflète donc la durée du
  // run qui réussit l'audit, pas la durée cumulée des retries (volontaire :
  // métrique d'observabilité de la latence pipeline en succès).
  const handlerStartMs = Date.now();

  logger.info("[process-reply] received", {
    eventId: event.id,
    name: event.name,
    // PAS de phone, body, ovhMessageId — anti-PII strict.
  });

  // S9.2.3 — Helper Step 8 `audit-reply-processed`.
  //
  // Posé UNIQUEMENT sur les branches non-drop (4 short_form, 5
  // classifier_long_form, 6 classified). PAS sur les drops, qui sont
  // déjà entièrement tracés par `reply_dropped` avec `reason`
  // discriminant + phoneHash/contactId/duplicateOfMessageId.
  //
  // Sémantique : "fin de cycle de traitement post-store-inbound avec
  // succès". Cible la conversation (entité qui a transitionné d'état),
  // pas le message (qui est un événement ponctuel déjà ciblé par
  // `intent_classified`). messageId reste tracé dans le payload pour
  // corréler la conversation → preuve écrite L.34-5 CPCE.
  //
  // Idempotence : `step.run("audit-reply-processed", ...)` memoizé par
  // (eventId, stepName). Branches mutuellement exclusives par flux de
  // contrôle (early return après chaque branche) → un seul appel par run.
  async function postReplyProcessedAudit(params: {
    contactId: string;
    conversationId: string;
    messageId: string;
    intent: Intent;
    branchTaken: "opt_out_short_form" | "opt_out_classifier_long_form" | "classified";
    finalConversationStatus: "opted_out" | "in_dialogue";
    /**
     * Présent UNIQUEMENT si la branche est passée par le classifier
     * (long_form opt_out + classified). Omis sur short_form qui
     * court-circuite avant l'appel Claude — éviter un faux signal de
     * fallback côté analytics.
     */
    classifierFallback?: boolean;
    /**
     * S9.3.3b — ID Firestore du draft créé au step 8b. Présent UNIQUEMENT
     * sur branche `branchTaken === "classified"` (les branches `opt_out_*`
     * skip step 8 entier). Permet la corrélation forensique
     * `reply_processed.payload.draftMessageId → messages/{id}` côté audit.
     */
    draftMessageId?: string;
  }): Promise<void> {
    await step.run("audit-reply-processed", async () => {
      const pipelineDurationMs = Date.now() - handlerStartMs;
      await _appendAuditLog({
        actorId: "system",
        actorType: "system",
        action: "reply_processed",
        targetType: "conversation",
        targetId: params.conversationId,
        // Payload scrubber-safe (cf. Q2 arbitrage Déthié S9.2.3) :
        //   - IDs opaques internes (contactId, conversationId, messageId,
        //     draftMessageId — S9.3.3b sur branche classified)
        //   - intent : enum fermé Intent
        //   - branchTaken/finalConversationStatus : enums fermés
        //   - classifierFallback : boolean optional (présent ssi branche
        //     passée par classifier — voir JSDoc helper)
        //   - pipelineDurationMs : number (observabilité P95 monitoring S9.6)
        // OMIS volontairement (jamais dans le payload) :
        //   - phone/body/ovhMessageId/reasoning : defense-in-depth anti-PII
        payload: {
          contactId: params.contactId,
          conversationId: params.conversationId,
          messageId: params.messageId,
          intent: params.intent,
          branchTaken: params.branchTaken,
          finalConversationStatus: params.finalConversationStatus,
          ...(params.classifierFallback !== undefined
            ? { classifierFallback: params.classifierFallback }
            : {}),
          ...(params.draftMessageId !== undefined ? { draftMessageId: params.draftMessageId } : {}),
          pipelineDurationMs,
        },
      });
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Helper PR-NO-DROPPED-SMS — flux "inbound sur conv inactive / orphan"
  // ─────────────────────────────────────────────────────────────────────
  //
  // Encapsule les sous-steps COMMUNS a toutes les branches qui, avant
  // cette PR, droppaient silencieusement un SMS entrant :
  //
  //   - P1  : contact inconnu              (unknown_contact)
  //   - P2  : handed_off sans assignedTo  (handed_off_no_assignee)
  //   - P3  : aucune conv active ni handed_off, conv la plus recente en
  //           closed/opted_out/blocked      (closed | opted_out | blocked)
  //   - P3' : contact connu sans aucune conv (no_conversation)
  //   - P6  : race opt-out pendant transition closed/blocked
  //           (conversation_became_terminal)
  //
  // Responsabilites (chacune step.run memoisee pour idempotence Inngest) :
  //   (a) Stocker en orphelins si `messageId` absent (= pas de conv
  //       rattachee). Si `messageId` est deja pose par le pipeline sur une
  //       conv (P2 / P3 avec conv la plus recente / P6), on NE restocke PAS :
  //       le forensic L.34-5 CPCE vit deja dans `messages/{id}`.
  //   (b) Envoyer la notification Slack : DM `assignedTo` si fourni ET
  //       canal orphelins disponible pour les reasons critiques (via
  //       includeHereMention). Fallback canal orphelins pour tous les autres
  //       cas sans assignedTo. Si NI DM NI canal disponible → audit avec
  //       `notifiedVia:"notify_failed"` + Sentry error (jamais throw).
  //   (c) Pose l'audit `inbound_on_inactive_conversation` avec le payload
  //       typé scrubber-safe.
  //   (d) Alerte Sentry via `captureMonitoringWarning` (level `warning` par
  //       defaut, `error` pour `handed_off_no_assignee` / `parse_failed` /
  //       `enqueue_failed` / `conversation_became_terminal`).
  //
  // Le markOptedOut eventuel reste a la charge du caller (contexte-dependant :
  // P1 n'a pas de contactId, P3 depend du status, P6 est deja dans la race).
  async function handleInactiveInbound(params: {
    reason: InboundOnInactiveConversationReason;
    stepSuffix: string;
    wasOptOut: boolean;
    sentryLevel?: "warning" | "error";
    includeHereMention?: boolean;
    contactId?: string;
    conversationId?: string;
    messageId?: string;
    assignedTo?: string;
    phoneHash?: string;
    phoneLast4?: string;
    firstName?: string;
    speciality?: string;
    city?: string;
  }): Promise<ProcessReplyResult & { status: "stored_on_inactive_conversation" }> {
    const sentryLevel = params.sentryLevel ?? "warning";

    // (a) Store orphan si pas de messageId existant.
    let orphanDocId: string | undefined;
    if (params.messageId === undefined) {
      // PR2c tour 2a — `AddOrphanInboundInput.reason` est restreint aux 4
      // raisons qui créent EFFECTIVEMENT un orphan (prouvé tour 1 bis par
      // relecture code). Les call sites `handleInactiveInbound` sans
      // messageId sont `unknown_contact` (l.1009) et `no_conversation`
      // (l.1265) — les deux sont dans l'union narrow. Les 5 autres
      // reasons (`closed`/`opted_out`/`blocked`/`handed_off_no_assignee`/
      // `conversation_became_terminal`) passent toutes `messageId:
      // storeResult.messageId` défini → cette branche n'est jamais prise.
      // Cast compile-only : runtime safe par invariant.
      const narrowReason = params.reason as "no_conversation" | "unknown_contact";
      const orphanResult = await step.run(`store-orphan-inbound-${params.stepSuffix}`, async () => {
        return _addOrphan({
          reason: narrowReason,
          body,
          idempotencyKey: ovhMessageId,
          source: "process-reply",
          ...(params.phoneHash !== undefined ? { phoneHash: params.phoneHash } : {}),
          ...(params.contactId !== undefined ? { contactId: params.contactId } : {}),
          ...(params.conversationId !== undefined ? { conversationId: params.conversationId } : {}),
          wasOptOut: params.wasOptOut,
        });
      });
      orphanDocId = orphanResult.docId;
    }

    // (b) Determiner la cible Slack. Priorite DM si assignedTo valide,
    // sinon canal orphelins. Depuis Finding 5 PR-NO-DROPPED-SMS,
    // SLACK_ORPHAN_LEADS_CHANNEL_ID est REQUIRED (env.ts) : `_getOrphanChannelId()`
    // retourne toujours une string Zod-validee (regex `/^[CG][A-Z0-9]+$/`).
    // L'ancien check `channelValid` + branche "notify_failed" quand canal
    // absent a ete retire (point 5 round 3 — dead code depuis Finding 5).
    const orphanChannelId = _getOrphanChannelId();
    const SLACK_USER_ID_REGEX = /^U[A-Z0-9]+$/;
    const assignedToValid =
      params.assignedTo !== undefined &&
      params.assignedTo !== "" &&
      SLACK_USER_ID_REGEX.test(params.assignedTo);

    const dashboardUrl =
      params.conversationId !== undefined
        ? _getDashboardUrl(params.conversationId)
        : _getDashboardUrl("orphans");

    // Enrichissement firstName/speciality/city — meilleur effort via
    // getContact si contactId fourni et champs pas deja renseignes.
    let enriched = {
      firstName: params.firstName,
      speciality: params.speciality,
      city: params.city,
    };
    if (
      params.contactId !== undefined &&
      (enriched.firstName === undefined ||
        enriched.speciality === undefined ||
        enriched.city === undefined)
    ) {
      const enrichResult = await step.run(`enrich-contact-${params.stepSuffix}`, async () => {
        const c = await _getContact(params.contactId!);
        if (!c) return { found: false as const };
        return {
          found: true as const,
          firstName: c.firstName,
          speciality: c.speciality,
          city: c.city,
        };
      });
      if (enrichResult.found) {
        enriched = {
          firstName: enriched.firstName ?? enrichResult.firstName,
          speciality: enriched.speciality ?? enrichResult.speciality,
          city: enriched.city ?? enrichResult.city,
        };
      }
    }

    // Point 2 + 3 round 3 : notifiedVia utilise le type partage
    // `InboundOnInactiveNotifiedVia`. Mapping precis depuis la decision
    // Slack :
    //   - DM : toujours "dm" (le plafond anti-inondation ne touche pas les DMs).
    //   - Channel + decision.kind === "send"        -> "orphan_channel"
    //   - Channel + decision.kind === "send_digest" -> "digest" (MED-1)
    //   - Channel + decision.kind === "suppressed"  -> "suppressed" (MED-1)
    //   - Si _sendInactiveNotif throw -> propage (Inngest retry), on ne
    //     pose pas d'audit "notify_failed" ici (c'est le role du caller
    //     downstream s'il veut gerer differemment).
    let notifiedVia: InboundOnInactiveNotifiedVia = "notify_failed";
    let slackTs: string | undefined;
    let slackChannel: string | undefined;

    if (assignedToValid) {
      const r = await step.run(`notify-dm-${params.stepSuffix}`, async () => {
        return _sendInactiveNotif({
          target: { kind: "dm", slackUserId: params.assignedTo! },
          reason: params.reason,
          wasOptOut: params.wasOptOut,
          lastInboundBody: body,
          dashboardUrl,
          includeHereMention: false,
          ...(enriched.firstName !== undefined ? { firstName: enriched.firstName } : {}),
          ...(enriched.speciality !== undefined ? { speciality: enriched.speciality } : {}),
          ...(enriched.city !== undefined ? { city: enriched.city } : {}),
          ...(params.phoneLast4 !== undefined ? { phoneLast4: params.phoneLast4 } : {}),
          ...(params.conversationId !== undefined ? { conversationId: params.conversationId } : {}),
          ...(orphanDocId !== undefined ? { orphanDocId } : {}),
        });
      });
      notifiedVia = "dm";
      slackTs = r.ts;
      slackChannel = r.channel;
    } else {
      const r = await step.run(`notify-orphan-${params.stepSuffix}`, async () => {
        return _sendInactiveNotif({
          target: { kind: "channel", channelId: orphanChannelId },
          reason: params.reason,
          wasOptOut: params.wasOptOut,
          lastInboundBody: body,
          dashboardUrl,
          includeHereMention: params.includeHereMention === true,
          ...(enriched.firstName !== undefined ? { firstName: enriched.firstName } : {}),
          ...(enriched.speciality !== undefined ? { speciality: enriched.speciality } : {}),
          ...(enriched.city !== undefined ? { city: enriched.city } : {}),
          ...(params.phoneLast4 !== undefined ? { phoneLast4: params.phoneLast4 } : {}),
          ...(params.conversationId !== undefined ? { conversationId: params.conversationId } : {}),
          ...(orphanDocId !== undefined ? { orphanDocId } : {}),
        });
      });
      // Mapping precis decision.kind -> notifiedVia (point 2 round 3).
      if (r.kind === "send") {
        notifiedVia = "orphan_channel";
        slackTs = r.ts;
        slackChannel = r.channel;
      } else if (r.kind === "send_digest") {
        notifiedVia = "digest";
        slackTs = r.ts;
        slackChannel = r.channel;
      } else {
        // r.kind === "suppressed" : ts/channel sont des chaines vides
        // dans le return du notifier (plafond MED-1 atteint). On NE
        // peuple PAS slackTs/slackChannel pour que l'audit n'ait pas
        // de valeur mensongere.
        notifiedVia = "suppressed";
      }
    }

    // (c) Audit `inbound_on_inactive_conversation` — targetType depend du cas.
    await step.run(`audit-inbound-on-inactive-${params.stepSuffix}`, async () => {
      let targetType: "conversation" | "contact" | "message";
      let targetId: string;
      if (params.conversationId !== undefined) {
        targetType = "conversation";
        targetId = params.conversationId;
      } else if (params.contactId !== undefined) {
        targetType = "contact";
        targetId = params.contactId;
      } else {
        targetType = "message";
        targetId = orphanDocId ?? `orphan_${shortFingerprint(ovhMessageId)}`;
      }
      const payload: InboundOnInactiveConversationPayload = {
        reason: params.reason,
        wasOptOut: params.wasOptOut,
        ...(params.contactId !== undefined ? { contactId: params.contactId } : {}),
        ...(params.conversationId !== undefined ? { conversationId: params.conversationId } : {}),
        ...(params.messageId !== undefined ? { messageId: params.messageId } : {}),
        ...(orphanDocId !== undefined ? { orphanDocId } : {}),
        ...(params.phoneHash !== undefined ? { phoneHash: params.phoneHash } : {}),
        ...(params.assignedTo !== undefined ? { assignedTo: params.assignedTo } : {}),
        ...(slackChannel !== undefined ? { slackChannel } : {}),
        ...(slackTs !== undefined ? { slackTs } : {}),
        notifiedVia,
      };
      await _appendAuditLog({
        actorId: "system",
        actorType: "system",
        action: "inbound_on_inactive_conversation",
        targetType,
        targetId,
        payload,
      });
    });

    // (d) Sentry.
    await step.run(`observe-inactive-inbound-${params.stepSuffix}`, async () => {
      _captureMonitoringWarning(`process_reply.inbound_on_inactive_conversation.${params.reason}`, {
        level: sentryLevel,
        tags: {
          reason: params.reason,
          was_opt_out: params.wasOptOut ? "true" : "false",
          notified_via: notifiedVia,
        },
        extra: {
          eventId: event.id ?? "",
          ovhMessageIdFingerprint: shortFingerprint(ovhMessageId),
          phoneFingerprint: shortFingerprint(phone),
          ...(params.contactId !== undefined ? { contactId: params.contactId } : {}),
          ...(params.conversationId !== undefined ? { conversationId: params.conversationId } : {}),
          ...(params.messageId !== undefined ? { messageId: params.messageId } : {}),
          ...(orphanDocId !== undefined ? { orphanDocId } : {}),
        },
      });
    });

    logger.info("[process-reply] stored on inactive conversation", {
      eventId: event.id,
      reason: params.reason,
      wasOptOut: params.wasOptOut,
      notifiedVia,
      hasConversationId: params.conversationId !== undefined,
      hasMessageId: params.messageId !== undefined,
      hasOrphanDocId: orphanDocId !== undefined,
    });

    return {
      status: "stored_on_inactive_conversation" as const,
      reason: params.reason,
      wasOptOut: params.wasOptOut,
      ...(params.contactId !== undefined ? { contactId: params.contactId } : {}),
      ...(params.conversationId !== undefined ? { conversationId: params.conversationId } : {}),
      ...(params.messageId !== undefined ? { messageId: params.messageId } : {}),
      ...(orphanDocId !== undefined ? { orphanDocId } : {}),
    };
  }

  // ── Step 1 — resolve-contact ──────────────────────────────────────────
  const contactStep = await step.run("resolve-contact", async () => {
    const contact = await _getContactByPhone(phone);
    if (!contact) {
      return { found: false as const };
    }
    return { found: true as const, contactId: contact.hubspotId };
  });

  if (!contactStep.found) {
    // PR-NO-DROPPED-SMS — P1 : contact inconnu. Avant cette PR : audit
    // `reply_dropped reason:"contact_unknown"` + return `dropped`. Fait
    // prouve en prod le 16/10/2026 16:57 UTC : SMS perdu.
    // Nouveau : stockage orphelins + alerte canal + opt-out detecte signale
    // en header. Lea muette.
    const phoneHash = safePhoneHash(phone, _hashPii);
    const digitsOnly = phone.replace(/\D/g, "");
    const phoneLast4 = digitsOnly.slice(-4);
    const wasOptOut = _isOptOut(body);
    logger.info("[process-reply] contact unknown — routing to orphans", {
      eventId: event.id,
      step: "resolve-contact",
      wasOptOut,
    });
    return handleInactiveInbound({
      reason: "unknown_contact",
      stepSuffix: "unknown-contact",
      wasOptOut,
      sentryLevel: "warning",
      includeHereMention: wasOptOut,
      phoneHash,
      phoneLast4,
    });
  }

  const contactId = contactStep.contactId;
  logger.info("[process-reply] contact resolved", {
    eventId: event.id,
    contactId,
  });

  // ── Step 2 — resolve-conversation ─────────────────────────────────────
  //
  // PR-NO-DROPPED-SMS — cascade de resolution :
  //   1. Conv ACTIVE (active/awaiting_reply/in_dialogue/qualified) → nominal
  //      flow (steps 3+).
  //   2. Conv HANDED_OFF avec assignedTo valide → branche PR-A "relayed_to_human"
  //      (steps 3+ puis bloc isHandedOff).
  //   3. Conv HANDED_OFF SANS assignedTo (invariant soft brise) → P2 : store
  //      sur cette conv + canal orphelins + audit + Sentry error.
  //   4. Aucune active ni handed_off → `getLatestConv` pour trouver la conv
  //      la plus recente, quel que soit son statut (closed/opted_out/blocked).
  //      → P3 : store sur cette conv + markOptedOut si applicable + notif
  //      titulaire DM OU canal + audit reason=status + Sentry warning.
  //   5. Aucune conv du tout → P3' : store orphelins + canal + audit
  //      reason="no_conversation" + Sentry warning.
  //
  // Les 3 cas (3), (4), (5) sortent du pipeline normal via la branche
  // `stored_on_inactive_conversation`. Lea reste muette : pas de generation
  // Claude, pas de dispatch, pas de modification du statut de la conv.
  const convStep = await step.run("resolve-conversation", async () => {
    const active = await _getActiveConv(contactId);
    if (active) {
      return {
        kind: "active" as const,
        conversationId: active.conversationId,
      };
    }

    const handedOff = await _getHandedOffConv(contactId);
    if (handedOff) {
      const assignedTo = handedOff.conversation.handoff?.assignedTo;
      if (assignedTo === undefined || assignedTo === "") {
        return {
          kind: "handed_off_no_assignee" as const,
          conversationId: handedOff.conversationId,
        };
      }
      return {
        kind: "handed_off" as const,
        conversationId: handedOff.conversationId,
        assignedTo,
      };
    }

    const latest = await _getLatestConv(contactId);
    if (latest) {
      return {
        kind: "latest_inactive" as const,
        conversationId: latest.conversationId,
        latestStatus: latest.conversation.status,
        latestAssignedTo: latest.conversation.handoff?.assignedTo,
      };
    }

    return { kind: "none" as const };
  });

  // Dispatch des cas (3) (4) (5) via `handleInactiveInbound`. Les cas
  // (1) et (2) tombent dans la suite du pipeline normal.
  if (convStep.kind === "handed_off_no_assignee") {
    const phoneHash = safePhoneHash(phone, _hashPii);
    const digitsOnly = phone.replace(/\D/g, "");
    const phoneLast4 = digitsOnly.slice(-4);
    const wasOptOut = _isOptOut(body);
    // Store sur la conv handed_off meme sans assignedTo (preuve L.34-5 CPCE).
    const storeResult = await step.run("store-inbound-handed-off-no-assignee", async () => {
      return _addInboundIdempotent(convStep.conversationId, {
        body,
        channel: "sms",
        externalId: ovhMessageId,
        externalReceiver: phone,
      });
    });
    // markOptedOut si wasOptOut. Point 4 round 3 : catch RESTREINT au cas
    // precis `ValidationError` + `context.currentStatus` dans
    // {closed, blocked} (TERMINAL_CONV_STATUSES_FOR_OPT_OUT dans
    // contacts.ts). Toute autre erreur se propage pour que Inngest
    // retry : contactId vide, doc corrompu, Firestore 5xx, etc.
    if (wasOptOut) {
      await step.run("markoptedout-handed-off-no-assignee", async () => {
        try {
          await _markOptedOut(contactId, "sms", {
            conversationId: convStep.conversationId,
            intent: "STOP",
          });
        } catch (err) {
          if (err instanceof ValidationError) {
            const ctx = (err.context ?? {}) as { currentStatus?: unknown };
            const currentStatus =
              typeof ctx.currentStatus === "string" ? ctx.currentStatus : undefined;
            if (currentStatus === "closed" || currentStatus === "blocked") {
              logger.warn(
                "[process-reply] markOptedOut race on handed_off_no_assignee (conv devenue terminale)",
                {
                  eventId: event.id,
                  contactId,
                  conversationId: convStep.conversationId,
                  currentStatus,
                },
              );
              return;
            }
          }
          throw err;
        }
      });
    }
    return handleInactiveInbound({
      reason: "handed_off_no_assignee",
      stepSuffix: "handed-off-no-assignee",
      wasOptOut,
      sentryLevel: "error",
      includeHereMention: true,
      contactId,
      conversationId: convStep.conversationId,
      messageId: storeResult.messageId,
      phoneHash,
      phoneLast4,
    });
  }

  if (convStep.kind === "latest_inactive") {
    const phoneHash = safePhoneHash(phone, _hashPii);
    const digitsOnly = phone.replace(/\D/g, "");
    const phoneLast4 = digitsOnly.slice(-4);
    const wasOptOut = _isOptOut(body);
    const latestStatus: ConversationStatus = convStep.latestStatus;
    // Mapping status -> reason. Les statuts non-terminaux (active, etc.)
    // ne devraient JAMAIS atterrir ici (sinon getActiveConv les aurait
    // trouves). On fail-safe sur "closed" par defaut si drift inattendu.
    const reasonByStatus: Partial<Record<ConversationStatus, InboundOnInactiveConversationReason>> =
      {
        closed: "closed",
        opted_out: "opted_out",
        blocked: "blocked",
      };
    const reason: InboundOnInactiveConversationReason = reasonByStatus[latestStatus] ?? "closed";
    // Store sur la conv la plus recente (sans modifier son statut).
    const storeResult = await step.run("store-inbound-latest-inactive", async () => {
      return _addInboundIdempotent(convStep.conversationId, {
        body,
        channel: "sms",
        externalId: ovhMessageId,
        externalReceiver: phone,
      });
    });
    // Application opt-out (Finding 2 + Finding 3 PR-NO-DROPPED-SMS).
    //   - Si wasOptOut && contact deja opt-out  -> audit opt_out alreadyOptedOut:true
    //     en PLUS de inbound_on_inactive_conversation (Finding 3). Pas de
    //     markOptedOut (serait no-op).
    //   - Si wasOptOut && contact pas opt-out ET latestStatus `opted_out` ->
    //     cas edge : contact pas opt mais conv opted_out. On applique
    //     markOptedOut SANS conversationId (le guard
    //     TERMINAL_CONV_STATUSES_FOR_OPT_OUT ne liste que closed/blocked,
    //     donc opted_out ne throw pas, mais on evite de passer convId pour
    //     ne pas rouvrir une conv terminale).
    //   - Si wasOptOut && contact pas opt-out && latestStatus `closed`/`blocked` ->
    //     markOptedOut sans conversationId pour eviter le ValidationError
    //     TERMINAL_CONV_STATUSES_FOR_OPT_OUT. On flip le contact uniquement.
    if (wasOptOut) {
      await step.run("apply-opt-out-latest-inactive", async () => {
        const contact = await _getContact(contactId);
        const alreadyOptedOut = contact?.consent.optedOut === true;
        if (alreadyOptedOut) {
          // Finding 3 : audit `opt_out alreadyOptedOut:true` en plus de
          // inbound_on_inactive_conversation (reaffirmation du choix PS).
          await _appendAuditLog({
            actorId: "system",
            actorType: "system",
            action: "opt_out",
            targetType: "contact",
            targetId: contactId,
            payload: {
              channel: "sms",
              conversationId: convStep.conversationId,
              alreadyOptedOut: true,
              reason: "reaffirmation_on_inactive_conversation",
            },
          });
          return;
        }
        // Contact pas opt-out encore. On flip. Pas de conversationId pour
        // eviter TERMINAL_CONV_STATUSES_FOR_OPT_OUT quand latestStatus =
        // closed/blocked. markOptedOut sans convId = flip contact only.
        await _markOptedOut(contactId, "sms", { intent: "STOP" });
      });
    }
    return handleInactiveInbound({
      reason,
      stepSuffix: `latest-inactive-${reason}`,
      wasOptOut,
      sentryLevel: "warning",
      includeHereMention: false,
      contactId,
      conversationId: convStep.conversationId,
      messageId: storeResult.messageId,
      ...(convStep.latestAssignedTo !== undefined ? { assignedTo: convStep.latestAssignedTo } : {}),
      phoneHash,
      phoneLast4,
    });
  }

  if (convStep.kind === "none") {
    // Contact connu sans AUCUNE conv (bug amont ou donnee corrompue).
    // Stockage orphelins avec contactId renseigne + canal.
    const phoneHash = safePhoneHash(phone, _hashPii);
    const digitsOnly = phone.replace(/\D/g, "");
    const phoneLast4 = digitsOnly.slice(-4);
    const wasOptOut = _isOptOut(body);
    // Finding 2 PR-NO-DROPPED-SMS : markOptedOut OBLIGATOIRE si wasOptOut.
    // Les erreurs propagent (contact disparu entre step 1 et ici = bug
    // amont). Finding 3 : si contact deja opt-out, audit
    // `opt_out alreadyOptedOut:true` au lieu du no-op markOptedOut
    // silencieux (preserver trace de la reaffirmation).
    if (wasOptOut) {
      await step.run("apply-opt-out-no-conversation", async () => {
        const contact = await _getContact(contactId);
        const alreadyOptedOut = contact?.consent.optedOut === true;
        if (alreadyOptedOut) {
          await _appendAuditLog({
            actorId: "system",
            actorType: "system",
            action: "opt_out",
            targetType: "contact",
            targetId: contactId,
            payload: {
              channel: "sms",
              alreadyOptedOut: true,
              reason: "reaffirmation_on_no_conversation",
            },
          });
          return;
        }
        // Flip contact (pas de conversationId car aucune conv). Les
        // erreurs ValidationError (contactId vide) / NotFoundError
        // (contact disparu) propagent : bug amont, Inngest retry.
        await _markOptedOut(contactId, "sms", { intent: "STOP" });
      });
    }
    return handleInactiveInbound({
      reason: "no_conversation",
      stepSuffix: "no-conversation",
      wasOptOut,
      sentryLevel: "warning",
      includeHereMention: true,
      contactId,
      phoneHash,
      phoneLast4,
    });
  }

  // Cas nominaux : active ou handed_off (avec assignedTo valide).
  const conversationId = convStep.conversationId;
  const isHandedOff = convStep.kind === "handed_off";
  logger.info("[process-reply] conversation resolved", {
    eventId: event.id,
    contactId,
    conversationId,
    isHandedOff,
  });

  // ── Step 3 — dedup-by-external-id ─────────────────────────────────────
  const dedupStep = await step.run("dedup-by-external-id", async () => {
    const existing = await _findInbound(conversationId, ovhMessageId);
    if (existing) {
      await _appendAuditLog({
        actorId: "system",
        actorType: "system",
        action: "reply_dropped",
        targetType: "message",
        targetId: existing.messageId,
        payload: {
          reason: "duplicate",
          contactId,
          conversationId,
          duplicateOfMessageId: existing.messageId,
        },
      });
      return { isDuplicate: true as const };
    }
    return { isDuplicate: false as const };
  });

  if (dedupStep.isDuplicate) {
    logger.info("[process-reply] dropped", {
      eventId: event.id,
      contactId,
      conversationId,
      step: "dedup-by-external-id",
      reason: "duplicate",
    });
    return { status: "dropped", reason: "duplicate" };
  }

  // ── Step 4 — store-inbound (atomique via docId deterministe) ──────────
  //
  // 🔒 FIX BUG-DEDUP-RACE (B) — Idempotence Firestore STRICTE.
  //
  // AVANT ce fix : `addInbound` creait un doc avec un auto-ID aleatoire.
  // 2 pipelines concurrents sur le meme ovhMessageId creaient 2 docs
  // distincts (externalId identique, docId different) -> 2 inbounds
  // stockes + 2 drafts + 2 SMS envoyes au PS en prod sur conv active.
  //
  // Maintenant : `addInboundIdempotent` utilise un docId DETERMINISTE
  // derive de l'externalId (safeExternalIdHash). `tx.create` throw
  // ALREADY_EXISTS si un run concurrent a deja commit -> le run perdant
  // recoit `{ created: false }`, pose un audit `reply_dropped` avec
  // reason "duplicate", et sort proprement SANS effet downstream (pas
  // de DM Slack, pas de generation Claude, pas de dispatch OVH).
  //
  // Belt-and-braces avec la dedup Inngest 60s (fix A dans route.ts) :
  // le fix A couvre > 95% des retries OVH (meme event.id), le fix B
  // garantit la correction meme sur une race au-dela de la fenetre
  // Inngest OU si un cold-start / bascule region fait echouer la
  // memoization.
  //
  // Stocke TOUS les inbounds AVANT le check opt-out (forensic juridique
  // L.34-5 CPCE : un STOP doit etre conserve en preuve).
  const storeResult = await step.run("store-inbound", async () => {
    return _addInboundIdempotent(conversationId, {
      body,
      channel: "sms",
      externalId: ovhMessageId,
      // L'EXPEDITEUR (= PS), nomme `externalReceiver` par homogeneite
      // schema (cf. JSDoc messages.ts:234-239).
      externalReceiver: phone,
    });
  });

  if (!storeResult.created) {
    // Run perdant d'une race Firestore. Un autre pipeline a deja stocke
    // l'inbound (ou retry Inngest apres un commit succes du run gagnant).
    // On pose un audit `reply_dropped reason:"duplicate"` et on sort
    // sans effet downstream.
    const phoneHash = safePhoneHash(phone, _hashPii);

    // Alerte Sentry observabilite (fix compliance-auditor INFO-1) :
    // en prod, un volume anormalement eleve de duplicate_atomic_race
    // (vs findInbound step-3) est un symptome de retry OVH anormal OU
    // d'une bascule region Inngest qui casse la memoization. Permet
    // d'alerter avant que l'operateur ne doive requeter audit_log.
    //
    // Payload scrubber-safe : IDs opaques + fingerprints djb2 (pas
    // d'ovhMessageId brut ni de phone — le scrubber Sentry pourrait
    // les masquer en [PHONE] ou alerter en PII leak).
    await step.run("observe-duplicate-atomic-race", async () => {
      _captureMonitoringWarning("process_reply.duplicate_atomic_race", {
        tags: { via: "atomic_create" },
        extra: {
          contactId,
          conversationId,
          messageId: storeResult.messageId,
          // event.id est optionnel cote Inngest typing — fallback string
          // vide pour satisfaire le type `extra` (string|number|boolean|null).
          eventId: event.id ?? "",
          ovhMessageIdFingerprint: shortFingerprint(ovhMessageId),
          phoneFingerprint: shortFingerprint(phone),
        },
      });
    });

    await step.run("audit-duplicate-atomic", async () => {
      await _appendAuditLog({
        actorId: "system",
        actorType: "system",
        action: "reply_dropped",
        targetType: "message",
        targetId: storeResult.messageId,
        payload: {
          reason: "duplicate",
          contactId,
          conversationId,
          duplicateOfMessageId: storeResult.messageId,
          phoneHash,
          via: "atomic_create",
        },
      });
    });
    logger.info("[process-reply] dropped", {
      eventId: event.id,
      contactId,
      conversationId,
      step: "store-inbound",
      reason: "duplicate",
      via: "atomic_create",
    });
    return { status: "dropped", reason: "duplicate" };
  }

  const messageId = storeResult.messageId;

  logger.info("[process-reply] inbound stored", {
    eventId: event.id,
    contactId,
    conversationId,
    messageId,
  });

  // ── PR-A — helper race "conversation_became_terminal" ─────────────────
  //
  // Entre le step 2 (resolve-conversation handed_off) et le markOptedOut
  // du bloc handed_off, la conversation peut avoir ete passee a `closed`
  // ou `blocked` par un autre flux (admin, compliance). Le guard
  // TERMINAL_CONV_STATUSES_FOR_OPT_OUT dans `markOptedOut` throw alors
  // `ValidationError` avec `context.currentStatus`.
  //
  // Comportement PR-NO-DROPPED-SMS (P6) : plus de `throw NonRetriableError`
  // avant la notification. Le helper RETOURNE un marker `terminal_race`
  // avec le `currentStatus` observe. Le caller invoque alors
  // `handleInactiveInbound` reason="conversation_became_terminal" qui
  // (a) pose l'audit `inbound_on_inactive_conversation` + wasOptOut:true,
  // (b) envoie le DM au titulaire avec en-tete "Desabonnement recu pendant
  //     un changement de statut : verifier la fiche.",
  // (c) alerte Sentry level "error",
  // (d) retourne proprement `stored_on_inactive_conversation`.
  //
  // Pas de retry Inngest sur cette branche (le return est un succes).
  // Dedup des sous-steps garantit qu'une re-livraison ne redeclenche pas
  // le DM.
  //
  // Une erreur ValidationError sans currentStatus terminal (= autre cause,
  // ex: contactId vide) est propagee telle quelle → Inngest retry OK.
  type RaceGuardOutcome =
    | { outcome: "applied" }
    | { outcome: "terminal_race"; currentStatus: "closed" | "blocked" };
  async function markOptedOutWithRaceGuard(params: {
    contactId: string;
    conversationId: string;
    messageId: string;
    was: InboundRelayedOptOutVia;
  }): Promise<RaceGuardOutcome> {
    try {
      await _markOptedOut(params.contactId, "sms", {
        conversationId: params.conversationId,
        intent: "STOP",
      });
      return { outcome: "applied" };
    } catch (err) {
      if (err instanceof ValidationError) {
        const ctx = (err.context ?? {}) as { currentStatus?: unknown };
        const currentStatus = typeof ctx.currentStatus === "string" ? ctx.currentStatus : undefined;
        if (currentStatus === "closed" || currentStatus === "blocked") {
          logger.warn("[process-reply] handed-off opt-out race: conv became terminal", {
            eventId: event.id,
            contactId: params.contactId,
            conversationId: params.conversationId,
            messageId: params.messageId,
            currentStatus,
            optOutVia: params.was,
          });
          return { outcome: "terminal_race", currentStatus };
        }
      }
      // Autre ValidationError (contactId vide, doc corrompu...) ou autre
      // erreur : propagation telle quelle, Inngest decide (retry si transient).
      throw err;
    }
  }

  // ── PR-A — branche "relayed_to_human" (handed_off only) ───────────────
  // Court-circuite les steps 5-9 classiques. Léa reste MUETTE : pas de
  // setConversationIntent (le status reste handed_off, ou devient
  // opted_out si STOP), pas de generateReply, pas de dispatch-reply-event,
  // pas de dispatch-handoff-event. Le pipeline ne consulte Claude QUE pour
  // détecter un STOP long-forme (invariant GUARD-001 préservé pour les
  // conv handed_off aussi).
  //
  // 🔒 ORDRE DES SOUS-STEPS :
  //   (a) handed-off-short-form-opt-out-check → markOptedOut si STOP court
  //   (b) handed-off-claude-classify → classifier Claude SI pas d'opt-out
  //       court. Branche STOP uniquement. Toute autre valeur (INTERESSE,
  //       OBJECTION, NEUTRE, AUTO_REPLY) est ignorée côté effet métier :
  //       on relaye tel quel au titulaire humain.
  //   (c) handed-off-markoptedout-long-form → markOptedOut si classifier STOP
  //   (d) enrich-for-notify → getContact pour firstName/speciality/city
  //   (e) notify-inbound-after-handoff → DM Slack au titulaire
  //   (f) audit-inbound-relayed-to-human → audit forensic
  if (convStep.kind === "handed_off") {
    const assignedTo = convStep.assignedTo;

    // (a) short-form opt-out — fast-path déterministe, zéro appel Claude.
    const hoOptOutStep = await step.run("handed-off-short-form-opt-out-check", async () => {
      if (_isOptOut(body)) {
        // markOptedOut étendu : grâce au fix PR-A (handed_off retiré de
        // TERMINAL_CONV_STATUSES_FOR_OPT_OUT côté contacts.ts), la tx
        // réussit : contact.consent.optedOut flip + conv passe de
        // handed_off → opted_out + audit opt_out posé dans la même tx.
        //
        // RACE GUARD (P6 PR-NO-DROPPED-SMS) : si la conv est devenue
        // `closed`/`blocked` entre step 2 et ici, `markOptedOutWithRaceGuard`
        // retourne `terminal_race` SANS throw. Le caller detecte le marker
        // apres le step et bascule sur `handleInactiveInbound`.
        const guard = await markOptedOutWithRaceGuard({
          contactId,
          conversationId,
          messageId,
          was: "short_form",
        });
        return { isOptOut: true as const, raceOutcome: guard };
      }
      return { isOptOut: false as const };
    });

    // P6 — short-form race : conv devenue terminale pendant le pipeline.
    if (hoOptOutStep.isOptOut && hoOptOutStep.raceOutcome.outcome === "terminal_race") {
      const phoneHash = safePhoneHash(phone, _hashPii);
      const digitsOnly = phone.replace(/\D/g, "");
      const phoneLast4 = digitsOnly.slice(-4);
      logger.warn("[process-reply] P6 short-form race -> handleInactiveInbound", {
        eventId: event.id,
        contactId,
        conversationId,
        messageId,
        currentStatus: hoOptOutStep.raceOutcome.currentStatus,
      });
      return handleInactiveInbound({
        reason: "conversation_became_terminal",
        stepSuffix: "p6-short-form",
        wasOptOut: true,
        sentryLevel: "error",
        includeHereMention: true,
        contactId,
        conversationId,
        messageId,
        assignedTo,
        phoneHash,
        phoneLast4,
      });
    }

    // Décision du chemin opt-out : short-forme | classifier long-forme | aucun.
    let wasOptOut = hoOptOutStep.isOptOut;
    let optOutVia: InboundRelayedOptOutVia | undefined = hoOptOutStep.isOptOut
      ? "short_form"
      : undefined;

    // (b) + (c) classifier STOP-only — SEULEMENT si pas d'opt-out court-forme.
    // Fail-safe : si le classifier throw / renvoie STOP par fallback, on
    // ferme GUARD-001 côté handed_off aussi.
    if (!wasOptOut) {
      const hoClassification = await step.run("handed-off-claude-classify", async () => {
        return _classifyReply(body);
      });

      // Audit du verdict classifier (miroir du step 6b classique) — même
      // forme de payload, même anti-PII strict. Préserve la trace du
      // verdict Claude indépendamment de ce que fait la branche.
      await step.run("handed-off-audit-intent-classified", async () => {
        await _appendAuditLog({
          actorId: "system",
          actorType: "system",
          action: "intent_classified",
          targetType: "message",
          targetId: messageId,
          payload: {
            contactId,
            conversationId,
            intent: hoClassification.intent,
            confidence: hoClassification.confidence,
            fallback: hoClassification.fallback,
            promptVersion: CLASSIFY_INTENT_PROMPT_VERSION,
            model: CLASSIFY_INTENT_MODEL,
          },
        });
      });

      if (hoClassification.intent === "STOP") {
        const longFormGuard = await step.run("handed-off-markoptedout-long-form", async () => {
          // Race guard identique a la branche short-form (P6).
          return markOptedOutWithRaceGuard({
            contactId,
            conversationId,
            messageId,
            was: "classifier_long_form",
          });
        });
        if (longFormGuard.outcome === "terminal_race") {
          const phoneHash = safePhoneHash(phone, _hashPii);
          const digitsOnly = phone.replace(/\D/g, "");
          const phoneLast4 = digitsOnly.slice(-4);
          logger.warn("[process-reply] P6 classifier-long-form race -> handleInactiveInbound", {
            eventId: event.id,
            contactId,
            conversationId,
            messageId,
            currentStatus: longFormGuard.currentStatus,
            classifierFallback: hoClassification.fallback,
          });
          return handleInactiveInbound({
            reason: "conversation_became_terminal",
            stepSuffix: "p6-classifier-long-form",
            wasOptOut: true,
            sentryLevel: "error",
            includeHereMention: true,
            contactId,
            conversationId,
            messageId,
            assignedTo,
            phoneHash,
            phoneLast4,
          });
        }
        wasOptOut = true;
        optOutVia = "classifier_long_form";

        logger.info("[process-reply] handed-off classifier long-form opt-out applied", {
          eventId: event.id,
          contactId,
          conversationId,
          messageId,
          step: "handed-off-markoptedout-long-form",
          classifierFallback: hoClassification.fallback,
        });
      }
    }

    // (d) enrich-for-notify — on relit le contact pour obtenir
    // firstName/speciality/city. Lecture isolée dans son propre step →
    // idempotence Inngest (memoization sur retry).
    //
    // Si le contact a disparu entre step 1 et ici (très improbable, mais
    // techniquement possible si un admin supprime en course), on log et
    // on bascule sur un DM "fallback" neutre. On NE drop PAS : le
    // message est déjà stocké, le commercial doit être prévenu même
    // avec un contexte minimal.
    const enrichedContact = await step.run("enrich-for-notify", async () => {
      const contact = await _getContact(contactId);
      if (!contact) {
        logger.warn(
          "[process-reply] handed-off relay: contact disappeared between step 1 and enrich",
          {
            eventId: event.id,
            contactId,
            conversationId,
          },
        );
        return { found: false as const };
      }
      return {
        found: true as const,
        firstName: contact.firstName,
        speciality: contact.speciality,
        city: contact.city,
      };
    });

    // (e) notify-inbound-after-handoff — DM Slack. Memoized Inngest step →
    // retry après succès ne re-poste pas. Sur failure propage
    // ExternalServiceError pour que Inngest retry (retries:3).
    const slackResult = await step.run("notify-inbound-after-handoff", async () => {
      const dashboardUrl = _getDashboardUrl(conversationId);
      return _sendInboundAfterHandoff({
        target: { kind: "dm", slackUserId: assignedTo },
        firstName: enrichedContact.found ? enrichedContact.firstName : "le lead",
        speciality: enrichedContact.found ? enrichedContact.speciality : "contact inconnu",
        city: enrichedContact.found ? enrichedContact.city : "ville inconnue",
        lastInboundBody: body,
        conversationId,
        isOptOut: wasOptOut,
        dashboardUrl,
      });
    });

    // (f) audit-inbound-relayed-to-human — forensic L.34-5 CPCE + traçabilité
    // commerciale. Payload strict `InboundRelayedToHumanPayload` : IDs
    // opaques + Slack IDs + boolean + enum fermé. Aucune PII.
    await step.run("audit-inbound-relayed-to-human", async () => {
      const payload: InboundRelayedToHumanPayload = {
        contactId,
        conversationId,
        messageId,
        assignedTo,
        slackTs: slackResult.ts,
        slackChannel: slackResult.channel,
        wasOptOut,
        ...(optOutVia !== undefined ? { optOutVia } : {}),
      };
      await _appendAuditLog({
        actorId: "system",
        actorType: "system",
        action: "inbound_relayed_to_human",
        targetType: "conversation",
        targetId: conversationId,
        payload,
      });
    });

    logger.info("[process-reply] handed-off relay done", {
      eventId: event.id,
      contactId,
      conversationId,
      messageId,
      wasOptOut,
      step: "audit-inbound-relayed-to-human",
    });

    if (wasOptOut) {
      // Discriminant `via` : short_form OU classifier_long_form sur handed_off.
      // Préfixe `handed_off_` pour les distinguer des branches sur conv active.
      const via =
        optOutVia === "classifier_long_form"
          ? "handed_off_classifier_long_form"
          : "handed_off_short_form";
      return {
        status: "opt_out",
        contactId,
        conversationId,
        messageId,
        intent: "STOP",
        via,
      };
    }

    return {
      status: "relayed_to_human",
      contactId,
      conversationId,
      messageId,
      assignedTo,
    };
  }

  // ── Step 5 — short-form-opt-out-check (fast-path déterministe) ────────
  // Économise un appel Claude pour les opt-out courts évidents (STOP,
  // ARRET, DESINSCRIPTION, ≤ 50 chars). Le long-form opt-out (>50 chars)
  // est rattrapé par le classifier Claude en step 6/7 (ferme GUARD-001).
  const optOutStep = await step.run("short-form-opt-out-check", async () => {
    if (_isOptOut(body)) {
      // S9.2.2.2 — markOptedOut variante étendue : synchronise la
      // conversation (intent="STOP", status="opted_out") dans la MÊME tx
      // que le contact. Ferme le trou de désync S9.2.1 où le contact
      // était marqué opted_out mais la conv restait awaiting_reply.
      await _markOptedOut(contactId, "sms", {
        conversationId,
        intent: "STOP",
      });
      return { isOptOut: true as const };
    }
    return { isOptOut: false as const };
  });

  if (optOutStep.isOptOut) {
    logger.info("[process-reply] short-form opt-out applied", {
      eventId: event.id,
      contactId,
      conversationId,
      messageId,
      step: "short-form-opt-out-check",
    });
    // S9.2.3 — Step 8 audit-reply-processed. Pas de classifierFallback
    // sur short_form (court-circuit avant Claude).
    await postReplyProcessedAudit({
      contactId,
      conversationId,
      messageId,
      intent: "STOP",
      branchTaken: "opt_out_short_form",
      finalConversationStatus: "opted_out",
    });
    return {
      status: "opt_out",
      contactId,
      conversationId,
      messageId,
      intent: "STOP",
      via: "short_form",
    };
  }

  // ── Step 6a — claude-classify (S9.3.1 split) ──────────────────────────
  // Appel classifier sur les messages non-opt-out short-form. Le classifier
  // a un contrat fail-safe STOP : toute erreur SDK absorbée → fallback
  // intent="STOP" + fallback=true (précaution juridique L.34-5 CPCE).
  //
  // 🔒 **Idempotence pleine Claude (S9.3.1 ferme S9.3-FOLLOWUP-1)** : le
  // step est ISOLÉ de l'audit `intent_classified` (step 6b). Si l'audit
  // Firestore throw (5xx transient, AuditPiiError d'un payload futur mal
  // posé), Inngest retry → step 6a est servi depuis le cache memoization
  // par `(eventId, "claude-classify")` → 0 ré-appel Claude → 0 double
  // facturation. Verrouillé par Test 6 de `process-reply.memoization.test.ts`.
  //
  // Le `logger.warn` fallback reste DANS step 6a car c'est un side-effect
  // d'observabilité lié à l'APPEL Claude (pas à son audit). Sur retry du
  // step 6b, l'observabilité du fallback est déjà loggée par le premier
  // run du step 6a — pas de double-log non plus.
  const classification = await step.run("claude-classify", async () => {
    const result = await _classifyReply(body);

    // Observabilité fail-safe (Q2 brief S9.2.2) : un fallback=true signale
    // un échec SDK (timeout, 429, tool_use malformé). À monitorer en prod —
    // si taux > 5%, alerter Sentry/Slack (câblage S9.6). Aucune PII dans
    // le log : seulement les IDs opaques + le messageId Firestore.
    if (result.fallback) {
      logger.warn("[process-reply] classifier_fallback", {
        eventId: event.id,
        contactId,
        conversationId,
        messageId,
        step: "claude-classify",
      });
    }

    return result;
  });

  // ── Step 6b — audit-intent-classified (S9.3.1 split) ──────────────────
  // Audit du verdict classifier, séparé de l'appel Claude pour garantir
  // l'idempotence Claude sur retry (cf. JSDoc step 6a + sentinelle MED-1).
  //
  // `classification` ci-dessus est le résultat commit du step 6a — sur
  // retry du step 6b après failure transient, la valeur servie au handler
  // sera servie depuis le cache memoization Inngest (pas de ré-appel SDK).
  //
  // Audit posé AVANT le branch step 7 (Q1 brief Déthié S9.2.2) — on audit
  // le VERDICT classifier indépendamment de ce que le pipeline en fait
  // ensuite. Payload scrubber-safe (pas de body, pas de reasoning).
  await step.run("audit-intent-classified", async () => {
    await _appendAuditLog({
      actorId: "system",
      actorType: "system",
      action: "intent_classified",
      targetType: "message",
      targetId: messageId,
      // Payload scrubber-safe (cf. Q1 arbitrage Déthié S9.2.2.0) :
      //   - contactId/conversationId/messageId : IDs opaques internes.
      //   - intent : enum fermé (`INTENT_VALUES`).
      //   - confidence : number [0,1].
      //   - fallback : boolean (distingue STOP authentique vs panne).
      //   - promptVersion : `"1.0.1"`, marker forensic + corrélation
      //     post-mortem si un changement prompt dégrade un intent.
      //   - model : `"claude-haiku-4-5-20251001"` snapshot daté
      //     (déterminisme compliance).
      // OMIS volontairement :
      //   - `reasoning` : defense-in-depth anti-fuite PII (le prompt
      //     l'interdit côté Claude, mais on ne fait pas confiance).
      //   - `tokensInput/tokensOutput` : disponibles via logs Pino côté
      //     wrapper Claude. Agrégation Firestore reportée S10+ si besoin
      //     (cf. Q1 arbitrage Déthié).
      payload: {
        contactId,
        conversationId,
        intent: classification.intent,
        confidence: classification.confidence,
        fallback: classification.fallback,
        promptVersion: CLASSIFY_INTENT_PROMPT_VERSION,
        model: CLASSIFY_INTENT_MODEL,
      },
    });
  });

  // ── Step 7 — branch-by-intent ────────────────────────────────────────
  // 4 branches discriminées par classifier.intent :
  //   STOP        → markOptedOut étendu (idem step 5 mais via classifier
  //                 long-form, discriminant `via: "classifier_long_form"`).
  //   INTERESSE   → setConversationIntent + nextStatus="in_dialogue".
  //   OBJECTION   → idem INTERESSE.
  //   NEUTRE      → idem INTERESSE.
  //
  // L'invariant GUARD-001 (long-form opt-out rattrapé par Claude) est
  // verrouillé par un test sentinelle dans process-reply.test.ts :
  // `isOptOut(body) === false` ET `result.intent === "STOP"` →
  // branche STOP empruntée + markOptedOut appelé avec conversationId.
  if (classification.intent === "STOP") {
    await step.run("branch-stop", async () => {
      // markOptedOut étendu : idempotent si le contact + conv sont déjà
      // à l'état final. Pose un audit `opt_out` avec payload enrichi
      // {channel, conversationId}.
      await _markOptedOut(contactId, "sms", {
        conversationId,
        intent: "STOP",
      });
    });

    logger.info("[process-reply] classifier long-form opt-out applied", {
      eventId: event.id,
      contactId,
      conversationId,
      messageId,
      step: "branch-stop",
      classifierFallback: classification.fallback,
    });

    // S9.2.3 — Step 8 audit-reply-processed. classifierFallback présent
    // car branche passée par Claude.
    await postReplyProcessedAudit({
      contactId,
      conversationId,
      messageId,
      intent: "STOP",
      branchTaken: "opt_out_classifier_long_form",
      finalConversationStatus: "opted_out",
      classifierFallback: classification.fallback,
    });

    return {
      status: "opt_out",
      contactId,
      conversationId,
      messageId,
      intent: "STOP",
      via: "classifier_long_form",
    };
  }

  // INTERESSE / OBJECTION / NEUTRE / AUTO_REPLY — la conv passe en
  // in_dialogue. S9.3.3b génère + stocke le draft + audit reply_generated.
  const nonStopIntent = classification.intent;

  // ── Step 7bis — OBSERVABILITÉ AUTO_REPLY (PR-AUTO-REPLY-OBSERVABILITE) ─
  //
  // 🔒 ZÉRO CHANGEMENT DE COMPORTEMENT. On n'interrompt rien : l'IA répond
  // exactement comme avant. On rend seulement la détection AUDIBLE.
  //
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // POURQUOI CETTE PR EXISTE SÉPARÉMENT DE L'ACTIVATION
  //
  // PR1 (#44) a posé la détection sans couper, pour mesurer le taux de
  // faux positifs sur du trafic réel avant de cesser de répondre à de
  // vrais PS. Mais elle n'écrivait la donnée QUE dans `audit_log`
  // (`intent_classified`), et **aucun consommateur ne lit cette
  // collection** : pas de vue conversations au dashboard, pas d'alerte.
  // La phase d'observation ne pouvait donc pas produire son échantillon.
  //
  // Cette PR ferme ce trou et RIEN D'AUTRE. L'activation de la coupure
  // reste subordonnée à la lecture des données produites ici.
  //
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ALERTE À CHAQUE DÉTECTION, PAS AU-DELÀ D'UN SEUIL
  //
  // À l'échelle MVP (200 dentistes IDF) le volume le permet, et c'est
  // précisément ce qui fournit l'échantillon à examiner MANUELLEMENT :
  // pour chaque alerte, on relit le body dans `messages/{messageId}` et on
  // tranche « vraie machine » vs « faux positif ». Sans ce grain fin, on
  // ne peut pas calibrer la décision d'activation.
  // ⚠️ À reconsidérer (agrégation 24h) avant la montée à 26k contacts.
  //
  // Encapsulé dans un `step.run` pour l'idempotence Inngest : un retry du
  // pipeline ne doit pas re-déclencher l'alerte (la memoization sert le
  // résultat en cache). Les `logger.info` du pipeline, eux, vivent hors
  // step et se répètent au retry — comportement voulu pour du log brut,
  // pas pour une alerte.
  //
  // Payload scrubber-safe : IDs opaques + number + boolean. PAS de body,
  // PAS de `reasoning` classifier (invariant anti-PII du step 6b).
  if (nonStopIntent === "AUTO_REPLY") {
    await step.run("observe-auto-reply", async () => {
      _captureMonitoringWarning("process_reply.auto_reply_detected", {
        tags: { phase: "observe_only" },
        extra: {
          contactId,
          conversationId,
          messageId,
          confidence: classification.confidence,
          classifierFallback: classification.fallback,
        },
      });
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // 🔻 COUTURE PR1 → PR2 (PR1-AUTO-REPLY-OBSERVE) — LIRE AVANT DE TOUCHER
  //
  // PR1 NE COUPE RIEN. Un `AUTO_REPLY` est traité EXACTEMENT comme un
  // `NEUTRE` : la conv passe en in_dialogue, Claude génère, le SMS part.
  // Le comportement observable est donc STRICTEMENT identique à avant.
  //
  // Ce que PR1 apporte : l'audit `intent_classified` (step 6b) enregistre
  // la classification BRUTE (`classification.intent`, donc `AUTO_REPLY`
  // le cas échéant) AVANT ce remapping. C'est la donnée qu'on vient
  // chercher — mesurer le taux de faux positifs sur du trafic réel avant
  // de cesser de répondre à de vrais PS.
  //
  // Pourquoi observer d'abord : le coût d'un faux positif est asymétrique
  // ET SILENCIEUX (un PS humain classé machine ne reçoit plus jamais de
  // réponse, et personne ne s'en aperçoit). Le coût d'un faux négatif est
  // le comportement actuel. On ne coupe pas à l'aveugle.
  //
  // ⚠️ PR2 remplacera CETTE ligne par un early return (pas de génération,
  // pas d'event, pas de hand-off, audit `reply_dropped` avec
  // `reason: "auto_reply_detected"` + garde `confidence >= 0.8`).
  // C'est le SEUL endroit à modifier : tout l'aval consomme
  // `effectiveIntent`.
  //
  // Le remapping vers "NEUTRE" est aussi ce qui garantit la décision
  // Déthié « AUTO_REPLY n'entre jamais dans l'état conversation » :
  // `_setConversationIntent` ne verra jamais cette valeur.
  // ─────────────────────────────────────────────────────────────────────
  const effectiveIntent: GenerateReplyIntent =
    nonStopIntent === "AUTO_REPLY" ? "NEUTRE" : nonStopIntent;

  await step.run(`branch-${effectiveIntent.toLowerCase()}`, async () => {
    await _setConversationIntent(conversationId, effectiveIntent, {
      nextStatus: "in_dialogue",
    });
  });

  logger.info("[process-reply] classified", {
    eventId: event.id,
    contactId,
    conversationId,
    messageId,
    intent: nonStopIntent,
    step: `branch-${nonStopIntent.toLowerCase()}`,
  });

  // ── Step 8a — claude-generate-${intent} (S9.3.3b) ─────────────────────
  // Appel Claude Sonnet 4.6 isolé en step.run distinct pour idempotence
  // pleine sur retry (cohérent S9.3.1 split classify-intent). Si step 8b
  // ou 8c throw → retry → step 8a est servi depuis cache memoization
  // Inngest → 0 ré-appel Claude (anti-double-facturation).
  //
  // Charge l'historique 3 derniers messages (drafts exclus, S9.3.3a) +
  // appelle generateReply qui propage toute AppError SDK (pas de fallback
  // artificiel — décision Déthié S9.3.0). Si Claude omet "Médéré", le
  // wrapper throw ExternalServiceError retry-friendly (triple garde Q3).
  //
  // contactCivility=undefined en MVP — voir S9.5-CONTACT-CIVILITY-IN-REPLY-001
  // pour étendre resolve-contact step 1.
  const generationResult = await step.run(
    `claude-generate-${effectiveIntent.toLowerCase()}`,
    async () => {
      const history = await _listRecentMessages(conversationId);
      return _generateReply({
        intent: effectiveIntent,
        rawMessage: body,
        history,
      });
    },
  );

  // ── Step 8b — store-draft (S9.3.3b) ───────────────────────────────────
  // Stockage Firestore atomique via tx (addOutboundDraft wrap
  // addOutboundDraftInTx). Status="draft" — NE BUMP PAS counters
  // conversation, NE POSE PAS audit sms_sent (S9.3.3a invariants).
  // Sera transitionné en S9.4 via commitDraftToQueued.
  //
  // Si throw (Firestore 5xx transient) → retry, step 8a servi depuis
  // cache → 0 ré-appel Claude. Si succeed → draftMessageId cached pour
  // step 8c.
  const draftMessageId = await step.run("store-draft", async () => {
    return _addOutboundDraft({
      contactId,
      conversationId,
      body: generationResult.body,
      aiModel: generationResult.model,
      aiPromptVersion: generationResult.promptVersion,
      aiTemperature: generationResult.temperature,
      aiTokensInput: generationResult.tokensInput,
      aiTokensOutput: generationResult.tokensOutput,
      aiGenerationDurationMs: generationResult.generationDurationMs,
    });
  });

  // ── Step 8c — audit-reply-generated (S9.3.3b) ─────────────────────────
  // Audit forensic L.34-5 CPCE du verdict génération. Payload strict
  // `ReplyGeneratedPayload` (defense-in-depth anti-PII : pas de `body`
  // brut, seulement `bodyLength`). Cf. LOW-4 compliance-auditor S9.3.2 +
  // NIT-1 compliance-auditor S9.3.3a.
  //
  // Si throw → retry, steps 8a + 8b servis depuis cache → 0 ré-appel
  // Claude + 0 double-doc Firestore.
  await step.run("audit-reply-generated", async () => {
    const payload: ReplyGeneratedPayload = {
      contactId,
      conversationId,
      draftMessageId,
      intent: effectiveIntent,
      promptVersion: generationResult.promptVersion,
      model: generationResult.model,
      temperature: generationResult.temperature,
      tokensInput: generationResult.tokensInput,
      tokensOutput: generationResult.tokensOutput,
      bodyLength: generationResult.body.length,
      generationDurationMs: generationResult.generationDurationMs,
    };
    await _appendAuditLog({
      actorId: "system",
      actorType: "system",
      action: "reply_generated",
      targetType: "message",
      targetId: draftMessageId,
      payload,
    });
  });

  logger.info("[process-reply] reply draft stored", {
    eventId: event.id,
    contactId,
    conversationId,
    messageId,
    draftMessageId,
    intent: nonStopIntent,
    step: "audit-reply-generated",
  });

  // ── Step 8d — dispatch-reply-event (S9.4.3) ──────────────────────────
  // Émet l'event `medere/sms.reply.send-requested` consommé par le
  // handler `send-reply.ts` (S9.4.2) pour le dispatch OVH. Le draft est
  // déjà queued (S9.4.1) ; le handler aval va commit + dispatch OVH +
  // poser audit `sms_provider_dispatched`. Branche STOP NE PASSE PAS par
  // ce step (early return en step 7 STOP fait un return avant — physique
  // dans le bloc non-STOP).
  //
  // 🚨 IDEMPOTENCE — eventId déterministe `reply.send.${draftMessageId}`
  //
  // Memoization native Inngest `step.sendEvent` par (parent eventId,
  // stepName) couvre 95% des cas d'idempotence (retry intra-pipeline). On
  // ajoute un eventId déterministe pour belt-and-braces :
  //   1. Déduplication 60s native Inngest sur `event.id` — couvre les
  //      retry rapides où le cache memoization pourrait être perdu.
  //   2. Filet ultime — `commitDraftToQueued` (S9.4.1) assert
  //      `status === "draft"` DANS sa tx. Si le draft est DÉJÀ queued
  //      (1ère invocation a commit), `ValidationError` propage → Inngest
  //      marque la 2ème invocation "failed" sans dispatch OVH.
  //   3. Bénéfice forensique — Inngest cloud dashboard filtre par
  //      eventId, on retrouve facilement les events par draft (corrélation
  //      avec audits `reply_generated`/`sms_sent`/`sms_provider_dispatched`
  //      sur même `draftMessageId`).
  //
  // 🚨 ANTI-PII event.id — `reply.send.${draftMessageId}` est scrubber-safe
  // par construction (`draftMessageId` est un Firestore auto-ID
  // `[A-Za-z0-9]{20}`). Sentinelle test verrouille le format strict
  // `/^reply\.send\.[A-Za-z0-9]+$/` + absence de phone/email/ovhMessageId.
  //
  // 🚨 ANTI-PII event.data — payload minimaliste `{contactId,
  // conversationId, draftMessageId}` (cf. arbitrage Q-B3 S9.4.0). Pas
  // d'intent/body/phone — récupérables via lecture Firestore aval.
  await step.sendEvent("dispatch-reply-event", {
    name: smsReplySendRequested.name,
    data: {
      contactId,
      conversationId,
      draftMessageId,
    },
    id: `reply.send.${draftMessageId}`,
  });

  // ── Step 8e — dispatch-handoff-event (S9.9-PR4) ──────────────────────
  // Émet `medere/handoff.requested` UNIQUEMENT sur `intent === "INTERESSE"`.
  // Le futur handler `slack-handoff` (S9.9-PR5) résoudra owner HubSpot →
  // commercial Airtable → sendHandoffNotification (DM ou canal orphelins).
  //
  // 🚨 ORDRE CRITIQUE — step 8e APRÈS step 8d. Le SMS auto part TOUJOURS
  // en premier ; le hand-off ne bloque JAMAIS la réponse au PS. Si le
  // step 8e throw (Inngest cloud transient), la memoization Inngest sert
  // step 8d depuis le cache au retry → 0 double-dispatch OVH → 0 double
  // SMS au PS. Le SMS auto est déjà parti — le hand-off est resservi
  // jusqu'à succès (retries: 3).
  //
  // 🚨 CONDITION INTERESSE-ONLY — sur OBJECTION/NEUTRE le PS a répondu mais
  // pas assez chaud pour un hand-off commercial (la boucle Claude continue
  // via step 8d). Sur STOP (short_form ou classifier_long_form) le PS
  // opted-out : ce step n'est même pas atteint (early return step 5/7).
  //
  // 🚨 IDEMPOTENCE — eventId déterministe `handoff.${draftMessageId}`,
  // miroir strict `reply.send.${draftMessageId}` (step 8d) :
  //   1. Memoization native Inngest `step.sendEvent` par (parent eventId,
  //      stepName) — couvre 95% des retry intra-pipeline.
  //   2. Déduplication 60s native Inngest sur `event.id` — belt-and-braces
  //      si cache memoization est perdu (fenêtre étroite).
  //   3. Filet ultime PR5 — le handler `slack-handoff` sera idempotent
  //      côté audit Firestore (`audit_log/{docId}` — pas de docId
  //      déterministe encore mais posé APRÈS `chat.postMessage` OK ;
  //      double-notif Slack théorique en cas de retry sans (1) et (2),
  //      MAIS l'eventId déterministe (2) l'exclut à 60s).
  //
  // 🚨 ANTI-PII event.id — `handoff.${draftMessageId}` est scrubber-safe
  // par construction (draftMessageId = Firestore auto-ID `[A-Za-z0-9]{20}`).
  // Sentinelle test verrouille le format strict `/^handoff\.[A-Za-z0-9]+$/`.
  //
  // 🚨 ANTI-PII event.data — payload minimaliste `{contactId,
  // conversationId, draftMessageId}` (cf. arbitrage Q-B3 S9.4.0 étendu
  // S9.9-PR4). Pas de firstName/speciality/city/body/phone — le consumer
  // PR5 les charge à la volée depuis Firestore au moment du post Slack
  // (état frais vs état stale figé T0).
  // `nonStopIntent` (brut) et `effectiveIntent` (remappé) sont ici
  // ÉQUIVALENTS : le remapping PR1 ne touche que `AUTO_REPLY → NEUTRE`,
  // donc aucun des deux ne peut valoir "INTERESSE" sans que l'autre le
  // vaille aussi. On garde le brut — le hand-off suit la classification
  // réelle du PS, pas une projection de pipeline. Un `AUTO_REPLY` ne
  // déclenche donc JAMAIS de hand-off (un accusé machine n'est pas un lead).
  if (nonStopIntent === "INTERESSE") {
    await step.sendEvent("dispatch-handoff-event", {
      name: handoffRequested.name,
      data: {
        contactId,
        conversationId,
        draftMessageId,
      },
      id: `handoff.${draftMessageId}`,
    });
  }

  // ── Step 9 — audit-reply-processed (étendu draftMessageId) ────────────
  await postReplyProcessedAudit({
    contactId,
    conversationId,
    messageId,
    intent: nonStopIntent,
    branchTaken: "classified",
    finalConversationStatus: "in_dialogue",
    classifierFallback: classification.fallback,
    draftMessageId,
  });

  return {
    status: "classified",
    contactId,
    conversationId,
    messageId,
    intent: effectiveIntent,
    draftMessageId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Function Inngest — wrap autour du handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inngest function `process-reply` — pipeline déterministe 14 steps
 * distincts (12 `step.run` + 2 `step.sendEvent` = step 8d + 8e) sur branche
 * `classified` INTERESSE (post-S9.9-PR4) :
 *   1. resolve-contact
 *   2. resolve-conversation
 *   3. dedup-by-external-id
 *   4. store-inbound
 *   5. short-form-opt-out-check
 *   6a. claude-classify           (S9.3.1 split)
 *   6b. audit-intent-classified   (S9.3.1 split)
 *   7. branch-{intent}            (`branch-stop` early return STOP)
 *   8a. claude-generate-{intent}  (S9.3.3b, non-STOP only)
 *   8b. store-draft               (S9.3.3b, non-STOP only)
 *   8c. audit-reply-generated     (S9.3.3b, non-STOP only)
 *   8d. dispatch-reply-event      (S9.4.3, non-STOP only)
 *   8e. dispatch-handoff-event    (S9.9-PR4, INTERESSE only) 🆕
 *   9. audit-reply-processed
 *
 * Branche STOP (short-form ou classifier_long_form) : skip steps 8a-8e,
 * step 9 est appelé pour forensic.
 *
 * Branche OBJECTION/NEUTRE : skip step 8e (le hand-off Slack est réservé
 * aux leads chauds INTERESSE). Steps 8a-8d + 9 exécutés normalement.
 *
 * **Trigger** : event `medere/sms.reply.received` (`SmsReplyReceivedDataSchema`).
 *
 * **Retries** : 3 (= default Inngest v4.x mais choix EXPLICITE pour
 * visibilité dans le code). Memoization step.run protège contre
 * double-commit sur retry (cf. JSDoc en-tête + sentinelle MED-1 dans
 * `process-reply.memoization.test.ts` S9.2.3.2).
 *
 * **Handler** : `processReplyHandler` (exporté pour tests).
 */
export const processReply = getInngestClient().createFunction(
  {
    id: FUNCTION_ID,
    triggers: [{ event: smsReplyReceived }],
    // S9.2.3 — choix explicite (= default Inngest v4.x), pas implicite.
    // Sentinelle test verrouille `retries === 3`. La memoization
    // `step.run(name, fn)` (clé `(eventId, stepName)`) assure idempotence
    // sur tous les writes Firestore + audits + appels Claude (pas de
    // double facturation, pas de double-commit forensique).
    retries: 3,
  },
  processReplyHandler,
);

// ─────────────────────────────────────────────────────────────────────────────
// Exposés pour tests sentinelles
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export const __FUNCTION_ID_FOR_TESTS = FUNCTION_ID;

/** @internal */
export const __DROP_REASONS_FOR_TESTS = DROP_REASONS;

/** @internal */
export const __PHONE_HASH_PREFIX_FOR_TESTS = PHONE_HASH_PREFIX;
