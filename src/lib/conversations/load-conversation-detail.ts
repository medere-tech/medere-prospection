/**
 * Chargement orchestré des données pour la vue conversation
 * (VUE-CONVERSATION PR1).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rôle
 *
 *   Charge en parallèle depuis Firestore + Airtable :
 *     - `getConversation(conversationId)`
 *     - `getContact(contactId)` (extrait depuis conversationId)
 *     - `listMessagesInConversation(conversationId, { order: "asc" })`
 *     - `listAuditLogByTarget("conversation", conversationId)`
 *     - `listAuditLogByTarget("contact", contactId)`
 *     - `resolveCommercialBySlackUserId(handoff.assignedTo)` (si handoff)
 *     - Pour chaque message commercial, résolution du nom via même source
 *       Airtable (cache 5 min, 0 round-trip supplémentaire).
 *
 *   Puis sanitize vers la shape `ConversationDetailProps` (STRIPPE toute
 *   PII numéro / email).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Discriminated result
 *
 *   Retourne une union discriminée :
 *     - `{ kind: "ok", data }`                  : charge réussi
 *     - `{ kind: "not_found" }`                 : conversation OU contact inconnu
 *     - `{ kind: "not_mine", assignedToName }`  : commercial non-titulaire
 *     - `{ kind: "error", code }`               : erreur inattendue (I/O)
 *
 *   Le caller server component (page.tsx) traduit en 404, en page 403, ou
 *   en page d'erreur générique.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 ZÉRO PII dans le retour
 *
 *   `ConversationDetailProps` est garanti sans `e164` / `phone` /
 *   `externalReceiver` / `email` (sanitize.ts). Sentinelle test
 *   `tests/scripts/no-phone-in-payload.test.ts` grep la payload sérialisée.
 */
import {
  sanitizeAuditEntriesForJournal,
  sanitizeContactForHeader,
  sanitizeConversationIntent,
  sanitizeConversationStatus,
  sanitizeHandoffForPanel,
  sanitizeMessageForBubble,
} from "@/components/conversations/sanitize";
import type {
  ConversationDetailProps,
  JournalEntryProps,
  MessageProps,
} from "@/components/conversations/types";
import { resolveCommercialBySlackUserId } from "@/lib/airtable/commerciaux";
import { listAuditLogByTarget } from "@/lib/firestore/audit-log";
import { getContact } from "@/lib/firestore/contacts";
import { getConversation } from "@/lib/firestore/conversations";
import { listMessagesInConversation } from "@/lib/firestore/messages";
import { logger } from "@/lib/utils/logger";

export type LoadConversationDetailResult =
  | { kind: "ok"; data: ConversationDetailProps }
  | { kind: "not_found" }
  | { kind: "not_mine"; assignedToName: string | null }
  | { kind: "error"; code: string };

/**
 * Charge et sanitize une conversation pour affichage dashboard.
 *
 * @param conversationId  docId Firestore composite `${contactId}_${campaignId}`.
 * @param viewer          contexte RBAC du viewer : rôle + slackUserId (si commercial).
 */
