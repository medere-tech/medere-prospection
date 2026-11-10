/**
 * Dérive l'hôte du serveur FAPI (Frontend API) Clerk à partir de la
 * publishable key. Utilisé par `next.config.ts` pour construire une CSP
 * EXACTE (sans joker `*.clerk.accounts.dev`) autour de l'instance Clerk
 * active, en dev comme en prod.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi ne pas écrire l'hôte en dur
 *
 *   Chaque instance Clerk expose son propre FAPI :
 *     - prod   : `clerk.prospection.medere.fr`
 *     - dev    : `<slug>.clerk.accounts.dev` (ex. `new-lamprey-17.…`)
 *   Un joker `*.clerk.accounts.dev` dans la CSP neutraliserait la défense
 *   en acceptant n'importe quelle instance Clerk dev (tenant tiers compris).
 *   On dérive donc l'hôte EXACT de la clé publique active.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi `@clerk/shared/keys::parsePublishableKey`
 *
 *   Fonction officielle exportée par `@clerk/shared@4.40.0` (tirée transitivement
 *   par `@clerk/nextjs`). Elle décode le base64 encodé après le préfixe, retire
 *   le `$` final et retourne `{ frontendApi, instanceType }`. Appelée avec
 *   `{ fatal: true }`, elle THROW au moindre défaut (préfixe manquant, base64
 *   malformé, `$` final absent, clé vide). Pas de fallback silencieux.
 *
 *   Sondage 2026-11-10 (`node -e "parsePublishableKey(…, {fatal:true})"`) :
 *     - pk_live_Y2xlcmsucHJvc3BlY3Rpb24ubWVkZXJlLmZyJA → "clerk.prospection.medere.fr"
 *     - pk_test_bmV3LWxhbXByZXktMTcuY2xlcmsuYWNjb3VudHMuZGV2JA → "new-lamprey-17.clerk.accounts.dev"
 *     - "xxxxx" / "" / undefined / null                → THROW "not valid / missing"
 *     - "pk_live_<base64('*.evil.com$')>"              → retourne "*.evil.com" (!)
 *
 *   Le dernier cas explique le second filet ci-dessous : Clerk laisse passer
 *   un wildcard dans l'hostname décodé. On refuse manuellement tout host qui
 *   n'est pas un FQDN DNS strict (lettres, chiffres, tirets, points, deux
 *   labels minimum).
 */
import { parsePublishableKey } from "@clerk/shared/keys";

/**
 * Hostname DNS strict — zéro joker, minimum deux labels. Volontairement plus
 * restrictif que la RFC (pas d'IDN, pas de digits-only TLD) : la FAPI Clerk
 * est toujours `<label>.<label>…` en ASCII.
 */
const HOSTNAME_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Erreur dédiée — sanitisée : jamais la valeur de la clé publique dans le
 * message (préfixe `pk_live_` suffit à identifier le type d'erreur sans
 * fuite). Le caller (next.config.ts) propage l'erreur telle quelle → le
 * build Next fail-fast avec un message lisible.
 */
export class ClerkFrontendApiError extends Error {
  constructor(reason: string) {
    super(`clerkFrontendApiFromPublishableKey: ${reason}`);
    this.name = "ClerkFrontendApiError";
  }
}

/**
 * Retourne l'hôte FAPI Clerk (ex. `clerk.prospection.medere.fr`).
 *
 * Fail-closed : throw `ClerkFrontendApiError` si la clé est absente,
 * malformée, ou si l'host décodé n'est pas un FQDN DNS strict.
 */
export function clerkFrontendApiFromPublishableKey(publishableKey: string | undefined): string {
  let parsed;
  try {
    parsed = parsePublishableKey(publishableKey, { fatal: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new ClerkFrontendApiError(`invalid NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY — ${msg}`);
  }
  const frontendApi = parsed.frontendApi;
  if (!HOSTNAME_REGEX.test(frontendApi)) {
    throw new ClerkFrontendApiError(
      `decoded frontend API is not a strict DNS hostname (contains a wildcard or invalid character) — refused for CSP safety.`,
    );
  }
  return frontendApi;
}
