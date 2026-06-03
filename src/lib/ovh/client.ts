/**
 * Singleton client `@ovhcloud/node-ovh` v3.0.0 pour Médéré (S7a.3.1).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pattern identique à S2 (`getXxxEnv`), S6 (`getAdminDb`), S7a.1
 * (`getAnthropicClient`) : construction paresseuse au PREMIER appel,
 * mémoïsation, back-door `__setOvhClientForTests` pour les tests, garde
 * runtime `NODE_ENV === "test"`.
 *
 * Les credentials (`OVH_APP_KEY`, `OVH_APP_SECRET`, `OVH_CONSUMER_KEY`)
 * sont lus via `getOvhEnv()` au premier appel. Si une de ces variables
 * manque ou est mal formée, `ConfigError` (message sanitisé S2, jamais
 * de fuite de valeur).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Surface API : juste le strict nécessaire pour `send-sms.ts` :
 *
 *   - `requestPromised(method, path, params)` : seule méthode SDK
 *     utilisée. Reject avec `{ error, message }` shape (cf. SDK v3
 *     `lib/ovh.es5.js` ligne 504-507) — la discrimination du type d'erreur
 *     est faite dans `send-sms.ts::mapOvhError`.
 *
 * Type structurel minimal `OvhClient` (vs `ReturnType<typeof ovhApi>`)
 * pour permettre l'injection d'un fake `{ requestPromised: vi.fn() }`
 * dans les tests sans dépendance au shape interne du SDK.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Sécurité :
 *
 *   - Aucun log de credentials, même tronqués. Le wrapper SDK ne log
 *     jamais. La gestion d'erreur côté `send-sms.ts` propage uniquement
 *     HTTP status / errno category, JAMAIS le `err.message` brut SDK
 *     (qui pourrait embarquer la consumer key tronquée).
 *
 *   - Pas de mode debug actif côté `@ovhcloud/node-ovh` (le SDK ne loggue
 *     rien par défaut sauf si explicitement configuré).
 */

import ovhApi from "@ovhcloud/node-ovh";

import { getOvhEnv } from "@/lib/security/env";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes — bornes d'I/O
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Timeout d'appel SDK OVH (ms) — parité S7a.1 Claude (`DEFAULT_TIMEOUT_MS`).
 *
 * Sans ce paramètre, le SDK `@ovhcloud/node-ovh` v3 n'arme PAS
 * `socket.setTimeout` (cf. `lib/ovh.es5.js:463`) — un socket TCP pendu
 * côté OVH consommerait le timeout Vercel serverless (~60s) au lieu
 * d'échouer rapidement via `ETIMEDOUT`. Pile défensive contre le piège
 * CLAUDE.md « `fetch()` sans timeout ».
 *
 * 10s = consensus avec S7a.1 et `lib/security/env.ts`. Si OVH renvoie
 * légitimement plus lentement, à bumper après mesure terrain.
 */
const OVH_TIMEOUT_MS = 10_000;

// ─────────────────────────────────────────────────────────────────────────────
// Type structurel minimal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Interface structurelle exposée aux consommateurs. Permet aux tests
 * d'injecter un fake `{ requestPromised: vi.fn() }` sans recréer une
 * instance SDK complète. Reflète l'API utilisée par `send-sms.ts`.
 *
 * Le SDK v3 typescriptifié ailleurs : pas dispo (`@ovhcloud/node-ovh`
 * v3.0.0 livre du JS ES5 sans types `.d.ts`). On accepte un retour
 * `unknown` plutôt qu'`any` pour forcer la discrimination côté caller.
 */
export interface OvhClient {
  requestPromised(method: string, path: string, params?: unknown): Promise<unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton + back-door tests
// ─────────────────────────────────────────────────────────────────────────────

let cachedClient: OvhClient | null = null;

function buildClient(): OvhClient {
  const env = getOvhEnv();
  // Le SDK est typé via `src/types/ovh-sdk.d.ts` (déclaration manuelle —
  // le package n'a pas de `.d.ts` natif). `OvhSdkClient` (déclaré) et
  // `OvhClient` (local) sont structurellement compatibles → assignation
  // directe possible.
  return ovhApi({
    endpoint: env.OVH_ENDPOINT,
    appKey: env.OVH_APP_KEY,
    appSecret: env.OVH_APP_SECRET,
    consumerKey: env.OVH_CONSUMER_KEY,
    timeout: OVH_TIMEOUT_MS,
  });
}

/**
 * Retourne le client SDK OVH singleton. Premier appel lit l'env
 * (`getOvhEnv`) et instancie le SDK ; les suivants retournent
 * l'instance mémoïsée. Throw `ConfigError` si une des vars OVH
 * manque ou est mal formée.
 */
export function getOvhClient(): OvhClient {
  if (cachedClient === null) {
    cachedClient = buildClient();
  }
  return cachedClient;
}

/**
 * Test-only : injecte un client fake (typiquement
 * `{ requestPromised: vi.fn() }`). Passer `null` pour forcer la
 * prochaine résolution via `getOvhEnv()` (utile pour tester le code
 * path "env manquante → ConfigError").
 *
 * Garde runtime : refuse en dehors de `NODE_ENV === "test"`.
 */
export function __setOvhClientForTests(client: OvhClient | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setOvhClientForTests called outside of tests");
  }
  cachedClient = client;
}