export async function loadConversationDetail(
  conversationId: string,
  viewer: { role: "admin" | "commercial"; slackUserId: string | undefined },
): Promise<LoadConversationDetailResult> {
  try {
    const conv = await getConversation(conversationId);
    if (conv === null) return { kind: "not_found" };

    // Contrôle d'accès commercial : si viewer est commercial ET pas titulaire,
    // 403 avec résolution du nom du titulaire (meilleur UX).
    const isAdmin = viewer.role === "admin";
    const assignedToSlack = conv.handoff?.assignedTo ?? null;
    if (!isAdmin) {
      if (!viewer.slackUserId || viewer.slackUserId !== assignedToSlack) {
        const commercial = assignedToSlack
          ? await resolveCommercialBySlackUserId(assignedToSlack).catch(() => null)
          : null;
        return {
          kind: "not_mine",
          assignedToName: commercial && commercial.name.length > 0 ? commercial.name : null,
        };
      }
    }

    // Charge en parallèle contact + messages + 2 audits (conv + contact).
    const [contact, messagesPage, convAudit, contactAudit] = await Promise.all([
      getContact(conv.contactId),
      listMessagesInConversation({ conversationId, order: "asc", limit: 200 }),
      listAuditLogByTarget({ targetType: "conversation", targetId: conversationId, limit: 20 }),
      listAuditLogByTarget({ targetType: "contact", targetId: conv.contactId, limit: 20 }),
    ]);

    if (contact === null) return { kind: "not_found" };

    // Résout le titulaire (hand-off) + les commerciaux humains de chaque message.
    const titulaireCommercial = assignedToSlack
      ? await resolveCommercialBySlackUserId(assignedToSlack).catch(() => null)
      : null;
    const titulaireName = titulaireCommercial?.name ?? null;

    // Résolution bulk des noms des commerciaux depuis les messages
    // `generatedBy === "human"`. On déduplique les slackUserIds (pas
    // modélisés dans message pour l'instant → on utilise `handoff.assignedTo`
    // en fallback global car les commerciaux humains ne sont pas identifiés
    // sur le doc message — c'est une limite MVP, à affiner en S11+).
    // Pour MVP : tous les messages humans sont attribués au titulaire courant.
    // `sanitizeMessageForBubble` retourne `null` sur status="duplicate"
    // (defense-in-depth). On filtre les nulls ici — le composant UI
    // en aval ne doit JAMAIS recevoir de `duplicate`.
    const sanitizedMessages: MessageProps[] = messagesPage.messages
      .map((m) => sanitizeMessageForBubble(m, m.generatedBy === "human" ? titulaireName : null))
      .filter((m): m is MessageProps => m !== null);

    // Fusion des 2 audits par date desc, top 5.
    const merged = [...convAudit.entries, ...contactAudit.entries].sort((a, b) => {
      const aMs = a.timestamp.toMillis();
      const bMs = b.timestamp.toMillis();
      return bMs - aMs;
    });
    const journal: JournalEntryProps[] = sanitizeAuditEntriesForJournal(merged.slice(0, 5));

    const data: ConversationDetailProps = {
      conversationId,
      contactId: conv.contactId,
      status: sanitizeConversationStatus(conv),
      intent: sanitizeConversationIntent(conv),
      campaignId: conv.campaignId,
      createdAtIso: conv.createdAt.toDate().toISOString(),
      // Expose `updatedAtIso` dans la payload RSC — permet au client
      // de calculer une signature SSR strictement identique à celle du
      // premier poll `/version`. Évite un refetch détail inutile au
      // mount quand rien n'a bougé. Finding INFO security-reviewer
      // PR1.11 appliqué.
      updatedAtIso: conv.updatedAt.toDate().toISOString(),
      lastInboundAtIso: conv.lastInboundAt?.toDate().toISOString() ?? null,
      lastOutboundAtIso: conv.lastOutboundAt?.toDate().toISOString() ?? null,
      inboundCount: conv.inboundCount,
      outboundCount: conv.outboundCount,
      summary: conv.summary ?? null,
      handoff: sanitizeHandoffForPanel(conv, titulaireName),
      contact: sanitizeContactForHeader(contact),
      messages: sanitizedMessages,
      journal,
      viewerIsOwner:
        isAdmin || (viewer.slackUserId !== undefined && viewer.slackUserId === assignedToSlack),
    };

    return { kind: "ok", data };
  } catch (err) {
    logger.error(
      {
        err,
        conversationId,
        role: viewer.role,
      },
      "[loadConversationDetail] error loading conversation",
    );
    const code = err && typeof err === "object" && "name" in err ? String(err.name) : "unknown";
    return { kind: "error", code };
  }
}
