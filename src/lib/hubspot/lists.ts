/**
 * Liste des listes HubSpot SMS du portal Médéré (S10.1.2.b).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rôle métier
 *
 *   Le seed S10.1.3 et l'UI `/admin/contacts` S10.1.5 doivent énumérer
 *   les listes HubSpot dédiées campagnes SMS (nommées "SMS …" par
 *   convention Médéré : "SMS Dentistes IDF", "SMS Médecins PACA", etc.)
 *   pour proposer un dropdown campagne dynamique.
 *
 *   `campaignId` Firestore = `hubspot-list-${listId}` (cf. décision Q-G2
 *   S10.1.0).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ⚠️ Anti-régression S10.1.3-FIX-LISTS-DOSEARCH-001 (juin 2026)
 *
 *   Utilise `listsApi.doSearch` (POST /crm/v3/lists/search), PAS `getAll`.
 *   `getAll` est en fait "fetch lists BY ID" malgré son nom trompeur —
 *   sans `listIds[]`, il retourne `{lists: []}` (vérifié SDK source
 *   `node_modules/@hubspot/api-client/lib/codegen/crm/lists/apis/ListsApi.js`
 *   l.98-113 : `localVarPath = '/crm/v3/lists/'` + query `listIds` optionnels).
 *
 *   Toute modification doit conserver `doSearch` — verrouillé par test
 *   sentinelle `"appelle listsApi.doSearch et JAMAIS listsApi.getAll"`
 *   dans `lists.test.ts`.
 *
 *   Paramètres `doSearch` (cf. SDK `ListSearchRequest`) :
 *     - `query?: string`               — filter partial match côté API
 *     - `count?: number` (max 500)     — limit par page
 *     - `offset?: number`              — pagination cursor
 *     - `additionalProperties?: string[]` — récupère champs additionnels
 *                                          (ex: `["size"]` pour la taille)
 *
 *   Réponse `ListSearchResponse` :
 *     - `lists: PublicObjectListSearchResult[]`
 *     - `hasMore: boolean`             — pagination flag
 *     - `offset: number`               — offset courant
 *     - `total: number`                — total listes matchant
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Defense-in-depth filter (D1 S10.1.3-FIX-LISTS-DOSEARCH-001)
 *
 *   Couche 1 (API) : `query: searchQuery` poussée à HubSpot via doSearch —
 *                    réduit le payload, partial match natif côté serveur.
 *
 *   Couche 2 (code) : regex `new RegExp(escaped, "i")` ré-appliquée sur
 *                     les résultats. Si HubSpot a un bug serveur et
 *                     retourne une liste hors-match (vu en production
 *                     parfois sur d'autres APIs), le filter code-side la
 *                     rejette quand même.
 *
 *   Test dédié verrouille ce comportement.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Sécurité & robustesse
 *
 *   - Aucune PII dans la sortie : les noms de listes sont des labels
 *     business (pas de données PS).
 *   - Erreur SDK (token expiré, 401/403/5xx) → `ExternalServiceError`
 *     retry-friendly (sans `err.message` brut — peut contenir le token
 *     dans certains scénarios SDK).
 *   - Garde-fou anti-boucle infinie : `HUBSPOT_LISTS_MAX_PAGES` (200).
 *   - Log warn si > 200 listes matchent (signal portail mal organisé).
 *   - Anti-ReDoS sur le regex code-side : `escapeRegexMetachars` traite
 *     `searchQuery` comme litéral.
 */

