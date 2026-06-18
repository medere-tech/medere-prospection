/**
 * Singleton client `@hubspot/api-client` v13 pour Médéré (S10.1.2.b).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pattern identique S2 (`getXxxEnv`), S6 (`getAdminDb`), S7a.1
 * (`getAnthropicClient`), S7a.3.1 (`getOvhClient`) : construction
 * paresseuse au PREMIER appel, mémoïsation, back-door
 * `__setHubspotClientForTests` pour les tests, garde runtime
 * `NODE_ENV === "test"`.
 *
 * Les credentials (`HUBSPOT_ACCESS_TOKEN`) sont lus via `getHubspotEnv()`
 * au premier appel. Si manquante ou mal formée (regex `pat-*`),
 * `ConfigError` (message sanitisé S2, jamais de fuite de valeur).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Surface API : interface structurelle minimale exposant juste les sous-
 * APIs CRM consommées par `lists.ts` + `contacts.ts` :
 *
 *   - `crm.lists.listsApi.getAll(...)`              → `listSmsLists`
 *   - `crm.lists.membershipsApi.getPage(...)`       → `getContactsInList` step 1
 *   - `crm.contacts.batchApi.read(...)`             → `getContactsInList` step 2
 *   - `crm.contacts.basicApi.getById(...)`          → `getContact`
 *
 * Le typage exact des paramètres/retours SDK est tracé côté caller via
 * les types `@hubspot/api-client` (la surface ici accepte `unknown` à
 * la racine pour permettre l'injection d'un fake en tests sans recréer
 * une instance Client complète).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rate limiting natif Bottleneck
 *
 *   Le SDK v13 embarque un Bottleneck limiter pré-configuré :
 *     - DEFAULT_LIMITER_OPTIONS = { minTime: ~111ms, maxConcurrent: 6 }
 *       → ~9 req/sec (conforme HubSpot standard 100 req/10sec)
 *     - SEARCH_LIMITER_OPTIONS = { minTime: 550ms, maxConcurrent: 3 }
 *       → ~1.8 req/sec (conforme HubSpot Search 4 req/sec)
 *
 *   Pas besoin de wrapper retry custom. On configure juste
 *   `numberOfApiCallRetries: 3` au constructeur — le SDK rejoue
 *   automatiquement sur 429 (TooManyRequests) + 5xx (server errors)
 *   avec backoff Bottleneck natif.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Sécurité :
 *
 *   - Aucun log de credentials, même tronqués. Le SDK ne log jamais
 *     l'access token dans ses propres erreurs (vérifié codebase).
 *
 *   - Le `pat-eu1-*` prefix route automatiquement vers `api.hubapi.com`
 *     EU (région RGPD compliant pour les contacts PS Médéré). Pas
 *     d'override `basePath` ici.
 */

import { Client } from "@hubspot/api-client";

import { getHubspotEnv } from "@/lib/security/env";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Nombre de retries automatiques sur 429/5xx avant que le SDK throw
 * l'erreur au caller. 3 = compromis entre résilience (un pic 429
 * transitoire ne casse pas le seed) et fail-fast (un token invalide
 * échoue rapidement, pas après 10s de backoff).
 *
 * 🔒 SENTINEL — verrouillé par test sentinelle.
 */
export const HUBSPOT_API_RETRIES = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Type structurel minimal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Interface structurelle exposée aux consommateurs. Permet aux tests
 * d'injecter un fake `{ crm: { lists: {...}, contacts: {...} } }` sans
 * recréer une instance SDK complète. Reflète exactement la surface
 * utilisée par `lists.ts` + `contacts.ts`.
 *
 * Les retours `unknown` sont volontaires : le typage strict est appliqué
 * côté caller (chaque module wrapper cast via Zod parse OU le type SDK
 * importé explicitement). Cohérent pattern OVH (`requestPromised`
 * retourne `unknown`).
 */
export interface HubspotClient {
  crm: {
    lists: {
      listsApi: {
        getAll(listIds?: Array<string>, includeFilters?: boolean): Promise<unknown>;
      };
      membershipsApi: {
        getPage(listId: string, after?: string, before?: string, limit?: number): Promise<unknown>;
      };
    };
    contacts: {
      basicApi: {
        getById(
          contactId: string,
          properties?: Array<string>,
          propertiesWithHistory?: Array<string>,
          associations?: Array<string>,
          archived?: boolean,
          idProperty?: string,
        ): Promise<unknown>;
      };
      batchApi: {
        read(input: {
          inputs: Array<{ id: string }>;
          properties: Array<string>;
          propertiesWithHistory: Array<string>;
        }): Promise<unknown>;
      };
    };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton + back-door tests
// ─────────────────────────────────────────────────────────────────────────────

let cachedClient: HubspotClient | null = null;

function buildClient(): HubspotClient {
  const env = getHubspotEnv();
  // `as unknown as HubspotClient` : le SDK Client v13 expose une surface
  // bien plus large (10+ discovery namespaces, internals, etc.). Notre
  // interface structurelle ne capture que les 4 sous-APIs consommées —
  // c'est volontaire (anti over-typing + injection fake facile en tests).
  return new Client({
    accessToken: env.HUBSPOT_ACCESS_TOKEN,
    numberOfApiCallRetries: HUBSPOT_API_RETRIES,
    // limiterOptions/limiterJobOptions : defaults SDK OK (cf. JSDoc top).
    // basePath : auto-routé via préfixe pat-eu1-* (Médéré EU).
  }) as unknown as HubspotClient;
}

/**
 * Retourne le client SDK HubSpot singleton. Premier appel lit l'env
 * (`getHubspotEnv`) et instancie le SDK ; les suivants retournent
 * l'instance mémoïsée. Throw `ConfigError` si `HUBSPOT_ACCESS_TOKEN`
 * manque ou ne match pas le pattern `pat-*`.
 */
export function getHubspotClient(): HubspotClient {
  if (cachedClient === null) {
    cachedClient = buildClient();
  }
  return cachedClient;
}

/**
 * Test-only : injecte un client fake (typiquement un objet
 * `{ crm: { lists: {...}, contacts: {...} } }` avec `vi.fn()`). Passer
 * `null` pour forcer la prochaine résolution via `getHubspotEnv()`
 * (utile pour tester le code path "env manquante → ConfigError").
 *
 * Garde runtime : refuse en dehors de `NODE_ENV === "test"`.
 */
export function __setHubspotClientForTests(client: HubspotClient | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setHubspotClientForTests called outside of tests");
  }
  cachedClient = client;
}
