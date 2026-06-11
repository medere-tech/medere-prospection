/**
 * Lecture + mutations atomiques sur la collection Firestore `conversations/`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * API EXPOSÉE (S6.4 — MVP) :
 *
 *   - `conversationDocId(contactId, campaignId)`
 *         → helper pur, retourne `${contactId}_${campaignId}` (cf. skill
 *           `medere-firestore-schema` l.328).
 *   - `getConversation(id)`
 *         → lecture validée (Zod strict, throw ValidationError si corrompu).
 *   - `incrementMessageCount(id, direction)`
 *         → bump messageCount + (outboundCount | inboundCount) + timestamps
 *           de cadence + audit log `sms_sent` | `sms_received` dans la MÊME tx.
 *   - `setHandoff(id, assignedTo, notes)`
 *         → STRICTEMENT non-idempotent : throw `ConflictError` si la
 *           conversation est déjà handed_off (cf. arbitrage Déthié S6.4 Q2).
 *
 * Hors périmètre S6.4 (reportés explicitement) :
 *   - `createConversation`        → S7 (déclenchement campagne)
 *   - `closeConversation`         → S6.5+
 *   - `updateConversationStatus`  → S6.5+
 *   - `acceptHandoff`             → S6.5+ ou S6.6 (Slack interactif)
 *   - `listConversations` paginé  → S9+ (dashboard)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INVARIANTS (CNIL / RGPD) :
 *
 *   1. Toute lecture passe par `ConversationSchema.parse()`. Doc corrompu
 *      → throw `ValidationError` (pas de fallback sur données partielles).
 *
 *   2. Toute mutation est encapsulée dans `runTransaction` + `appendAuditLogTx`
 *      → atomicité conversation ↔ audit log. Si l'audit fail (ex: payload
 *      PII détecté), l'update conversation est rolled back. Pas de trou
 *      forensic possible.
 *
 *   3. `setHandoff` n'est PAS idempotent : 2 commerciaux qui prennent
 *      simultanément le même hand-off → un seul gagne, l'autre reçoit
 *      `ConflictError`. UX correcte côté Slack ("déjà pris par X"),
 *      forensic complet (2 audits = 2 tentatives auditées vs 1 silence
 *      + 1 trou).
 *
 *   4. `incrementMessageCount` audit payload = `{ direction }` UNIQUEMENT.
 *      PAS de messageId (peut être PII-leaky si construit naïvement, et
 *      traçable via la sous-collection messages en S6.5).
 *
 *   5. `setHandoff` audit payload = `{ notesLength: number }`. JAMAIS
 *      `notes` brut (commercial peut écrire "Dr Dupont 06...") même si
 *      le scrubber S6.2 le détecterait. Défense en profondeur.
 */
import { type DocumentReference, Timestamp, type Transaction } from "firebase-admin/firestore";
import { z } from "zod";

import { getAdminDb } from "@/lib/firestore/admin";
import { appendAuditLogTx } from "@/lib/firestore/audit-log";
import { ConflictError, InternalError, NotFoundError, ValidationError } from "@/lib/utils/errors";
import type { Conversation, ConversationStatus } from "@/types/conversation";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes & helper public
// ─────────────────────────────────────────────────────────────────────────────

const CONVERSATIONS_COLLECTION = "conversations";

const HANDOFF_NOTES_MIN_LENGTH = 10;

/**
 * 🔒 SENTINELLE S9.2.1 (Q1 brief Déthié) — set des `status` considérés
 * "actifs" pour `getActiveConversationByContactId`.
 *
 * Inclusion / exclusion documentée :
 *
 *   - `active`          : conv créée, 1er SMS pas encore envoyé. INCLUS
 *                         pour fermer la race condition "inbound arrive
 *                         AVANT que send-first-sms ait mis à jour le
 *                         status à awaiting_reply" (Q1 décision Déthié).
 *   - `awaiting_reply`  : cas nominal — 1er SMS envoyé, on attend.
 *   - `in_dialogue`     : échange IA en cours, peut recevoir n-ième msg.
 *   - `qualified`       : intent positif détecté, hand-off prochain.
 *
 * Exclus :
 *
 *   - `handed_off`      : déjà chez commercial humain. Un follow-up PS
 *                         doit alerter le commercial via Slack S9.4+,
 *                         pas re-rentrer dans le pipeline IA.
 *   - `closed`          : conversation terminée.
 *   - `opted_out`       : STOP déjà reçu. Un re-STOP serait idempotent
 *                         côté markOptedOut mais déjà filtré ici.
 *   - `blocked`         : bloquée par compliance.
 *
 * Modifier ce set nécessite arbitrage Déthié + re-validation
 * compliance-auditor (impact direct sur quelles conversations reçoivent
 * un traitement automatique vs sont droppées).
 */
