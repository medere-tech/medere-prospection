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

import {
  buildInboundAfterHandoffBlocks,
  type InboundAfterHandoffInput,
} from "./format-inbound-after-handoff";
import { sendSlackBlocks, type SlackSendTarget } from "./send-slack-blocks";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Alias local — même shape que `SlackSendTarget` (bloc C octies : point
 * d'envoi UNIQUE partagé). Le re-export est maintenu pour que les callers
 * historiques (ex. `process-reply`) qui importent ce type ne cassent pas.
 */
export type InboundAfterHandoffTarget = SlackSendTarget;

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
  const blocks = buildInboundAfterHandoffBlocks({
    firstName: input.firstName,
    speciality: input.speciality,
    city: input.city,
    lastInboundBody: input.lastInboundBody,
    conversationId: input.conversationId,
    isOptOut: input.isOptOut,
    dashboardUrl: input.dashboardUrl,
  });

  // `text` de fallback pour les clients Slack sans support Block Kit
  // (notifications mobiles pauvres, screen readers). JAMAIS de PII
  // dedans — juste un resume neutre discriminant la variante.
  const fallbackText = input.isOptOut
    ? "Demande d'arrêt (STOP) à traiter"
    : "Nouveau message d'un lead";

  // Wire layer unique (bloc C octies) : validation DM, postMessage
  // anti-unfurl, mapping d'erreurs, log sans PII.
  return sendSlackBlocks({
    target: input.target,
    fallbackText,
    blocks,
    logEvent: "Inbound-after-handoff Slack notification sent",
    logContext: { isOptOut: input.isOptOut },
  });
}
