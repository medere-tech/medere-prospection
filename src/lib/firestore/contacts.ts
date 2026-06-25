/**
 * Lecture + mutations restreintes sur la collection Firestore `contacts/`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * API EXPOSÉE (S6.3 — MVP) :
 *
 *   - `getContact(id)`              → lecture validée (Zod strict).
 *   - `markOptedOut(id, channel, options?)` → marque le consentement révoqué
 *                                     + audit log dans la MÊME transaction.
 *                                     Variante S9.2.2.1 : si
 *                                     `options.conversationId` fourni,
 *                                     synchronise aussi la conversation
 *                                     (intent=STOP, status=opted_out) dans
 *                                     la même tx — atomicité étendue.
 *   - `updateContactStatus(id, f)`  → whitelist Pick<status|assignedTo>
 *                                     + audit log atomique.
 *
 * Hors périmètre S6.3 (reportés explicitement) :
 *   - `createContact`     → S7 (import HubSpot)
 *   - `softDelete`        → Phase 2 (purge RGPD à 3 ans)
 *   - `listContacts`      → S9+ (dashboard admin)
 *   - `markBloctelChecked`→ Phase 2 (fonction dédiée)
 *   - `markEnriched`      → S6.4 / Phase 2 (fonction dédiée)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INVARIANTS (CNIL / RGPD) :
 *
 *   1. Toute lecture passe par `ContactSchema.parse()`. Un document
 *      corrompu/migré-incomplet `throw ValidationError` plutôt que de
 *      laisser un PII partiel polluer la chaîne d'envoi.
 *
 *   2. Toute MUTATION (mark opt-out, update status) est encapsulée dans
 *      une `runTransaction` qui appelle `appendAuditLogTx` dans la même
 *      transaction. Atomicité contact ↔ audit log : pas de trou forensic
 *      en cas de crash entre les 2 writes.
 *
 *   3. `updateContactStatus` accepte UNIQUEMENT les champs de la whitelist
 *      `UpdatableContactFields` (typage compile-time). Les champs
 *      identité (phone, email, name, civilite), consent, enrichment, IDs
 *      immuables sont INTERDITS — passent par leurs fonctions dédiées ou
 *      pas du tout.
 *
 *   4. `markOptedOut` est idempotent : 2 appels successifs sur un
 *      contact déjà opted-out → 1 seul audit log canonique. La date du
 *      1er opt-out est juridiquement décisive et n'est jamais réécrasée.
 *
 *   5. `getContact` retourne `null` pour une absence légitime (vs throw
 *      pour une corruption). Les mutations throw `NotFoundError` car
 *      agir sur un contact inexistant = erreur d'orchestration côté
 *      caller (qui avait identifié ce contact comme cible).
 */
import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";

import { getAdminDb } from "@/lib/firestore/admin";
import { appendAuditLogTx } from "@/lib/firestore/audit-log";
import { _parseConversationOrThrow } from "@/lib/firestore/conversations";
import { ConflictError, InternalError, NotFoundError, ValidationError } from "@/lib/utils/errors";
import { E164_REGEX } from "@/lib/utils/phone";
import { type Contact, CONTACT_STATUS_VALUES } from "@/types/contact";
import type { Conversation, ConversationStatus } from "@/types/conversation";

/**
 * 🔒 Re-export pour rétrocompat (S10.1.5-FIX-SEC). Source de vérité unique
 * dans `@/types/contact` — module pur sans dépendance Admin SDK pour
 * éviter de polluer le bundle browser via `status-filter.tsx` (`"use client"`).
 *
 * Les tests serveur historiques (`audit-log.test.ts`, etc.) qui font
 * `import { CONTACT_STATUS_VALUES } from "@/lib/firestore/contacts"`
 * continuent à fonctionner via ce re-export.
 */
export { CONTACT_STATUS_VALUES };

// ─────────────────────────────────────────────────────────────────────────────
// Constantes & types internes
// ─────────────────────────────────────────────────────────────────────────────

const CONTACTS_COLLECTION = "contacts";

/**
 * Doit rester aligné avec `__CONVERSATIONS_COLLECTION_FOR_TESTS` de
 * `conversations.ts`. Test sentinelle dans `contacts.test.ts` vérifie
 * l'égalité — si quelqu'un renomme côté conversations.ts, le test casse.
 * (Pattern identique à `messages.ts:120`.)
 */
const CONVERSATIONS_COLLECTION = "conversations";

/**
 * 🔒 Status conversation considérés "terminaux" — impossibles à transitionner
 * vers `opted_out` via `markOptedOut` étendu (S9.2.2.1).
 *
 *   - `handed_off` : déjà chez commercial humain. Un STOP arrivant après
 *                    handoff doit alerter le commercial via Slack, PAS
 *                    rollback le handoff côté Firestore.
 *   - `closed`     : conversation terminée explicitement.
 *   - `blocked`    : bloquée par compliance (Bloctel, plafond...).
 *
 * `opted_out` est EXCLU de ce set car c'est l'état cible — le re-mark est
 * traité comme idempotent (cf. JSDoc `markOptedOut`).
 */
const TERMINAL_CONV_STATUSES_FOR_OPT_OUT: readonly ConversationStatus[] = [
  "handed_off",
  "closed",
  "blocked",
];

/**
 * Whitelist STRICTE des champs modifiables via `updateContactStatus`.
 *
 *   - `status` : workflow `pending → enriched → ready → in_conversation →
 *                qualified | opted_out | archived`.
 *   - `assignedTo` : Slack user ID du commercial qui prend le hand-off.
 *
 * Tout le reste est explicitement BANNI (impossible par typage) :
 *   - Identité (phone/email/firstName/lastName/civilite) → immuable
 *   - Consent → passe par `markOptedOut` UNIQUEMENT
 *   - Bloctel → fonction dédiée `markBloctelChecked` (Phase 2)
 *   - Enrichment → fonction dédiée (Phase 2)
 *   - IDs immuables (hubspotId, campaignId, createdAt) → jamais
 */
