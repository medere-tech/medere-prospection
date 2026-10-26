/**
 * Helper central pour les identifiants de campagne — PR2b-2 round 2.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Deux formats coexistent dans la base de code :
 *
 *   - **canonique Firestore + URL** : `hubspot-list-${listId}` (ex.
 *     `"hubspot-list-6081"`). C'est ce que porte `conversation.campaignId`
 *     en base, et ce que les URL `?campaignId=` du dashboard transportent.
 *     Décision Q-G2 (`src/lib/hubspot/lists.ts:12`) et mapper HubSpot
 *     (`src/lib/hubspot/mapper.ts:114`).
 *
 *   - **court HubSpot** : `listId` seul (ex. `"6081"`). C'est ce que
 *     l'API HubSpot v3 renvoie et ce qu'on expose en `HubspotListInfo.listId`
 *     (`src/lib/hubspot/lists.ts:122`).
 *
 * Toute résolution « id → nom de campagne » doit passer par ces 3 fonctions
 * pour que le code soit robuste si quelqu'un modifie l'un ou l'autre
 * format isolément. Sinon : une campagne qui EXISTE s'affiche
 * "Campagne inconnue" (défaut PR2b-2 round 1 identifié par Déthié).
 *
 * Zéro dépendance React — module pur, testable sans jsdom.
 */

export const CAMPAIGN_ID_PREFIX = "hubspot-list-";

/** Format canonique strict : `hubspot-list-${chiffres}`. */
export const CAMPAIGN_ID_PATTERN = /^hubspot-list-(\d+)$/;

/** Format court strict : uniquement des chiffres. */
export const LIST_ID_PATTERN = /^\d+$/;

/**
 * Normalise une entrée (format court OU canonique) vers l'id canonique
 * Firestore `hubspot-list-${listId}`. Retourne `null` si l'entrée n'est
 * d'aucun format reconnu (jamais le `input` tel quel — pas de leak).
 */
export function toCanonicalCampaignId(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (CAMPAIGN_ID_PATTERN.test(trimmed)) return trimmed;
  if (LIST_ID_PATTERN.test(trimmed)) return `${CAMPAIGN_ID_PREFIX}${trimmed}`;
  return null;
}

/**
 * Extrait le `listId` HubSpot court (ex. `"6081"`) depuis l'un ou l'autre
 * format. Retourne `null` si l'entrée n'est pas reconnue.
 */
export function extractListId(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const m = trimmed.match(CAMPAIGN_ID_PATTERN);
  if (m) return m[1] ?? null;
  if (LIST_ID_PATTERN.test(trimmed)) return trimmed;
  return null;
}

/**
 * Résout un nom de campagne lisible à partir d'un id de n'importe quel
 * format et d'une map `listId → name` (format court en clé).
 *
 *   - Entrée reconnue + listId trouvé dans la map → `name`.
 *   - Entrée reconnue + listId non trouvé → `null` (campagne vraiment
 *     absente de HubSpot : le caller affichera "Campagne inconnue").
 *   - Entrée non reconnue (format invalide) → `null`.
 *
 * ⚠️ Ne retourne JAMAIS l'id brut : les call sites doivent gérer `null`
 * via un libellé humain ("Campagne inconnue").
 */
export function resolveCampaignName(
  campaignId: string | null | undefined,
  nameByListId: ReadonlyMap<string, string>,
): string | null {
  const listId = extractListId(campaignId);
  if (listId === null) return null;
  return nameByListId.get(listId) ?? null;
}

/**
 * Libellé final à afficher dans la ligne / carte mobile — un seul endroit
 * du code porte le fallback "Campagne inconnue" (pas de divergence entre
 * desktop et mobile).
 *
 *   - Priorité à la copie dénormalisée `campaignName` quand l'API l'a renvoyée.
 *   - Sinon résolution via la map HubSpot (tous formats de `campaignId`).
 *   - Sinon libellé explicite "Campagne inconnue". Jamais d'id brut.
 */
export const CAMPAIGN_UNKNOWN_LABEL = "Campagne inconnue";

export function campaignDisplayLabel(
  campaignId: string | null | undefined,
  denormalizedName: string | null | undefined,
  nameByListId: ReadonlyMap<string, string>,
): string {
  if (typeof denormalizedName === "string" && denormalizedName.trim().length > 0) {
    return denormalizedName;
  }
  return resolveCampaignName(campaignId, nameByListId) ?? CAMPAIGN_UNKNOWN_LABEL;
}
