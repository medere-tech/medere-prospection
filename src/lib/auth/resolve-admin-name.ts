/**
 * Résolution serveur d'un `Clerk userId` → nom affichable (prénom + nom)
 * pour l'historique UI (PR2c tour 2b bloc B — post security-reviewer).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi un helper partagé
 *
 *   Comme pour `resolveCommercialBySlackUserId` (Airtable, cache 5 min),
 *   l'UI « SMS orphelins » affiche l'auteur d'une action (`attachedBy`,
 *   `dismissedBy`) sous forme de nom humain, JAMAIS l'identifiant Clerk
 *   opaque. On centralise la résolution ici pour qu'un futur appel
 *   analogue (ex. historique d'une conversation) partage la même source.
 *
 *   Fallback : si l'id n'est pas retrouvable (compte supprimé, erreur
 *   API Clerk, format invalide) → `null`, le caller affiche
 *   « Admin inconnu ».
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Cache module-level (5 min)
 *
 *   Les admins sont peu nombreux (Déthié, Harry, Justine), et un même
 *   admin apparaît souvent plusieurs fois dans une seule page (plusieurs
 *   orphans qu'il a traités). Un cache court évite N requêtes Clerk par
 *   affichage de page.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Fail-closed
 *
 *   Tout throw de Clerk SDK est intercepté → `null` propre, pas de 500
 *   leaké. On loge en warn pour que le dev voie la cause (SDK HTTP, 404,
 *   quota) sans faire exploser le rendu de l'UI historique.
 */
import "server-only";

import { clerkClient } from "@clerk/nextjs/server";

import { logger } from "@/lib/utils/logger";

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedEntry {
  readonly name: string | null;
  readonly expiresAt: number;
}

const cache = new Map<string, CachedEntry>();

/** Normalise un prénom/nom. Vide → null. */
function normalizeName(input: {
  firstName: string | null | undefined;
  lastName: string | null | undefined;
}): string | null {
  const first = typeof input.firstName === "string" ? input.firstName.trim() : "";
  const last = typeof input.lastName === "string" ? input.lastName.trim() : "";
  const full = [first, last].filter((s) => s.length > 0).join(" ");
  return full.length > 0 ? full : null;
}

/**
 * Résout un `Clerk userId` → nom affichable. `null` si introuvable.
 *
 *   - Cache module-level TTL 5 min.
 *   - Fail-closed sur toute erreur Clerk (log warn, retour `null`).
 *   - Entrées `null` cachées aussi (évite de pilonner Clerk pour un id
 *     qui ne résout jamais).
 */
export async function resolveAdminName(userId: string): Promise<string | null> {
  if (typeof userId !== "string" || userId.length === 0) return null;
  const now = Date.now();
  const hit = cache.get(userId);
  if (hit !== undefined && hit.expiresAt > now) {
    return hit.name;
  }

  try {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    const name = normalizeName({ firstName: user.firstName, lastName: user.lastName });
    cache.set(userId, { name, expiresAt: now + CACHE_TTL_MS });
    return name;
  } catch (err) {
    logger.warn(
      {
        userIdPrefix: userId.slice(0, 8),
        errName: err instanceof Error ? err.name : "unknown",
      },
      "[resolveAdminName] clerk lookup failed",
    );
    // Cache le "null" pour pas spammer Clerk, mais TTL plus court.
    cache.set(userId, { name: null, expiresAt: now + 60 * 1000 });
    return null;
  }
}

/** Résout un batch dédupliqué. `Promise.all` + cache évite les N calls. */
export async function resolveAdminNamesBatch(
  userIds: readonly string[],
): Promise<Map<string, string | null>> {
  const unique = Array.from(new Set(userIds.filter((id) => id.length > 0)));
  const results = await Promise.all(unique.map((id) => resolveAdminName(id)));
  const map = new Map<string, string | null>();
  unique.forEach((id, i) => map.set(id, results[i] ?? null));
  return map;
}

/** @internal — test only. Réinitialise le cache module-level. */
export function __resetAdminNameCacheForTests(): void {
  cache.clear();
}
