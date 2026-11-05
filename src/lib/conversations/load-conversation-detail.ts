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
import { resolveAdminNamesBatch } from "@/lib/auth/resolve-admin-name";
import { resolveCampaignName } from "@/lib/campaigns/campaign-id";
import { campaignNameByListIdFrom, getCachedSmsCampaigns } from "@/lib/campaigns/campaigns-cache";
import { getAdminDb } from "@/lib/firestore/admin";
import { listAuditLogByTarget } from "@/lib/firestore/audit-log";
import { getContact } from "@/lib/firestore/contacts";
import { getConversation } from "@/lib/firestore/conversations";
import { listMessagesInConversation } from "@/lib/firestore/messages";
import { logger } from "@/lib/utils/logger";
import type { AuditLog, AuditTargetType } from "@/types/audit-log";

export type LoadConversationDetailResult =
  | { kind: "ok"; data: ConversationDetailProps }
  | { kind: "not_found" }
  | { kind: "not_mine"; assignedToName: string | null }
  | { kind: "error"; code: string };

// ─────────────────────────────────────────────────────────────────────────────
// Journal — lecture unique indexée, coût O(20) indépendant des entrées test
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Taille cible du journal pour le viewer réel. L'UI n'affiche aujourd'hui
 * que les 5 plus récentes, on en collecte 20 pour que le slice final
 * reste stable même si plusieurs entrées se disputent la tête.
 */
const JOURNAL_REAL_TARGET_COUNT = 20;

/**
 * Lit les entrées d'audit pour un `(targetType, targetId)` donné.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Un seul chemin de lecture
 *
 *   - `viewerIsTestAccount: true`  → lecture simple `listAuditLogByTarget`
 *     (voit tout — canal de debug du harnais).
 *   - `viewerIsTestAccount: false` → query indexée unique :
 *       where targetType == tt
 *         AND targetId == ti
 *         AND actorTestAccount == false
 *         orderBy timestamp DESC
 *         limit 20
 *     Utilise l'index composite #15 (`targetType + targetId +
 *     actorTestAccount + timestamp DESC`). Coût O(20) indépendant du
 *     nombre d'entrées test accumulées.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pré-condition : rattrapage des entrées sans le champ top-level
 *
 *   Firestore ne matche pas un champ absent à `== false`. Toute entrée
 *   écrite AVANT ce PR (ou par un rollback de prod) est donc invisible
 *   du journal d'un compte réel tant qu'elle n'a pas le champ.
 *
 *   La règle projet append-only reste tenue : on n'EDITE PAS l'événement,
 *   on l'enrichit d'une donnée DÉRIVÉE (`actorTestAccount` dérivé du
 *   contexte de l'auteur, calculable a posteriori à partir du payload).
 *   Le rattrapage vit dans `src/lib/firestore/backfill-actor-test-account-core.ts`
 *   et son script mince `scripts/backfill-audit-actor-test-account.mjs`.
 *   Il doit être lancé une fois avant le merge pour que le journal d'un
 *   compte réel n'ait pas de trou.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Fail-closed : tout throw Firestore remonte au caller
 * (`loadConversationDetail`) qui logge et renvoie `kind: "error"`.
 */
export async function fetchJournalEntriesRealOnly(args: {
  targetType: AuditTargetType;
  targetId: string;
  viewerIsTestAccount: boolean;
  targetCount?: number;
}): Promise<Array<AuditLog & { docId: string }>> {
  const targetCount = args.targetCount ?? JOURNAL_REAL_TARGET_COUNT;

  if (args.viewerIsTestAccount) {
    const { entries } = await listAuditLogByTarget({
      targetType: args.targetType,
      targetId: args.targetId,
      limit: targetCount,
    });
    return entries;
  }

  const snap = await getAdminDb()
    .collection("audit_log")
    .where("targetType", "==", args.targetType)
    .where("targetId", "==", args.targetId)
    .where("actorTestAccount", "==", false)
    .orderBy("timestamp", "desc")
    .limit(targetCount)
    .get();
  return snap.docs.map((d) => ({ ...(d.data() as AuditLog), docId: d.id }));
}

