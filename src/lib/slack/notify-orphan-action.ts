/**
 * Résolution + envoi de la notification Slack pour les actions admin
 * sur un orphan (PR2c tour 2a bis + bloc C sexies — format dédié).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Discipline de routage (UNE SEULE fonction, réutilisable par PR4)
 *
 *   1. Acteur `testAccount` → SLACK_TEST_CHANNEL_ID. Si la var manque,
 *      RIEN n'est envoyé + `logger.error` ; JAMAIS de repli vers un vrai
 *      destinataire (sinon un compte e2e polluerait le workspace prod).
 *   2. Sinon, si `conversation.handoff.assignedTo` existe (quel que soit
 *      le statut de la conv) → DM au titulaire.
 *   3. Sinon → canal orphelins (SLACK_ORPHAN_LEADS_CHANNEL_ID, requis
 *      en prod et preview par `getSlackEnv()`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Format dédié rattachement (PR2c tour 2b bloc C sexies)
 *
 *   On n'utilise plus `buildInboundAfterHandoffBlocks` (qui parle de
 *   « nouveau message ») — à la place `buildOrphanAttachedBlocks` qui dit
 *   explicitement « SMS rattaché manuellement », porte le nom de l'admin,
 *   la date de réception D'ORIGINE (pas celle du clic), et la mention
 *   « Désabonnement appliqué » quand opt-out. Le post Slack reste un
 *   `chat.postMessage` direct avec la même discipline anti-unfurl que
 *   `sendInboundAfterHandoffNotification`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * URL du lien dashboard
 *
 *   `getDashboardConversationUrl(conversationId)` → `/admin/conversations/<id>`.
 *   Pointe la CONVERSATION où le SMS vient d'être rattaché, en cohérence
 *   avec le libellé « Voir la conversation ». Avant le fix bloc C sexies,
 *   le lien pointait vers `/admin/orphan-inbounds?id=...` — libellé
 *   trompeur, régression harnais e2e sur preview `c6ac6f0`.
 */
import { getSlackEnv } from "@/lib/security/env";
import { logger } from "@/lib/utils/logger";

import { getDashboardConversationUrl } from "./dashboard-url";
import { buildOrphanAttachedBlocks } from "./format-orphan-attached";
import { resolveTargetKind } from "./orphan-notify-target";
import { sendSlackBlocks } from "./send-slack-blocks";

/**
 * Pur, sans I/O — résout la cible à utiliser pour une notif orphan.
 * Réutilisable par PR4 et testable sans mocker Slack.
 */
export type OrphanNotifyTarget =
  | { readonly kind: "dm"; readonly slackUserId: string }
  | {
      readonly kind: "channel";
      readonly channelId: string;
      readonly reason: "test" | "titulaire-absent";
    }
  | { readonly kind: "none"; readonly reason: "test_channel_missing" };

export interface ResolveOrphanNotifyTargetInput {
  readonly actorTestAccount: boolean;
  readonly assignedToSlackUserId: string | undefined;
  readonly testChannelId: string | undefined;
  readonly orphanChannelId: string;
}

export function resolveOrphanNotifyTarget(
  input: ResolveOrphanNotifyTargetInput,
): OrphanNotifyTarget {
  // Logique partagée avec `describeAttachNotifyTargetForUi` via la
  // fonction pure `resolveTargetKind` (bloc B — pas de duplication).
  const kind = resolveTargetKind({
    actorTestAccount: input.actorTestAccount,
    assignedToSlackUserId: input.assignedToSlackUserId,
    testChannelConfigured: input.testChannelId !== undefined && input.testChannelId.length > 0,
  });
  switch (kind) {
    case "test_channel":
      // `testChannelConfigured: true` ↔ `testChannelId` défini ET non-vide.
      return { kind: "channel", channelId: input.testChannelId as string, reason: "test" };
    case "test_channel_missing":
      // Fail-closed strict : jamais de repli vers un vrai destinataire.
      return { kind: "none", reason: "test_channel_missing" };
    case "dm_titulaire":
      return { kind: "dm", slackUserId: input.assignedToSlackUserId as string };
    case "orphan_channel":
      return {
        kind: "channel",
        channelId: input.orphanChannelId,
        reason: "titulaire-absent",
      };
  }
}

