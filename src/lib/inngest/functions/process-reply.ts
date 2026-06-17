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
 *   7. `branch-by-intent`           : 4 branches discriminées :
 *                                     - STOP → `markOptedOut` étendu
 *                                       (ferme GUARD-001 long-form
 *                                       opt-out >50 chars rattrapé) +
 *                                       SKIP step 8 entier + return
 *                                       `{status:"opt_out", via:
 *                                       "classifier_long_form"}`.
 *                                     - INTERESSE/OBJECTION/NEUTRE →
 *                                       `setConversationIntent(convId,
 *                                       intent, {nextStatus:
 *                                       "in_dialogue"})` puis enchaîne
 *                                       les sub-steps 8a/8b/8c.
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
import { generateReply } from "@/lib/claude/reply-generator";
import type { Intent } from "@/lib/claude/types";
import { isOptOut } from "@/lib/compliance/opt-out";
import { appendAuditLog } from "@/lib/firestore/audit-log";
import { getContactByPhone, markOptedOut } from "@/lib/firestore/contacts";
import {
  getActiveConversationByContactId,
  setConversationIntent,
} from "@/lib/firestore/conversations";
import {
  addInbound,
  addOutboundDraft,
  findInboundByExternalId,
  listRecentMessages,
} from "@/lib/firestore/messages";
import { getInngestClient } from "@/lib/inngest/client";
import { smsReplyReceived, smsReplySendRequested } from "@/lib/inngest/events";
import { hashPii, PHONE_HASH_PREFIX, safePhoneHash } from "@/lib/utils/pii-detector";
import type { ReplyGeneratedPayload } from "@/types/audit-log";

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
 * Raisons de drop possibles en S9.2.1. Discriminant du retour
 * `ProcessReplyResult.status === "dropped"`. Sentinelle test verrouille
 * cette union.
 */
