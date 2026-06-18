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
 *   Plutôt que de hard-coder une liste de campagnes, on interroge HubSpot
 *   à chaque besoin (rare — l'UI cache) et on filtre par nom via regex
 *   insensible à la casse.
 *
 *   `campaignId` Firestore = `hubspot-list-${listId}` (cf. décision Q-G2
 *   S10.1.0).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi pas `listsApi.getByName(searchQuery, objectTypeId)` ?
 *
 *   `getByName` veut un nom EXACT + un `objectTypeId`. Pas de partial
 *   match. Pour "toutes les listes dont le nom contient 'SMS'", on doit
 *   passer par `getAll()` + filter côté code.
 *
 *   Coût : un portal Médéré a typiquement < 100 listes. Le payload
 *   est léger (< 50 KB). Pas d'optimisation prématurée.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Sécurité & robustesse
 *
 *   - Aucune PII dans la sortie : les noms de listes sont des labels
 *     business (pas de données PS).
 *   - Erreur SDK (token expiré, 401/403/5xx) → `ExternalServiceError`
 *     retry-friendly (Inngest function S10.1.3 catch et retry).
 *   - Log warn si > 200 listes retournées (signal de portal mal organisé
 *     OU caller qui devrait paginer côté UI).
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
 * Seuil au-dessus duquel on log un warn (sans filtrer côté code) — signal
 * d'un portal mal organisé OU d'un searchQuery trop large.
 */
const LIST_COUNT_WARN_THRESHOLD = 200;

// ─────────────────────────────────────────────────────────────────────────────
// Types publiques (minimalistes — surface UI dropdown)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sous-ensemble des champs d'une `PublicObjectList` SDK qu'on expose au
 * caller. On ne propage PAS `filterBranch`, `membershipSettings`,
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

interface RawPublicObjectList {
  listId: string;
  name: string;
  size?: number;
  processingType: string;
  createdAt?: Date | string;
}

interface RawListsByIdResponse {
  lists: RawPublicObjectList[];
}

/**
 * Type guard tolérant — vérifie que le retour SDK a bien la forme
 * `{ lists: Array<{listId, name, processingType, size?, createdAt?}> }`.
 * Un retour mal formé (SDK breaking change, anomalie HubSpot) throw
 * `ExternalServiceError` côté caller — pas de crash silencieux.
 */
function isListsResponse(raw: unknown): raw is RawListsByIdResponse {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as { lists?: unknown };
  if (!Array.isArray(r.lists)) return false;
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
 * `searchQuery` (regex insensible à la casse).
 *
 * @param searchQuery  Pattern regex à matcher contre `list.name`.
 *                     Default `"SMS"` (convention nommage Médéré).
 *                     Passer `""` pour récupérer TOUTES les listes.
 *
 * @returns Tableau de `HubspotListInfo[]`. Peut être vide si aucune
 *          liste ne match. Pas d'erreur si vide.
 *
 * @throws ExternalServiceError si l'appel SDK échoue (401, 5xx, network)
 *                              ou si le retour est mal formé.
 *
 * ⚠️ Concurrence : pas thread-safe (le SDK Bottleneck l'est, mais notre
 * wrapper ne mémoïse pas le résultat — chaque appel hit l'API HubSpot).
 * Caller (UI dropdown S10.1.5) doit cacher côté React Query.
 *
 * @example
 *   // Dropdown campagne MVP
 *   const lists = await listSmsLists();
 *   // → [{ listId: "1234", name: "SMS Dentistes IDF", size: 200, ... }]
 *
 *   // Recherche custom
 *   const all2026 = await listSmsLists("2026");
 *   // → toutes les listes dont le nom contient "2026" (case-insensitive)
 */
export async function listSmsLists(
  searchQuery: string = DEFAULT_SMS_LIST_SEARCH_QUERY,
): Promise<HubspotListInfo[]> {
  const client = getHubspotClient();

  let raw: unknown;
  try {
    raw = await client.crm.lists.listsApi.getAll();
  } catch (err) {
    // SDK throw sur 401, 5xx, network. On wrap en ExternalServiceError
    // retry-friendly (sans inclure `err.message` brut — peut contenir
    // le token dans certains scénarios SDK).
    throw new ExternalServiceError({
      message: "listSmsLists: HubSpot listsApi.getAll failed",
      context: {
        service: "hubspot",
        op: "listSmsLists.getAll",
      },
      cause: err,
    });
  }

  if (!isListsResponse(raw)) {
    throw new ExternalServiceError({
      message: "listSmsLists: HubSpot returned malformed lists response",
      context: {
        service: "hubspot",
        op: "listSmsLists.parse",
      },
    });
  }

  // Filtre regex insensible à la casse. Échappement des metacaracteres
  // regex pour traiter `searchQuery` comme litéral (anti-ReDoS si caller
  // future-injecte une regex catastrophique).
  const escapedQuery = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const filter = new RegExp(escapedQuery, "i");

  const matched = raw.lists.filter((l) => filter.test(l.name));

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

  // Normalisation : Date → ISO string, size undefined si manquant.
  return matched.map((l) => ({
    listId: l.listId,
    name: l.name,
    size: l.size,
    processingType: l.processingType,
    createdAt:
      l.createdAt === undefined
        ? undefined
        : l.createdAt instanceof Date
          ? l.createdAt.toISOString()
          : String(l.createdAt),
  }));
}
