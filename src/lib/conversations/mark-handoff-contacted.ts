/**
 * PR4 — « J'ai contacté le médecin ».
 *
 * Core server-only partagé entre les routes POST et DELETE
 * `/api/admin/conversations/[id]/handoff-contacted`. Les routes sont
 * des wrappers minces (Zod id + rate-limit + appel), toute la logique
 * (droits, statut, idempotence, écriture, audit) vit ici.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Ordre STRICT des contrôles
 *
 *   1. HORS transaction : si `actor.testAccount`, `assertTestAccountMayWriteConversation`
 *      (403 « Compte de test refusé sur cette conversation. »). AUCUNE
 *      lecture Firestore avant ce refus.
 *   2. DANS `db.runTransaction` sur `tx.get(ref)` :
 *        a. existence → 404 `NotFoundError`.
 *        b. droits fins (admin OU titulaire pour mark, admin OU auteur
 *           pour unmark) → 403 `ForbiddenError`. VOLONTAIRE avant le
 *           check statut : un non-titulaire sur une conv pas
 *           handed_off doit recevoir 403, pas 409 (cadrage corr. 1).
 *        c. statut `handed_off` → 409 si autre statut.
 *        d. idempotence (`handoffContacted === true` pour mark,
 *           `!== true` pour unmark) → 409.
 *        e. `tx.update(...)` + `appendAuditLogTx(tx, ...)` — atomique.
 *
 * Le bump `updatedAt` dans la même tx fait bouger la signature
 * `/version` (liste + détail), qui déclenche le refetch client.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Audit sans PII
 *
 *   - `handoff_contacted` : payload `{ contactedBy: actor.userId }`.
 *   - `handoff_contact_undone` : payload `{ originalContactedBy,
 *     originalContactedAtMs }`. `actorId` = userId de celui qui annule
 *     (admin OU auteur), DIFFÉRENT de `originalContactedBy` en cas
 *     d'annulation admin (E5).
 *
 *   `actorTestAccount: boolean` top-level sur chaque audit (PR3 tour 2b
 *   bis ter) — dérivé du claim Clerk.
 */
import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { assertTestAccountMayWriteConversation } from "@/lib/conversations/testaccount-whitelist";
import { getAdminDb } from "@/lib/firestore/admin";
import { appendAuditLogTx } from "@/lib/firestore/audit-log";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/utils/errors";
import type { Conversation } from "@/types/conversation";

const CONVERSATIONS_COLLECTION = "conversations";

export interface HandoffContactedActor {
  readonly userId: string;
  readonly role: "admin" | "commercial";
  readonly slackUserId: string | undefined;
  readonly testAccount: boolean;
}

export interface MarkHandoffContactedResult {
  readonly contactedAtIso: string;
}

/**
 * Prédicat PUR du droit de marquer. Admin OK partout ; commercial
 * autorisé UNIQUEMENT si `slackUserId` non vide ET égal à
 * `handoff.assignedTo`. Deux chaînes vides ne matchent PAS (garde
 * explicite). Appelé dans la transaction, sur la lecture
 * transactionnelle.
 */
export function canMarkHandoffContacted(
  actor: HandoffContactedActor,
  assignedTo: string | undefined,
): boolean {
  if (actor.role === "admin") return true;
  if (typeof actor.slackUserId !== "string" || actor.slackUserId.length === 0) return false;
  if (typeof assignedTo !== "string" || assignedTo.length === 0) return false;
  return actor.slackUserId === assignedTo;
}

/**
 * Prédicat du droit d'annuler : admin OU auteur du marquage.
 */
export function canUnmarkHandoffContacted(
  actor: HandoffContactedActor,
  contactedBy: string | undefined,
): boolean {
  if (actor.role === "admin") return true;
  if (typeof contactedBy !== "string" || contactedBy.length === 0) return false;
  return actor.userId === contactedBy;
}

/**
 * POST — pose `handoff.contactedAt`, `handoff.contactedBy`,
 * `handoffContacted: true`, `updatedAt: now` + audit `handoff_contacted`
 * dans la même transaction.
 */