export const __JOURNAL_CONSTANTS_FOR_TESTS = {
  JOURNAL_REAL_TARGET_COUNT,
} as const;

/**
 * PR1.14.2 (fix S5) — un admin n'est "owner" d'une conversation que si
 * son `slackUserId` coïncide avec `handoff.assignedTo`. Avant ce fix,
 * `viewerIsOwner` renvoyait `true` pour TOUT admin (`isAdmin || …`),
 * ce qui cachait la bannière « Mode admin » à l'admin qui consulte une
 * conv assignée à quelqu'un d'autre — exactement l'inverse de l'intention.
 *
 * ⚠ **Règle stricte** (durcie PR1.14.2 2026-10-23) :
 *   `true` **UNIQUEMENT** si les deux arguments sont des chaînes NON
 *   VIDES et égales. Toute valeur `null`, `undefined`, `""` (ou autre
 *   non-string au runtime) force `false`. Protège contre le cas pervers
 *   où un viewer sans slackUserId configuré (chaîne vide côté Firestore
 *   ou absence côté metadata Clerk) viendrait "matcher" une conv sans
 *   handoff (`""` === `""` → true accidentel).
 *
 * Table de vérité étendue :
 *   (undefined, undefined)       → false
 *   (null,      null)            → false
 *   (undefined, null)            → false
 *   ("",        "")              → false   ← PROTÈGE ce cas pervers
 *   (undefined, "U123")          → false
 *   ("U123",    null)            → false
 *   ("U123",    "")              → false
 *   ("",        "U123")          → false
 *   ("U123",    "U456")          → false
 *   ("U123",    "U123")          → true
 *
 * Signature élargie à `string | null | undefined` des DEUX côtés pour
 * refléter la réalité runtime (Firestore peut retourner `null` ou champ
 * absent, Clerk JWT peut émettre `null` ou `""` quand metadata absent).
 *
 * Garanti pur, testable sans mocker Firestore/Airtable.
 */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function computeViewerIsOwner(
  viewerSlackUserId: string | null | undefined,
  assignedToSlack: string | null | undefined,
): boolean {
  if (!isNonEmptyString(viewerSlackUserId)) return false;
  if (!isNonEmptyString(assignedToSlack)) return false;
  return viewerSlackUserId === assignedToSlack;
}

/**
 * PR2b-2 round 3 R3-P1 — résout le nom lisible de la campagne côté
 * serveur. Priorité à la copie dénormalisée Firestore ; sinon on consulte
 * le cache mémoire 5 min des listes HubSpot (même source que la page
 * liste). En cas d'échec HubSpot : retourne `null` → l'UI dégradée
 * affichera "Campagne inconnue", jamais l'id brut.
 *
 * Pur / safe à appeler : ne throw pas (catch interne), ne log pas de PII.
 */
export async function resolveCampaignNameServerSide(
  campaignId: string,
  denormalizedName: string | undefined,
): Promise<string | null> {
  if (typeof denormalizedName === "string" && denormalizedName.trim().length > 0) {
    return denormalizedName;
  }
  try {
    const campaigns = await getCachedSmsCampaigns();
    const map = campaignNameByListIdFrom(campaigns);
    return resolveCampaignName(campaignId, map);
  } catch (err) {
    // Dégradation gracieuse : si HubSpot est down, le détail reste
    // affichable et l'UI tombera sur "Campagne inconnue".
    logger.warn(
      { campaignId, errName: err instanceof Error ? err.name : "unknown" },
      "[load-conversation-detail] HubSpot campaign cache miss — fallback null",
    );
    return null;
  }
}

/**
 * Charge et sanitize une conversation pour affichage dashboard.
 *
 * @param conversationId  docId Firestore composite `${contactId}_${campaignId}`.
 * @param viewer          contexte RBAC du viewer : rôle + slackUserId (si commercial).
 */
