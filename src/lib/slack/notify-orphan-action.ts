/**
 * Résolution + envoi de la notification Slack pour les actions admin
 * sur un orphan (PR2c tour 2a bis).
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
 * On ne retourne JAMAIS `"skipped"` dans les cas 2/3 : un acteur réel
 * reçoit toujours quelque chose quelque part. Seul le cas 1 avec var
 * manquante produit un no-op audible via logger.error.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Envoi
 *
 *   L'envoi passe TOUJOURS par `sendInboundAfterHandoffNotification` —
 *   la seule fonction Slack du projet qui construit des blocks avec le
 *   bon échappement mrkdwn (`buildInboundAfterHandoffBlocks` escape déjà
 *   les `<`, `>`, `&`, `*`, `_` et `` ` `` du body PS pour éviter l'injection
 *   mrkdwn Slack). Pas de post direct `chat.postMessage` ici — on
 *   réutilise la cible `kind: "channel"` ajoutée au type `InboundAfterHandoffTarget`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * URL du lien dashboard
 *
 *   `getDashboardOrphanDetailUrl(orphanDocId)` → `/admin/orphan-inbounds?id=...`.
 *   Pointe la fiche détail de l'orphan rattaché (pas la conv destinataire)
 *   pour permettre à l'admin de revoir le contexte de rattachement.
 */
import { getSlackEnv } from "@/lib/security/env";
import { logger } from "@/lib/utils/logger";

import { getDashboardOrphanDetailUrl } from "./dashboard-url";
import { sendInboundAfterHandoffNotification } from "./notify-inbound-after-handoff";
import { resolveTargetKind } from "./orphan-notify-target";

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

  try {
    const result = await sendInboundAfterHandoffNotification({
      target:
        target.kind === "dm"
          ? { kind: "dm", slackUserId: target.slackUserId }
          : { kind: "channel", channelId: target.channelId },
      firstName: input.firstName ?? "",
      speciality: input.speciality ?? "",
      city: input.city ?? "",
      lastInboundBody: input.lastInboundBody,
      conversationId: input.conversationId,
      isOptOut: input.isOptOut,
      // PR2c tour 2a bis — lien vers la fiche orphan dans le dashboard,
      // construit par l'unique fonction d'URL dashboard.
      dashboardUrl: getDashboardOrphanDetailUrl(input.orphanDocId),
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