import { ExternalServiceError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

import { getHubspotClient } from "./client";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Search query par défaut. La convention Médéré préfixe les listes SMS
 * par "SMS …" — on filtre dessus pour ne pas pollutionner le dropdown
 * UI avec les listes email marketing, leads, etc.
 *
 * 🔒 SENTINEL — modification = re-validation Déthié (changement de
 * convention de nommage HubSpot).
 */
export const DEFAULT_SMS_LIST_SEARCH_QUERY = "SMS";

/**
 * Taille de page demandée à `doSearch` (`count`). HubSpot v3 limite à
 * 500 par page selon doc API. On utilise le max pour minimiser le
 * nombre d'appels (MVP : 1 page suffit pour < 500 listes au portail).
 *
 * 🔒 SENTINEL — verrouillé par test sentinelle.
 */
export const HUBSPOT_LISTS_PAGE_SIZE = 500;

/**
 * Garde-fou anti-boucle infinie. Si `hasMore === true` persiste au-delà
 * de N itérations (= 200 × 500 = 100 000 listes — délirant), on throw
 * `ExternalServiceError` pour éviter un script qui boucle à vide.
 *
 * 🔒 SENTINEL — verrouillé par test sentinelle.
 */
export const HUBSPOT_LISTS_MAX_PAGES = 200;

/**
 * Seuil au-dessus duquel on log un warn (sans filtrer côté code) — signal
 * d'un portail mal organisé OU d'un searchQuery trop large.
 */
const LIST_COUNT_WARN_THRESHOLD = 200;

// ─────────────────────────────────────────────────────────────────────────────
// Types publiques (minimalistes — surface UI dropdown)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sous-ensemble des champs d'une `PublicObjectListSearchResult` SDK qu'on
 * expose au caller. On ne propage PAS `filterBranch`, `membershipSettings`,
 * `listPermissions`, etc. (complexes, pas utiles UI MVP).
 */
export interface HubspotListInfo {
  /** ID Firestore-safe (`hubspot-list-${listId}` côté caller). */
  listId: string;
  /** Nom UI affiché dans le dropdown. */
  name: string;
  /** Nombre de contacts dans la liste (peut être undefined si HubSpot ne renvoie pas). */
  size: number | undefined;
  /** Type de liste HubSpot (`MANUAL`, `DYNAMIC`, etc.) — info diag. */
  processingType: string;
  /** ISO date string de création — `Date.toISOString()` ou `undefined`. */
  createdAt: string | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shape attendue du retour SDK (typage défensif — SDK retourne `unknown`)
// ─────────────────────────────────────────────────────────────────────────────

interface RawPublicObjectListSearchResult {
  listId: string;
  name: string;
  processingType: string;
  createdAt?: Date | string;
  /** Champ enrichi via `additionalProperties: ["size"]` — string côté API. */
  additionalProperties?: Record<string, string>;
}

interface RawListSearchResponse {
  lists: RawPublicObjectListSearchResult[];
  hasMore: boolean;
  offset: number;
  total: number;
}

/**
 * Type guard tolérant pour `ListSearchResponse`. Vérifie que le retour
 * SDK a bien la forme `{ lists: Array<{listId, name, processingType, ...}>,
 * hasMore: boolean, offset: number, total: number }`.
 *
 * Un retour mal formé (SDK breaking change, anomalie HubSpot) throw
 * `ExternalServiceError` côté caller — pas de crash silencieux.
 */
function isListSearchResponse(raw: unknown): raw is RawListSearchResponse {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as {
    lists?: unknown;
    hasMore?: unknown;
    offset?: unknown;
    total?: unknown;
  };
  if (!Array.isArray(r.lists)) return false;
  if (typeof r.hasMore !== "boolean") return false;
  if (typeof r.offset !== "number") return false;
  if (typeof r.total !== "number") return false;
  return r.lists.every((item) => {
    if (typeof item !== "object" || item === null) return false;
    const l = item as Record<string, unknown>;
    return (
      typeof l.listId === "string" &&
      typeof l.name === "string" &&
      typeof l.processingType === "string"
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// listSmsLists
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Liste les listes HubSpot du portal Médéré dont le nom match le
 * `searchQuery` (couche 1 : `query` API HubSpot + couche 2 : regex code).
 *
 * @param searchQuery  Pattern à matcher contre `list.name`. Default `"SMS"`.
 *                     Passer `""` pour récupérer TOUTES les listes.
 *
 * @returns Tableau de `HubspotListInfo[]`. Peut être vide si aucune
 *          liste ne match. Pas d'erreur si vide.
 *
 * @throws ExternalServiceError si l'appel SDK échoue (401, 5xx, network)
 *                              OU si le retour est mal formé OU si la
 *                              pagination boucle au-delà de `HUBSPOT_LISTS_MAX_PAGES`.
 *
 * @example
 *   const lists = await listSmsLists();
 *   // → [{ listId: "1234", name: "SMS Dentistes IDF", size: 200, ... }]
 *
 *   const all2026 = await listSmsLists("2026");
 *   // → toutes les listes dont le nom contient "2026"
 */
export async function listSmsLists(
  searchQuery: string = DEFAULT_SMS_LIST_SEARCH_QUERY,
): Promise<HubspotListInfo[]> {
  const client = getHubspotClient();

  const collected: RawPublicObjectListSearchResult[] = [];
  let offset = 0;
  let pageCount = 0;
  let hasMore = true;

  while (hasMore) {
    pageCount++;
    if (pageCount > HUBSPOT_LISTS_MAX_PAGES) {
      throw new ExternalServiceError({
        message: "listSmsLists: pagination exceeded HUBSPOT_LISTS_MAX_PAGES (infinite loop guard)",
        context: {
          service: "hubspot",
          op: "listSmsLists.pagination",
          maxPages: HUBSPOT_LISTS_MAX_PAGES,
        },
      });
    }

    let raw: unknown;
    try {
      raw = await client.crm.lists.listsApi.doSearch({
        // Couche 1 : filter API HubSpot (réduit payload).
        query: searchQuery,
        count: HUBSPOT_LISTS_PAGE_SIZE,
        offset,
        // D2 : récupère le size de chaque liste via additionalProperties.
        additionalProperties: ["size"],
      });
    } catch {
      // SDK throw sur 401, 5xx, network. On wrap en ExternalServiceError
      // retry-friendly SANS attacher `cause: err` (S10.1.3-FIX-LISTS-
      // DOSEARCH-001 security F1) : le SDK HubSpot peut embarquer le
      // token Bearer dans `err.message`, et si un caller logue
      // `logger.error({ err: ext })` (sérialiseur Pino par défaut), la
      // chaîne `err.cause.message` est sérialisée et fuit le token.
      // Forensic via context op/offset/pageCount + Sentry côté serveur.
      throw new ExternalServiceError({
        message: "listSmsLists: HubSpot listsApi.doSearch failed",
        context: {
          service: "hubspot",
          op: "listSmsLists.doSearch",
          offset,
          pageCount,
        },
      });
    }

    if (!isListSearchResponse(raw)) {
      throw new ExternalServiceError({
        message: "listSmsLists: HubSpot returned malformed search response",
        context: {
          service: "hubspot",
          op: "listSmsLists.parse",
          offset,
          pageCount,
        },
      });
    }

    collected.push(...raw.lists);
    hasMore = raw.hasMore;
    offset += raw.lists.length;
  }

  // Couche 2 : defense-in-depth filter regex code-side. Échappement des
  // metacaracteres regex pour traiter `searchQuery` comme litéral
  // (anti-ReDoS si caller future-injecte une regex catastrophique).
  const escapedQuery = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const filter = new RegExp(escapedQuery, "i");

  const matched = collected.filter((l) => filter.test(l.name));

  if (matched.length > LIST_COUNT_WARN_THRESHOLD) {
    logger.warn(
      {
        service: "hubspot",
        op: "listSmsLists",
        matched: matched.length,
        // Pas de noms de listes dans le log (label business mais
        // payload potentiellement long).
      },
      `[listSmsLists] ${matched.length} lists matched — searchQuery trop large ?`,
    );
  }

  // Normalisation finale : `size` depuis additionalProperties (string → number),
  // `createdAt` Date → ISO string.
  return matched.map((l) => {
    const sizeRaw = l.additionalProperties?.size;
    const size =
      sizeRaw === undefined || sizeRaw === null || sizeRaw === "" ? undefined : Number(sizeRaw);
    return {
      listId: l.listId,
      name: l.name,
      size: size !== undefined && Number.isFinite(size) ? size : undefined,
      processingType: l.processingType,
      createdAt:
        l.createdAt === undefined
          ? undefined
          : l.createdAt instanceof Date
            ? l.createdAt.toISOString()
            : String(l.createdAt),
    };
  });
}
