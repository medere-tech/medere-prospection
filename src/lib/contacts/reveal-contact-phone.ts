/**
 * Révélation auditée du numéro d'un contact (VUE-CONVERSATION PR3).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi UNE SEULE fonction
 *
 *   Trois chemins UI veulent le numéro :
 *     1. En-tête conversation (page détail) — commercial titulaire OU admin.
 *     2. Toggle « œil » de la liste `/admin/contacts` — admin.
 *     3. Preview dialog d'envoi 1er SMS — admin.
 *
 *   Si chaque route posait son propre audit, un oubli ou un drift de
 *   payload violerait L.34-5 CPCE (traçabilité des accès PII). UNE seule
 *   fonction = UNE seule règle d'accès + UN seul écriture d'audit. Les
 *   routes sont des wrappers minces : parsing Zod + rate-limit + appel.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Contrat
 *
 *   - Audit `contact_phone_accessed` écrit AVANT le `return`. Si
 *     `appendAuditLog` throw, la fonction throw aussi — RIEN n'est
 *     renvoyé au caller (fail-closed strict, miroir
 *     `attachOrphanToConversation` qui audit en même temps que l'écriture).
 *   - Vérif d'accès : admin accepté partout ; commercial accepté
 *     UNIQUEMENT si `conversationId` fourni ET `actor.slackUserId ===
 *     conv.handoff.assignedTo` (titulaire). JAMAIS basé sur
 *     `computeViewerIsOwner` ni sur une prop client.
 *   - Format FR du numéro renvoyé en plus de l'E.164 brut, pour que
 *     l'UI puisse l'afficher directement sans logique locale.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Payload audit — zéro PII
 *
 *   `{ method, contactId, conversationId?, actorTestAccount }`. Pas de
 *   `e164`, pas de `firstName`, pas de `email` (invariant
 *   `ContactPhoneAccessedPayload` + scrubber Pino + sentinelle test).
 */
import "server-only";

