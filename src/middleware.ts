/**
 * Middleware d'authentification Clerk — protège les routes admin et API admin.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Contrat
 *
 *   - Routes PROTÉGÉES (auth Clerk obligatoire) :
 *       /admin/*        → UI admin Next.js
 *       /api/admin/*    → routes API admin (futures S10.1.4+)
 *
 *   - Routes PUBLIQUES (no-auth, explicitement listées — fail-closed) :
 *       /               → redirect côté page.tsx (vers /sign-in ou /admin/contacts)
 *       /sign-in/*      → Clerk catch-all sign-in (S10.1.1)
 *       /api/inngest/*  → webhook signé HMAC par Inngest, NE PAS protéger Clerk
 *
 *   - Toute autre route non-listée → on laisse passer (les pages Next.js
 *     côté serveur sont responsables de leur propre check si elles sont
 *     sensibles). Les routes admin/* sont en plus protégées au niveau
 *     layout via `requireRole()` (défense en profondeur).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi `auth.protect()` et pas un redirect manuel
 *
 *   `auth.protect()` (Clerk v6+/v7) renvoie une `NextResponse` cohérente
 *   selon le type de requête :
 *     - page Next.js  → 302 redirect vers /sign-in (configuré côté Clerk)
 *     - route API    → 404 (volontairement opaque, anti-énumération)
 *   On laisse Clerk gérer le branchement — moins de surface bug.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Le matcher `config.matcher`
 *
 *   Pattern Clerk recommandé : on FAIT TOURNER le middleware sur quasi tout
 *   sauf les assets statiques `_next/` et les fichiers binaires. Cela
 *   permet à Clerk d'attacher le cookie session sur les pages publiques
 *   aussi (utile pour `auth()` côté server component `/`, qui décide
 *   redirect `/admin/contacts` si signed-in).
 */
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Routes EXPLICITEMENT publiques. Tout le reste est candidat à
 * `auth.protect()` si dans `isProtectedRoute`.
 *
 * 🚨 Chaque préfixe est posé DEUX fois : path exact + path/(.*). Le
 * pattern `/sign-in(.*)` matcherait aussi `/sign-input`, `/sign-in-typo`
 * etc. (le `(.*)` est gourmand sur n'importe quel caractère, pas juste
 * `/`). Couvert par `middleware.test.ts::sentinelle anti-typo`.
 */
const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in",
  "/sign-in/(.*)",
  "/api/inngest",
  "/api/inngest/(.*)",
]);

/**
 * Routes qui DOIVENT être authentifiées Clerk. Le check de rôle est fait
 * en plus dans les layouts/routes via `requireRole()` (défense en
 * profondeur — middleware fait juste le check session).
 *
 * 🚨 Même règle anti-typo que `isPublicRoute` : préfixe exact + sous-chemins
 * via `/(.*)`. Sinon `/admins` ou `/admin-public-typo` seraient capturés
 * par `/admin(.*)`, ce qui n'est pas du tout l'intention (et en plus
 * casserait l'usage de `auth.protect()` sur des routes qui n'existent
 * pas → 404 opaque mais inattendu pour l'admin qui debug).
 */
const isProtectedRoute = createRouteMatcher([
  "/admin",
  "/admin/(.*)",
  "/api/admin",
  "/api/admin/(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (isPublicRoute(req)) return;
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  /**
   * Matcher Clerk standard — on exclut les assets statiques Next.js et les
   * extensions de fichiers binaires/text statiques. On INCLUT `/api/*`
   * volontairement (pour que `/api/admin/*` soit protégé). `/api/inngest`
   * est ensuite court-circuité dans le handler via `isPublicRoute`.
   */
  matcher: [
    // Tout sauf : _next, fichiers statiques par extension
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Force le middleware sur les routes API (route handlers Next.js)
    "/(api|trpc)(.*)",
  ],
};
