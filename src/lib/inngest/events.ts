/**
 * Définition typée des events Inngest émis et consommés par l'app Médéré.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pattern Inngest v4 (`eventType()` + Standard Schema)
 *
 * `eventType(name, { schema })` produit un objet `EventType` qui est :
 *   - Utilisable comme TRIGGER d'une `createFunction({ triggers: [{ event }] })`
 *     → le SDK utilise le nom du `EventType` et infère `event.data` typé.
 *   - Utilisable comme PAYLOAD de `inngest.send(eventType.create(data))`
 *     → typage strict sur `data` au site d'appel + validation runtime
 *     (`event.validate()` côté SDK avant émission).
 *
 * Zod 4.x expose `~standard` (StandardSchemaV1 vendor="zod") nativement, donc
 * un `z.object({...})` est accepté directement par `eventType()` sans
 * adapter. Le SDK appelle `schema['~standard'].validate(...)` côté ingestion
 * + côté handler.
 *
 * ⚠️ AssertNoTransform — Inngest interdit les Zod transforms (`TInput`
 * doit être strictement égal à `TOutput`). Concrètement :
 *
 *   ✅ `z.object({...})`, `z.string()`, `z.enum([...])`, `.regex()`, `.min()`,
 *       `.max()`, `.optional()` (avec attention : transforms via default qui
 *        produit un Output différent ne passent pas)
 *   ❌ `.transform()`, `.coerce.xxx()`, `.pipe(...)`
 *
 * Les schemas ci-dessous respectent strictement cette contrainte (vérifié
 * par le compileur à l'appel `eventType()`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Stabilité des noms d'events
 *
 * Les noms d'events sont des CONTRATS — émis par des sources externes
 * (webhook OVH inbound) ou par des scripts terminaux versionnés
 * (`scripts/test-send-sms.mjs`). Les modifier nécessite une migration
 * coordonnée :
 *
 *   1. Émettre les 2 noms (ancien + nouveau) en parallèle pendant une
 *      période de transition.
 *   2. Mettre à jour TOUS les émetteurs (webhook handler, scripts, callers
 *      `inngest.send()`).
 *   3. Retirer l'ancien nom après vérification dashboard Inngest cloud que
 *      plus aucun event ancien nom n'arrive depuis N jours.
 *
 * Test sentinelle (events.test.ts) verrouille les noms par chaîne literal.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ⚠️ `event.id` — NE JAMAIS y mettre de PII (S8.10, security review)
 *
 * Le champ `event.id` (optionnel à l'émission, sinon UUID v4 généré par le
 * SDK Inngest) sert à l'idempotence — et il est affiché tel quel dans le
 * dashboard Inngest cloud + dans tous les `logger.info` qui l'incluent
 * (cf. `send-first-sms.ts:215, 229`). Le scrubber PII de l'audit log
 * Firestore (`detectPiiInPayload`) NE COUVRE PAS Inngest cloud — un
 * `event.id` mal forgé fuiterait directement dans l'UI.
 *
 * Règles pour les émetteurs (`inngest.send()`) :
 *
 *   ❌ NE JAMAIS forger `event.id` à partir de :
 *     - téléphone E.164 ou national FR (`+33775...`, `0775...`)
 *     - email (`...@...`)
 *     - nom + prénom du PS
 *     - ovhMessageId (identifiant externe stocké dans `messages.externalId`,
 *       traité comme semi-sensible cf. `messages.ts:36-54`)
 *
 *   ✅ FORMES ACCEPTÉES si on a besoin d'idempotence explicite :
 *     - laisser le SDK générer un UUID v4 (default)
 *     - `<contactId>-<campaignId>-<nonce>` où `contactId` = hubspotId
 *       (string opaque scrubber-safe par construction, cf. `contacts.ts`)
 *     - hash HMAC-SHA256 d'un tuple sensible (avec pepper AUDIT_PII_PEPPER)
 *
 * Voir aussi : `process-reply.ts:132-138` qui documente la même règle
 * pour le payload du stub inbound.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Bornes des `body` SMS (cohérence cross-module S6.5 + S7a)
 *
 * Le `body` d'un SMS — qu'il soit sortant (outbound) ou entrant (inbound)
 * — est borné à 1600 caractères (= 10 segments SMS GSM-7). Cette borne
 * est appliquée à 3 endroits qui DOIVENT rester alignés :
 *
 *   - `firestore/messages.ts::BODY_MAX_LENGTH` = 1600  (S6.5)
 *   - `ovh/send-sms.ts::BODY_MAX_LENGTH`      = 1600  (S7a.3)
 *   - `inngest/events.ts::BODY_MAX_LENGTH`    = 1600  (ce fichier, S8.3)
 *
 * Tout drift se manifesterait par un event accepté côté Inngest mais
 * refusé côté wrapper OVH ou Firestore. Pas de constante partagée (les
 * 3 modules sont indépendants) — discipline visuelle.
 */
