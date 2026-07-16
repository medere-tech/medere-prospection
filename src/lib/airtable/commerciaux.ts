/**
 * Résolution `hubspot_owner_id` → commercial Slack via Airtable Commerciaux
 * (S9.9-PR2).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rôle métier
 *
 *   Chaque lead HubSpot qualifié INTERESSE a un `hubspot_owner_id`. La
 *   table Airtable Commerciaux est la source de vérité qui mappe ce
 *   propriétaire vers son Slack user id + son état (actif/inactif) pour
 *   permettre au module hand-off (PR5) de router :
 *     - `active=true`  → DM Slack au commercial
 *     - `active=false` → fallback canal orphelins
 *     - `null` (owner absent OU sans slack_user_id) → fallback canal orphelins
 *
 *   ⚠️ Le module RAPPORTE l'état, il ne DÉCIDE PAS du routage. C'est le
 *   caller (hand-off PR5) qui interprète `active=false` ou `null` pour
 *   basculer vers orphelins. On ne veut PAS coupler le lookup au routage
 *   (testabilité + réutilisation dans un dashboard admin futur).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Cache module-level (TTL 5 min)
 *
 *   La table Commerciaux évolue rarement (~18 lignes, changement humain
 *   quand un AE arrive/part). On cache toute la table en mémoire pour
 *   éviter de payer un round-trip Airtable à chaque hand-off.
 *
 *   - Cache miss OU expiré → re-fetch complet via `client.ts`, remplace
 *     atomiquement la Map + `expiresAt`.
 *   - Cache hit → lookup O(1) dans la Map en mémoire.
 *   - Pas de dedup in-flight : si 2 hand-offs tombent en même temps sur un
 *     cache expiré, on paie 2 fetch. Acceptable (fréquence rare, fetch
 *     rapide < 500ms pour 18 lignes).
 *   - Erreur Airtable (après retries client) → propage au caller (module
 *     hand-off), qui décidera du fallback orphelins. Le cache expiré N'EST
 *     PAS écrasé par une erreur — un cache "stale" reste préférable à
 *     retourner `null` faussement si Airtable est down 30s.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Normalisation (piège cross-format)
 *
 *   - `hubspot_owner_id` HubSpot = numérique (ex `"477507801"`).
 *   - Airtable peut retourner le champ en String OU Number selon comment
 *     il a été saisi (formule vs texte).
 *   → Normalisation systématique via `String(v).trim()` des DEUX côtés
 *     avant comparaison / mise en Map.
 *
 *   - `slack_user_id` peut arriver en `string` OU en `[string]` (Airtable
 *     linked-record ou multi-select) → helper `firstOrString`.
 */

import { getAirtableEnv } from "@/lib/security/env";
import { logger } from "@/lib/utils/logger";

import { type AirtableRecord, fetchAirtableRecords } from "./client";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

/** TTL cache table Commerciaux : 5 min. Change rare (~mensuel). */
const CACHE_TTL_MS = 5 * 60 * 1_000;

/**
 * Champs Airtable strictement nécessaires au lookup owner → commercial.
 * Data minimization : on ne demande ni email ni phone (non utilisés).
 *
 * 🔒 SENTINEL — modification = re-validation impact Airtable schema.
 */
const COMMERCIAUX_FIELDS = ["hubspot_id", "slack_user_id", "Statut", "hubspot_name"] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Commercial {
  /** Slack user id (`U...`) — jamais vide si l'objet est retourné. */
  slackUserId: string;
  /** Nom lisible pour affichage (log, dashboard) — best-effort. */
  name: string;
  /**
   * `true` si `Statut === "Actif"` (case-insensitive après trim). Le
   * caller décide du routage (DM si true, orphelins si false).
   */
  active: boolean;
}