export async function markHandoffContacted(args: {
  actor: HandoffContactedActor;
  conversationId: string;
}): Promise<MarkHandoffContactedResult> {
  // 1) Whitelist HORS tx — zéro lecture avant le refus.
  if (args.actor.testAccount) {
    assertTestAccountMayWriteConversation(args.conversationId);
  }

  const db = getAdminDb();
  const ref = db.collection(CONVERSATIONS_COLLECTION).doc(args.conversationId);
  const now = Timestamp.now();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new NotFoundError({
        message: "markHandoffContacted: conversation not found",
        clientMessage: "Conversation introuvable.",
        context: { conversationId: args.conversationId },
      });
    }
    const data = snap.data() as Conversation;

    // (b) Droits AVANT statut : un non-titulaire ne doit pas apprendre
    // si la conv est handed_off ou pas.
    if (!canMarkHandoffContacted(args.actor, data.handoff?.assignedTo)) {
      throw new ForbiddenError({
        message: "markHandoffContacted: actor is not titulaire",
        clientMessage: "Accès refusé.",
        context: {
          conversationId: args.conversationId,
          actorRole: args.actor.role,
        },
      });
    }

    // (c) Statut.
    if (data.status !== "handed_off") {
      throw new ConflictError({
        message: `markHandoffContacted: status is ${data.status}, not handed_off`,
        clientMessage:
          "Action impossible : cette conversation n'est plus en attente d'un commercial.",
        context: { conversationId: args.conversationId, status: data.status },
      });
    }

    // (d) Idempotence.
    if (data.handoffContacted === true) {
      throw new ConflictError({
        message: "markHandoffContacted: already contacted",
        clientMessage: "Cette conversation est déjà marquée comme contactée.",
        context: { conversationId: args.conversationId },
      });
    }

    // (e) Écriture + audit dans la même tx.
    tx.update(ref, {
      "handoff.contactedAt": now,
      "handoff.contactedBy": args.actor.userId,
      handoffContacted: true,
      updatedAt: now,
    });
    appendAuditLogTx(tx, {
      actorId: args.actor.userId,
      actorType: "human",
      actorTestAccount: args.actor.testAccount,
      action: "handoff_contacted",
      targetType: "conversation",
      targetId: args.conversationId,
      payload: { contactedBy: args.actor.userId },
    });

    return { contactedAtIso: now.toDate().toISOString() };
  });
}

/**
 * DELETE — efface `handoff.contactedAt`, `handoff.contactedBy`, pose
 * `handoffContacted: false`, bump `updatedAt`. Audit
 * `handoff_contact_undone` avec `originalContactedBy` et
 * `originalContactedAtMs` en payload. L'`actorId` est celui qui
 * annule (admin OU auteur).
 */
export async function unmarkHandoffContacted(args: {
  actor: HandoffContactedActor;
  conversationId: string;
}): Promise<void> {
  if (args.actor.testAccount) {
    assertTestAccountMayWriteConversation(args.conversationId);
  }

  const db = getAdminDb();
  const ref = db.collection(CONVERSATIONS_COLLECTION).doc(args.conversationId);
  const now = Timestamp.now();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new NotFoundError({
        message: "unmarkHandoffContacted: conversation not found",
        clientMessage: "Conversation introuvable.",
        context: { conversationId: args.conversationId },
      });
    }
    const data = snap.data() as Conversation;

    if (!canUnmarkHandoffContacted(args.actor, data.handoff?.contactedBy)) {
      throw new ForbiddenError({
        message: "unmarkHandoffContacted: actor is neither author nor admin",
        clientMessage: "Accès refusé.",
        context: {
          conversationId: args.conversationId,
          actorRole: args.actor.role,
        },
      });
    }

    if (data.status !== "handed_off") {
      throw new ConflictError({
        message: `unmarkHandoffContacted: status is ${data.status}, not handed_off`,
        clientMessage:
          "Action impossible : cette conversation n'est plus en attente d'un commercial.",
        context: { conversationId: args.conversationId, status: data.status },
      });
    }

    if (data.handoffContacted !== true) {
      throw new ConflictError({
        message: "unmarkHandoffContacted: nothing to undo",
        clientMessage: "Aucun contact à annuler.",
        context: { conversationId: args.conversationId },
      });
    }

    const originalContactedBy = data.handoff?.contactedBy;
    const originalContactedAtMs = data.handoff?.contactedAt?.toMillis?.();

    tx.update(ref, {
      "handoff.contactedAt": FieldValue.delete(),
      "handoff.contactedBy": FieldValue.delete(),
      handoffContacted: false,
      updatedAt: now,
    });
    appendAuditLogTx(tx, {
      actorId: args.actor.userId,
      actorType: "human",
      actorTestAccount: args.actor.testAccount,
      action: "handoff_contact_undone",
      targetType: "conversation",
      targetId: args.conversationId,
      payload: {
        originalContactedBy: typeof originalContactedBy === "string" ? originalContactedBy : null,
        originalContactedAtMs:
          typeof originalContactedAtMs === "number" ? originalContactedAtMs : null,
      },
    });
  });
}
