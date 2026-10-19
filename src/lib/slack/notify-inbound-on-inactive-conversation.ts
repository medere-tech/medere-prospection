/**
 * Envoi d'une notification Slack "SMS entrant sur conv inactive /
 * contact inconnu / parse ou enqueue en echec" (PR-NO-DROPPED-SMS).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pattern miroir strict de `notify-inbound-after-handoff.ts` (PR-A). Deux
 * modes de routage via `target` :
 *   - `kind: "dm"`      → `slackUserId` du commercial titulaire
 *                         (valide via `assertSlackUserId` miroir PR-A).
 *   - `kind: "channel"` → `channelId` du canal orphelins
 *                         (`SLACK_ORPHAN_LEADS_CHANNEL_ID`, deja utilise
 *                         par `slack-handoff.ts`).
 *
 * Le caller (process-reply ou webhook ovh-sms) decide du mode en fonction
 * de la `reason` et de la presence d'un `handoff.assignedTo`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Contrat d'erreur
 *
 * Identique a `sendInboundAfterHandoffNotification` :
 *   - Toute panne SDK (rejet Promise) OU reponse `{ok: false}` → throw
 *     `ExternalServiceError` (statusCode 502, retry-friendly Inngest).
 *   - Le context de l'erreur porte uniquement `{service, targetKind,
 *     slackError?}` — JAMAIS de PII.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Validation Slack ID — defense-in-depth
 *
 * Pour `kind: "dm"` : `assertSlackUserId(slackUserId)` (regex `^U[A-Z0-9]+$`,
 * fix LOW security-reviewer PR-A).
 * Pour `kind: "channel"` : regex `^[CG][A-Z0-9]+$` miroir `env.ts:198`
 * (SLACK_ORPHAN_LEADS_CHANNEL_ID).
 */

