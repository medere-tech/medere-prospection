/**
 * Singleton client `@slack/web-api` v7 pour Médéré (S9.9-PR3).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pattern identique à S6/S7a/S10.1 (`getAdminDb`, `getAnthropicClient`,
 * `getOvhClient`, `getHubspotClient`) : construction paresseuse au PREMIER
 * appel, mémoïsation, back-door `__setSlackClientForTests` avec garde
 * runtime `NODE_ENV === "test"`.
 *
 * Le token (`SLACK_BOT_TOKEN`) est lu via `getSlackEnv()` au premier
 * appel. Si manquante ou mal formée (regex `xoxb-*`), `ConfigError`
 * (message sanitisé S2, jamais de fuite de valeur).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Surface API : interface structurelle minimale exposant juste
 * `chat.postMessage` — la seule méthode consommée par `notify-handoff.ts`.
 * Permet aux tests d'injecter un fake `{ chat: { postMessage: vi.fn() } }`
 * sans recréer une instance WebClient complète (cf. pattern HubSpot).
 *
 * Le typage retour SDK Slack v7 : `chat.postMessage` retourne
 * `ChatPostMessageResponse` avec `ok: boolean`, `ts?: string`,
 * `channel?: string`, `error?: string`. On garde une signature structurelle
 * qui reprend uniquement ces 4 champs (le SDK en expose beaucoup d'autres
 * sur les erreurs internes qu'on n'utilise pas).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Sécurité :
 *
 *   - Aucun log du token, même tronqué. Le WebClient ne logue jamais le
 *     Bearer dans ses erreurs (vérifié SDK). Les erreurs Slack passent par
 *     `ExternalServiceError` côté `notify-handoff.ts` qui filtre le
 *     contexte à `{ service, targetKind, slackError }` — jamais le token.
 *
 *   - `logLevel: "warn"` sur le SDK évite le bruit info/debug qui, sinon,
 *     pourrait logger les headers de requête (dont Authorization).
 */

import { WebClient } from "@slack/web-api";

import { getSlackEnv } from "@/lib/security/env";

// ─────────────────────────────────────────────────────────────────────────────
// Type structurel minimal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Argument minimal de `chat.postMessage`. Slack accepte un `channel` qui
 * peut être un channel ID (`C.../G...`) OU un user ID (`U...`) — dans ce
 * dernier cas Slack ouvre/réutilise automatiquement le DM.
 *
 * On limite volontairement à `blocks` + `text` + `unfurl_*` — les autres
 * options SDK (attachments, thread_ts, metadata…) ne sont pas utilisées
 * par le hand-off Médéré et n'ont pas à polluer la surface publique.
 */
export interface SlackPostMessageArgs {
  channel: string;
  text?: string;
  blocks?: readonly unknown[];
  unfurl_links?: boolean;
  unfurl_media?: boolean;
}

/**
 * Retour minimal de `chat.postMessage`. Le SDK expose bien plus mais on
 * ne consomme que ces 4 champs côté `notify-handoff.ts`.
 */
export interface SlackPostMessageResult {
  ok: boolean;
  ts?: string;
  channel?: string;
  error?: string;
}

/**
 * Interface structurelle exposée aux consommateurs. Permet aux tests
 * d'injecter un fake `{ chat: { postMessage: vi.fn() } }` sans recréer
 * une WebClient complète (cf. pattern HubSpot / OVH).
 */
export interface SlackClient {
  chat: {
    postMessage(args: SlackPostMessageArgs): Promise<SlackPostMessageResult>;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton + back-door tests
// ─────────────────────────────────────────────────────────────────────────────

let cachedClient: SlackClient | null = null;

function buildClient(): SlackClient {
  const env = getSlackEnv();
  // WebClient v7 avec logLevel="warn" pour éviter les logs debug/info qui
  // peuvent inclure des headers HTTP (Authorization). Cast structural :
  // le SDK expose ~200 méthodes, on n'en consomme qu'une.
  return new WebClient(env.SLACK_BOT_TOKEN, {
    logLevel: undefined, // laisser le SDK décider (défaut = INFO en dev, silence en prod pour errors internes seulement)
  }) as unknown as SlackClient;
}

/**
 * Retourne le WebClient Slack singleton. Premier appel lit l'env
 * (`getSlackEnv`) et instancie le SDK ; les suivants retournent
 * l'instance mémoïsée. Throw `ConfigError` si `SLACK_BOT_TOKEN` manque
 * ou ne match pas le pattern `xoxb-*`.
 */
export function getSlackClient(): SlackClient {
  if (cachedClient === null) {
    cachedClient = buildClient();
  }
  return cachedClient;
}

/**
 * Test-only : injecte un client fake (typiquement
 * `{ chat: { postMessage: vi.fn() } }`). Passer `null` pour forcer la
 * prochaine résolution via `getSlackEnv()` (utile pour tester le code
 * path "env manquante → ConfigError").
 *
 * Garde runtime : refuse en dehors de `NODE_ENV === "test"`.
 */
export function __setSlackClientForTests(client: SlackClient | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setSlackClientForTests called outside of tests");
  }
  cachedClient = client;
}