export async function loadConversationDetail(
  conversationId: string,
  viewer: {
    role: "admin" | "commercial";
    slackUserId: string | undefined;
    /**
     * PR3 tour 2b — flag JWT Clerk `testAccount`. Quand `false`, le
     * sanitize du journal filtre les entrées dont le payload audit porte
     * `actorTestAccount === true` (actions posées par le harnais
     * Playwright). Quand `true`, toutes les entrées sont visibles.
     */
    testAccount: boolean;
  },
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
    // PR3 tour 2b bis — les audits sont paginés jusqu'à `JOURNAL_REAL_TARGET_COUNT`
    // entrées RÉELLES par stream (viewer réel), ou un seul fetch avec
    // `limit = targetCount` (viewer testAccount). Fail-closed : tout throw
    // remonte à `loadConversationDetail` (catch global en bas).
    const [contact, messagesPage, convAudit, contactAudit] = await Promise.all([
      getContact(conv.contactId),
      listMessagesInConversation({ conversationId, order: "asc", limit: 200 }),
      fetchJournalEntriesRealOnly({
        targetType: "conversation",
        targetId: conversationId,
        viewerIsTestAccount: viewer.testAccount,
      }),
      // Le second stream (contact) peut être appelé après que l'on
      // connaisse `conv.contactId`. Dans un `Promise.all` top-level on
      // doit l'instancier séparément — on le fait AVANT le Promise.all
      // en wrappant dans un IIFE qui reçoit la conv. Trop verbose : on
      // passe directement `conv.contactId` (déjà disponible).
      fetchJournalEntriesRealOnly({
        targetType: "contact",
        targetId: conv.contactId,
        viewerIsTestAccount: viewer.testAccount,
      }),
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

    // Fusion des 2 streams (chacun déjà filtré côté `fetchJournalEntriesRealOnly`
    // pour un viewer réel) par date desc, top 5 pour la place UI actuelle.
    // Le filtre `actorTestAccount` AU NIVEAU DE LA SANITIZE reste en
    // place en défense en profondeur (si un futur site d'écriture
    // oublie de dénormaliser `actorTestAccount`, il sera quand même
    // filtré UI-side — cf. sanitize.ts).
    const merged = [...convAudit, ...contactAudit].sort((a, b) => {
      const aMs = a.timestamp.toMillis();
      const bMs = b.timestamp.toMillis();
      return bMs - aMs;
    });
    const topFive = merged.slice(0, 5);
    const humanActorIds = topFive.filter((e) => e.actorType === "human").map((e) => e.actorId);
    const actorNameByUserId =
      humanActorIds.length > 0
        ? await resolveAdminNamesBatch(humanActorIds)
        : new Map<string, string | null>();
    const journal: JournalEntryProps[] = sanitizeAuditEntriesForJournal(topFive, {
      actorNameByUserId,
      viewerIsTestAccount: viewer.testAccount,
    });

    const data: ConversationDetailProps = {
      conversationId,
      contactId: conv.contactId,
      status: sanitizeConversationStatus(conv),
      intent: sanitizeConversationIntent(conv),
      campaignId: conv.campaignId,
      // PR2b-2 round 3 R3-P1 — résolution côté serveur avec cascade :
      //   1) `conv.campaignName` dénormalisé Firestore (quand backfill PR2a
      //      l'a posé — pas garanti ; conversation A par exemple ne l'a pas).
      //   2) Sinon : map HubSpot en cache 5 min (`getCachedSmsCampaigns`),
      //      même source que la page liste → cohérence des libellés.
      //   3) Sinon : `null` → l'UI tombe sur "Campagne inconnue" (plutôt
      //      que l'id brut `hubspot-list-6081` qui apparaissait avant).
      // HubSpot down → catch silencieux, dégradation gracieuse à null.
      campaignName: await resolveCampaignNameServerSide(conv.campaignId, conv.campaignName),
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
      viewerIsOwner: computeViewerIsOwner(viewer.slackUserId, assignedToSlack),
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
