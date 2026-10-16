/**
 * Envoi d'un DM Slack "SMS entrant sur conv handed_off" (PR-A-INBOUND-HANDED-OFF).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Role
 *
 *   Poste la notification au DM du commercial titulaire quand un PS
 *   repond apres un hand-off (step branche `handed_off` du pipeline
 *   `process-reply`). Toujours un DM (jamais un canal partage) :
 *   `handoff.assignedTo` existe par definition sur une conv `handed_off`.
 *
 *   Pattern miroir strict de `notify-handoff.ts` (SDK call identique,
 *   gestion erreurs identique, logs sans PII identique). Differences :
 *     - Un seul mode de target (DM) — pas de union discriminee.
 *     - Builder dedie `buildInboundAfterHandoffBlocks` (titre distinct +
 *       variante STOP, zero emoji dans le nouveau code).
 *     - Fallback text `isOptOut` : "Demande d'arret (STOP) a traiter" vs
 *       "Nouveau message d'un lead" — contexte au premier coup d'oeil
 *       sur mobile sans ouvrir le DM.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Contrat d'erreur
 *
 *   - Toute panne SDK (rejet Promise) OU reponse `{ok: false}` → throw
 *     `ExternalServiceError` (statusCode 502, retry-friendly Inngest).
 *   - Le context de l'erreur porte uniquement `{service, targetKind,
 *     slackError?}` — JAMAIS le body, le nom, ou le prenom (data
 *     minimization dans les logs).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Anti-PII dans les logs
 *
 *   Le logger applicatif (`@/lib/utils/logger`) scrube deja `firstName`,
 *   `body`, `email`, `phone` via `PII_KEYS`. Par securite on ne passe
 *   AUCUN champ PII au logger, meme via une cle neutre — on ne logue que
 *   les metadonnees non-PII (`ts`, `channel`, `targetKind`, `isOptOut`).
 */

import { ExternalServiceError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

import { getSlackClient } from "./client";
import {
  buildInboundAfterHandoffBlocks,
  type InboundAfterHandoffInput,
} from "./format-inbound-after-handoff";
import { assertSlackUserId } from "./slack-user-id";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cible du relais — toujours un DM. Un `handoff.assignedTo` existe par
 * definition sur une conv `handed_off` (invariant pose par `setHandoff`).
 * Le champ `kind` est garde pour homogeneite avec `HandoffTarget` et pour
 * faciliter une evolution future (fallback canal titulaire absent).
 */
export interface InboundAfterHandoffTarget {
  kind: "dm";
  /** Slack user ID (`U...`) du commercial titulaire. */
  slackUserId: string;
}

/**
 * Input complet de `sendInboundAfterHandoffNotification` : le contenu du
 * message (`InboundAfterHandoffInput`) + la cible de routage. Le contrat
 * PII de `InboundAfterHandoffInput` (pas de lastName/phone/email/hubspotId/
 * ovhMessageId) s'applique par extension.
 */
export interface SendInboundAfterHandoffInput extends InboundAfterHandoffInput {
  target: InboundAfterHandoffTarget;
}

/** Retour minimal : ce qu'il faut pour tracer / corréler. */
export interface SendInboundAfterHandoffResult {
  ts: string;
  channel: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Poste le DM relais au commercial titulaire.
 *
 * Retourne `{ts, channel}` (utilisable pour tracer dans l'audit log
 * `inbound_relayed_to_human` cote caller `process-reply`).
 *
 * Throw `ExternalServiceError` si :
 *   - Le SDK Slack rejette (network, timeout, API error avec Promise
 *     rejection) → cause preservee pour Sentry, message sanitise.
 *   - Slack repond `{ok: false}` → context inclut `slackError` (le code
 *     court Slack, ex `"channel_not_found"`), JAMAIS le body ni le token.
 *
 * Throw `ConfigError` (via `getSlackClient` → `getSlackEnv`) si le token
 * manque au moment du premier appel.
 */
export async function sendInboundAfterHandoffNotification(
  input: SendInboundAfterHandoffInput,
): Promise<SendInboundAfterHandoffResult> {
  // Fix LOW security-reviewer PR-A : defense-in-depth sur docs legacy
  // dont le `assignedTo` n'aurait pas ete valide a l'ecriture (avant
  // cette PR). Throw ValidationError sans leak PII dans le context.
  // Pattern miroir avec `sendHandoffNotification` et `setHandoff`.
  assertSlackUserId(input.target.slackUserId, "sendInboundAfterHandoffNotification");

  const blocks = buildInboundAfterHandoffBlocks({
    firstName: input.firstName,
    speciality: input.speciality,
    city: input.city,
    lastInboundBody: input.lastInboundBody,
    conversationId: input.conversationId,
    isOptOut: input.isOptOut,
    dashboardUrl: input.dashboardUrl,
  });

  const channel = input.target.slackUserId;

  // `text` de fallback pour les clients Slack sans support Block Kit
  // (notifications mobiles pauvres, screen readers). JAMAIS de PII
  // dedans — juste un resume neutre discriminant la variante.
  const fallbackText = input.isOptOut
    ? "Demande d'arret (STOP) a traiter"
    : "Nouveau message d'un lead";

  const client = getSlackClient();

  let result;
  try {
    result = await client.chat.postMessage({
      channel,
      text: fallbackText,
      blocks,
      // Anti-preview : les URLs dashboard peuvent leaker des IDs si Slack
      // fait un GET d'unfurl cote serveur. Desactive par securite.
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
      isOptOut: input.isOptOut,
    },
    "Inbound-after-handoff Slack notification sent",
  );

  return { ts: result.ts, channel: result.channel };
}
