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
 * Regex E.164 stricte (cf. `src/types/contact.ts` + `lib/twilio/lookup`).
 * Format : `+` + chiffre 1-9 (pas de leading zero) + 6 à 14 chiffres
 * complémentaires (longueur totale 8 à 16 caractères).
 *
 * Exemple FR mobile : `+33775745453` (12 chars).
 */
const E164_REGEX = /^\+[1-9]\d{6,14}$/;

/** Nom de l'event "premier SMS demandé pour un contact". Stable. */
const SMS_SEND_FIRST_REQUESTED = "medere/sms.send-first.requested";

/** Nom de l'event "réponse SMS reçue d'un PS via webhook OVH". Stable. */
const SMS_REPLY_RECEIVED = "medere/sms.reply.received";

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

// ─────────────────────────────────────────────────────────────────────────────
// Exposés pour tests sentinelles
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export const __EVENT_NAMES_FOR_TESTS = {
  SMS_SEND_FIRST_REQUESTED,
  SMS_REPLY_RECEIVED,
} as const;

/** @internal */
export const __BODY_MAX_LENGTH_FOR_TESTS = BODY_MAX_LENGTH;
