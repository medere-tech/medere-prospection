/**
 * Inngest function `process-reply` — pipeline déterministe steps 1-7 (S9.2.2).
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
 * PIPELINE 7 STEPS (S9.2.2)
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
 *   6. `classify-intent`            : `classifyReply(body)` (S7a.2,
 *                                      Claude Haiku 4.5 + tool use).
 *                                     - Toujours retourne un résultat
 *                                       (fail-safe STOP avec fallback=
 *                                       true sur erreur SDK).
 *                                     - Audit `intent_classified` posé
 *                                       AVANT branch (Q1 brief Déthié).
 *                                     - `logger.warn` si fallback=true
 *                                       (observabilité S9.6 monitoring).
 *
 *   7. `branch-by-intent`           : 4 branches discriminées :
 *                                     - STOP → `markOptedOut` étendu
 *                                       (ferme GUARD-001 long-form
 *                                       opt-out >50 chars rattrapé) +
 *                                       return `{status:"opt_out", via:
 *                                       "classifier_long_form"}`.
 *                                     - INTERESSE/OBJECTION/NEUTRE →
 *                                       `setConversationIntent(convId,
 *                                       intent, {nextStatus:
 *                                       "in_dialogue"})` + return
 *                                       `{status:"classified", intent}`.
 *                                       S9.3 reprendra la gen IA.
 *
 * Step 8 (`audit-final reply_processed`) → S9.2.3.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * RETRIES — gardé à 0 en S9.2.2
 *
 * `retries: 0` est conservé tant que la chaîne complète n'est pas
 * stabilisée (S9.2.3 relâchera à default Inngest = 4 avec un test
 * d'intégration qui valide la memoization step.run anti-doublon).
 *
 * Note Inngest : `step.run(name, fn)` memoize le résultat par
 * `(eventId, stepName)`. Sur retry, un step déjà commit retourne son
 * résultat caché sans ré-exécuter `fn` — assure idempotence sur tous
 * les writes Firestore, tous les `appendAuditLog`, ET tous les appels
 * Claude (pas de double facturation). Vérifié en S9.2.3.
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
 *
 * Action `reply_processed` (audit final) viendra en S9.2.3.
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
import { isOptOut } from "@/lib/compliance/opt-out";
import { appendAuditLog } from "@/lib/firestore/audit-log";
import { getContactByPhone, markOptedOut } from "@/lib/firestore/contacts";
import {
  getActiveConversationByContactId,
  setConversationIntent,
} from "@/lib/firestore/conversations";
import { addInbound, findInboundByExternalId } from "@/lib/firestore/messages";
import { getInngestClient } from "@/lib/inngest/client";
import { smsReplyReceived } from "@/lib/inngest/events";
import { hashPii, PHONE_HASH_PREFIX, safePhoneHash } from "@/lib/utils/pii-detector";

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

  const { event, step, logger } = ctx;
  const { phone, body, ovhMessageId } = event.data;

  logger.info("[process-reply] received", {
    eventId: event.id,
    name: event.name,
    // PAS de phone, body, ovhMessageId — anti-PII strict.
  });

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
    // S9.2.3 ajoutera l'audit `reply_processed` final ici.
    return {
      status: "opt_out",
      contactId,
      conversationId,
      messageId,
      intent: "STOP",
      via: "short_form",
    };
  }

  // ── Step 6 — classify-intent (Claude Haiku 4.5) ───────────────────────
  // Appel classifier sur les messages non-opt-out short-form. Le classifier
  // a un contrat fail-safe STOP : toute erreur SDK absorbée → fallback
  // intent="STOP" + fallback=true (précaution juridique L.34-5 CPCE).
  // L'audit `intent_classified` est posé AVANT le branch (Q1 brief) —
  // on audit le VERDICT classifier indépendamment de ce que le pipeline
  // en fait ensuite. Payload scrubber-safe (pas de body, pas de reasoning).
  const classification = await step.run("classify-intent", async () => {
    const result = await _classifyReply(body);

    // Observabilité fail-safe (Q2 brief) : un fallback=true signale un
    // échec SDK (timeout, 429, tool_use malformé). À monitorer en prod —
    // si taux > 5%, alerter Sentry/Slack (câblage S9.6). Aucune PII dans
    // le log : seulement les IDs opaques + le messageId Firestore.
    if (result.fallback) {
      logger.warn("[process-reply] classifier_fallback", {
        eventId: event.id,
        contactId,
        conversationId,
        messageId,
        step: "classify-intent",
      });
    }

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
        intent: result.intent,
        confidence: result.confidence,
        fallback: result.fallback,
        promptVersion: CLASSIFY_INTENT_PROMPT_VERSION,
        model: CLASSIFY_INTENT_MODEL,
      },
    });

    return result;
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
  // S9.3 reprendra le relais pour la génération IA + envoi reply.
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

  return {
    status: "classified",
    contactId,
    conversationId,
    messageId,
    intent: nonStopIntent,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Function Inngest — wrap autour du handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inngest function `process-reply` — pipeline déterministe 5 steps (S9.2.1).
 *
 * **Trigger** : event `medere/sms.reply.received` (`SmsReplyReceivedDataSchema`).
 *
 * **Retries** : 0 en S9.2.1. Relâchement à default Inngest (4) en S9.2.3
 * avec test d'intégration de memoization.
 *
 * **Handler** : `processReplyHandler` (exporté pour tests).
 */
export const processReply = getInngestClient().createFunction(
  {
    id: FUNCTION_ID,
    triggers: [{ event: smsReplyReceived }],
    // S9.2.1 — gardé à 0. Sentinelle test verrouille jusqu'à S9.2.3.
    retries: 0,
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
