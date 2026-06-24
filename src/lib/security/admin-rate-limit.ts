/**
 * Helper d'application du rate-limit pour les routes admin authentifiées
 * (S10.1.9 RATELIMIT-001).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rôle
 *
 *   Glue entre `createRateLimiter` (wrapper Upstash bas niveau) et les
 *   handlers `/api/admin/*`. Évite la duplication boilerplate (×4 routes)
 *   pour le pattern :
 *
 *     1. check()  → résultat structuré
 *     2. log warn (zéro PII) si bloqué
 *     3. 429 NextResponse + headers Retry-After + X-RateLimit-*
 *
 *   Pattern d'usage dans chaque handler :
 *
 *     const { userId } = await requireRole("admin");
 *     const rl = await applyAdminRateLimit(myLimiter, userId);
 *     if (rl) return rl;  // 429 → court-circuit, abandon du pipeline
 *     // ... reste du handler (parse body, fetch, etc.)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Décisions de design
 *
 *   - Clé = Clerk `userId` (pas IP). Justification : un admin Médéré peut
 *     être derrière un VPN ou un NAT d'entreprise → l'IP partagée ferait
 *     du faux positif entre admins. Le `userId` Clerk est stable, opaque,
 *     et identifie l'individu authentifié sans révéler de PII.
 *
 *   - Fail-closed par défaut (hérité du défaut du wrapper
 *     `createRateLimiter`). Si Upstash est indisponible, on bloque les
 *     admins plutôt que d'ouvrir une faille — cohérent avec la doctrine
 *     projet "sécurité > disponibilité" (CLAUDE.md §Sécurité). Le caller
 *     reste libre d'instancier son limiter avec `failureMode: "open"`
 *     pour les endpoints de pur confort UX.
 *
 *   - Headers HTTP 429 :
 *       - `Retry-After`        — secondes, plancher 1s (anti-amplification)
 *       - `X-RateLimit-Limit`  — quota total de la fenêtre
 *       - `X-RateLimit-Remaining` — slots restants (0 sur 429)
 *       - `X-RateLimit-Reset`  — unix ms du prochain reset
 *     Le frontend dashboard peut consommer ces headers pour afficher un
 *     countdown sans round-trip supplémentaire (pattern GitHub/Twitter).
 *
 *   - Body via `RateLimitError.toClientBody()` — cohérent avec toutes les
 *     autres erreurs typées du projet. Le timing reste dans le header
 *     `Retry-After` pour éviter la duplication body/header.
 *
 *   - Log `warn` avec `reason` + `userId` Clerk opaque. Permet de :
 *       1. Debug Upstash quand `reason === "rate_limiter_unavailable"`.
 *       2. Détecter un pattern suspect (admin spam → token compromis ?).
 *     Zéro PII loggée : `userId` est l'ID Clerk opaque, pas un email/nom.
 */
import { NextResponse } from "next/server";

import { RateLimitError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

import type { RateLimiter } from "./rate-limit";

/**
 * Applique le rate-limit pour une requête admin authentifiée.
 *
 * @param limiter  Instance retournée par `createRateLimiter()`.
 * @param userId   Clerk userId extrait de `requireRole("admin").userId`.
 * @param now      Référence temporelle (défaut `Date.now()`). Injection tests.
 *
 * @returns
 *   - `null`         si la requête est autorisée (le caller poursuit le handler).
 *   - `NextResponse` 429 prêt à renvoyer (le caller fait `return rl`).
 */
export async function applyAdminRateLimit(
  limiter: RateLimiter,
  userId: string,
  now: number = Date.now(),
): Promise<NextResponse | null> {
  const result = await limiter.check(userId);

  if (result.success) {
    return null;
  }

  // Retry-After en secondes, plancher 1s (anti-amplification). Si `resetAt`
  // est dans le passé immédiat (slot vient juste de se fermer + clock skew),
  // on n'invite pas le client à retry "maintenant" — il amplifierait la
  // charge sur l'instance Upstash en récupération.
  const retryAfterSeconds = Math.max(1, Math.ceil((result.resetAt - now) / 1000));

  logger.warn(
    {
      userId,
      reason: result.reason,
      limit: result.limit,
      remaining: result.remaining,
      retryAfterSeconds,
    },
    "[applyAdminRateLimit] admin request blocked",
  );

  const body = new RateLimitError({
    message: `applyAdminRateLimit: blocked (reason=${result.reason})`,
    context: { userId, reason: result.reason },
  }).toClientBody();

  return NextResponse.json(body, {
    status: 429,
    headers: {
      "Retry-After": String(retryAfterSeconds),
      "X-RateLimit-Limit": String(result.limit),
      "X-RateLimit-Remaining": String(result.remaining),
      "X-RateLimit-Reset": String(result.resetAt),
    },
  });
}
