/**
 * Construction PURE de la Content Security Policy — extraite de
 * `next.config.ts` pour être testable.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Référence (sondée 2026-11-10) :
 *   https://clerk.com/docs/guides/secure/best-practices/csp-headers
 *
 * Directives EXIGÉES par Clerk :
 *   - script-src : « This value should include the host application's FAPI
 *                   hostname ». Il faut y ajouter `https://challenges.cloudflare.com`
 *                   et `https://*.protect.clerk.com`.
 *   - connect-src : FAPI hostname + `https://*.protect.clerk.com:*` (le
 *                   suffixe `:*` est obligatoire — abuse & fraud protection
 *                   servie hors 443).
 *   - img-src    : `https://img.clerk.com`.
 *   - worker-src : `'self'` + `blob:`.
 *   - style-src  : `'unsafe-inline'` (CSS-in-JS runtime).
 *   - frame-src  : `https://challenges.cloudflare.com` + `https://*.protect.clerk.com`.
 *
 * Non exigés par la doc mais conservés (anti-régression) :
 *   - connect-src : `https://clerk-telemetry.com` (présent dans la config
 *                   `default` de `clerkMiddleware()` ; retirer casserait la
 *                   télémétrie Clerk).
 *
 * Ce module est importé par `next.config.ts` ET par `csp.test.ts`. Pas de
 * `"use server"` ni `"server-only"` ici : la fonction est pure et doit
 * rester chargeable par le build Next.
 */

/**
 * Entrée de construction : tout ce que la CSP doit savoir du contexte.
 * Zéro I/O, zéro lecture de `process.env` dans ce module.
 */
export interface BuildCspInput {
  /** FAPI Clerk dérivé de la publishable key — ex. `clerk.prospection.medere.fr`. */
  clerkFrontendApi: string;
  /** `true` si `process.env.NODE_ENV !== "production"`. Active les relaxations dev. */
  isDev: boolean;
}

/** Hôte abuse & fraud protection Clerk (wildcard IMPOSÉ par la doc Clerk). */
const CLERK_PROTECT = "https://*.protect.clerk.com";
/** Même hôte avec ports libres — requis en connect-src par la doc Clerk. */
const CLERK_PROTECT_PORTS = "https://*.protect.clerk.com:*";
/** Hôte des avatars Clerk — directive img-src uniquement (doc Clerk). */
const CLERK_IMG = "https://img.clerk.com";
/**
 * Télémétrie Clerk — présente dans la config `default` de `clerkMiddleware()`.
 * Pas dans la liste "directives requises" mais retirer régresserait la
 * télémétrie dashboard.
 */
const CLERK_TELEMETRY = "https://clerk-telemetry.com";
const CLOUDFLARE_TURNSTILE = "https://challenges.cloudflare.com";
const SENTRY = "https://*.sentry.io";
const SENTRY_INGEST =
  // Région EU imposée pour conformité RGPD (données de PS). Us exclu.
  "https://*.ingest.sentry.io https://*.ingest.de.sentry.io";
const VERCEL_LIVE = "https://vercel.live";

/**
 * Retourne la liste des directives CSP pour l'env donné. Appelée par
 * `next.config.ts` qui join avec `"; "` et pose le header.
 */
export function buildCspDirectives(input: BuildCspInput): string[] {
  const { clerkFrontendApi, isDev } = input;
  const CLERK_FAPI_HTTPS = `https://${clerkFrontendApi}`;
  const CLERK_FAPI_WSS = `wss://${clerkFrontendApi}`;
  // Turbopack/HMR ouvre un WebSocket vers localhost en dev.
  const DEV_HMR = isDev ? "ws://localhost:* wss://localhost:*" : "";

  const directives = [
    `default-src 'self'`,
    // script-src : FAPI + Turnstile + protect.clerk.com (doc Clerk).
    // 'unsafe-inline' tant que la CSP n'est pas nonce-based ; 'unsafe-eval'
    // UNIQUEMENT en dev (React Refresh / Turbopack).
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} ${CLERK_FAPI_HTTPS} ${CLERK_PROTECT} ${CLOUDFLARE_TURNSTILE} ${VERCEL_LIVE}`,
    // style-src : 'unsafe-inline' exigé par Clerk (CSS-in-JS runtime).
    `style-src 'self' 'unsafe-inline'`,
    // img-src : img.clerk.com exigé par la doc. On garde aussi le FAPI (certains
    // assets Clerk sont servis sur le FAPI selon les versions).
    `img-src 'self' blob: data: ${CLERK_IMG} ${CLERK_FAPI_HTTPS}`,
    `font-src 'self' data:`,
    // connect-src : FAPI (XHR) + FAPI_WSS (sessions) + protect.clerk.com:*
    // (abuse/fraud, ports libres — doc Clerk) + Sentry + Vercel + HMR dev.
    `connect-src 'self' ${DEV_HMR} ${CLERK_FAPI_HTTPS} ${CLERK_FAPI_WSS} ${CLERK_PROTECT_PORTS} ${CLERK_TELEMETRY} ${SENTRY} ${SENTRY_INGEST} ${VERCEL_LIVE}`,
    // frame-src : FAPI + Turnstile + protect.clerk.com (doc Clerk).
    `frame-src 'self' ${CLERK_FAPI_HTTPS} ${CLERK_PROTECT} ${CLOUDFLARE_TURNSTILE} ${VERCEL_LIVE}`,
    `worker-src 'self' blob:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    ...(isDev ? [] : [`upgrade-insecure-requests`]),
  ];

  return directives.map((d) => d.replace(/\s+/g, " ").trim());
}
