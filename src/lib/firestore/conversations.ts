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
import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";

import { getAdminDb } from "@/lib/firestore/admin";
import { appendAuditLogTx } from "@/lib/firestore/audit-log";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/utils/errors";
import type { Conversation } from "@/types/conversation";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes & helper public
// ─────────────────────────────────────────────────────────────────────────────

const CONVERSATIONS_COLLECTION = "conversations";

const HANDOFF_NOTES_MIN_LENGTH = 10;

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

    appendAuditLogTx(tx, {
      actorId: "system",
      actorType: "system",
      action: isOutbound ? "sms_sent" : "sms_received",
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