export type UpdatableContactFields = Pick<Contact, "status" | "assignedTo">;

// ─────────────────────────────────────────────────────────────────────────────
// Speciality — enum aligné HubSpot (S10.1.2.b)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Liste STRICTE des spécialités professionnelles, alignée 1:1 sur l'enum
 * `profession` de la propriété HubSpot custom Médéré.
 *
 * 🔒 SENTINEL — toute modification (ajout / retrait / reformulation) DOIT :
 *   1. Être validée par Déthié (alignement HubSpot CRM)
 *   2. Re-passer la migration des 15+ fichiers de tests/seeds
 *   3. Mettre à jour le `HUBSPOT_PROFESSION` mapping côté `lib/hubspot/mapper.ts`
 *   4. Casser intentionnellement le build via le test sentinelle de
 *      `contacts.test.ts` — si tu vois le test échouer, c'est volontaire,
 *      pas un bug.
 *
 * 🚨 Caractères spéciaux PRÉSERVÉS EXACTEMENT (HubSpot string match strict) :
 *   - Tirets : "Sage-Femme", "Pédicure-podologue", "Chirurgien-dentiste"
 *   - Parenthèses : "Assistant(e) dentaire"
 *   - Accents : "Médecin", "Pédiatre", "Étudiant", "Gynécologue", etc.
 *   - Casse mixte : "Sage-Femme" (F maj), "Médecin vasculaire" (v min)
 *
 * Toute déviation casse le mapping HubSpot → Firestore — un contact dont
 * `properties.profession` ne match aucune valeur ici throw
 * `ValidationError` côté mapper (anti-fall-through silencieux).
 */
