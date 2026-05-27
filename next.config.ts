import type { NextConfig } from "next";

/**
 * Headers de sécurité — Médéré Prospection
 * =========================================
 * Politique : STRICTE par défaut sur tout ce qui ne dépend pas de tiers,
 * et raisonnablement PERMISSIVE sur la CSP (l'inventaire complet des
 * ressources tierces chargées côté navigateur n'est pas figé en MVP).
 *
 * Important : la CSP ne gouverne QUE les requêtes initiées par le NAVIGATEUR.
 * Les appels serveur (Anthropic, OVH, HubSpot, Lusha, Twilio, Slack...) partent
 * des API routes / Inngest et ne sont donc PAS listés ici.
 *
 * TODO (Phase 7 — hardening) :
 *  - Passer la CSP en nonce-based et retirer 'unsafe-inline' de script-src.
 *  - Retirer 'unsafe-eval' (présent uniquement en dev : React Refresh / Turbopack).
 *  - Figer le domaine Clerk de PRODUCTION (https://clerk.<domaine>) une fois connu.
 *  - Ajouter `preload` à HSTS après soumission au préload list.
 *  - Éventuelle CSP dédiée et plus stricte pour /api/* (réponses JSON).
 */

const isDev = process.env.NODE_ENV !== "production";

// --- Sources tierces connues (NAVIGATEUR uniquement) ---
const CLERK = "https://*.clerk.accounts.dev";
const CLERK_WS = "wss://*.clerk.accounts.dev";
const CLERK_IMG = "https://img.clerk.com";
const CLERK_TELEMETRY = "https://clerk-telemetry.com";
const CLOUDFLARE_TURNSTILE = "https://challenges.cloudflare.com"; // bot protection Clerk
const SENTRY = "https://*.sentry.io";
const SENTRY_INGEST =
  // Région EU (Allemagne) imposée pour conformité RGPD (données de PS).
  // `*.ingest.sentry.io` conservé en fallback documenté Sentry. Région US EXCLUE.
  "https://*.ingest.sentry.io https://*.ingest.de.sentry.io";
const VERCEL_LIVE = "https://vercel.live"; // commentaires preview Vercel
// NB : Vercel Analytics (va.vercel-scripts.com / vitals.vercel-insights.com)
// volontairement ABSENT — non activé sur ce projet. À rajouter si on l'active.

// En dev, Turbopack/HMR ouvre un WebSocket vers localhost : à autoriser
// explicitement (sinon le fast refresh casse + erreurs CSP console).
const DEV_HMR = isDev ? "ws://localhost:* wss://localhost:*" : "";

const csp = [
  `default-src 'self'`,
  // script-src : 'unsafe-inline' nécessaire tant que la CSP n'est pas nonce-based ;
  // 'unsafe-eval' UNIQUEMENT en dev.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} ${CLERK} ${CLOUDFLARE_TURNSTILE} ${VERCEL_LIVE}`,
  `style-src 'self' 'unsafe-inline'`,
  `img-src 'self' blob: data: ${CLERK_IMG} ${CLERK}`,
  `font-src 'self' data:`,
  // connect-src : XHR/fetch/WebSocket DEPUIS le navigateur (nos API = 'self',
  // Clerk frontend, Sentry browser SDK, Vercel, + HMR en dev).
  `connect-src 'self' ${DEV_HMR} ${CLERK} ${CLERK_WS} ${CLERK_TELEMETRY} ${SENTRY} ${SENTRY_INGEST} ${VERCEL_LIVE}`,
  `frame-src 'self' ${CLERK} ${CLOUDFLARE_TURNSTILE} ${VERCEL_LIVE}`,
  `worker-src 'self' blob:`,
  `object-src 'none'`,
  `base-uri 'self'`,
  `form-action 'self'`,
  `frame-ancestors 'none'`,
  // upgrade-insecure-requests casserait http://localhost en dev → prod uniquement.
  ...(isDev ? [] : [`upgrade-insecure-requests`]),
]
  .map((d) => d.replace(/\s+/g, " ").trim())
  .join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  // --- Headers stricts, immédiats (indépendants des tiers) ---
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=(), payment=()",
  },
  // HSTS : effectif uniquement en HTTPS (ignoré sur http://localhost).
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
