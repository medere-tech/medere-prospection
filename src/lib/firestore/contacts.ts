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
import { InternalError, NotFoundError, ValidationError } from "@/lib/utils/errors";
import { E164_REGEX } from "@/lib/utils/phone";
import type { Contact } from "@/types/contact";
import type { Conversation, ConversationStatus } from "@/types/conversation";

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
// Exposés pour tests
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export const __CONTACTS_COLLECTION_FOR_TESTS = CONTACTS_COLLECTION;
