import type { NextConfig } from "next";

import { clerkFrontendApiFromPublishableKey } from "./src/lib/security/clerk-frontend-api";
import { buildCspDirectives } from "./src/lib/security/csp";

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
 * Domaine Clerk DÉRIVÉ de `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` à chaque build
 * (prod → `clerk.prospection.medere.fr`, dev → `<slug>.clerk.accounts.dev`).
 * Fail-closed : `clerkFrontendApiFromPublishableKey` throw si la clé manque
 * ou décode un host avec joker — jamais de `*.clerk.accounts.dev` de secours.
 *
 * TODO (Phase 7 — hardening) :
 *  - Passer la CSP en nonce-based et retirer 'unsafe-inline' de script-src.
 *  - Retirer 'unsafe-eval' (présent uniquement en dev : React Refresh / Turbopack).
 *  - Ajouter `preload` à HSTS après soumission au préload list.
 *  - Éventuelle CSP dédiée et plus stricte pour /api/* (réponses JSON).
 */

const isDev = process.env.NODE_ENV !== "production";

// Dérive l'hôte FAPI Clerk au BUILD. Throw ClerkFrontendApiError si la var
// est absente ou invalide → le build Next échoue immédiatement avec un
// message lisible, impossible de partir en prod avec une CSP wildcard.
const clerkFrontendApi = clerkFrontendApiFromPublishableKey(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
);

const csp = buildCspDirectives({ clerkFrontendApi, isDev }).join("; ");

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
  /**
   * PR1.14.2 — active les auth interrupts stabilisés depuis Next 15.1 :
   * `forbidden()` et `unauthorized()` depuis `next/navigation` + les
   * fichiers `forbidden.tsx` / `unauthorized.tsx` colocalisés.
   *
   * Utilisé par `src/app/admin/layout.tsx` : quand `requireRole` throw
   * ForbiddenError (role absent/invalide dans le JWT), on appelle
   * `forbidden()` qui déclenche le rendu de `src/app/admin/forbidden.tsx`
   * avec un vrai statut HTTP 403 (plutôt qu'une page 500 brute).
   *
   * Encore sous `experimental` en Next 16.2.x — stable fonctionnellement.
   * Référence : https://nextjs.org/docs/app/api-reference/config/next-config-js/authInterrupts
   */
  experimental: {
    authInterrupts: true,
  },
};

export default nextConfig;
