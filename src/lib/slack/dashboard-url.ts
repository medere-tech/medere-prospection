/**
 * Construit l'URL dashboard d'une conversation
 * (`${base}/conversations/${conversationId}`) — helper partagé des
 * notifications Slack (hand-off initial + relais post-handed_off PR-A).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rôle
 *
 *   Deux pipelines Slack construisent exactement la même URL dashboard
 *   pour pointer un commercial vers une conversation :
 *
 *     1. `slack-handoff` (S9.9-PR5b) — notification initiale INTERESSE.
 *     2. `notify-inbound-after-handoff` (PR-A) — relais d'un SMS entrant
 *        arrivé APRÈS la reprise humaine.
 *
 *   Les deux doivent produire STRICTEMENT la même URL — sinon un
 *   commercial reçoit deux liens différents pour la même conversation
 *   et ne sait pas lequel est "le bon". Ce helper verrouille l'invariant.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🔒 FALLBACK ANTI-DRIFT
 *
 *   `DASHBOARD_URL_FALLBACK` est strictement égal à celui déclaré dans
 *   `src/lib/inngest/functions/slack-handoff.ts` (constante locale D5).
 *   Je ne modifie pas slack-handoff.ts dans cette PR pour éviter toute
 *   régression sur le chemin hand-off initial — à la place, un test
 *   sentinelle importe `__DASHBOARD_URL_FALLBACK_FOR_TESTS` depuis
 *   slack-handoff.ts et verrouille l'égalité des deux constantes.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🔒 FORME DE L'URL
 *
 *   - Trailing slash du `baseUrl` toléré (`.replace(/\/+$/, "")`).
 *   - `conversationId` injecté tel quel — il est opaque par construction
 *     (`${contactId}_${campaignId}`, scrubber-safe). Aucun encodeURIComponent
 *     NÉCESSAIRE côté format (pas de `#` ni `?` dans les hubspotId numériques
 *     ni les campaignId slug). On applique quand même `encodeURIComponent`
 *     defense-in-depth : si un futur campaignId introduit un `/`, l'URL
 *     reste cohérente.
 */

import { getCoreEnv } from "@/lib/security/env";
import { logger } from "@/lib/utils/logger";

/**
 * Fallback utilisé UNIQUEMENT en dev et en test quand `NEXT_PUBLIC_APP_URL`
 * est absent. En production (`NODE_ENV === "production"`), `getCoreEnv()`
 * throw `ConfigError` au démarrage si la var manque (R4-Point3 PR-NO-DROPPED-SMS).
 */
export const DASHBOARD_URL_FALLBACK = "https://medere-prospection.vercel.app";

/**
 * Options d'injection pour tests unitaires. En production, ne pas fournir
 * `getBaseUrl` — la fonction lit `getCoreEnv().NEXT_PUBLIC_APP_URL`.
 *
 * @internal Public uniquement pour le testing.
 */
export interface GetDashboardConversationUrlDeps {
  /**
   * Fournit la base URL (sans trailing slash obligatoire). Si retourne
   * `undefined` ou chaîne vide, le fallback Vercel est utilisé et un
   * `logger.warn` est émis.
   */
  getBaseUrl?: () => string | undefined;
}

/**
 * Retourne l'URL dashboard d'une conversation. JAMAIS de PII dans la
 * chaîne de sortie — `conversationId` est opaque par construction.
 *
 * @param conversationId  docId composite `${contactId}_${campaignId}`.
 * @param deps            optionnel ; en prod, lit `NEXT_PUBLIC_APP_URL`.
 * @returns               `"${base}/conversations/${encodeURIComponent(conversationId)}"`.
 */
export function getDashboardConversationUrl(
  conversationId: string,
  deps: GetDashboardConversationUrlDeps = {},
): string {
  return `${resolveDashboardBase(deps.getBaseUrl, "getDashboardConversationUrl")}/conversations/${encodeURIComponent(conversationId)}`;
}

/**
 * R4-Point3 PR-NO-DROPPED-SMS : URL unique pour la future vue admin
 * orphelins. Avant R4, chaque caller la construisait inline :
 *   - `route.ts:211-214` : `buildOrphansDashboardUrl()` locale.
 * On centralise ici pour que les deux usages (webhook W3/W4/W5/W6 +
 * `handleInactiveInbound` dans le pipeline) partagent la même source.
 */
export function getDashboardOrphansUrl(deps: GetDashboardConversationUrlDeps = {}): string {
  return `${resolveDashboardBase(deps.getBaseUrl, "getDashboardOrphansUrl")}/admin/orphan-inbounds`;
}

/**
 * PR2c tour 2a bis — URL deep-link vers UN orphan précis dans la vue
 * admin orphelins. Format `/admin/orphan-inbounds?id=<orphanDocId>`.
 *
 * UNIQUE fonction (plus de concaténation inline chez les callers Slack).
 * Les notifications orphans channel + testAccount l'utilisent pour
 * pointer la fiche détail en un clic.
 */
export function getDashboardOrphanDetailUrl(
  orphanDocId: string,
  deps: GetDashboardConversationUrlDeps = {},
): string {
  return `${resolveDashboardBase(deps.getBaseUrl, "getDashboardOrphanDetailUrl")}/admin/orphan-inbounds?id=${encodeURIComponent(orphanDocId)}`;
}

/**
 * Résout la base URL dashboard. Centralise la logique de fallback entre
 * les 2 constructeurs (`conversation` + `orphans`). Si
 * `NEXT_PUBLIC_APP_URL` est absente :
 *   - en PROD : `getCoreEnv()` throw `ConfigError` AVANT d'arriver ici
 *     (R4-Point3 décision Déthié : var required en production).
 *   - en dev/test : fallback Vercel + `logger.warn` (comportement legacy).
 */
function resolveDashboardBase(
  getBaseUrl: GetDashboardConversationUrlDeps["getBaseUrl"],
  op: string,
): string {
  const read = getBaseUrl ?? (() => getCoreEnv().NEXT_PUBLIC_APP_URL);
  const raw = read();
  if (raw !== undefined && raw !== "") {
    return raw.replace(/\/+$/, "");
  }
  logger.warn(
    { op },
    "[dashboard-url] NEXT_PUBLIC_APP_URL missing — using Vercel fallback (dev/test)",
  );
  return DASHBOARD_URL_FALLBACK;
}
