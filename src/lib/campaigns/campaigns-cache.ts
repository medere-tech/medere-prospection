/**
 * Cache mémoire 5 min pour `listSmsLists("SMS")` — PR2b-2 round 3.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi
 *
 *   La page détail `/admin/conversations/[id]` doit résoudre le nom
 *   lisible de la campagne (`conv.campaignId` → "SMS Dentistes IDF") pour
 *   que le panneau "Détails" n'affiche jamais `hubspot-list-6081` brut.
 *   `conv.campaignName` dénormalisé Firestore n'est PAS garanti (le
 *   backfill PR2a ne l'a pas posé sur toutes les conversations existantes,
 *   dont la conversation A réelle du harnais E2E).
 *
 *   On ne veut PAS tirer HubSpot à chaque visite détail (coût latence +
 *   quota). On ne veut pas non plus toucher à `src/lib/hubspot/lists.ts`
 *   (hors scope). Solution : un cache module-scope 5 min aligné sur le
 *   cache Airtable `listCommerciauxForFilter` (`page.tsx:30`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Garanties
 *
 *   - 1 appel HubSpot max toutes les 5 min par instance serverless.
 *   - Promesse mémoïsée : requêtes concurrentes partagent le même call
 *     (évite le "thundering herd" au premier hit tiède).
 *   - En cas d'échec HubSpot : la promesse est stockée et son rejet
 *     propagé une seule fois ; le prochain appel après l'erreur
 *     retentera (TTL effacé lors du rejet).
 *   - Multi-process serverless : chaque instance Vercel a son propre
 *     cache. C'est acceptable (best-effort, pas une source de vérité).
 */

import { type HubspotListInfo, listSmsLists } from "@/lib/hubspot/lists";

const TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  readonly inflight: Promise<readonly HubspotListInfo[]>;
  readonly expiresAt: number;
}

let cache: CacheEntry | null = null;

export async function getCachedSmsCampaigns(): Promise<readonly HubspotListInfo[]> {
  const now = Date.now();
  if (cache !== null && cache.expiresAt > now) {
    return cache.inflight;
  }
  const inflight = listSmsLists("SMS");
  // On stocke la promesse AVANT résolution → les callers concurrents
  // réutilisent le même call. Si elle rejette, on invalide le cache pour
  // que le prochain caller retente.
  cache = { inflight, expiresAt: now + TTL_MS };
  inflight.catch(() => {
    if (cache?.inflight === inflight) cache = null;
  });
  return inflight;
}

/** Construit `listId → name` pour le passage à `campaignDisplayLabel`. */
export function campaignNameByListIdFrom(
  campaigns: readonly HubspotListInfo[],
): ReadonlyMap<string, string> {
  const m = new Map<string, string>();
  for (const c of campaigns) m.set(c.listId, c.name);
  return m;
}

/** Reset pour tests — isolation entre `describe`. */
export function __resetCampaignsCache_FOR_TESTS(): void {
  cache = null;
}
