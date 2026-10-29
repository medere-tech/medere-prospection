/**
 * Catalogue exhaustif des FORMES de requêtes Firestore que les 3 routes
 * `/api/admin/conversations*` peuvent émettre (PR2a — vérification d'index).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi ce module existe
 *
 *   L'emulator Firestore N'enforce PAS les index composites (il exécute
 *   toute requête, même sans index). En prod Firestore Cloud, une query
 *   sans index composite échoue avec `FAILED_PRECONDITION` + un lien
 *   de création d'index. On a donc deux filets :
 *
 *     1. Déclaratif : `firestore.indexes.json` liste les index attendus.
 *     2. Fonctionnel (ce module + `scripts/check-conversation-list-indexes.mjs`)
 *        : exécute chaque forme de requête contre la vraie base en
 *        lecture seule et vérifie qu'elle NE lève PAS.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Lecture seule stricte
 *
 *   Les `run()` ne font QUE :
 *     - `listConversations(...)` / `listConversationsByAssignee(...)` avec `limit:1`
 *     - `countConversations(...)` (agrégation côté serveur, 1 lecture)
 *     - `queryConversationListVersion(...)` (`.limit(1).get()`)
 *     - `getActiveConversationByContactId(...)` / `getHandedOffConversationByContactId(...)`
 *       / `getLatestConversationByContactId(...)` (existants PR0, 1 lecture)
 *
 *   AUCUNE écriture, AUCUN side effect. Les probes utilisent des IDs
 *   qui ne risquent pas d'exister en prod (`UPROBE…`, `zzz-probe-…`).
 */
import { Timestamp } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firestore/admin";
import {
  backfillConversationsRef,
  queryBackfillContact,
  queryBackfillLastHumanOutbound,
  queryBackfillLastInbound,
  queryBackfillLastMessage,
} from "@/lib/firestore/backfill-conversation-list-fields";
import { normalizeContactNameSearch } from "@/lib/firestore/conversation-list-fields";
import {
  ADMIN_TABS,
  COMMERCIAL_TABS,
  TAB_TO_STATUSES,
} from "@/lib/firestore/conversation-list-tabs";
import { queryConversationListVersion } from "@/lib/firestore/conversation-list-version-query";
import {
  countConversations,
  getActiveConversationByContactId,
  getHandedOffConversationByContactId,
  getLatestConversationByContactId,
  listConversations,
  listConversationsByAssignee,
  type ListConversationsFilters,
} from "@/lib/firestore/conversations";

/** Probes volontairement improbables pour ne JAMAIS matcher un doc réel. */
export const PROBE_SLACK_USER_ID = "UPROBE0001ZZZZ";
export const PROBE_CAMPAIGN_ID = "zzz-probe-campaign-check-indexes";
export const PROBE_Q_RAW = "zzzprobename";
export const PROBE_Q = normalizeContactNameSearch(PROBE_Q_RAW);
export const PROBE_CONTACT_ID = "zzz_probe_contact_check_indexes";

export interface QueryForm {
  /** Label unique, lu par le test de couverture (anti-drift). */
  label: string;
  /** Catégorie — "list" | "list-cursor" | "counts" | "version" | "legacy" | "backfill" | "propagate". */
  category: "list" | "list-cursor" | "counts" | "version" | "legacy" | "backfill" | "propagate";
  /** Exécute la requête (lecture seule). Peut lever FAILED_PRECONDITION. */
  run: () => Promise<unknown>;
}

/**
 * Construit les filtres `ListConversationsFilters` pour une combinaison.
 * Pure, sans side effect.
 */
function buildFilters(tab: string, hasCampaign: boolean, hasQ: boolean): ListConversationsFilters {
  const filters: ListConversationsFilters = {};
  if (tab !== "toutes") {
    filters.statusIn = TAB_TO_STATUSES[tab as "a_traiter" | "en_cours" | "cloturees"];
  }
  if (hasCampaign) filters.campaignId = PROBE_CAMPAIGN_ID;
  if (hasQ) filters.contactNameSearch = PROBE_Q;
  return filters;
}

type RoleTabs = { role: "admin" | "commercial"; tabs: ReadonlyArray<string> };

const ROLES: ReadonlyArray<RoleTabs> = [
  { role: "admin", tabs: ADMIN_TABS },
  { role: "commercial", tabs: COMMERCIAL_TABS },
];

