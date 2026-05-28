/**
 * Wrapper rate-limit Upstash Redis (`@upstash/ratelimit` + `@upstash/redis`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Architecture
 *
 *   - `createRateLimiter(config, redis?)` : factory qui renvoie un objet
 *     `{ check(identifier) }`.
 *   - Lazy : la lecture de l'env Upstash (S2 `getUpstashEnv`) et la
 *     construction de `Ratelimit` se font au PREMIER appel à `check()`,
 *     jamais à l'import / à la création du limiteur.
 *   - Client `redis` injectable pour les tests (ou pour un wrapper custom
 *     de Redis si besoin).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Stratégie de panne (`failureMode`)
 *
 *   - 'closed' (DÉFAUT) : si Upstash répond mal ou est down, on REFUSE.
 *     C'est le mode obligatoire pour les webhooks publics (sécurité >
 *     disponibilité — un webhook bloqué temporairement n'est pas grave,
 *     OVH/Slack retry).
 *   - 'open' : si Upstash répond mal ou est down, on AUTORISE. Acceptable
 *     uniquement pour des endpoints internes de confort UX (ex: `/api/kpis`
 *     du dashboard commercial) où une panne Upstash ne doit pas casser
 *     l'expérience des commerciaux.
 *
 * Le wrapper N'EMET AUCUN LOG : le caller exploite le champ `reason` du
 * `RateLimitResult` pour logger ou répondre à l'appelant.
 */

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

import { getUpstashEnv } from "./env";

/**
 * Fenêtre de rate-limit, syntaxe Upstash : `"<nombre> <unité>"` avec unité
 * dans `s | m | h | d`. Ex: `"10 s"`, `"1 m"`, `"24 h"`.
 */
export type RateLimitWindow = `${number} ${"s" | "m" | "h" | "d"}`;

export interface RateLimiterConfig {
  /** Nombre d'actions autorisées dans la fenêtre. */
  limit: number;
  /** Durée de la fenêtre (sliding window). */
  window: RateLimitWindow;
  /** Préfixe des clés Redis (utile pour partager une base entre plusieurs limiteurs). */
  prefix: string;
  /**
   * Stratégie de panne en cas d'erreur Upstash. Défaut `"closed"`.
   *
   * @example
   * // Webhook public — TOUJOURS le défaut :
   * createRateLimiter({ limit: 10, window: "1 m", prefix: "ovh-webhook" });
   *
   * @example
   * // Endpoint interne de confort UX — fail-open acceptable :
   * createRateLimiter({
   *   limit: 30,
   *   window: "10 s",
   *   prefix: "kpis",
   *   failureMode: "open",
   * });
   */
  failureMode?: "closed" | "open";
}

/** Raison textuelle d'un résultat de `check()`, exploitable par le caller. */
export type RateLimitReason =
  | "allowed"
  | "rate_limited"
  | "rate_limiter_unavailable"
  | "rate_limiter_unavailable_failed_open";

export interface RateLimitResult {
  /** true = autorisé, false = bloqué (rate-limited OU panne fail-closed). */
  success: boolean;
  /** Limite configurée pour la fenêtre. */
  limit: number;
  /** Nombre de slots restants. */
  remaining: number;
  /** Unix ms du prochain reset de la fenêtre. */
  resetAt: number;
  /** Raison textuelle pour logs / réponses caller-side. */
  reason: RateLimitReason;
}

export interface RateLimiter {
  check(identifier: string): Promise<RateLimitResult>;
}

/**
 * Crée un rate limiter Upstash. Lazy : aucun I/O ni lecture d'env tant
 * qu'on n'appelle pas `check()`.
 *
 * @param config Limite + fenêtre + préfixe + (optionnel) `failureMode`.
 * @param redis  Client Upstash optionnel (injection tests / Redis custom).
 */
export function createRateLimiter(config: RateLimiterConfig, redis?: Redis): RateLimiter {
  const failureMode: "closed" | "open" = config.failureMode ?? "closed";

  // Memoize : construit `Ratelimit` UNE seule fois, au 1er `check()`.
  let limiter: Ratelimit | null = null;

  function getLimiter(): Ratelimit {
    if (limiter) return limiter;

    // Si pas de client injecté : lecture paresseuse de l'env Upstash.
    let client = redis;
    if (!client) {
      const env = getUpstashEnv();
      client = new Redis({
        url: env.UPSTASH_REDIS_REST_URL,
        token: env.UPSTASH_REDIS_REST_TOKEN,
      });
    }

    limiter = new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(config.limit, config.window),
      prefix: config.prefix,
    });
    return limiter;
  }

  return {
    async check(identifier: string): Promise<RateLimitResult> {
      try {
        const r = await getLimiter().limit(identifier);
        return {
          success: r.success,
          limit: r.limit,
          remaining: r.remaining,
          resetAt: r.reset,
          reason: r.success ? "allowed" : "rate_limited",
        };
      } catch {
        // Panne (Upstash down, init invalide, etc.). On NE THROW PAS :
        // le caller doit pouvoir logger et répondre proprement.
        if (failureMode === "open") {
          return {
            success: true,
            limit: config.limit,
            remaining: config.limit,
            // En fail-open success=true → resetAt n'a pas de signification métier
            // (le caller passe). On garde Date.now() comme placeholder.
            resetAt: Date.now(),
            reason: "rate_limiter_unavailable_failed_open",
          };
        }
        return {
          success: false,
          limit: config.limit,
          remaining: 0,
          // 60s de cooldown plutôt que Date.now() (=0 immédiat) : un caller
          // qui mapperait `resetAt` sur `Retry-After` ne dira pas "retry
          // maintenant" et n'amplifiera pas la panne (OVH/Slack retry).
          resetAt: Date.now() + 60_000,
          reason: "rate_limiter_unavailable",
        };
      }
    },
  };
}