const ACTIVE_CONVERSATION_STATUSES: readonly ConversationStatus[] = [
  "active",
  "awaiting_reply",
  "in_dialogue",
  "qualified",
];

/**
 * Construit le docId Firestore d'une conversation : `${contactId}_${campaignId}`
 * (skill `medere-firestore-schema` l.328 — unicité contact-campagne).
 *
 * Exemples :
 *   conversationDocId("contact_abc", "campaign_xyz") → "contact_abc_campaign_xyz"
 *   conversationDocId("123456", "dentistes-idf-mai-2026") → "123456_dentistes-idf-mai-2026"
 *
 * Helper exposé pour que les callers (Inngest functions, dashboard) n'aient
 * pas à recopier le template chacun de leur côté — risque de divergence si
 * la convention change un jour.
 */
export function conversationDocId(contactId: string, campaignId: string): string {
  return `${contactId}_${campaignId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schéma Zod (validation runtime à la lecture)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `z.unknown()` pour les Timestamps : Firestore renvoie une instance de
 * classe `Timestamp` (firebase-admin). On valide la PRÉSENCE de la clé,
 * pas la forme exacte — déjà garantie par le SDK côté lecture.
 */
const TimestampLike = z.unknown();

export const ConversationHandoffSchema = z.object({
  assignedTo: z.string().min(1),
  assignedAt: TimestampLike,
  acceptedAt: TimestampLike.optional(),
  acceptedBy: z.string().optional(),
  hubspotDealId: z.string().optional(),
  notes: z.string().min(HANDOFF_NOTES_MIN_LENGTH).optional(),
});

export const ConversationSchema = z.object({
  contactId: z.string().min(1),
  campaignId: z.string().min(1),
  channel: z.enum(["sms", "whatsapp"]),
  status: z.enum([
    "active",
    "awaiting_reply",
    "in_dialogue",
    "qualified",
    "handed_off",
    "closed",
    "opted_out",
    "blocked",
  ]),
  intent: z.enum(["INTERESSE", "NEUTRE", "OBJECTION", "STOP", "unknown"]),
  messageCount: z.number().int().nonnegative(),
  outboundCount: z.number().int().nonnegative(),
  inboundCount: z.number().int().nonnegative(),
  firstMessageAt: TimestampLike.optional(),
  lastMessageAt: TimestampLike.optional(),
  lastOutboundAt: TimestampLike.optional(),
  lastInboundAt: TimestampLike.optional(),
  lastIntentChangeAt: TimestampLike.optional(),
  handoff: ConversationHandoffSchema.optional(),
  nextActionAt: TimestampLike.optional(),
  nextActionType: z.enum(["followup_3d", "followup_7d", "archive", "none"]).optional(),
  followupCount: z.number().int().nonnegative(),
  summary: z.string().optional(),
  createdAt: TimestampLike,
  updatedAt: TimestampLike,
});

/** Type inféré depuis le schéma Zod. */
export type ConversationValidated = z.infer<typeof ConversationSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers internes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse + cast strict, identique au pattern `parseContactOrThrow` (S6.3).
 * ⚠️  PAS de cause: result.error — la ZodError contient les valeurs reçues
 * (potentiellement PII). Voir env.ts (sanitizeZodError) pour le pattern.
 */
function parseConversationOrThrow(raw: unknown, conversationId: string): Conversation {
  const result = ConversationSchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError({
      message: `Conversation document corrupted (${conversationId}): ${result.error.issues
        .map((i) => `${i.path.join(".")} (${i.code})`)
        .join(", ")}`,
      context: {
        conversationId,
        issues: result.error.issues.map((i) => ({
          path: i.path.join("."),
          code: i.code,
        })),
      },
    });
  }
  return result.data as Conversation;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers transactionnels partagés (S6.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrapper public de `parseConversationOrThrow` pour usage cross-module
 * dans `lib/firestore/`. Identique en sémantique au helper privé — c'est
 * juste un point d'accès stable pour `messages.ts` (et S6.6+) afin d'éviter
 * de dupliquer la logique Zod + ValidationError. NE JAMAIS faire de
 * surcouche ici : toute évolution du parsing doit rester dans
 * `parseConversationOrThrow`.
 *
 * @internal Helper inter-modules `firestore/`. NE PAS appeler depuis du
 *           code applicatif : utiliser `getConversation()` pour une
 *           lecture standalone (avec retour `null` en cas d'absence).
 */
export function _parseConversationOrThrow(raw: unknown, conversationId: string): Conversation {
  return parseConversationOrThrow(raw, conversationId);
}

/**
 * Bumpe atomiquement les compteurs de cadence d'une conversation (sans audit).
 *
 * **Helper transactionnel partagé** extrait en S6.5 pour être réutilisé par
 * `addOutbound` / `addInbound` (`lib/firestore/messages.ts`) — qui posent
 * leur propre audit `sms_sent` / `sms_received` enrichi avec `messageId` —
 * sans dupliquer la logique compteurs.
 *
 * Champs mis à jour (en une seule `tx.update`) :
 *   - `messageCount` : +1
 *   - `outboundCount` ou `inboundCount` selon `direction` : +1
 *   - `lastMessageAt`, `lastOutboundAt` | `lastInboundAt` : `now`
 *   - `firstMessageAt` : posé UNIQUEMENT si absent (cadence stable
 *     pour les jobs de relance followup_3d / followup_7d)
 *   - `updatedAt` : `now`
 *
 * **Préconditions caller (non vérifiées ici) :**
 *   1. La conversation `conv` a été lue dans `tx` et validée par
 *      `parseConversationOrThrow` au préalable.
 *   2. Le caller pose son propre audit log dans la même `tx` (pas posé
 *      ici pour permettre des payloads enrichis selon le contexte —
 *      `incrementMessageCount` posé `{direction}`, `addOutbound` posé
 *      `{direction, messageId}`).
 *
 * @internal Helper inter-modules `firestore/`. NE PAS appeler depuis du
 *           code applicatif (Inngest, API routes) : utiliser
 *           `incrementMessageCount`, `addOutbound` ou `addInbound`.
 */
export function _bumpConversationCountersTx(
  tx: Transaction,
  ref: DocumentReference,
  conv: Conversation,
  direction: "outbound" | "inbound",
  now: Timestamp,
): void {
  const isOutbound = direction === "outbound";
  const updates: Record<string, unknown> = {
    messageCount: conv.messageCount + 1,
    [isOutbound ? "outboundCount" : "inboundCount"]:
      (isOutbound ? conv.outboundCount : conv.inboundCount) + 1,
    lastMessageAt: now,
    [isOutbound ? "lastOutboundAt" : "lastInboundAt"]: now,
    updatedAt: now,
  };
  // `firstMessageAt` posé UNE SEULE FOIS — historique de cadence stable
  // pour les jobs de relance (followup_3d / followup_7d).
  if (!conv.firstMessageAt) {
    updates.firstMessageAt = now;
  }
  tx.update(ref, updates);
}

// ─────────────────────────────────────────────────────────────────────────────
// API publique
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Récupère une conversation par son docId composite.
 *
 *   - Document absent              → `null` (cas légitime, le caller
 *                                     décide si c'est une erreur dans son
 *                                     contexte — cf. arbitrage S6.3).
 *   - Document présent + Zod OK    → `Conversation`.
 *   - Document présent + Zod fail  → `throw ValidationError` (corruption).
 */
export async function getConversation(conversationId: string): Promise<Conversation | null> {
  const doc = await getAdminDb().collection(CONVERSATIONS_COLLECTION).doc(conversationId).get();
  if (!doc.exists) return null;
  return parseConversationOrThrow(doc.data(), conversationId);
}

/**
 * Résout `contactId → conversation active` pour le pipeline `process-reply`
 * (S9.2).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * RAISON D'ÊTRE (S9.2.1 — process-reply)
 *
 * Le webhook OVH (futur S9.6) livre l'inbound avec `{phone, body,
 * ovhMessageId}` sans `campaignId` ni `conversationId`. Après résolution
 * `phone → contactId` (S9.1 `getContactByPhone`), il reste à trouver la
 * conversation ACTIVE de ce contact (status dans
 * `ACTIVE_CONVERSATION_STATUSES`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INVARIANT UNICITÉ — defense-in-depth (Q1 brief Déthié S9.2.0)
 *
 * Invariant business : 1 contact = max 1 conversation ACTIVE à un instant
 * donné (un contact ne participe qu'à 1 campagne à la fois en MVP, et le
 * docId composite `${contactId}_${campaignId}` empêche la dup naïve dans
 * une même campagne).
 *
 * Si la query retourne :
 *
 *   - 0 doc → `null`. Caller (process-reply) drop avec audit
 *     `reply_dropped` `{reason: "no_active_conversation"}` (Q3 brief
 *     Déthié S9.2.0). Cohérent avec `getContactByPhone` qui retourne
 *     `null` pour absence légitime.
 *
 *   - 1 doc → cas nominal. Retour `{ conversationId, conversation }`.
 *
 *   - >1 doc → throw `InternalError` (`isOperational: false`). Drift
 *     d'invariant = bug d'orchestration campagne OU corruption. Le
 *     pipeline doit arrêter et alerter — pas continuer avec un choix
 *     arbitraire qui enverrait la réponse dans la mauvaise conv.
 *     Pattern identique à `getContactByPhone` (S9.1).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INDEX FIRESTORE COMPOSITE REQUIS (S9.2.1)
 *
 * La query combine 1 `where` égalité + 1 `where` IN → Firestore exige
 * un index composite. Déclaré dans `firestore.indexes.json` (S9.2.1) :
 *
 *   { "collectionGroup": "conversations", "queryScope": "COLLECTION",
 *     "fields": [
 *       { "fieldPath": "contactId", "order": "ASCENDING" },
 *       { "fieldPath": "status", "order": "ASCENDING" }
 *     ] }
 *
 * Sans déploiement de cet index, la query throw `FAILED_PRECONDITION`.
 * Cf. `docs/firestore-indexes.md` section "Index 3".
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ⚠️ PII DOWNSTREAM — responsabilité du caller
 *
 * Le retour `{ conversationId, conversation }` ne contient pas de PII
 * directe (pas de phone, pas de email). Mais :
 *
 *   - `conversationId = ${contactId}_${campaignId}` est un identifiant
 *     traçable. Acceptable en logs/audits par construction (scrubber-safe).
 *
 *   - `conversation.summary` peut contenir des éléments quasi-identifiants
 *     (mention de cabinet, ville) si l'IA en a inséré. Le caller NE doit
 *     PAS logger ni inclure `conversation.summary` dans un audit sans
 *     re-validation prompt-engineer (le prompt actuel l'interdit, mais
 *     defense-in-depth).
 *
 *   - `conversation.handoff.notes` peut contenir des notes commerciales
 *     avec PII. Idem, NE PAS logger.
 *
 * @param contactId  ID Firestore du contact (= hubspotId, S6.3). NON vide.
 *
 * @returns `{ conversationId, conversation }` si trouvée, sinon `null`.
 *
 * @throws ValidationError  si `contactId` est vide.
 * @throws InternalError    si >1 conv active trouvée (invariant cassé).
 * @throws ValidationError  si un doc trouvé est corrompu (Zod fail).
 */
export async function getActiveConversationByContactId(
  contactId: string,
): Promise<{ conversationId: string; conversation: Conversation } | null> {
  if (contactId.length === 0) {
    throw new ValidationError({
      message: "getActiveConversationByContactId: contactId is empty",
      context: { op: "getActiveConversationByContactId", inputLength: 0 },
    });
  }

  const snap = await getAdminDb()
    .collection(CONVERSATIONS_COLLECTION)
    .where("contactId", "==", contactId)
    .where("status", "in", ACTIVE_CONVERSATION_STATUSES)
    .limit(2) // limit(2) suffit pour détecter le drift invariant — économie I/O
    .get();

  if (snap.empty) {
    return null;
  }

  if (snap.size > 1) {
    throw new InternalError({
      message:
        "getActiveConversationByContactId: invariant violation — multiple active conversations for same contact",
      context: {
        op: "getActiveConversationByContactId",
        contactId,
        count: snap.size,
      },
    });
  }

  // snap.size === 1 — cas nominal.
  const doc = snap.docs[0]!;
  const conversation = parseConversationOrThrow(doc.data(), doc.id);
  return { conversationId: doc.id, conversation };
}

/**
 * Incrémente atomiquement les compteurs de messages d'une conversation et
 * pose les timestamps de cadence pour `lib/compliance/rate-limits` et
 * `lib/compliance/hours`.
 *
 * Champs mis à jour (1 tx) :
 *   - `messageCount` : +1
 *   - `outboundCount` ou `inboundCount` selon `direction` : +1
 *   - `lastMessageAt`, `lastOutboundAt` | `lastInboundAt` : now
 *   - `firstMessageAt` : posé UNIQUEMENT si absent (1er message)
 *   - `updatedAt` : now
 *   - audit_log : 1 entrée `sms_sent` | `sms_received` avec
 *     `payload: { direction }` (rien d'autre — pas de messageId).
 *
 * Volume audit anticipé (à monitorer en prod, cf. arbitrage S6.4 Q1) :
 *   26k contacts × ~3 outbound + ~2 inbound = ~130k audits compteurs
 *   sur la campagne MVP complète. Coût Firestore négligeable (~0.50€).
 *
 * @throws NotFoundError    si la conversation n'existe pas.
 * @throws ValidationError  si le doc est corrompu.
 */
export async function incrementMessageCount(
  conversationId: string,
  direction: "outbound" | "inbound",
): Promise<void> {
  await getAdminDb().runTransaction(async (tx) => {
    const ref = getAdminDb().collection(CONVERSATIONS_COLLECTION).doc(conversationId);
    const doc = await tx.get(ref);
    if (!doc.exists) {
      throw new NotFoundError({
        message: `Conversation not found: ${conversationId}`,
        context: { conversationId },
      });
    }
    const conv = parseConversationOrThrow(doc.data(), conversationId);

    const now = Timestamp.now();
    _bumpConversationCountersTx(tx, ref, conv, direction, now);

    appendAuditLogTx(tx, {
      actorId: "system",
      actorType: "system",
      action: direction === "outbound" ? "sms_sent" : "sms_received",
      targetType: "conversation",
      targetId: conversationId,
      payload: { direction },
    });
  });
}

/**
 * Verrouille une conversation à un commercial humain pour suite manuelle.
 *
 * **NON idempotent** (arbitrage Déthié S6.4 Q2) : si la conversation est
 * déjà `handed_off` (ou possède un sous-objet `handoff`), throw
 * `ConflictError` — y compris si le 2e appel est avec le MÊME `assignedTo`
 * (le caller Inngest est attendu idempotent via `step.run` memoization,
 * pas la fonction Firestore).
 *
 * `notes` est obligatoire, ≥10 chars (forensic). Exemples valides :
 *   - "RDV demain"        (10)
 *   - "demande info"      (12)
 *   - "INTERESSE: RDV"    (15)
 *
 * Audit log : `payload = { notesLength: notes.length }`. JAMAIS `notes`
 * brut — risque PII si le commercial écrit un téléphone/email dedans.
 *
 * Validation `notes` faite AVANT `runTransaction` → pas d'écriture
 * Firestore si l'input est invalide.
 *
 * @throws ValidationError  si `notes.length < 10`.
 * @throws NotFoundError    si la conversation n'existe pas.
 * @throws ConflictError    si la conversation est déjà `handed_off`.
 */
export async function setHandoff(
  conversationId: string,
  assignedTo: string,
  notes: string,
): Promise<void> {
  if (notes.length < HANDOFF_NOTES_MIN_LENGTH) {
    throw new ValidationError({
      message: `setHandoff: notes must be at least ${HANDOFF_NOTES_MIN_LENGTH} characters`,
      context: {
        conversationId,
        actualLength: notes.length,
        minRequired: HANDOFF_NOTES_MIN_LENGTH,
      },
    });
  }

  await getAdminDb().runTransaction(async (tx) => {
    const ref = getAdminDb().collection(CONVERSATIONS_COLLECTION).doc(conversationId);
    const doc = await tx.get(ref);
    if (!doc.exists) {
      throw new NotFoundError({
        message: `Conversation not found: ${conversationId}`,
        context: { conversationId },
      });
    }
    const conv = parseConversationOrThrow(doc.data(), conversationId);

    if (conv.status === "handed_off" || conv.handoff) {
      throw new ConflictError({
        message: "Conversation already handed off",
        context: {
          conversationId,
          currentAssignedTo: conv.handoff?.assignedTo ?? "unknown",
        },
      });
    }

    const now = Timestamp.now();
    tx.update(ref, {
      status: "handed_off",
      "handoff.assignedTo": assignedTo,
      "handoff.assignedAt": now,
      "handoff.notes": notes,
      updatedAt: now,
    });

    appendAuditLogTx(tx, {
      actorId: assignedTo,
      actorType: "human",
      action: "handoff",
      targetType: "conversation",
      targetId: conversationId,
      // Pas `notes` brut — risque PII. Seulement la longueur comme preuve
      // forensic qu'une note a été fournie. Les notes restent lisibles
      // dans le doc conversation pour audit manuel (skill alignment).
      payload: { notesLength: notes.length },
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Exposés pour tests
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export const __CONVERSATIONS_COLLECTION_FOR_TESTS = CONVERSATIONS_COLLECTION;

/** @internal */
export const __HANDOFF_NOTES_MIN_LENGTH_FOR_TESTS = HANDOFF_NOTES_MIN_LENGTH;

/** @internal */
export const __ACTIVE_CONVERSATION_STATUSES_FOR_TESTS = ACTIVE_CONVERSATION_STATUSES;