import { eventType } from "inngest";
import { z } from "zod";

import { E164_REGEX } from "@/lib/utils/phone";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes — bornes & noms
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Plafond du `body` SMS. Cohérent avec :
 *   - `firestore/messages.ts::BODY_MAX_LENGTH`
 *   - `ovh/send-sms.ts::BODY_MAX_LENGTH`
 * Cf. JSDoc en-tête pour la procédure si modification.
 */
const BODY_MAX_LENGTH = 1600;

/**
 * Regex E.164 stricte. Source de vérité unique : `@/lib/utils/phone::E164_REGEX`
 * (S9.1 — refactor anti-drift). NE PAS redéfinir en local.
 *
 * Format : `+` + chiffre 1-9 (pas de leading zero) + 6 à 14 chiffres
 * complémentaires (longueur totale 8 à 16 caractères).
 *
 * Exemple FR mobile : `+33775745453` (12 chars).
 */

/** Nom de l'event "premier SMS demandé pour un contact". Stable. */
const SMS_SEND_FIRST_REQUESTED = "medere/sms.send-first.requested";

/** Nom de l'event "réponse SMS reçue d'un PS via webhook OVH". Stable. */
const SMS_REPLY_RECEIVED = "medere/sms.reply.received";

/**
 * Nom de l'event "dispatch OVH du draft réponse demandé". Stable.
 *
 * Émis par `process-reply.ts` après step 9 audit-reply-processed sur la
 * branche `classified` (S9.4.3 — process-reply émet l'event jumeau).
 * Consommé par `send-reply.ts` handler (S9.4.2) pour le dispatch OVH.
 */
const SMS_REPLY_SEND_REQUESTED = "medere/sms.reply.send-requested";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas Zod (data des events) — exportés pour réutilisation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schéma data de `medere/sms.send-first.requested`.
 *
 * **Émis par** : scripts internes (`scripts/test-send-sms.mjs` S8.6), futur
 * UI dashboard (S10+), ou cron de campagne (S11+).
 *
 * **Consommé par** : Inngest function `send-first-sms` (S8.4).
 *
 * **Sémantique** :
 *   - `contactId` : ID Firestore du contact (= hubspotId, source de
 *      vérité, cf. `contacts.ts`).
 *   - `campaignId` : ID Firestore de la campagne (doc id arbitraire,
 *      stocké côté Firestore en S9+).
 *   - `body` : texte du SMS pré-généré par l'amont. La function NE
 *      régénère PAS — elle prend le body tel quel et le passe à
 *      `preSendCheckWithAudit` + `sendSms`. Si on veut un body dynamique
 *      généré dans Inngest, c'est `body: z.string().optional()` + step
 *      "generate-body" en S9+.
 *
 * `strictObject` (vs `object`) : un payload avec champs en plus
 * (ex: `dryRun: true` injecté à la main pour bypass DRY_RUN_SMS env)
 * throw immédiat à l'émission au lieu de stripper silencieusement → un
 * signal d'erreur explicite, anti-faille.
 */
export const SmsSendFirstRequestedDataSchema = z.strictObject({
  contactId: z.string().min(1),
  campaignId: z.string().min(1),
  body: z.string().min(1).max(BODY_MAX_LENGTH),
});

/** Type inféré (Output = Input — aucun transform). */
export type SmsSendFirstRequestedData = z.infer<typeof SmsSendFirstRequestedDataSchema>;

/**
 * Schéma data de `medere/sms.reply.received`.
 *
 * **Émis par** : webhook OVH inbound `/api/webhooks/ovh/inbound` (S9+,
 * non livré S8 — cf. ticket Notion INFRA-SMS-001).
 *
 * **Consommé par** : Inngest function `process-reply` (stub S8.5, réel S9+).
 *
 * **Sémantique** :
 *   - `phone` : E.164 strict de l'expéditeur (PS qui a répondu). Le
 *      webhook OVH doit parser le format brut → E.164 AVANT d'émettre.
 *      Format invalide = erreur 400 côté webhook, pas d'event émis.
 *   - `body` : corps SMS brut, 1-1600 chars. PII potentielle inbound
 *      (un PS peut écrire "mon numéro perso est..."), traitée comme
 *      telle dans les logs et audits par les consumers downstream.
 *   - `ovhMessageId` : ID OVH du message inbound (idempotency key).
 *      Permettra en S9 de détecter un double-livrage OVH via query
 *      Firestore (cf. `messages.ts::externalId` invariant).
 */
export const SmsReplyReceivedDataSchema = z.strictObject({
  phone: z.string().regex(E164_REGEX),
  body: z.string().min(1).max(BODY_MAX_LENGTH),
  ovhMessageId: z.string().min(1),
});