import { ExternalServiceError, ValidationError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";
import { captureMonitoringWarning } from "@/lib/utils/observability";

import { getSlackClient } from "./client";
import {
  buildInboundOnInactiveConversationBlocks,
  HEADERS_BY_REASON,
  type OrphanNotifInput,
} from "./format-inbound-on-inactive-conversation";
import { decideOrphanAlert, type OrphanAlertDecision } from "./orphan-notification-rate-limit";
import { assertSlackUserId } from "./slack-user-id";

// ─────────────────────────────────────────────────────────────────────────────
// Validation channel ID (miroir env.ts regex)
// ─────────────────────────────────────────────────────────────────────────────

const SLACK_CHANNEL_ID_REGEX = /^[CG][A-Z0-9]+$/;

function assertSlackChannelId(channelId: string, op: string): void {
  if (!SLACK_CHANNEL_ID_REGEX.test(channelId)) {
    throw new ValidationError({
      message: `${op}: invalid Slack channel ID shape`,
      context: { op, channelIdLength: channelId.length },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cible du routage orphan. Discriminated union :
 *   - DM titulaire quand `handoff.assignedTo` existe.
 *   - Canal orphelins (`SLACK_ORPHAN_LEADS_CHANNEL_ID`) sinon.
 */
export type OrphanNotifTarget =
  | { kind: "dm"; slackUserId: string }
  | { kind: "channel"; channelId: string };

/**
 * Input complet de `sendInboundOnInactiveConversationNotification` :
 * contenu du message (`OrphanNotifInput`) + cible de routage.
 */
export interface SendOrphanNotifInput extends OrphanNotifInput {
  target: OrphanNotifTarget;
}

/** Retour minimal pour tracer / correler. */
export interface SendOrphanNotifResult {
  ts: string;
  channel: string;
  /**
   * Discriminant de la decision MED-1 PR-NO-DROPPED-SMS :
   *   - "send"        : alerte normale envoyee.
   *   - "send_digest" : au-dela de 20 alertes/min/reason, UNE seule
   *                     alerte de synthese remplace les surplus.
   *   - "suppressed"  : alerte ni envoyee ni comptee cote Slack (quota
   *                     digest deja atteint pour la minute). Dans ce cas,
   *                     `ts` et `channel` valent chaines vides — le
   *                     caller doit tester `kind` AVANT de poser un audit
   *                     avec slackTs/slackChannel.
   */
  kind: "send" | "send_digest" | "suppressed";
}

// ─────────────────────────────────────────────────────────────────────────────
// Digest blocks — MED-1 PR-NO-DROPPED-SMS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Construit les blocks d'une alerte de SYNTHESE quand 20+ alertes du
 * meme `reason` sont declenchees dans la minute (hors wasOptOut). Format
 * minimaliste, zero PII : juste la reason + le compteur + un lien vers
 * la future vue admin orphelins. Les details individuels vivent dans
 * `inbound_messages_orphans/`.
 */
function buildDigestBlocks(params: {
  reason: string;
  suppressed: number;
  dashboardUrl: string;
}): Array<Record<string, unknown>> {
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Vague d'alertes orphelines (synthese 1min)",
        emoji: false,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Reason* : \`${params.reason}\`\n*Alertes comptabilisees dans la minute* : *${params.suppressed}+*\n\nLes alertes individuelles sont supprimees pour eviter l'inondation du canal. Les SMS correspondants restent persistes dans \`inbound_messages_orphans/\` et un audit \`inbound_on_inactive_conversation\` est pose pour chacun.`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `<${params.dashboardUrl}|Voir les orphelins>`,
      },
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Poste la notification orphan au DM titulaire OU au canal orphelins.
 *
 * Retourne `{ts, channel}` (utilisable pour tracer dans l'audit
 * `inbound_on_inactive_conversation` cote caller).
 *
 * Throw `ExternalServiceError` si :
 *   - Le SDK Slack rejette → cause preservee pour Sentry, message sanitise.
 *   - Slack repond `{ok: false}` → context inclut `slackError`.
 *
 * Throw `ValidationError` si le Slack ID (user ou channel) est mal forme.
 *
 * Throw `ConfigError` (via `getSlackClient` → `getSlackEnv`) si le token
 * manque au moment du premier appel.
 */
export async function sendInboundOnInactiveConversationNotification(
  input: SendOrphanNotifInput,
): Promise<SendOrphanNotifResult> {
  const op = "sendInboundOnInactiveConversationNotification";

  // Validation Slack ID — defense-in-depth miroir PR-A.
  if (input.target.kind === "dm") {
    assertSlackUserId(input.target.slackUserId, op);
  } else {
    assertSlackChannelId(input.target.channelId, op);
  }

  // MED-1 PR-NO-DROPPED-SMS : plafond anti-inondation canal orphelins.
  // Les DM titulaires (`kind: "dm"`) ne passent PAS par ce plafond : un
  // DM va a UN commercial, pas de risque d'inondation d'un canal
  // partage. Seul le routage `kind: "channel"` est soumis au plafond.
  //
  // wasOptOut === true -> jamais regroupe/supprime (`decideOrphanAlert`
  // retourne "send" immediatement).
  let decision: OrphanAlertDecision = { kind: "send" };
  if (input.target.kind === "channel") {
    decision = await decideOrphanAlert({
      reason: input.reason,
      wasOptOut: input.wasOptOut,
    });
    if (decision.kind === "suppress") {
      // Aucun post Slack. On trace Sentry warning pour visibilite
      // operationnelle (observabilite, pas erreur).
      captureMonitoringWarning("slack.orphan_alert.suppressed", {
        level: "warning",
        tags: { reason: input.reason, target_kind: "channel" },
        extra: {
          suppressed_in_window: decision.suppressed_in_window,
        },
      });
      return { ts: "", channel: "", kind: "suppressed" };
    }
  }

  // Garde-fou : `includeHereMention` n'a de sens qu'en canal. En DM Slack
  // affiche `<!here>` litteralement sans ping — on strip pour eviter le
  // bruit visuel.
  const normalizedInput: OrphanNotifInput = {
    reason: input.reason,
    wasOptOut: input.wasOptOut,
    lastInboundBody: input.lastInboundBody,
    dashboardUrl: input.dashboardUrl,
    includeHereMention: input.target.kind === "channel" ? input.includeHereMention : false,
    firstName: input.firstName,
    speciality: input.speciality,
    city: input.city,
    phoneLast4: input.phoneLast4,
    conversationId: input.conversationId,
    orphanDocId: input.orphanDocId,
    // LOW-1 PR-NO-DROPPED-SMS : si un ID footer ne match pas
    // /^[A-Za-z0-9_-]+$/, le formatter l'OMIT du footer (safe) et nous
    // signale la deviation via Sentry warning.
    onInvalidFooterId: (invalidFields) => {
      captureMonitoringWarning("slack.inactive_inbound.invalid_footer_id", {
        level: "warning",
        tags: {
          reason: input.reason,
          target_kind: input.target.kind,
        },
        extra: {
          invalidFields: invalidFields.join(","),
        },
      });
    },
  };

  // MED-1 : si decision="send_digest", on remplace les blocks par un
  // message de synthese court qui liste la reason + nombre d'alertes
  // comptabilisees dans la fenetre glissante 1min. Pas de body SMS, pas
  // de phoneLast4 — c'est une alerte agregee, les details individuels
  // vivent dans `inbound_messages_orphans/`.
  const blocks =
    decision.kind === "send_digest"
      ? buildDigestBlocks({
          reason: input.reason,
          suppressed: decision.suppressed_in_window,
          dashboardUrl: input.dashboardUrl,
        })
      : buildInboundOnInactiveConversationBlocks(normalizedInput);

  const channel = input.target.kind === "dm" ? input.target.slackUserId : input.target.channelId;

  // `text` de fallback pour clients Slack sans Block Kit. Reprend l'en-tete
  // de la reason (toujours scrubber-safe par construction : pas de PII).
  const fallbackText =
    decision.kind === "send_digest"
      ? `Vague d'alertes orphelines ${input.reason} (synthese)`
      : HEADERS_BY_REASON[input.reason];

  const client = getSlackClient();

  let result;
  try {
    result = await client.chat.postMessage({
      channel,
      text: fallbackText,
      blocks,
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
      reason: input.reason,
      wasOptOut: input.wasOptOut,
      decisionKind: decision.kind,
    },
    "Inbound-on-inactive-conversation Slack notification sent",
  );

  return {
    ts: result.ts,
    channel: result.channel,
    kind: decision.kind === "send_digest" ? "send_digest" : "send",
  };
}
