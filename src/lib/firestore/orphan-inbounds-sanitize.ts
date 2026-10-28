/**
 * Sanitize pour vue client des docs `inbound_messages_orphans/`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Invariant côté client — JAMAIS exposés :
 *   - `phoneHash`      : hash HMAC + pepper (traçable par corrélation
 *                        archive si pepper leak).
 *   - `idempotencyKey` : peut contenir un `ovhMessageId` semi-sensible.
 *
 * Les API routes doivent passer par CETTE fonction avant tout `.json()`.
 * Sentinelle test `no-phone-hash-in-payload.sentinel.test.ts`.
 */
import type { OrphanInboundView } from "./orphan-inbounds";

export interface OrphanInboundClientView {
  readonly docId: string;
  readonly reason: "no_conversation" | "unknown_contact" | "parse_failed" | "enqueue_failed";
  readonly body: string;
  readonly source: "process-reply" | "webhook-ovh-sms";
  readonly contactId?: string;
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
    readonly attachedBy: string;
  };
  readonly dismissal?: {
    readonly reason: "unrelated_or_spam" | "already_handled_elsewhere" | "sender_not_identifiable";
    readonly dismissedAtIso: string;
    readonly dismissedBy: string;
  };
}

export function sanitizeOrphanInboundForClient(view: OrphanInboundView): OrphanInboundClientView {
  const base: OrphanInboundClientView = {
    docId: view.docId,
    reason: view.reason,
    body: view.body,
    source: view.source,
    ...(view.contactId !== undefined ? { contactId: view.contactId } : {}),
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
            attachedBy: view.attachment.attachedBy,
          },
        }
      : {}),
    ...(view.dismissal !== undefined
      ? {
          dismissal: {
            reason: view.dismissal.reason,
            dismissedAtIso: view.dismissal.dismissedAt.toDate().toISOString(),
            dismissedBy: view.dismissal.dismissedBy,
          },
        }
      : {}),
  };
  return base;
}