/** Type inféré (Output = Input — aucun transform). */
export type SmsReplyReceivedData = z.infer<typeof SmsReplyReceivedDataSchema>;

/**
 * Schéma data de `medere/sms.reply.send-requested` (S9.4.2).
 *
 * **Émis par** : `process-reply.ts` step 8d (S9.4.3) après step 9
 * `audit-reply-processed` sur la branche `classified`. Le draft existe
 * déjà en Firestore avec `status="draft"` (posé par step 8b `store-draft`
 * S9.3.3b). L'event signale que le draft est prêt à être commité +
 * dispatché OVH.
 *
 * **Consommé par** : `send-reply.ts` Inngest handler (S9.4.2). Le handler :
 *   1. `commitDraftToQueued({conversationId, draftMessageId})` → tx
 *      atomique compliance + transition draft→queued + audit `sms_sent`.
 *   2. Si compliance fail → audit `reply_draft_dropped` posé par
 *      commitDraftToQueued, handler retourne `blocked_by_compliance`.
 *   3. Sinon dispatch OVH via `sendSms` + audit `sms_provider_dispatched`.
 *
 * **Sémantique** (payload minimaliste — décision Q-B3 Déthié S9.4.0) :
 *   - `contactId` : hubspotId opaque. Redondant par dérivation depuis
 *      `conversationId = ${contactId}_${campaignId}` mais utile pour
 *      observabilité Inngest dashboard + logs sans round-trip Firestore.
 *   - `conversationId` : docId composite `${contactId}_${campaignId}`.
 *   - `draftMessageId` : Firestore auto-ID `[A-Za-z0-9]{20}` du draft à
 *      transitionner. Source de vérité — le body, aiModel, aiPromptVersion
 *      etc. vivent dans `messages/{draftMessageId}`, PAS dans le payload
 *      event (minimiser surface PII Inngest cloud).
 *
 * 🚨 **PAS de `intent` dans le payload** : récupérable via lecture du draft
 * (champ `aiPromptVersion` permet de tracer la branche) ou via audit
 * `reply_generated` corrélé. Minimaliser drift.
 *
 * 🚨 **`event.id` INTERDIT avec PII** (cf. l.49-73) — phone, email,
 * ovhMessageId interdits dans le forge d'event.id par l'émetteur S9.4.3.
 *
 * `strictObject` (vs `object`) — anti-bypass identique
 * `SmsSendFirstRequestedDataSchema`.
 */
export const SmsReplySendRequestedDataSchema = z.strictObject({
  contactId: z.string().min(1),
  conversationId: z.string().min(1),
  draftMessageId: z.string().min(1),
});

/** Type inféré (Output = Input — aucun transform). */
export type SmsReplySendRequestedData = z.infer<typeof SmsReplySendRequestedDataSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// EventType Inngest — réutilisables comme triggers + .send() payloads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Event typé "premier SMS demandé". À utiliser comme trigger
 * (`triggers: [{ event: smsSendFirstRequested }]`) et comme payload
 * (`inngest.send(smsSendFirstRequested.create({ contactId, ... }))`).
 *
 * Le `eventType()` Inngest produit un objet `EventType<TName, TSchema>`
 * dont la propriété `name` est le nom Inngest. Le SDK l'utilise pour le
 * matching trigger/event ET pour typer `event.data` dans le handler.
 */
export const smsSendFirstRequested = eventType(SMS_SEND_FIRST_REQUESTED, {
  schema: SmsSendFirstRequestedDataSchema,
});

/**
 * Event typé "réponse SMS reçue". À utiliser comme trigger
 * (`triggers: [{ event: smsReplyReceived }]`) et comme payload
 * (`inngest.send(smsReplyReceived.create({ phone, body, ovhMessageId }))`).
 */
export const smsReplyReceived = eventType(SMS_REPLY_RECEIVED, {
  schema: SmsReplyReceivedDataSchema,
});

/**
 * Event typé "dispatch OVH du draft réponse demandé" (S9.4.2). À utiliser
 * comme trigger (`triggers: [{ event: smsReplySendRequested }]`) et comme
 * payload (`inngest.send(smsReplySendRequested.create({ contactId,
 * conversationId, draftMessageId }))`).
 */
export const smsReplySendRequested = eventType(SMS_REPLY_SEND_REQUESTED, {
  schema: SmsReplySendRequestedDataSchema,
});

// ─────────────────────────────────────────────────────────────────────────────
// Exposés pour tests sentinelles
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export const __EVENT_NAMES_FOR_TESTS = {
  SMS_SEND_FIRST_REQUESTED,
  SMS_REPLY_RECEIVED,
  SMS_REPLY_SEND_REQUESTED,
} as const;

/** @internal */
export const __BODY_MAX_LENGTH_FOR_TESTS = BODY_MAX_LENGTH;
