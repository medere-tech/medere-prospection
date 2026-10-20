/**
 * Redirection permanente `/conversations/[id]` → `/admin/conversations/[id]`
 * (VUE-CONVERSATION PR1).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi cette route
 *
 *   Les notifications Slack émises par le pipeline hand-off / orphelins /
 *   inbound-on-handed-off portent un lien `/conversations/{convId}`
 *   construit par `src/lib/slack/dashboard-url.ts:getDashboardConversationUrl`.
 *   Ces liens sont déjà en circulation (threads Slack historiques). Pour
 *   préserver leur fonctionnement sans toucher au code Slack, cette route
 *   redirige en 308 (permanent) vers la vraie page sous `/admin/*`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi `permanentRedirect` (308) et pas `redirect` (307)
 *
 *   Décision Déthié : les clients SMS / Slack qui cachent le lien doivent
 *   pouvoir le résoudre une fois pour toutes vers la cible canonique
 *   (`/admin/conversations/[id]`). 308 préserve la méthode HTTP, 307
 *   aussi mais signale « temporaire » et empêche les clients d'optimiser
 *   le cache. 301 est HTTP/1.0 et change parfois la méthode (POST→GET),
 *   on l'évite. 308 est le standard moderne pour « permanent sans
 *   changement de méthode ».
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Route PUBLIQUE côté middleware (`src/middleware.ts:50-56` ne la liste
 * PAS mais ne la protège pas non plus — tombe dans le pass-through).
 *
 *   Conséquence voulue : si un utilisateur clique le lien Slack SANS être
 *   connecté à Clerk :
 *     1. `/conversations/[id]` → 308 → `/admin/conversations/[id]`
 *     2. Middleware voit `/admin/*` dans `isProtectedRoute` → `auth.protect()`
 *     3. Clerk redirige vers `/sign-in?redirect_url=/admin/conversations/[id]`
 *     4. Après sign-in réussi, Clerk ramène sur `/admin/conversations/[id]`
 *
 *   Le lien Slack fonctionne donc sans friction, avec ou sans session active.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Zéro appel Firestore
 *
 *   Cette route NE charge AUCUNE donnée. L'autorisation + le chargement
 *   sont faits par la cible `/admin/conversations/[id]`. Évite de leaker
 *   l'existence d'une conversation à un utilisateur non authentifié
 *   (défense anti-énumération, miroir du 404 opaque pour les API admin).
 */
import { permanentRedirect } from "next/navigation";

type RouteParams = { id: string };

export default async function ConversationRedirectPage({
  params,
}: {
  params: Promise<RouteParams>;
}): Promise<never> {
  const { id } = await params;
  permanentRedirect(`/admin/conversations/${encodeURIComponent(id)}`);
}
