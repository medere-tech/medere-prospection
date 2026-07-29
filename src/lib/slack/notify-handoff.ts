/**
 * Envoi d'une notification hand-off Slack (S9.9-PR3).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rôle
 *
 *   Point d'entrée unique pour poster une notification de hand-off :
 *     - DM au commercial (`target.kind === "dm"`) → target.slackUserId
 *     - Canal orphelins (`target.kind === "channel"`) → target.channelId
 *
 *   Slack accepte indifféremment un `channel` = channel ID (`C…/G…`) OU
 *   user ID (`U…`) dans `chat.postMessage` — dans le second cas le SDK
 *   ouvre/réutilise automatiquement le DM. Pas besoin de
 *   `conversations.open` en amont.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Contrat d'erreur
 *
 *   - Toute panne SDK (rejet Promise) OU réponse `{ok: false}` → throw
 *     `ExternalServiceError` (statusCode 502, retry-friendly Inngest).
 *   - Le context de l'erreur porte uniquement `{service, targetKind,
 *     slackError?}` — JAMAIS le body, le nom, ou le prénom (data
 *     minimization dans les logs).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Anti-PII dans les logs
 *
 *   Le logger applicatif (`@/lib/utils/logger`) scrube déjà `firstName`,
 *   `body`, `email`, `phone` via `PII_KEYS`. Par sécurité on ne passe
 *   AUCUN champ PII au logger, même via une clé neutre — on ne logue que
 *   les métadonnées non-PII (`ts`, `channel`, `targetKind`, `isOrphan`).
 */

import { ExternalServiceError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

import { getSlackClient } from "./client";
import { buildHandoffBlocks, type HandoffInput } from "./format-handoff";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cible du hand-off — union discriminée sur `kind` :
 *   - `"dm"`      : DM au commercial (slackUserId `U…`)
 *   - `"channel"` : canal partagé (channelId `C…/G…`, typiquement orphelins)
 */
export type HandoffTarget =
  | { kind: "dm"; slackUserId: string }
  | { kind: "channel"; channelId: string };

/**
 * Input complet de `sendHandoffNotification` : le contenu du message
 * (`HandoffInput`) + la cible de routage. Le contrat PII de `HandoffInput`
 * (pas de lastName/phone/email/hubspotId) s'applique par extension.
 */
export interface SendHandoffInput extends HandoffInput {
  target: HandoffTarget;
}

/** Retour minimal : ce qu'il faut pour tracer / répondre en thread. */
export interface SendHandoffResult {
  ts: string;
  channel: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Poste la notification hand-off dans le DM du commercial OU dans le canal
 * orphelins, selon `input.target.kind`.
 *
 * Retourne `{ts, channel}` (utilisable pour rebondir en thread depuis le
 * caller, ou pour tracer dans un audit log).
 *
 * Throw `ExternalServiceError` si :
 *   - Le SDK Slack rejette (network, timeout, API error avec Promise
 *     rejection) → cause préservée pour Sentry, message sanitisé pour le
 *     client.
 *   - Slack répond `{ok: false}` (Slack utilise ce pattern pour signaler
 *     des erreurs API "métier" — `channel_not_found`, `not_in_channel`,
 *     `token_revoked`…) → context inclut `slackError` (le code court
 *     Slack, ex `"channel_not_found"`), JAMAIS le body ni le token.
 *
 * Throw `ConfigError` (via `getSlackClient` → `getSlackEnv`) si le token
 * manque au moment du premier appel.
 */
export async function sendHandoffNotification(input: SendHandoffInput): Promise<SendHandoffResult> {
  const blocks = buildHandoffBlocks({
    firstName: input.firstName,
    speciality: input.speciality,
    city: input.city,
    lastInboundBody: input.lastInboundBody,
    conversationId: input.conversationId,
    isOrphan: input.isOrphan,
    dashboardUrl: input.dashboardUrl,
  });

  const channel = input.target.kind === "dm" ? input.target.slackUserId : input.target.channelId;

  // `text` de fallback pour les clients Slack sans support Block Kit
  // (notifications mobiles pauvres, RSS, accessibility screen readers).
  // JAMAIS de PII dedans — juste un résumé neutre.
  const fallbackText = input.isOrphan
    ? "Lead non attribué à traiter"
    : "Nouveau lead intéressé pour vous";

  const client = getSlackClient();

  let result;
  try {
    result = await client.chat.postMessage({
      channel,
      text: fallbackText,
      blocks,
      // Anti-preview : les URLs dashboard peuvent leaker des IDs si Slack
      // fait un GET d'unfurl côté serveur. Désactivé par sécurité.
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (cause) {
    // SDK rejette (network / timeout / erreur non-Slack).
    throw new ExternalServiceError({
      message: "Slack chat.postMessage failed",
      context: { service: "slack", targetKind: input.target.kind },
      cause,
    });
  }

  // Slack utilise le pattern `{ok: false, error: "code"}` pour signaler
  // les erreurs métier — c'est PAS une Promise rejection côté SDK v7.
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
      isOrphan: input.isOrphan,
    },
    "Handoff Slack notification sent",
  );

  return { ts: result.ts, channel: result.channel };
}