export interface OrphanAttachedNotifyInput {
  readonly actorTestAccount: boolean;
  readonly orphanDocId: string;
  readonly conversationId: string;
  readonly assignedToSlackUserId: string | undefined;
  readonly firstName: string | undefined;
  readonly speciality: string | undefined;
  readonly city: string | undefined;
  readonly lastInboundBody: string;
  readonly isOptOut: boolean;
  /**
   * Nom résolu de l'admin qui a rattaché (`<firstName> <lastName>` depuis
   * Clerk via `resolveAdminName`). `null` → le format tombe sur « un
   * administrateur ». JAMAIS le `userId` Clerk brut.
   */
  readonly adminName: string | null;
  /**
   * Date de réception D'ORIGINE de l'orphan (`AttachOrphanResult.originalReceivedAt`),
   * ISO 8601. Rendue en Paris par le builder. PAS la date de rattachement.
   */
  readonly originalReceivedAtIso: string;
}

export type OrphanNotifyResult =
  | {
      readonly kind: "sent";
      readonly target: OrphanNotifyTarget;
      readonly slackTs: string;
      readonly slackChannel: string;
    }
  | { readonly kind: "skipped"; readonly target: OrphanNotifyTarget }
  | { readonly kind: "failed"; readonly target: OrphanNotifyTarget; readonly errorName: string };

/**
 * Envoi best-effort — ne throw jamais (les erreurs Slack ne doivent pas
 * annuler l'audit transition qui est déjà commité).
 */
export async function notifyOrphanAttachedBestEffort(
  input: OrphanAttachedNotifyInput,
): Promise<OrphanNotifyResult> {
  const slackEnv = getSlackEnv();

  const target = resolveOrphanNotifyTarget({
    actorTestAccount: input.actorTestAccount,
    assignedToSlackUserId: input.assignedToSlackUserId,
    testChannelId: slackEnv.SLACK_TEST_CHANNEL_ID,
    orphanChannelId: slackEnv.SLACK_ORPHAN_LEADS_CHANNEL_ID,
  });

  if (target.kind === "none") {
    logger.error(
      {
        service: "slack",
        orphanDocId: input.orphanDocId,
        reason: target.reason,
      },
      "[notifyOrphanAttachedBestEffort] SLACK_TEST_CHANNEL_ID missing for testAccount actor — notification SKIPPED (no fallback to real channel)",
    );
    return { kind: "skipped", target };
  }

  const blocks = buildOrphanAttachedBlocks({
    firstName: input.firstName ?? "",
    speciality: input.speciality ?? "",
    city: input.city ?? "",
    lastInboundBody: input.lastInboundBody,
    adminName: input.adminName,
    originalReceivedAtIso: input.originalReceivedAtIso,
    isOptOut: input.isOptOut,
    // PR2c tour 2b bloc C sexies — lien vers la CONVERSATION (fix du
    // lien trompeur). Fonction UNIQUE `getDashboardConversationUrl`.
    dashboardUrl: getDashboardConversationUrl(input.conversationId),
  });

  const fallbackText = input.isOptOut
    ? "SMS orphelin rattaché — demande d'arrêt (STOP)"
    : "SMS orphelin rattaché à une conversation";

  try {
    // Wire layer UNIQUE (bloc C octies) : validation DM, postMessage
    // anti-unfurl, mapping d'erreurs, log sans PII. Partagé avec
    // `sendInboundAfterHandoffNotification`.
    const result = await sendSlackBlocks({
      target:
        target.kind === "dm"
          ? { kind: "dm", slackUserId: target.slackUserId }
          : { kind: "channel", channelId: target.channelId },
      fallbackText,
      blocks,
      logEvent: "Orphan-attached Slack notification sent",
      logContext: { isOptOut: input.isOptOut },
    });
    return {
      kind: "sent",
      target,
      slackTs: result.ts,
      slackChannel: result.channel,
    };
  } catch (err) {
    logger.error(
      {
        errName: err instanceof Error ? err.name : "unknown",
        targetKind: target.kind,
      },
      "[notifyOrphanAttachedBestEffort] Slack notif failed (silent)",
    );
    return {
      kind: "failed",
      target,
      errorName: err instanceof Error ? err.name : "unknown",
    };
  }
}
