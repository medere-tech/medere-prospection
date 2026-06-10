/**
 * Lecture + mutations restreintes sur la collection Firestore `contacts/`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * API EXPOSÉE (S6.3 — MVP) :
 *
 *   - `getContact(id)`              → lecture validée (Zod strict).
 *   - `markOptedOut(id, channel)`   → marque le consentement révoqué +
 *                                     audit log dans la MÊME transaction.
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
import { InternalError, NotFoundError, ValidationError } from "@/lib/utils/errors";
import { E164_REGEX } from "@/lib/utils/phone";
import type { Contact } from "@/types/contact";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes & types internes
// ─────────────────────────────────────────────────────────────────────────────

const CONTACTS_COLLECTION = "contacts";

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
  speciality: z.enum(["dentiste", "generaliste", "ide", "autre"]),
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
  status: z.enum([
    "pending",
    "enriched",
    "ready",
    "in_conversation",
    "qualified",
    "opted_out",
    "archived",
  ]),
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
 * Atomique : update contact + audit log `action: "opt_out"` dans la MÊME
 * transaction (impossible d'avoir un opt-out sans audit ou inversement).
 *
 * Idempotent : si `contact.consent.optedOut === true` à l'entrée, NO-OP
 * silencieux — pas de re-écriture, pas de re-audit. La date du 1er opt-out
 * et son canal sont juridiquement décisifs et ne sont jamais réécrasés.
 * (Décision Déthié S6.3 : la reconfirmation multi-canal sera tracée
 * séparément en Phase 2 si besoin, via une fonction dédiée.)
 *
 * @param contactId  ID Firestore du contact.
 * @param channel    Canal de l'opt-out (sms = réponse STOP, manual = appel,
 *                   dashboard = action commerciale).
 * @param now        Référence temporelle injectable pour les tests.
 *                   Défaut : `new Date()` au moment de la transaction.
 *
 * @throws NotFoundError    si le contact n'existe pas (erreur d'orchestration).
 * @throws ValidationError  si le doc existe mais est corrompu.
 */
export async function markOptedOut(
  contactId: string,
  channel: "sms" | "manual" | "dashboard",
  now?: Date,
): Promise<void> {
  await getAdminDb().runTransaction(async (tx) => {
    const ref = getAdminDb().collection(CONTACTS_COLLECTION).doc(contactId);
    const doc = await tx.get(ref);
    if (!doc.exists) {
      throw new NotFoundError({
        message: `Contact not found: ${contactId}`,
        context: { contactId },
      });
    }
    const contact = parseContactOrThrow(doc.data(), contactId);

    // Idempotence : déjà opted-out → no-op total (pas d'update, pas d'audit).
    if (contact.consent.optedOut) {
      return;
    }

    const ts = now ? Timestamp.fromDate(now) : Timestamp.now();
    tx.update(ref, {
      status: "opted_out",
      "consent.optedOut": true,
      "consent.optedOutAt": ts,
      "consent.optedOutChannel": channel,
      updatedAt: ts,
    });

    appendAuditLogTx(tx, {
      actorId: "system",
      actorType: "system",
      action: "opt_out",
      targetType: "contact",
      targetId: contactId,
      payload: { channel },
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
// Exposés pour tests
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export const __CONTACTS_COLLECTION_FOR_TESTS = CONTACTS_COLLECTION;