import { ForbiddenError, NotFoundError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";
import type { ContactPhoneAccessedPayload, ContactPhoneAccessMethod } from "@/types/audit-log";

import { appendAuditLog } from "../firestore/audit-log";
import { getContact } from "../firestore/contacts";
import { getConversation } from "../firestore/conversations";

export interface RevealContactPhoneActor {
  readonly userId: string;
  readonly role: "admin" | "commercial";
  readonly slackUserId: string | undefined;
  readonly testAccount: boolean;
}

export interface RevealContactPhoneInput {
  readonly actor: RevealContactPhoneActor;
  readonly contactId: string;
  /**
   * Scope conversation : REQUIS pour qu'un commercial puisse révéler
   * (il doit en être titulaire). Omis quand l'actor est admin ET que
   * le contexte est hors conversation (ex. page `/admin/contacts`).
   * Quand fourni, la fonction vérifie que `conv.contactId === contactId`
   * (anti-tamper client).
   */
  readonly conversationId?: string;
  readonly method: ContactPhoneAccessMethod;
}

export interface RevealContactPhoneResult {
  /** E.164 strict (ex. `+33612345678`). */
  readonly e164: string;
  /** Format FR affichable (`06 12 34 56 78` pour un mobile FR). */
  readonly display: string;
  readonly optedOut: boolean;
}

/**
 * Formate un E.164 FR en affichage « 0X XX XX XX XX ». Pour un numéro
 * hors FR (ne doit pas arriver dans notre base, mais défense en profondeur),
 * retourne le E.164 tel quel. JAMAIS d'exception.
 */
export function formatFrenchPhoneForDisplay(e164: string): string {
  if (/^\+33[1-9]\d{8}$/.test(e164)) {
    const national = "0" + e164.slice(3);
    return national.replace(/(\d{2})(?=\d)/g, "$1 ").trim();
  }
  return e164;
}

/**
 * Révèle le numéro d'un contact, après vérif d'accès + audit.
 *
 * Throws :
 *   - `NotFoundError` si contact (ou conv) introuvable.
 *   - `ForbiddenError` si l'actor n'a pas le droit.
 *   - L'erreur de `appendAuditLog` (si Firestore write throw) remonte
 *     telle quelle — RIEN n'est renvoyé.
 */
export async function revealContactPhone(
  input: RevealContactPhoneInput,
): Promise<RevealContactPhoneResult> {
  // 1) Fetch contact AVANT la vérif d'accès pour renvoyer 404 opaque
  //    (ne pas révéler qu'un `contactId` existe à un utilisateur non
  //    autorisé via le code d'erreur).
  const contact = await getContact(input.contactId);
  if (contact === null) {
    throw new NotFoundError({
      message: "revealContactPhone: contact not found",
      context: { contactId: input.contactId },
    });
  }

  // 2) Vérif d'accès — règle UNIQUE :
  //    - admin : OK partout.
  //    - commercial : REQUIS `conversationId` + `slackUserId` égal au
  //      titulaire de la conversation. La conv doit porter CE contactId
  //      (anti-tamper : un commercial ne doit pas pouvoir révéler un
  //      autre contact via une conv dont il est titulaire).
  if (input.actor.role === "commercial") {
    if (input.conversationId === undefined) {
      throw new ForbiddenError({
        message: "revealContactPhone: commercial requires conversationId",
        clientMessage: "Accès refusé.",
        context: { contactId: input.contactId, actorRole: input.actor.role },
      });
    }
    const conv = await getConversation(input.conversationId);
    if (conv === null) {
      throw new NotFoundError({
        message: "revealContactPhone: conversation not found",
        context: { conversationId: input.conversationId },
      });
    }
    if (conv.contactId !== input.contactId) {
      throw new ForbiddenError({
        message: "revealContactPhone: conversation does not belong to contact",
        clientMessage: "Accès refusé.",
        context: {
          contactId: input.contactId,
          conversationId: input.conversationId,
        },
      });
    }
    const assignedToSlack = conv.handoff?.assignedTo ?? null;
    if (
      input.actor.slackUserId === undefined ||
      input.actor.slackUserId.length === 0 ||
      input.actor.slackUserId !== assignedToSlack
    ) {
      throw new ForbiddenError({
        message: "revealContactPhone: commercial is not titulaire of this conversation",
        clientMessage: "Accès refusé.",
        context: {
          contactId: input.contactId,
          conversationId: input.conversationId,
        },
      });
    }
  }

  // 3) Audit AVANT le return. Si write Firestore throw → RIEN renvoyé.
  const payload: ContactPhoneAccessedPayload & {
    actorTestAccount: boolean;
  } = {
    method: input.method,
    contactId: input.contactId,
    ...(input.conversationId !== undefined
      ? { conversationId: input.conversationId }
      : // Clef `conversationId` absente plutôt qu'`undefined` : évite
        // le bruit dans le payload audit (règle `AuditLogInput.payload`).
        {}),
    actorTestAccount: input.actor.testAccount,
  } as ContactPhoneAccessedPayload & { actorTestAccount: boolean };

  await appendAuditLog({
    actorId: input.actor.userId,
    actorType: "human",
    // PR3 tour 2b bis (ter) — top-level pour permettre au journal de
    // filtrer en O(1) (index composite). La valeur reste AUSSI dans
    // `payload.actorTestAccount` pour la rétrocompatibilité des docs
    // écrits sous l'ancien schéma et pour l'inspection payload-only.
    actorTestAccount: input.actor.testAccount,
    action: "contact_phone_accessed",
    targetType: "contact",
    targetId: input.contactId,
    payload,
  });

  // 4) Log info sans PII — trace op pour debug sans jamais le numéro.
  logger.info(
    {
      service: "reveal-contact-phone",
      method: input.method,
      actorRole: input.actor.role,
      userIdPrefix: input.actor.userId.slice(0, 8),
    },
    "contact_phone_accessed",
  );

  return {
    e164: contact.phone.e164,
    display: formatFrenchPhoneForDisplay(contact.phone.e164),
    optedOut: Boolean(contact.consent.optedOut),
  };
}