interface CacheEntry {
  data: Map<string, Commercial>;
  expiresAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de normalisation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extrait une string d'un champ Airtable qui peut arriver en string ou
 * en array de string (linked-record / multi-select). Retourne `undefined`
 * si le champ est vide, null, un array vide, ou tout autre type.
 *
 * Ne fait PAS de trim ici — la responsabilité de trim revient au caller
 * (qui peut vouloir la valeur brute pour un log de debug).
 */
export function firstOrString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

/** Normalise un id (String → trim) pour comparaison cross-format. */
function normalizeId(value: unknown): string {
  return String(value ?? "").trim();
}

/** `"Actif"` (toutes casses/variantes) → true. Sinon false. */
function parseActive(statut: unknown): boolean {
  const s = String(statut ?? "").trim();
  return /^actif$/i.test(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// Build de la Map à partir des records Airtable
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Construit `Map<hubspotOwnerId, Commercial>` à partir des records bruts.
 * Ignore silencieusement les lignes sans `hubspot_id` exploitable (line
 * de saisie incomplète) — un log warn tracé pour visibilité opérationnelle.
 *
 * Ne filtre PAS sur `slack_user_id` ici : une ligne sans Slack ID est
 * quand même mappée (mais `resolveCommercialByOwnerId` la traitera comme
 * `null` — cf. contrat retour de la fonction).
 */
function buildCommerciauxMap(records: AirtableRecord[]): Map<string, Commercial> {
  const map = new Map<string, Commercial>();
  let skippedNoId = 0;

  for (const record of records) {
    const hubspotIdRaw = record.fields["hubspot_id"];
    const hubspotId = normalizeId(hubspotIdRaw);
    if (hubspotId === "") {
      skippedNoId++;
      continue;
    }

    const slackUserId = (firstOrString(record.fields["slack_user_id"]) ?? "").trim();
    const name = (firstOrString(record.fields["hubspot_name"]) ?? "").trim();
    const active = parseActive(record.fields["Statut"]);

    map.set(hubspotId, { slackUserId, name, active });
  }

  if (skippedNoId > 0) {
    logger.warn(
      { service: "airtable", skippedNoId, totalRecords: records.length },
      "Airtable Commerciaux: lines skipped (no hubspot_id)",
    );
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache module-level
// ─────────────────────────────────────────────────────────────────────────────

let cache: CacheEntry | null = null;

async function loadCommerciaux(): Promise<Map<string, Commercial>> {
  const env = getAirtableEnv();
  const records = await fetchAirtableRecords(env.AIRTABLE_COMMERCIAUX_TABLE_ID, COMMERCIAUX_FIELDS);
  const data = buildCommerciauxMap(records);
  cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
  return data;
}

async function getCommerciauxMap(): Promise<Map<string, Commercial>> {
  if (cache !== null && Date.now() < cache.expiresAt) {
    return cache.data;
  }
  return loadCommerciaux();
}

// ─────────────────────────────────────────────────────────────────────────────
// API publique
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Résout un `hubspot_owner_id` en `Commercial | null`.
 *
 * Retourne `null` si :
 *   - `ownerId` normalisé est vide, OU
 *   - `ownerId` absent de la table Airtable Commerciaux, OU
 *   - la ligne existe mais `slack_user_id` est vide (impossible à DM).
 *
 * Retourne `{ slackUserId, name, active }` (avec `active` reflétant le
 * Statut Airtable) si la ligne existe ET a un `slack_user_id`. C'est au
 * caller (module hand-off PR5) de décider ce qu'il fait de `active=false`
 * (aujourd'hui : fallback canal orphelins).
 *
 * Propage `ExternalServiceError` du client si Airtable est down (après
 * retries) ou `ConfigError` si les vars Airtable manquent. Le caller est
 * responsable du fallback orphelins dans ce cas.
 */
export async function resolveCommercialByOwnerId(ownerId: string): Promise<Commercial | null> {
  const normalized = normalizeId(ownerId);
  if (normalized === "") return null;

  const map = await getCommerciauxMap();
  const commercial = map.get(normalized);
  if (commercial === undefined) return null;
  if (commercial.slackUserId === "") return null;
  return commercial;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test hook
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Test-only : vide le cache module-level. Garde runtime `NODE_ENV === "test"`
 * — un caller prod qui invaliderait le cache par erreur paierait un
 * round-trip Airtable non désiré. Pattern cohérent avec les autres
 * back-doors du repo (`__setOvhClientForTests`, etc.).
 */
export function clearCommerciauxCache(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("clearCommerciauxCache called outside of tests");
  }
  cache = null;
}