function listLabel(role: string, tab: string, hasCampaign: boolean, hasQ: boolean): string {
  return `list.${role}.${tab}${hasCampaign ? ".camp" : ""}${hasQ ? ".q" : ""}`;
}
function listCursorLabel(role: string, tab: string, hasCampaign: boolean, hasQ: boolean): string {
  return `list.${role}.${tab}${hasCampaign ? ".camp" : ""}${hasQ ? ".q" : ""}.cursor`;
}
function countsLabel(role: string, tab: string, hasCampaign: boolean, hasQ: boolean): string {
  return `counts.${role}.${tab}${hasCampaign ? ".camp" : ""}${hasQ ? ".q" : ""}`;
}
function versionLabel(role: string, tab: string): string {
  return `version.${role}.${tab}`;
}

function buildListForms(): QueryForm[] {
  const forms: QueryForm[] = [];
  for (const { role, tabs } of ROLES) {
    const assignedTo = role === "commercial" ? PROBE_SLACK_USER_ID : null;
    for (const tab of tabs) {
      for (const hasCampaign of [false, true] as const) {
        for (const hasQ of [false, true] as const) {
          const filters = buildFilters(tab, hasCampaign, hasQ);
          forms.push({
            label: listLabel(role, tab, hasCampaign, hasQ),
            category: "list",
            run: async () =>
              assignedTo !== null
                ? listConversationsByAssignee(assignedTo, { limit: 1, filters })
                : listConversations({ limit: 1, filters }),
          });
        }
      }
    }
  }
  return forms;
}

/**
 * Timestamp "distant futur" utilisé pour `startAfter(lastMessageAt)` : garantit
 * zéro résultat (`desc` → aucun doc ≥ 3000-01-01), mais Firestore DOIT quand
 * même exécuter le plan de requête → l'index est bien probé.
 */
const FUTURE_TIMESTAMP = Timestamp.fromDate(new Date("3000-01-01T00:00:00Z"));
/** Même principe pour `contactNameSearch asc` : chaîne au-delà de tout nom réel. */
const AFTER_ANY_NAME = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";

function buildListCursorForms(): QueryForm[] {
  const forms: QueryForm[] = [];
  for (const { role, tabs } of ROLES) {
    const assignedTo = role === "commercial" ? PROBE_SLACK_USER_ID : null;
    for (const tab of tabs) {
      for (const hasCampaign of [false, true] as const) {
        for (const hasQ of [false, true] as const) {
          const filters = buildFilters(tab, hasCampaign, hasQ);
          // `startAfterValues` DOIT matcher, dans l'ordre, les orderBy
          // appliqués par `buildListConversationsQuery` :
          //   - hors recherche : `[lastMessageAt]`
          //   - en recherche   : `[contactNameSearch, lastMessageAt]`
          const startAfterValues = hasQ ? [AFTER_ANY_NAME, FUTURE_TIMESTAMP] : [FUTURE_TIMESTAMP];
          forms.push({
            label: listCursorLabel(role, tab, hasCampaign, hasQ),
            category: "list-cursor",
            // `startAfter(values)` → aucune lecture préalable de doc,
            // zéro SKIP. L'index requis est strictement le même que la
            // variante sans cursor, mais on vérifie quand même que
            // Firestore accepte le `startAfter(...values)` sur le même
            // plan de requête (anti-régression si une évolution du query
            // builder cassait la combinaison).
            run: async () =>
              assignedTo !== null
                ? listConversationsByAssignee(assignedTo, { limit: 1, filters, startAfterValues })
                : listConversations({ limit: 1, filters, startAfterValues }),
          });
        }
      }
    }
  }
  return forms;
}

function buildCountForms(): QueryForm[] {
  const forms: QueryForm[] = [];
  for (const { role, tabs } of ROLES) {
    const assigneeFilter =
      role === "commercial"
        ? ({ kind: "specific", slackUserId: PROBE_SLACK_USER_ID } as const)
        : ({ kind: "none" } as const);
    for (const tab of tabs) {
      for (const hasCampaign of [false, true] as const) {
        for (const hasQ of [false, true] as const) {
          const filters = buildFilters(tab, hasCampaign, hasQ);
          forms.push({
            label: countsLabel(role, tab, hasCampaign, hasQ),
            category: "counts",
            run: () => countConversations({ filters, assigneeFilter }),
          });
        }
      }
    }
  }
  return forms;
}