const DROP_REASONS = ["contact_unknown", "no_active_conversation", "duplicate"] as const;
type DropReason = (typeof DROP_REASONS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Types de retour du handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Résultat du pipeline `process-reply` (S9.2.2). Discriminé sur `status`.
 *
 *   - `dropped`     : pipeline court-circuité par contact_unknown /
 *                     no_active_conversation / duplicate.
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
      status: "opt_out";
      contactId: string;
      conversationId: string;
      messageId: string;
      intent: "STOP";
      /**
       * Discriminant analytics + forensic L.34-5 CPCE :
       *   - `"short_form"` : fast-path déterministe (step 5).
       *   - `"classifier_long_form"` : rattrapé par Claude (step 7).
       * Permet de mesurer en prod le ratio des 2 voies (vérifier que le
       * classifier ne capture pas trop de faux positifs côté GUARD-001).
       */
      via: "short_form" | "classifier_long_form";
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
  markOptedOut?: typeof markOptedOut;
  isOptOut?: typeof isOptOut;
  hashPii?: typeof hashPii;
  appendAuditLog?: typeof appendAuditLog;
  // S9.2.2 — classifier + post-classification mutation
  classifyReply?: typeof classifyReply;
  setConversationIntent?: typeof setConversationIntent;
  // S9.3.3b — gen IA reply + stockage draft
  listRecentMessages?: typeof listRecentMessages;
  generateReply?: typeof generateReply;
  addOutboundDraft?: typeof addOutboundDraft;
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
  const _addInbound = deps.addInbound ?? addInbound;
  const _markOptedOut = deps.markOptedOut ?? markOptedOut;
  const _isOptOut = deps.isOptOut ?? isOptOut;
  const _hashPii = deps.hashPii ?? hashPii;
  const _appendAuditLog = deps.appendAuditLog ?? appendAuditLog;
  const _classifyReply = deps.classifyReply ?? classifyReply;
  const _setConversationIntent = deps.setConversationIntent ?? setConversationIntent;
  // S9.3.3b — gen IA reply + stockage draft
  const _listRecentMessages = deps.listRecentMessages ?? listRecentMessages;
  const _generateReply = deps.generateReply ?? generateReply;
  const _addOutboundDraft = deps.addOutboundDraft ?? addOutboundDraft;

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

  // ── Step 1 — resolve-contact ──────────────────────────────────────────
  const contactStep = await step.run("resolve-contact", async () => {
    const contact = await _getContactByPhone(phone);
    if (!contact) {
      // Drop : contact inconnu. Hash phone (préfixé `hph_`) pour forensic
      // sans PII brut + sans collision scrubber (cf. PHONE_HASH_PREFIX
      // JSDoc — HIGH-1 S9.2.1 security-reviewer).
      const phoneHash = safePhoneHash(phone, _hashPii);
      await _appendAuditLog({
        actorId: "system",
        actorType: "system",
        action: "reply_dropped",
        targetType: "contact",
        targetId: phoneHash,
        payload: { reason: "contact_unknown", phoneHash },
      });
      return { found: false as const };
    }
    return { found: true as const, contactId: contact.hubspotId };
  });

  if (!contactStep.found) {
    logger.info("[process-reply] dropped", {
      eventId: event.id,
      step: "resolve-contact",
      reason: "contact_unknown",
      // PAS de phoneHash dans le log applicatif (forensique côté audit Firestore).
    });
    return { status: "dropped", reason: "contact_unknown" };
  }

  const contactId = contactStep.contactId;
  logger.info("[process-reply] contact resolved", {
    eventId: event.id,
    contactId,
  });

  // ── Step 2 — resolve-conversation ─────────────────────────────────────
  const convStep = await step.run("resolve-conversation", async () => {
    const result = await _getActiveConv(contactId);
    if (!result) {
      const phoneHash = safePhoneHash(phone, _hashPii);
      await _appendAuditLog({
        actorId: "system",
        actorType: "system",
        action: "reply_dropped",
        targetType: "contact",
        targetId: contactId,
        payload: { reason: "no_active_conversation", phoneHash },
      });
      return { found: false as const };
    }
    return { found: true as const, conversationId: result.conversationId };
  });

  if (!convStep.found) {
    logger.info("[process-reply] dropped", {
      eventId: event.id,
      contactId,
      step: "resolve-conversation",
      reason: "no_active_conversation",
    });
    return { status: "dropped", reason: "no_active_conversation" };
  }

  const conversationId = convStep.conversationId;
  logger.info("[process-reply] conversation resolved", {
    eventId: event.id,
    contactId,
    conversationId,
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

  // ── Step 4 — store-inbound ────────────────────────────────────────────
  // Stocke TOUS les inbounds AVANT le check opt-out (forensic juridique
  // L.34-5 CPCE : un STOP doit être conservé en preuve).
  const messageId = await step.run("store-inbound", async () => {
    return _addInbound(conversationId, {
      body,
      channel: "sms",
      externalId: ovhMessageId,
      // L'EXPÉDITEUR (= PS), nommé `externalReceiver` par homogénéité
      // schéma (cf. JSDoc messages.ts:234-239).
      externalReceiver: phone,
    });
  });

  logger.info("[process-reply] inbound stored", {
    eventId: event.id,
    contactId,
    conversationId,
    messageId,
  });

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

  // INTERESSE / OBJECTION / NEUTRE — la conv passe en in_dialogue.
  // S9.3.3b génère + stocke le draft + audit reply_generated.
  const nonStopIntent = classification.intent;
  await step.run(`branch-${nonStopIntent.toLowerCase()}`, async () => {
    await _setConversationIntent(conversationId, nonStopIntent, {
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
    `claude-generate-${nonStopIntent.toLowerCase()}`,
    async () => {
      const history = await _listRecentMessages(conversationId);
      return _generateReply({
        intent: nonStopIntent,
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
      intent: nonStopIntent,
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
    intent: nonStopIntent,
    draftMessageId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Function Inngest — wrap autour du handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inngest function `process-reply` — pipeline déterministe 13 steps
 * distincts (12 `step.run` + 1 `step.sendEvent` = step 8d) sur branche
 * `classified` (post-S9.4.3) :
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
 *   8d. dispatch-reply-event      (S9.4.3, non-STOP only) 🆕
 *   9. audit-reply-processed
 *
 * Branche STOP (short-form ou classifier_long_form) : skip steps 8a-8d,
 * step 9 est appelé pour forensic.
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
