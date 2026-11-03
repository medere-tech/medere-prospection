/**
 * Envoi Slack de blocs Block Kit — fonction UNIQUE partagée par toutes
 * les notifs (PR2c tour 2b bloc C octies).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi une fonction unique
 *
 *   Avant ce bloc, `sendInboundAfterHandoffNotification` et
 *   `notifyOrphanAttachedBestEffort` répliquaient à l'identique :
 *     - validation `assertSlackUserId` sur la branche DM
 *     - résolution `channel` (`slackUserId` | `channelId`)
 *     - appel `client.chat.postMessage` avec `unfurl_links: false` +
 *       `unfurl_media: false` (anti-leak d'IDs via preview Slack)
 *     - mapping d'erreurs `ExternalServiceError` (throw sur rejet SDK OU
 *       `{ok: false}`)
 *     - log `logger.info` sans PII (service/targetKind/channel/ts)
 *
 *   Deux copies = deux endroits à patcher quand on durcit la discipline
 *   (ex. ajouter un `thread_ts` ou un retry). On extrait ici le wire
 *   layer unique ; les callers ne gardent que la construction des blocks
 *   et le `fallbackText`.
 */
import { ExternalServiceError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

import { getSlackClient } from "./client";
import { assertSlackUserId } from "./slack-user-id";

/**
 * Cible de l'envoi.
 *
 *   - `kind: "dm"` : DM à un commercial titulaire (`U...`). Validation
 *     `assertSlackUserId` appliquée.
 *   - `kind: "channel"` : canal partagé (`C.../G...`). Les ids canal sont
 *     déjà verrouillés Zod côté `getSlackEnv()` → pas de validation
 *     supplémentaire ici.
 */
export type SlackSendTarget =
  | { readonly kind: "dm"; readonly slackUserId: string }
  | { readonly kind: "channel"; readonly channelId: string };

export interface SendSlackBlocksInput {
  readonly target: SlackSendTarget;
  /**
   * Texte de fallback pour les clients Slack sans support Block Kit
   * (notifications mobiles pauvres, screen readers). JAMAIS de PII —
   * résumé neutre discriminant la variante (ex. "Nouveau message d'un
   * lead", "Demande d'arrêt (STOP) à traiter").
   */
  readonly fallbackText: string;
  /** Blocks Block Kit prêts à poster. Le caller gère son échappement mrkdwn. */
  readonly blocks: ReadonlyArray<Record<string, unknown>>;
  /**
   * Message de log posé après succès via `logger.info`. Permet au caller
   * de garder sa propre signature de log tout en passant par la même
   * fonction d'envoi.
   */
  readonly logEvent: string;
  /**
   * Métadonnées additionnelles à ajouter au log (jamais de PII).
   * Les clefs `service`, `targetKind`, `channel`, `ts` sont posées par
   * `sendSlackBlocks` et ne doivent pas être réécrites ici.
   */
  readonly logContext?: Readonly<Record<string, unknown>>;
}

export interface SendSlackBlocksResult {
  readonly ts: string;
  readonly channel: string;
}

/**
 * Point d'envoi UNIQUE. Throw `ExternalServiceError` sur :
 *   - rejet SDK Slack (`try/catch` autour de `postMessage`).
 *   - réponse `{ok: false}` ou champs `ts`/`channel` manquants.
 *
 * Throw `ConfigError` (via `getSlackClient` → `getSlackEnv`) si le token
 * manque au moment du premier appel.
 */
export async function sendSlackBlocks(input: SendSlackBlocksInput): Promise<SendSlackBlocksResult> {
  if (input.target.kind === "dm") {
    assertSlackUserId(input.target.slackUserId, "sendSlackBlocks");
  }

  const channel = input.target.kind === "dm" ? input.target.slackUserId : input.target.channelId;
  const client = getSlackClient();

  let result;
  try {
    result = await client.chat.postMessage({
      channel,
      text: input.fallbackText,
      blocks: input.blocks,
      // Anti-preview : les URLs dashboard peuvent leaker des IDs si Slack
      // fait un GET d'unfurl côté serveur. Désactivé par sécurité.
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (cause) {
    throw new ExternalServiceError({
      message: "Slack chat.postMessage failed",
      context: { service: "slack", targetKind: input.target.kind },
      cause,
    });
  }

  if (!result.ok || result.ts === undefined || result.channel === undefined) {
    throw new ExternalServiceError({
      message: "Slack chat.postMessage returned non-ok",
      context: {
        service: "slack",
        targetKind: input.target.kind,
        slackError: result.error ?? "unknown",
      },
    });
  }

  logger.info(
    {
      service: "slack",
      targetKind: input.target.kind,
      channel: result.channel,
      ts: result.ts,
      ...(input.logContext ?? {}),
    },
    input.logEvent,
  );

  return { ts: result.ts, channel: result.channel };
}
