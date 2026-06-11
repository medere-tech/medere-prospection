/**
 * Inngest function `process-reply` — pipeline déterministe steps 1-5 (S9.2.1).
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
 * PIPELINE 5 STEPS (S9.2.1)
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
 *   4. `store-inbound`              : `addInbound(convId, {body, channel:
 *                                      "sms", externalId: ovhMessageId,
 *                                      externalReceiver: phone})` (S6.5).
 *                                     - Pose le doc message + audit
 *                                       `sms_received` AUTO dans la tx.
 *                                     - Retourne `messageId` Firestore.
 *
 *   5. `short-form-opt-out-check`   : `isOptOut(body)` (S4, GUARD-001
 *                                      short-form ≤ 50 chars).
 *                                     - true → `markOptedOut(contactId,
 *                                       "sms")` (S6.3, audit `opt_out`
 *                                       AUTO dans la tx) + return
 *                                       `{status: "opt_out", ...}`.
 *                                     - false → return
 *                                       `{status: "pending_intent_
 *                                       classification", ...}`.
 *
 * Steps 6-7 (`classify-intent` + `branch-by-intent`) → S9.2.2.
 * Step 8 (`audit-final reply_processed`) → S9.2.3.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * RETRIES — gardé à 0 en S9.2.1
 *
 * `retries: 0` est conservé tant que la chaîne complète n'est pas
 * stabilisée (S9.2.3 relâchera à default Inngest = 4 avec un test
 * d'intégration qui valide la memoization step.run anti-doublon).
 *
 * Note Inngest : `step.run(name, fn)` memoize le résultat par
 * `(eventId, stepName)`. Sur retry, un step déjà commit retourne son
 * résultat caché sans ré-exécuter `fn` — assure idempotence sur tous
 * les writes Firestore et tous les `appendAuditLog`. Vérifié en S9.2.3.
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
 *
 * Champs INTERDITS dans les logs (PII / semi-sensibles) :
 *
 *   - `phone`          : E.164 du PS → hasher via `hashPii()` pour audit
 *   - `body`           : peut contenir n° perso, infos médicales
 *   - `ovhMessageId`   : identifiant externe semi-sensible (cf.
 *                        invariants `messages.ts:36-54`)
 *
 * Sentinelle anti-PII pipeline complet : `process-reply.test.ts` couvre
 * chaque step et vérifie via `JSON.stringify(logger.mock.calls)` que
 * phone/body/ovhMessageId n'apparaissent JAMAIS.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * AUDITS POSÉS (S9.2.1)
 *
 * Pattern uniforme `{actorId: "system", actorType: "system"}` (vérifié
 * cohérent avec 12 sites pipeline automatisés — `send-first-sms`,
 * `addOutbound`, `addInbound`, `markOptedOut`, etc.).
 *
 *   | Action               | targetType    | targetId                  | payload                                                      |
 *   |----------------------|---------------|---------------------------|--------------------------------------------------------------|
 *   | `reply_dropped`      | `contact`     | `phoneHash` (hashPii)     | `{reason: "contact_unknown", phoneHash}`                     |
 *   | `reply_dropped`      | `contact`     | `contactId`               | `{reason: "no_active_conversation", phoneHash}`              |
 *   | `reply_dropped`      | `message`     | `duplicateOfMessageId`    | `{reason: "duplicate", contactId, conversationId,            |
 *   |                      |               |                           |    duplicateOfMessageId}`                                    |
 *   | `sms_received` (auto)| `message`     | `messageId` (nouveau)     | `{direction: "inbound", messageId}` (par `addInbound`)       |
 *   | `opt_out` (auto)     | `contact`     | `contactId`               | `{channel: "sms"}` (par `markOptedOut`)                      |
 *
 * Les actions `reply_processed` + `intent_classified` viendront en
 * S9.2.2 / S9.2.3 (déjà whitelistées S9.1).
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
import { isOptOut } from "@/lib/compliance/opt-out";
import { appendAuditLog } from "@/lib/firestore/audit-log";
import { getContactByPhone, markOptedOut } from "@/lib/firestore/contacts";
import { getActiveConversationByContactId } from "@/lib/firestore/conversations";
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
 * Résultat du pipeline `process-reply` (S9.2.1). Discriminé sur `status`.
 *
 *   - `dropped`                         : pipeline court-circuité par
 *                                          contact_unknown / no_active_
 *                                          conversation / duplicate.
 *   - `opt_out`                         : short-form opt-out détecté,
 *                                          `markOptedOut` appliqué.
 *   - `pending_intent_classification`   : transition vers S9.2.2 (le
 *                                          message est stocké, on attend
 *                                          que classify-intent prenne la
 *                                          suite).
 */
export type ProcessReplyResult =
  | { status: "dropped"; reason: DropReason }
  | {
      status: "opt_out";
      contactId: string;
      conversationId: string;
      messageId: string;
    }
  | {
      status: "pending_intent_classification";
      contactId: string;
      conversationId: string;
      messageId: string;
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
  // sera détecté par le classifier Claude en S9.2.2.
  const optOutStep = await step.run("short-form-opt-out-check", async () => {
    if (_isOptOut(body)) {
      // `markOptedOut` est idempotent + atomique (update contact + audit
      // `opt_out` dans la MÊME tx). Cf. contacts.ts:239-278.
      await _markOptedOut(contactId, "sms");
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
    return { status: "opt_out", contactId, conversationId, messageId };
  }

  logger.info("[process-reply] pending intent classification", {
    eventId: event.id,
    contactId,
    conversationId,
    messageId,
  });

  // S9.2.2 enchaînera classify-intent + branch-by-intent.
  return {
    status: "pending_intent_classification",
    contactId,
    conversationId,
    messageId,
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