function buildVersionForms(): QueryForm[] {
  const forms: QueryForm[] = [];
  for (const { role, tabs } of ROLES) {
    const assignedTo = role === "commercial" ? PROBE_SLACK_USER_ID : null;
    for (const tab of tabs) {
      const statuses =
        tab === "toutes"
          ? undefined
          : TAB_TO_STATUSES[tab as "a_traiter" | "en_cours" | "cloturees"];
      forms.push({
        label: versionLabel(role, tab),
        category: "version",
        run: () => queryConversationListVersion({ statusIn: statuses, assignedTo }),
      });
    }
  }
  return forms;
}

/**
 * Formes du backfill. Chaque forme appelle EXACTEMENT la même fonction
 * que `computeBackfillUpdatesForConversation` utilise au runtime —
 * jamais de requête recopiée à la main. Si le backfill change sa
 * query (ex: ajout d'un filtre), le script la verra automatiquement.
 */
function buildBackfillForms(): QueryForm[] {
  const probeConvId = `${PROBE_CONTACT_ID}_${PROBE_CAMPAIGN_ID}`;
  return [
    {
      label: "backfill.conversations.scan",
      category: "backfill",
      // Même ref que `backfill-conversation-list-fields.ts::backfillConversationsRef`.
      run: () => backfillConversationsRef(getAdminDb()).limit(1).get(),
    },
    {
      label: "backfill.contacts.lookup",
      category: "backfill",
      run: () => queryBackfillContact(getAdminDb(), PROBE_CONTACT_ID),
    },
    {
      label: "backfill.messages.last",
      category: "backfill",
      run: () => queryBackfillLastMessage(getAdminDb(), probeConvId),
    },
    {
      // Requiert composite `(direction, generatedBy, createdAt desc)` sur messages.
      label: "backfill.messages.last-human-outbound",
      category: "backfill",
      run: () => queryBackfillLastHumanOutbound(getAdminDb(), probeConvId),
    },
    {
      // PR2c tour 2b bloc C — Requiert composite `(direction, createdAt desc)`
      // sur messages (déjà déclaré dans `firestore.indexes.json` bloc 1).
      // Pose `conv.lastInboundAt` manquant quand on vient d'effacer les
      // champs de liste (ex: `reset-e2e-orphans.mjs`).
      label: "backfill.messages.last-inbound",
      category: "backfill",
      run: () => queryBackfillLastInbound(getAdminDb(), probeConvId),
    },
  ];
}

/**
 * Formes émises par `propagate-contact-denorm.ts`.
 */
function buildPropagateForms(): QueryForm[] {
  return [
    {
      // propagate-contact-denorm.ts:88 — `where("contactId","==",X)`.
      // Single-field auto, aucun composite requis.
      label: "propagate.by-contact-id",
      category: "propagate",
      run: () =>
        getAdminDb()
          .collection("conversations")
          .where("contactId", "==", PROBE_CONTACT_ID)
          .limit(1)
          .get(),
    },
  ];
}

function buildLegacyForms(): QueryForm[] {
  // Pré-existants PR0 : trois lookups par contact qui émettent des queries
  // `where("contactId","==",X).where("status","in",[...])`. L'index
  // composite `(contactId asc, status asc)` doit exister.
  // PR2c tour 2b bis — les formes legacy connaissent leur type (`Conversation
  // | null` ou `{conversationId, conversation} | null`). Elles le convertissent
  // ELLES-MÊMES en nombre avant de passer la main à `countFromResult`, qui
  // reste fail-closed strict sur tout objet inconnu. Avant ce fix, les POJO
  // tombaient dans un `return 1` arbitraire → régression masquée en prod
  // quand les lookups ne trouvaient rien.
  const toCount = (r: unknown): number => (r === null ? 0 : 1);
  return [
    {
      label: "legacy.getActiveConversationByContactId",
      category: "legacy",
      run: () => getActiveConversationByContactId(PROBE_CONTACT_ID).then(toCount),
    },
    {
      label: "legacy.getHandedOffConversationByContactId",
      category: "legacy",
      run: () => getHandedOffConversationByContactId(PROBE_CONTACT_ID).then(toCount),
    },
    {
      label: "legacy.getLatestConversationByContactId",
      category: "legacy",
      run: () => getLatestConversationByContactId(PROBE_CONTACT_ID).then(toCount),
    },
  ];
}

/** Catalogue complet (concat des 7 catégories). */
export const QUERY_FORMS: ReadonlyArray<QueryForm> = [
  ...buildListForms(),
  ...buildListCursorForms(),
  ...buildCountForms(),
  ...buildVersionForms(),
  ...buildLegacyForms(),
  ...buildBackfillForms(),
  ...buildPropagateForms(),
];
