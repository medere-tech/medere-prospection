/**
 * Sanitize pour vue client des docs `inbound_messages_orphans/`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Invariant côté client — JAMAIS exposés :
 *   - `phoneHash`      : hash HMAC + pepper (traçable par corrélation
 *                        archive si pepper leak).
 *   - `idempotencyKey` : peut contenir un `ovhMessageId` semi-sensible.
 *   - `attachedBy` / `dismissedBy` : identifiants Clerk opaques — on les
 *                        strippe au profit du libellé générique « un admin »
 *                        pour éviter de corréler des actions à des userIds
 *                        depuis le client. Les audits serveur conservent
 *                        l'identifiant précis.
 *
 * Les API routes doivent passer par CETTE fonction avant tout `.json()`.
 * Sentinelle test `no-phone-hash-in-payload.sentinel.test.ts`.
 *
 * Shape enrichie (PR2c tour 2b bloc B) :
 *   `OrphanInboundEnrichedClientView` ajoute `contact` (nom pro + spécialité
 *   + ville) résolu côté serveur via `enrichOrphansWithContacts`. Le client
 *   ne connaît NI `contactId`, NI tout autre identifiant interne : il reçoit
 *   le libellé pré-résolu, prêt à afficher.
 */
import type { Contact } from "@/types/contact";

import type { OrphanInboundView } from "./orphan-inbounds";

/** Nom pro affichable, résolu côté serveur. `null` → « Expéditeur non identifié ».
 * Volontairement SANS `contactId` (hubspotId) côté client : data minimization
 * RGPD — aucun composant client ne lit l'id du contact depuis cette shape ;
 * les liens vers une conversation utilisent `attachment.conversationId` quand
 * l'orphan a été rattaché. Si un futur besoin « lien profil contact » apparaît,
 * on ré-ajoutera le champ à ce moment-là. */
export interface OrphanContactSummary {
  readonly displayName: string | null;
  readonly speciality: string | null;
  readonly city: string | null;
  readonly optedOut: boolean;
}

export interface OrphanInboundClientView {
  readonly docId: string;
  readonly reason: "no_conversation" | "unknown_contact" | "parse_failed" | "enqueue_failed";
  readonly body: string;
  readonly source: "process-reply" | "webhook-ovh-sms";
  /**
   * Résumé pro du médecin émetteur quand il a pu être résolu côté serveur
   * (via `enrichOrphansWithContacts`). `null` → l'orphan est un expéditeur
   * non identifié (`reason === "unknown_contact"` ou contact supprimé
   * depuis). La shape ne porte JAMAIS `contactId` — ni à la racine, ni sous
   * `contact` (data minimization, cf. `OrphanContactSummary`).
   */
  readonly contact: OrphanContactSummary | null;
  /** Hint UI : conversation déjà rattachée (post-attach ou cas
   * `handed_off_no_assignee` qui pose `conversationId` à la création). */
  readonly conversationId?: string;
  readonly wasOptOut?: boolean;
  /**
   * `true` ssi un phoneHash est présent côté serveur (indicateur
   * UI "rattachement possible"). La VALEUR du hash n'est jamais envoyée.
   */
  readonly hasPhoneHash: boolean;
  readonly receivedAtIso: string;
  readonly processingState: "pending" | "attached" | "dismissed";
  readonly isTestFixture: boolean;
  readonly attachment?: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly phoneMatch: "match" | "mismatch" | "not_computable";
    readonly attachedAtIso: string;
    /**
     * Nom pré-résolu côté serveur (prénom + nom Clerk). `null` → l'UI
     * affiche « Admin inconnu ». L'identifiant Clerk ne quitte jamais
     * le serveur.
     */
    readonly attachedByName: string | null;
  };
  readonly dismissal?: {
    readonly reason: "unrelated_or_spam" | "already_handled_elsewhere" | "sender_not_identifiable";
    readonly dismissedAtIso: string;
    /** Idem `attachedByName`. */
    readonly dismissedByName: string | null;
  };
}

/**
 * Résolution d'un `Clerk userId` → nom. Signature séparée pour que la
 * fonction reste pure et testable sans mocker `clerkClient`. L'enrich
 * serveur passe la map pré-résolue via `resolveAdminNamesBatch`.
 */
export type AdminNameResolver = (userId: string) => string | null;

/**
 * Construit la vue client. Appelable sans contact résolu (`contact: null`)
 * et sans résolveur admin (les noms seront `null` → UI affiche « Admin
 * inconnu »).
 */
export function sanitizeOrphanInboundForClient(
  view: OrphanInboundView,
  resolvedContact?: Contact | null,
  resolveAdminName?: AdminNameResolver,
): OrphanInboundClientView {
  const contact: OrphanContactSummary | null = (() => {
    if (view.contactId === undefined) return null;
    if (!resolvedContact) return null;
    const first = resolvedContact.firstName?.trim() ?? "";
    const last = resolvedContact.lastName?.trim() ?? "";
    const full = [first, last].filter((s) => s.length > 0).join(" ");
    const civ = typeof resolvedContact.civilite === "string" ? resolvedContact.civilite.trim() : "";
    const prefix = civ === "Dr" || civ === "Pr" ? `${civ} ` : "";
    const name = full.length > 0 ? `${prefix}${full}`.trim() : null;
    return {
      displayName: name,
      speciality:
        resolvedContact.speciality && resolvedContact.speciality.length > 0
          ? resolvedContact.speciality
          : null,
      city: resolvedContact.city && resolvedContact.city.length > 0 ? resolvedContact.city : null,
      optedOut: Boolean(resolvedContact.consent?.optedOut),
    };
  })();

  const base: OrphanInboundClientView = {
    docId: view.docId,
    reason: view.reason,
    body: view.body,
    source: view.source,
    contact,
    ...(view.conversationId !== undefined ? { conversationId: view.conversationId } : {}),
    ...(view.wasOptOut !== undefined ? { wasOptOut: view.wasOptOut } : {}),
    hasPhoneHash: typeof view.phoneHash === "string" && view.phoneHash.length > 0,
    receivedAtIso: view.receivedAt.toDate().toISOString(),
    processingState: view.processingState,
    isTestFixture: view.isTestFixture === true,
    ...(view.attachment !== undefined
      ? {
          attachment: {
            conversationId: view.attachment.conversationId,
            messageId: view.attachment.messageId,
            phoneMatch: view.attachment.phoneMatch,
            attachedAtIso: view.attachment.attachedAt.toDate().toISOString(),
            attachedByName: resolveAdminName ? resolveAdminName(view.attachment.attachedBy) : null,
          },
        }
      : {}),
    ...(view.dismissal !== undefined
      ? {
          dismissal: {
            reason: view.dismissal.reason,
            dismissedAtIso: view.dismissal.dismissedAt.toDate().toISOString(),
            dismissedByName: resolveAdminName ? resolveAdminName(view.dismissal.dismissedBy) : null,
          },
        }
      : {}),
  };
  return base;
}