export const CONTACT_SPECIALITY_VALUES = [
  "Médecin",
  "Chirurgien-dentiste",
  "Sage-Femme",
  "Pharmacien",
  "IDE",
  "MKDE",
  "Pédicure-podologue",
  "Assistant(e) dentaire",
  "Aide-soignante",
  "Autre profession paramédicale",
  "Orthophoniste",
  "Étudiant",
  "Autre",
  "Infirmier",
  "Pédiatre",
  "Psychiatre",
  "Gynécologue",
  "Dermatologue",
  "Radiologue",
  "Médecin vasculaire",
  "Psychologue",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Schéma Zod (validation runtime à la lecture)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `z.unknown()` pour les Timestamps : Firestore renvoie une instance de
 * classe `Timestamp` (firebase-admin). On valide la PRÉSENCE de la clé,
 * pas la forme exacte — déjà garantie par le SDK côté lecture.
 */
const TimestampLike = z.unknown();

export const ContactPhoneSchema = z.object({
  e164: z.string().regex(/^\+\d{10,15}$/, "Doit être au format E.164"),
  raw: z.string(),
  type: z.enum(["mobile", "landline", "voip", "unknown"]),
  carrier: z.string().optional(),
  valid: z.boolean(),
  lookupAt: TimestampLike,
});

export const ContactConsentSchema = z.object({
  legitimateInterest: z.string().min(20, "Documente précisément l'intérêt légitime (20 chars min)"),
  optedOut: z.boolean(),
  optedOutAt: TimestampLike.optional(),
  optedOutReason: z.string().optional(),
  optedOutChannel: z.enum(["sms", "manual", "dashboard"]).optional(),
});

export const ContactEnrichmentSchema = z.object({
  source: z.enum(["lusha", "hubspot", "manual"]),
  enrichedAt: TimestampLike,
  raw: z.record(z.string(), z.unknown()).optional(),
});

export const ContactSchema = z.object({
  hubspotId: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  civilite: z.enum(["Dr", "Pr", "M.", "Mme"]).optional(),
  speciality: z.enum(CONTACT_SPECIALITY_VALUES),
  city: z.string(),
  postalCode: z.string(),
  email: z.email().optional(),
  phone: ContactPhoneSchema,
  segment: z.enum(["b2b_cabinet", "b2c_mobile_perso", "unknown"]),
  bloctelChecked: z.boolean(),
  bloctelOptOut: z.boolean(),
  bloctelCheckedAt: TimestampLike.optional(),
  consent: ContactConsentSchema,
  enrichment: ContactEnrichmentSchema,
  status: z.enum(CONTACT_STATUS_VALUES),
  campaignId: z.string(),
  assignedTo: z.string().optional(),
  createdAt: TimestampLike,
  updatedAt: TimestampLike,
});

/** Type inféré depuis le schéma Zod (privilégier pour inputs validés). */
export type ContactValidated = z.infer<typeof ContactSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers internes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse + cast strict. Le schéma Zod accepte `unknown` pour les Timestamps
 * (déjà garantis par le SDK Firestore côté lecture), mais le type `Contact`
 * exige `Timestamp`. Le cast post-parse n'introduit aucun risque runtime —
 * c'est purement une compatibilité d'inférence avec `z.unknown()`.
 */
function parseContactOrThrow(raw: unknown, contactId: string): Contact {
  const result = ContactSchema.safeParse(raw);
  if (!result.success) {
    // ⚠️  PAS de cause: result.error — la ZodError contient les valeurs
    // reçues dans issue.received (potentiellement un téléphone/email du
    // contact corrompu). Voir env.ts (sanitizeZodError) pour le pattern.
    throw new ValidationError({
      message: `Contact document corrupted (${contactId}): ${result.error.issues
        .map((i) => `${i.path.join(".")} (${i.code})`)
        .join(", ")}`,
      context: {
        contactId,
        issues: result.error.issues.map((i) => ({
          path: i.path.join("."),
          code: i.code,
        })),
      },
    });
  }
  return result.data as Contact;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers transactionnels partagés (S6.6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrapper public de `parseContactOrThrow` pour usage cross-module dans
 * `lib/firestore/`. Identique en sémantique au helper privé — c'est juste
 * un point d'accès stable pour `transactions.ts` (`withContactLock`) afin
 * d'éviter de dupliquer la logique Zod + ValidationError. NE JAMAIS faire
 * de surcouche ici : toute évolution du parsing doit rester dans
 * `parseContactOrThrow`.
 *
 * Aligné sur le même pattern que `_parseConversationOrThrow` exposé par
 * `conversations.ts` en S6.5.
 *
 * @internal Helper inter-modules `firestore/`. NE PAS appeler depuis du
 *           code applicatif : utiliser `getContact()` pour une lecture
 *           standalone (avec retour `null` en cas d'absence).
 */
export function _parseContactOrThrow(raw: unknown, contactId: string): Contact {
  return parseContactOrThrow(raw, contactId);
}

// ─────────────────────────────────────────────────────────────────────────────
// API publique
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Récupère un contact par son ID Firestore.
 *
 *   - Document absent              → `null` (cas légitime).
 *   - Document présent + Zod OK    → `Contact`.
 *   - Document présent + Zod fail  → `throw ValidationError` (corruption,
 *                                    bug applicatif ou migration incomplète).
 */
export async function getContact(contactId: string): Promise<Contact | null> {
  const doc = await getAdminDb().collection(CONTACTS_COLLECTION).doc(contactId).get();
  if (!doc.exists) return null;
  return parseContactOrThrow(doc.data(), contactId);
}

/**
 * Récupère un contact par son téléphone E.164 strict.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * RAISON D'ÊTRE (S9.1 — process-reply)
 *
 * Le pipeline `process-reply` (S9.2) reçoit un event Inngest typé
 * `{phone, body, ovhMessageId}` sans `contactId`. Cette fonction résout
 * `phone → contactId` pour permettre le branchement déterministe (opt-out,
 * handoff, génération réponse IA) sur la suite du pipeline.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * VALIDATION INPUT — régex E.164 STRICTE
 *
 * Pre-flight validation via `E164_REGEX` (source de vérité unique
 * `@/lib/utils/phone`). Format `/^\+[1-9]\d{6,14}$/` :
 *
 *   - `+` obligatoire en tête
 *   - 1er chiffre 1-9 (PAS de leading zero — invariant strict ITU-T E.164)
 *   - 6 à 14 chiffres complémentaires
 *
 * Un input qui ne match pas → throw `ValidationError` AVANT la query
 * Firestore (fail-fast, économie I/O, pas de leak côté Firestore d'un
 * input mal-formé qui pourrait fuiter dans les query logs côté GCP).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * DIVERGENCE ASSUMÉE vs `ContactPhoneSchema` (Q2 brief Déthié S9.1)
 *
 * `ContactPhoneSchema.e164` (l.89) utilise une régex PLUS LARGE
 * `/^\+\d{10,15}$/` qui accepterait `+0612345678` (leading zero).
 *
 * Choix S9.1 : `getContactByPhone` valide avec `E164_REGEX` STRICT, PAS
 * avec `ContactPhoneSchema`. Conséquence :
 *
 *   - Un contact historique stocké en base avec `phone.e164` mal-formé
 *     (leading zero, format ITU-T non-canonique) sera INTROUVABLE via
 *     cette fonction même s'il existe dans Firestore.
 *
 *   - Acceptable MVP : pas d'observation de tel cas en prod Phase 1
 *     (tous les imports HubSpot Phase 1 passent par Twilio Lookup qui
 *     normalise en E.164 strict).
 *
 *   - Risque résiduel documenté ici. Si un cas survient un jour, soit on
 *     élargit la régex (hors scope S9.1, nécessite re-validation
 *     compliance), soit on patche le contact historique vers le format
 *     canonique.
 *
 * `ContactPhoneSchema` reste inchangé — c'est un filet en LECTURE
 * (tolère les contacts historiques pour éviter de casser le doc parsing
 * sur des données legacy). `E164_REGEX` est le filet en ENTRÉE (refuse
 * strict).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INVARIANT UNICITÉ — defense-in-depth (Q1 brief Déthié S9.1)
 *
 * L'invariant business est : 1 PS = 1 contact = 1 `phone.e164` unique.
 * Cet invariant n'est PAS verrouillé côté Firestore (pas d'index unique
 * natif Firestore — c'est une garantie applicative qui dépend du flow
 * d'import HubSpot).
 *
 * Si la query retourne :
 *
 *   - 0 doc → `null` (PS inconnu, cas légitime traité par caller en
 *     branche "reply_dropped"). PAS `NotFoundError` (cohérent avec
 *     `getContact` qui retourne `null` pour absence légitime).
 *
 *   - 1 doc → parsing Zod via `_parseContactOrThrow` + retour `Contact`.
 *     Cas nominal.
 *
 *   - >1 doc → throw `InternalError` (`isOperational: false`). Drift
 *     d'invariant base = bug d'import HubSpot OU corruption. Le caller
 *     (process-reply) doit arrêter le flow et alerter — pas continuer
 *     avec un choix arbitraire qui enverrait un SMS au mauvais PS.
 *
 * Pas de log/audit du téléphone côté serveur en cas d'erreur — l'E.164
 * est PII. Le `context` de l'erreur expose `count` (nombre de docs
 * trouvés) mais JAMAIS le phone lui-même. Forensic via Firestore direct
 * si besoin (un admin querie manuellement).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ⚠️ PII DOWNSTREAM — responsabilité du caller
 *
 * Le `Contact` retourné contient **toutes les PII** du PS :
 *   - `phone.e164` (PII)
 *   - `email`     (PII)
 *   - `firstName`, `lastName`, `civilite` (PII)
 *   - `city`, `postalCode` (semi-identifiantes)
 *
 * Le caller est responsable de :
 *
 *   1. **NE JAMAIS logger le Contact complet** via Pino/Sentry. Le
 *      scrubber audit-log (S6.2) ne couvre QUE les writes
 *      `audit_log/` — un `logger.info({ contact })` fuiterait dans
 *      Vercel logs / Sentry. Utiliser `maskPhone()` (lib/utils/phone)
 *      pour les logs forensiques où l'identifiant est nécessaire.
 *
 *   2. **NE JAMAIS l'inclure brut dans un `appendAuditLog` payload**.
 *      Le scrubber détecterait et throw `AuditPiiError` → tx rollback.
 *      Pour audit, utiliser `targetId = contactId` (= hubspotId, opaque
 *      identifiant interne) + payload sans champ PII.
 *
 *   3. **NE JAMAIS le renvoyer côté client** sans filtrage par rôle
 *      (commercial vs admin) + masking explicite des champs sensibles.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INDEX FIRESTORE
 *
 * Single-field equality query sur `phone.e164` — Firestore crée
 * automatiquement les index single-field, pas besoin d'entrée dans
 * `firestore.indexes.json`.
 *
 * @param e164  Téléphone E.164 strict (`+33612345678`). Validé via
 *              `E164_REGEX`. Tout autre format throw `ValidationError`.
 *
 * @returns Le contact unique trouvé, ou `null` si aucun match.
 *
 * @throws ValidationError  si `e164` ne match pas `E164_REGEX`.
 * @throws InternalError    si la query retourne >1 doc (drift invariant
 *                          unicité — bug d'import ou corruption).
 * @throws ValidationError  si le doc Firestore est corrompu (Zod fail).
 */
export async function getContactByPhone(e164: string): Promise<Contact | null> {
  if (!E164_REGEX.test(e164)) {
    throw new ValidationError({
      message: "getContactByPhone: input is not a valid strict E.164 phone number",
      context: {
        op: "getContactByPhone",
        // PAS de `e164` dans le context — PII. Seulement la longueur
        // pour forensic minimal.
        inputLength: e164.length,
      },
    });
  }

  const snap = await getAdminDb()
    .collection(CONTACTS_COLLECTION)
    .where("phone.e164", "==", e164)
    .limit(2) // limit(2) suffit pour détecter le cas >1 — économie I/O
    .get();

  if (snap.empty) {
    return null;
  }

  if (snap.size > 1) {
    throw new InternalError({
      message: "getContactByPhone: invariant violation — multiple contacts share the same E.164",
      context: {
        op: "getContactByPhone",
        // PAS de `e164` ni de `contactIds[]` — l'E.164 est PII et les
        // contactIds (=hubspotId) sont semi-sensibles. Le forensic se
        // fait via query manuelle admin si besoin d'investiguer.
        count: snap.size,
      },
    });
  }

  // snap.size === 1 — cas nominal. Le `docs[0]` est garanti défini.
  const doc = snap.docs[0]!;
  return parseContactOrThrow(doc.data(), doc.id);
}

/**
 * Marque un contact comme ayant explicitement opté-out de la prospection.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * VARIANTE S9.2.2.1 — extension `options.conversationId`
 *
 * Si `options.conversationId` est fourni, la même transaction update
 * ÉGALEMENT la conversation cible (`intent="STOP"`, `status="opted_out"`,
 * `lastIntentChangeAt=now`). Ferme le trou de désynchronisation
 * contact ↔ conversation qui existait depuis S9.2.1 (le step 5 fast-path
 * marquait le contact opt-out mais laissait `conversation.status` à
 * `awaiting_reply`/`in_dialogue` — incohérence forensic + bug futur si
 * un follow-up tentait de reprendre la conversation).
 *
 * **Atomicité étendue** : si l'update conversation fail (transition
 * interdite, conv inexistante, doc corrompu) → la transaction rollback
 * et le contact N'EST PAS marqué opt-out non plus. Pas de demi-état
 * possible.
 *
 * **Garde transitions terminales** : refuse l'opt-out si la conversation
 * est en `handed_off`/`closed`/`blocked`. `opted_out` est OK (idempotent).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * IDEMPOTENCE — état final cible
 *
 * Si TOUT l'état final est déjà atteint (contact.consent.optedOut=true
 * ET conv.status="opted_out" ET conv.intent="STOP"), le call est un
 * NO-OP TOTAL : pas d'update, pas de re-audit. La date du 1er opt-out
 * et son canal sont juridiquement décisifs et ne sont jamais réécrasés.
 *
 * **Cas désync (contact opt-out mais conv pas synchro)** : la conv est
 * synchronisée (update intent + status), et un audit `opt_out` AVEC
 * `payload.reason = "sync_conversation"` est posé pour traçabilité.
 * Distingue clairement le flow initial du rattrapage cohérence.
 *
 * **Cas sans `options.conversationId`** : comportement strictement
 * identique à pré-S9.2.2.1 (rétrocompat — process-reply.ts S9.2.1 step
 * 5 fast-path continue à fonctionner sans modification le temps que
 * S9.2.2.2 le migre vers la variante étendue).
 *
 * @param contactId  ID Firestore du contact.
 * @param channel    Canal de l'opt-out (sms = réponse STOP, manual = appel,
 *                   dashboard = action commerciale).
 * @param options    Variante étendue S9.2.2.1 :
 *                   - `conversationId` : si fourni, synchronise la conv
 *                     dans la même tx (intent=STOP, status=opted_out).
 *                   - `intent` : marker explicite au call site (toujours
 *                     `"STOP"` quand `conversationId` fourni — c'est le
 *                     seul intent qui déclenche l'opt-out).
 *                   - `now` : référence temporelle injectable pour tests.
 *
 * @throws NotFoundError    si le contact ou la conversation n'existe pas.
 * @throws ValidationError  si la conv est en état terminal (handed_off,
 *                          closed, blocked), ou si un doc est corrompu.
 */
export async function markOptedOut(
  contactId: string,
  channel: "sms" | "manual" | "dashboard",
  options?: {
    conversationId?: string;
    intent?: "STOP";
    now?: Date;
  },
): Promise<void> {
  const conversationId = options?.conversationId;
  const now = options?.now;

  await getAdminDb().runTransaction(async (tx) => {
    const contactRef = getAdminDb().collection(CONTACTS_COLLECTION).doc(contactId);
    const contactDoc = await tx.get(contactRef);
    if (!contactDoc.exists) {
      throw new NotFoundError({
        message: `Contact not found: ${contactId}`,
        context: { contactId },
      });
    }
    const contact = parseContactOrThrow(contactDoc.data(), contactId);

    // Variante S9.2.2.1 : pré-fetch + parse + guard la conversation si
    // conversationId fourni. tx.get DOIT précéder toutes les tx.update
    // (règle Firestore : reads avant writes dans une transaction).
    const convRef = conversationId
      ? getAdminDb().collection(CONVERSATIONS_COLLECTION).doc(conversationId)
      : null;
    let conv: Conversation | null = null;

    if (convRef && conversationId) {
      const convDoc = await tx.get(convRef);
      if (!convDoc.exists) {
        throw new NotFoundError({
          message: `Conversation not found: ${conversationId}`,
          context: { conversationId, contactId },
        });
      }
      conv = _parseConversationOrThrow(convDoc.data(), conversationId);

      if (TERMINAL_CONV_STATUSES_FOR_OPT_OUT.includes(conv.status)) {
        throw new ValidationError({
          message: `Cannot mark opted_out, conversation in terminal state: ${conv.status}`,
          context: {
            conversationId,
            contactId,
            currentStatus: conv.status,
          },
        });
      }
    }

    // Idempotence sur l'ÉTAT FINAL CIBLE COMPLET : si tout est déjà
    // atteint, no-op total. Sinon, on traite ce qui manque.
    const contactAlreadyOptedOut = contact.consent.optedOut;
    const convAlreadyOptedOut =
      conv !== null && conv.status === "opted_out" && conv.intent === "STOP";

    // No-op total :
    //   - cas legacy (conv === null) : contact déjà opt-out → no-op (rétrocompat)
    //   - cas étendu (conv !== null) : contact opt-out ET conv synchro → no-op
    if (contactAlreadyOptedOut && (conv === null || convAlreadyOptedOut)) {
      return;
    }

    const ts = now ? Timestamp.fromDate(now) : Timestamp.now();

    if (!contactAlreadyOptedOut) {
      tx.update(contactRef, {
        status: "opted_out",
        "consent.optedOut": true,
        "consent.optedOutAt": ts,
        "consent.optedOutChannel": channel,
        updatedAt: ts,
      });
    }

    if (convRef !== null && !convAlreadyOptedOut) {
      tx.update(convRef, {
        intent: "STOP",
        status: "opted_out",
        lastIntentChangeAt: ts,
        updatedAt: ts,
      });
    }

    // Payload audit : `channel` toujours présent (compat). `conversationId`
    // ajouté si fourni (forensic). `reason: "sync_conversation"` si on
    // est dans le cas de rattrapage désync (contact déjà opt, conv pas
    // encore). Tous scrubber-safe (channel ∈ enum, conversationId opaque,
    // reason ∈ string courte).
    const payload: Record<string, unknown> = { channel };
    if (conversationId !== undefined) {
      payload.conversationId = conversationId;
    }
    if (contactAlreadyOptedOut && conv !== null && !convAlreadyOptedOut) {
      payload.reason = "sync_conversation";
    }

    appendAuditLogTx(tx, {
      actorId: "system",
      actorType: "system",
      action: "opt_out",
      targetType: "contact",
      targetId: contactId,
      payload,
    });
  });
}

/**
 * Met à jour un sous-ensemble strictement contrôlé des champs d'un contact
 * (workflow status + assignation commercial). Atomique avec un audit log
 * `action: "status_changed"` dans la même transaction.
 *
 * Le typage `Partial<UpdatableContactFields>` empêche au COMPILE-TIME
 * toute tentative de modifier identité, consent, enrichment ou IDs
 * immuables. Cf. tests `@ts-expect-error` dans contacts.test.ts.
 *
 * @param contactId  ID Firestore du contact.
 * @param fields     Au moins un champ parmi `status` et `assignedTo`.
 *                   Un objet vide `{}` throw `ValidationError` (le caller
 *                   doit savoir ce qu'il fait — pas de no-op silencieux).
 *
 * @throws NotFoundError    si le contact n'existe pas.
 * @throws ValidationError  si `fields` est vide OU si le doc est corrompu.
 */
export async function updateContactStatus(
  contactId: string,
  fields: Partial<UpdatableContactFields>,
): Promise<void> {
  const keys = Object.keys(fields) as (keyof UpdatableContactFields)[];
  if (keys.length === 0) {
    throw new ValidationError({
      message: "updateContactStatus: at least one field required",
      context: { contactId },
    });
  }

  await getAdminDb().runTransaction(async (tx) => {
    const ref = getAdminDb().collection(CONTACTS_COLLECTION).doc(contactId);
    const doc = await tx.get(ref);
    if (!doc.exists) {
      throw new NotFoundError({
        message: `Contact not found: ${contactId}`,
        context: { contactId },
      });
    }
    parseContactOrThrow(doc.data(), contactId);

    tx.update(ref, {
      ...fields,
      updatedAt: Timestamp.now(),
    });

    // payload ne contient QUE les NOMS des champs modifiés. Les valeurs
    // (status enum + Slack ID) ne sont pas des PII mais on reste minimal
    // par principe — alignement convention RGPD payload audit.
    appendAuditLogTx(tx, {
      actorId: "system",
      actorType: "system",
      action: "status_changed",
      targetType: "contact",
      targetId: contactId,
      payload: { fields: keys },
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// listContacts (S10.1.2.c) — pagination cursor + filtres status/campaignId
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Nombre de contacts par page par défaut quand `limit` est omis. Calibré
 * pour TanStack Table server-side : 50 = bonne densité info-pour-1-écran
 * desktop sans surcoût lecture inutile.
 *
 * 🔒 SENTINEL — verrouillé par test sentinelle (toute modification doit
 * passer par une re-validation Déthié + ux-reviewer pour confirmer
 * que la pagination 50 reste pertinente).
 */
export const LIST_CONTACTS_DEFAULT_LIMIT = 50;

/**
 * Plafond strict sur `limit` — anti-DoS Firestore quota. Au-delà, un
 * caller buggué (ou un attaquant authentifié) pourrait drain le quota
 * de lecture Firestore en quelques appels. 100 = 2× la valeur défaut,
 * largement suffisant pour un export ponctuel.
 *
 * 🔒 SENTINEL — verrouillé par test sentinelle.
 */
export const LIST_CONTACTS_MAX_LIMIT = 100;

/**
 * Schema Zod des filtres `listContacts`. Whitelist STRICTE :
 *   - `status`  : enum verrouillé via `ContactSchema.shape.status` (source unique).
 *                 Un `status: "foo"` reçu de l'UI → `ValidationError` AVANT query.
 *   - `campaignId` : string non vide. Pas de validation de format (campaign
 *                    IDs sont des slugs internes, pas de regex stricte).
 *
 * Toute clé en plus → silencieusement strippée par Zod (NOT strict) —
 * on tolère l'UI qui enverrait des champs futurs (forward-compat).
 */
const ListContactsFiltersSchema = z.object({
  status: ContactSchema.shape.status.optional(),
  campaignId: z.string().min(1).optional(),
});

/**
 * Schema Zod input complet — validé en première ligne de `listContacts`.
 *
 *   - `filters.status` : default `"ready"` appliqué côté code (pas
 *                        dans Zod pour rester explicite côté caller).
 *   - `sortBy`/`sortOrder` : hard-coded `"createdAt"`/`"desc"` MVP —
 *                            extensible dans une future signature sans
 *                            casser l'API.
 *   - `limit` : borné `[1, LIST_CONTACTS_MAX_LIMIT]`. Default 50 côté code.
 *   - `cursor` : `contactId` opaque du dernier doc de la page précédente.
 *                Validé côté code via un `get(cursor)` Firestore — si
 *                inexistant → `ValidationError`.
 */
const ListContactsInputSchema = z.object({
  filters: ListContactsFiltersSchema.optional(),
  sortBy: z.literal("createdAt").optional(),
  sortOrder: z.literal("desc").optional(),
  limit: z.number().int().min(1).max(LIST_CONTACTS_MAX_LIMIT).optional(),
  cursor: z.string().min(1).optional(),
});

/** Input typé du caller. Tous les champs sont optionnels — les defaults
 * sont appliqués côté implémentation. */
export type ListContactsInput = z.input<typeof ListContactsInputSchema>;

/** Sortie typée — `Contact[]` strictement parsé + cursor pour la page suivante. */
export interface ListContactsOutput {
  contacts: Contact[];
  /** `contactId` à passer dans `input.cursor` pour la page suivante.
   *  `null` si c'est la dernière page. */
  nextCursor: string | null;
  /** True si une page suivante existe. Permet à l'UI de désactiver le
   *  bouton "Suivant" sans tester `nextCursor === null` (redondant mais
   *  explicite pour le contrat). */
  hasMore: boolean;
}

/**
 * Liste les contacts paginés via cursor.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * USAGE
 *
 *   ```ts
 *   // Page 1 : 50 contacts "ready" de la campagne MVP, plus récents en haut
 *   const page1 = await listContacts({
 *     filters: { status: "ready", campaignId: "mvp-200-dentistes-idf" },
 *   });
 *   // → { contacts: [50 items], nextCursor: "hs_abc123", hasMore: true }
 *
 *   // Page 2 : passer le cursor renvoyé
 *   const page2 = await listContacts({
 *     filters: { status: "ready", campaignId: "mvp-200-dentistes-idf" },
 *     cursor: page1.nextCursor!,
 *   });
 *   ```
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INDEXES FIRESTORE COMPOSITES REQUIS (S10.1.2.c + S10.1.12b)
 *
 *   `campaignId` étant OPTIONNEL côté caller (cf. `ListContactsInput`),
 *   la query produit DEUX shapes distinctes selon que le filtre est posé
 *   ou non. Firestore exige un index composite qui matche EXACTEMENT les
 *   fields utilisés — un seul "super-index" `(status, campaignId, createdAt)`
 *   NE COUVRE PAS la query sans `campaignId` (Firestore est strict, pas
 *   d'index sparse / pas de skip de field intermédiaire). Donc 2 indexes
 *   distincts sont OBLIGATOIRES :
 *
 *   1. Query SANS campaignId — `where(status) + orderBy(createdAt)` :
 *
 *      { "collectionGroup": "contacts", "queryScope": "COLLECTION",
 *        "fields": [
 *          { "fieldPath": "status",    "order": "ASCENDING" },
 *          { "fieldPath": "createdAt", "order": "DESCENDING" }
 *        ] }
 *
 *      🚨 S10.1.12b — Cet index manquait initialement, ce qui rendait
 *      `GET /api/admin/contacts?status=X` (sans campaignId) cassé en
 *      `FAILED_PRECONDITION` côté Firestore Cloud. Le mode A (status seul)
 *      vs mode B (status + campaignId) sont 2 chemins runtime distincts.
 *
 *   2. Query AVEC campaignId — `where(status) + where(campaignId) + orderBy(createdAt)` :
 *
 *      { "collectionGroup": "contacts", "queryScope": "COLLECTION",
 *        "fields": [
 *          { "fieldPath": "status",     "order": "ASCENDING" },
 *          { "fieldPath": "campaignId", "order": "ASCENDING" },
 *          { "fieldPath": "createdAt",  "order": "DESCENDING" }
 *        ] }
 *
 *   Sans déploiement de CES DEUX indexes (cf. `firestore.indexes.json`),
 *   les queries throwent `FAILED_PRECONDITION` côté Firestore Cloud (le
 *   `err.message` contient le lien de création one-click vers la Firebase
 *   Console — vérifier le log côté serveur). L'emulator local accepte
 *   TOUTE query sans index : piège connu, valider avec
 *   `npm run firebase:deploy:indexes` avant tout déploiement / runtime
 *   pointant sur Firestore Cloud. Déploiement idempotent — un re-run ne
 *   recrée pas les indexes déjà présents.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CURSOR PAGINATION — pattern `startAfter(DocumentSnapshot)`
 *
 * Le cursor exposé au caller est un `contactId` opaque (pas un
 * `DocumentSnapshot` qui serait coûteux à sérialiser pour l'UI). On
 * réhydrate côté serveur via un `get(cursorContactId)` :
 *
 *   - Cursor inexistant (contact supprimé, attaquant qui forge) →
 *     `ValidationError` côté code (PAS de fall-through silencieux qui
 *     retournerait la page 1 — surprise UX inacceptable).
 *
 *   - Cursor existant → `startAfter(snap)` continue après ce doc.
 *
 * Coût : 1 read supplémentaire par page (acceptable — 1 read = $0.06 / 1M).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * DÉTECTION `hasMore` — fetch limit + 1
 *
 * On fetch `limit + 1` docs : si on en récupère plus que `limit`, il y a
 * une page suivante. Économie 1 round-trip vs un second `count()` Firestore.
 * L'extra doc est strippé du retour.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ⚠️ PII DOWNSTREAM — `Contact[]` retourné contient TOUTES les PII
 *
 * Mêmes responsabilités caller que `getContactByPhone` :
 *   1. NE JAMAIS logger les contacts complets via Pino/Sentry.
 *   2. NE JAMAIS les inclure brut dans un audit log payload.
 *   3. NE JAMAIS renvoyer côté client sans filtrage par rôle + masking
 *      (commercial ne voit pas tous les champs d'un contact non assigné).
 *
 * @throws ValidationError si l'input ne match pas `ListContactsInputSchema`
 *                         OU si le cursor pointe sur un doc inexistant.
 * @throws ValidationError si un doc Firestore est corrompu (Zod fail).
 */
export async function listContacts(input: ListContactsInput = {}): Promise<ListContactsOutput> {
  const parsed = ListContactsInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError({
      message: "listContacts: invalid input",
      context: {
        op: "listContacts",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          code: i.code,
        })),
      },
    });
  }

  const { filters, limit: requestedLimit, cursor } = parsed.data;
  const status = filters?.status ?? "ready";
  const campaignId = filters?.campaignId;
  const limit = requestedLimit ?? LIST_CONTACTS_DEFAULT_LIMIT;

  // Build query : status (always) + campaignId (optional) + orderBy + cursor + limit.
  let q: FirebaseFirestore.Query = getAdminDb()
    .collection(CONTACTS_COLLECTION)
    .where("status", "==", status);

  if (campaignId !== undefined) {
    q = q.where("campaignId", "==", campaignId);
  }

  q = q.orderBy("createdAt", "desc");

  if (cursor !== undefined) {
    const cursorSnap = await getAdminDb().collection(CONTACTS_COLLECTION).doc(cursor).get();
    if (!cursorSnap.exists) {
      throw new ValidationError({
        message: "listContacts: cursor refers to a non-existent contact",
        context: {
          op: "listContacts",
          // PAS de `cursor` dans context — hubspotId est semi-sensible
          // (identifiant interne PS, à ne pas log/renvoyer).
          cursorPresent: true,
        },
      });
    }
    q = q.startAfter(cursorSnap);
  }

  // Fetch limit+1 pour détecter `hasMore` en 1 round-trip.
  const snap = await q.limit(limit + 1).get();
  const docs = snap.docs;
  const hasMore = docs.length > limit;
  const pageDocs = hasMore ? docs.slice(0, limit) : docs;

  const contacts = pageDocs.map((doc) => parseContactOrThrow(doc.data(), doc.id));

  // nextCursor = id du DERNIER doc retourné (pas du extra fetch).
  const nextCursor = hasMore && pageDocs.length > 0 ? pageDocs[pageDocs.length - 1]!.id : null;

  return { contacts, nextCursor, hasMore };
}

// ─────────────────────────────────────────────────────────────────────────────
// createContact (S10.1.2.c) — write idempotent par hubspotId
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Détecte une erreur ALREADY_EXISTS du SDK firebase-admin sans dépendre
 * d'un import gRPC direct. Le SDK expose un `code` numérique (gRPC
 * StatusCode) OU une string `"already-exists"` selon la version /
 * surface API. On check les deux par défense en profondeur.
 *
 * gRPC ALREADY_EXISTS = 6 (cf. https://grpc.github.io/grpc/core/md_doc_statuscodes.html).
 */
function isAlreadyExistsError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 6 || code === "already-exists";
}

/**
 * Input typé pour `createContact`. Strict whitelist via `ContactSchema` :
 * un caller qui tenterait de passer un champ HubSpot brut non-mappé
 * (ex: `hs_lifecyclestage`, `hs_lead_status`) verra ce champ
 * silencieusement strippé par Zod (NOT strict mode) — pas d'erreur, mais
 * pas de persistance non plus.
 *
 * Le `createdAt` et `updatedAt` fournis par le caller sont IGNORÉS et
 * remplacés par `Timestamp.now()` côté serveur (anti-spoofing — un caller
 * ne peut pas backdate un contact pour bypasser le 30-jours rate limit).
 */
export type CreateContactInput = Contact;

/**
 * Crée un contact en Firestore de manière idempotente par `hubspotId`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * IDÉMPOTENCE ATOMIQUE — pattern `ref.create()` Firestore
 *
 * Le doc id = `input.hubspotId` (déterministe, anti-duplication).
 * `ref.create(data)` est l'API firebase-admin qui WRITE-IF-NOT-EXISTS
 * atomiquement côté Firestore — pas de race condition entre check et
 * write (qu'un naïf `get + if-exists + set` aurait).
 *
 *   - Contact n'existe pas → créé, retourne `{ contactId }`.
 *   - Contact existe déjà  → throw `ConflictError` (HTTP 409,
 *                            sémantique RFC 7231).
 *
 * Le caller (seed S10.1.3, route API S10.1.4) décide comment réagir au
 * conflict : skip silencieux pour un re-seed idempotent, OU surface
 * l'erreur si c'est une création utilisateur.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * VALIDATION ZOD STRICTE PRE-WRITE
 *
 * `ContactSchema.parse(input)` valide TOUS les invariants RGPD/business :
 *   - `consent.legitimateInterest` ≥ 20 chars (documentation art. 6.1.f RGPD)
 *   - `phone.e164` regex `/^\+\d{10,15}$/`
 *   - `status` ∈ enum 7 valeurs (whitelist contre injection workflow)
 *   - `speciality` ∈ enum 4 valeurs
 *   - `hubspotId`, `firstName`, `lastName`, `campaignId` non-vides
 *
 * Un input invalide → `ValidationError` AVANT tout I/O Firestore.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * TIMESTAMPS — override serveur (anti-spoofing)
 *
 * `createdAt` et `updatedAt` fournis par le caller sont SILENCIEUSEMENT
 * remplacés par `Timestamp.now()`. Raison : un caller compromis ne doit
 * pas pouvoir backdate un contact pour bypasser le rate limit 3-SMS/30j
 * (qui compte depuis `createdAt` côté pre-send-check ailleurs).
 *
 * Note design — `Timestamp.now()` côté Admin SDK (pas `serverTimestamp()`)
 * pour cohérence patterns projet (`addOutboundDraftInTx`, `markOptedOut`).
 * Drift Vercel ↔ Firestore < 10ms, cosmétique.
 *
 * @throws ValidationError si `input` ne match pas `ContactSchema`.
 * @throws ConflictError   si un contact avec ce `hubspotId` existe déjà.
 */
export async function createContact(input: CreateContactInput): Promise<{ contactId: string }> {
  const parsed = ContactSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError({
      message: "createContact: invalid input",
      context: {
        op: "createContact",
        // PAS de `input` brut dans context — contient des PII (phone,
        // email, nom). Seulement les paths sanitisés des champs invalides.
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          code: i.code,
        })),
      },
    });
  }

  const contactId = parsed.data.hubspotId;
  const now = Timestamp.now();

  // Construction explicite : on REPREND tous les champs validés ET on
  // override `createdAt`/`updatedAt`. Pas de spread `...parsed.data`
  // suivi de réécriture — l'ordre serait fragile.
  const doc: Contact = {
    ...(parsed.data as Contact),
    createdAt: now,
    updatedAt: now,
  };

  const ref = getAdminDb().collection(CONTACTS_COLLECTION).doc(contactId);

  try {
    await ref.create(doc);
  } catch (err) {
    if (isAlreadyExistsError(err)) {
      throw new ConflictError({
        message: "createContact: contact already exists for this hubspotId",
        context: {
          op: "createContact",
          reason: "contact_already_exists",
          // hubspotId est OPAQUE (identifiant interne), pas une PII E.164
          // ni email — OK dans le context d'erreur (cohérent S6.5
          // ConflictError handoff race condition).
          hubspotId: contactId,
        },
        cause: err,
      });
    }
    throw err;
  }

  return { contactId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exposés pour tests
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export const __CONTACTS_COLLECTION_FOR_TESTS = CONTACTS_COLLECTION;
