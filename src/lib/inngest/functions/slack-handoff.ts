/**
 * Inngest function `slack-handoff` — hand-off Slack d'un lead INTERESSE (S9.9-PR5b).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * VUE D'ENSEMBLE
 *
 * Consume `medere/handoff.requested` (émis par `process-reply` step 8e
 * S9.9-PR4 sur branche INTERESSE) et route le lead vers :
 *   - **DM Slack au commercial propriétaire** (owner HubSpot ACTUEL →
 *     commercial Airtable actif → DM Slack) — chemin nominal
 *   - **Canal orphelins Slack** (fallback si owner absent/inactif/HubSpot
 *     ou Airtable indisponible) — le lead reste actionnable manuellement
 *     par le commercial team qui monitore le canal.
 *
 * **Invariant produit** : un lead INTERESSE ne doit JAMAIS être perdu
 * silencieusement. Toutes les pannes HubSpot/Airtable basculent en
 * orphelins (dégradé mais visible). Slack down = seule cause de fonction
 * failed retryée par Inngest cloud jusqu'à recovery.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * PIPELINE 8 STEPS
 *
 *   0. `check-already-handoff`      : `getConversation(convId)`.
 *                                     - conv absente → throw `NotFoundError`
 *                                     - conv.status === "handed_off" → log +
 *                                       early return `{status:
 *                                       "already_handed_off"}` (sentinelle
 *                                       replay >60s au-delà de la dédup
 *                                       native Inngest sur `event.id`).
 *                                     - sinon → continue.
 *
 *   1. `load-contact`                : `getContact(contactId)`.
 *                                     - null → throw `NotFoundError`
 *                                       (anomalie : le contact existait à
 *                                       T0 de l'émission handoff.requested,
 *                                       retry Inngest peut résoudre un
 *                                       blip Firestore transient).
 *                                     - présent → `{firstName, speciality,
 *                                       city}` (extraits du Contact).
 *
 *   2. `load-last-inbound`           : `listRecentMessages(convId, 5)`
 *                                      filtré `direction === "inbound"`
 *                                      `.at(-1)?.body ?? ""`.
 *                                     - vide → `""` + log warn (dégradé
 *                                       mais pas bloquant, le module Slack
 *                                       rendra un blockquote vide).
 *                                     - troncature à 300 chars = downstream
 *                                       `sendHandoffNotification` PR3.
 *
 *   3. `resolve-owner-hubspot`       : `getContactOwnerId(contactId)` — nouveau
 *                                      helper HubSpot S9.9-PR5b, data-min
 *                                      (que `hubspot_owner_id`).
 *                                     - 🔒 CATCH INTERNE : throw HubSpot →
 *                                       log error + retour `{ok: false}`.
 *                                       Pas de retry Inngest (blast radius
 *                                       limité, orphelins = fallback légitime).
 *                                     - ok+ownerId=null → contact sans owner
 *                                       assigné → orphelins reason=`no_owner`.
 *                                     - ok+ownerId=string → passe step 4.
 *
 *   4. `resolve-commercial-airtable` : `resolveCommercialByOwnerId(ownerId)`
 *                                      (S9.9-PR2 Airtable).
 *                                     - Court-circuit interne si step 3
 *                                       `{ok: false}` OU `ownerId === null`
 *                                       → `{ok: true, commercial: null}` pour
 *                                       nom stable de step + trace Inngest
 *                                       lisible.
 *                                     - 🔒 CATCH INTERNE : throw Airtable →
 *                                       log error + retour `{ok: false}`.
 *                                     - commercial=null → owner sans ligne
 *                                       Airtable → orphelins reason=
 *                                       `commercial_not_found`.
 *                                     - commercial.active=false → orphelins
 *                                       reason=`commercial_inactive`.
 *                                     - commercial actif → DM.
 *
 *   5. `decide-route`                : PURE (pas de `step.run`, pas de I/O).
 *                                      Discrimine sur (step3, step4) →
 *                                      `{type: "dm", commercial} |
 *                                       {type: "orphan", reason}`.
 *
 *   6. `slack-notify`                : `sendHandoffNotification({target, ...})`
 *                                      (S9.9-PR3 Slack).
 *                                     - target = DM (slackUserId) OU channel
 *                                       (SLACK_ORPHAN_LEADS_CHANNEL_ID).
 *                                     - PAS de catch → throw propage →
 *                                       Inngest retry naturel (Slack down =
 *                                       seul cas où on attend).
 *                                     - Retour `{ts, channel}` mémoizé.
 *
 *   7a. `persist-handoff-dm`         : (branche DM uniquement)
 *                                      `setHandoff(convId, slackUserId,
 *                                       HANDOFF_NOTES)`. La tx pose auto
 *                                      audit `handoff` (S6.4).
 *                                     - Catch `ConflictError` → no-op
 *                                       idempotent (déjà handed_off par
 *                                       une race concurrente).
 *                                     - Autre erreur → propage → retry
 *                                       (Firestore blip transient).
 *
 *   7b. `audit-handoff-unassigned`   : (branche orphan uniquement)
 *                                      `appendAuditLog({action:
 *                                      "handoff_unassigned", payload:
 *                                       HandoffUnassignedPayload})`.
 *                                     - PAS de `setHandoff` — la conv
 *                                       reste `status="in_dialogue"` avec
 *                                       `intent="INTERESSE"`. Le commercial
 *                                       team peut reassigner manuellement.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ORDRE CRITIQUE — slack-notify AVANT persist-and-audit (D1)
 *
 * Le SMS auto au PS est déjà parti (step 8d process-reply PR4). Ici la
 * priorité est : **le commercial est PRÉVENU** > la conv est marquée
 * handed_off en Firestore.
 *
 * Si on inversait : setHandoff commit → Slack notify échoue → retry →
 * setHandoff throw `ConflictError` → catch → retry Slack → sur succès
 * Slack, la conv est handed_off mais le commercial vient d'être notifié
 * après une fenêtre où il "possédait" un lead sans le savoir. UX terrible.
 *
 * Ordre actuel : Slack notify → setHandoff. Si Slack succeed + setHandoff
 * throw non-Conflict → Inngest retry → step 6 servi depuis cache
 * memoization (pas de double notif) → step 7a réessaie setHandoff. Le
 * commercial est déjà notifié, on rattrape le persist.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * IDEMPOTENCE — 3 filets superposés
 *
 *   1. **Dédup 60s Inngest** — `event.id = "handoff.${draftMessageId}"`
 *      (PR4 émetteur). Re-livraisons < 60s dédupées à l'ingestion.
 *
 *   2. **Memoization step.run par (eventId, stepName)** — Inngest retry
 *      intra-event ne rejoue pas les steps déjà commit. Slack notif
 *      succeed = 1 seul `chat.postMessage` même sur 3 retries.
 *
 *   3. **Step 0 `check-already-handoff`** — protège les re-livraisons > 60s
 *      (fenêtre dédup expirée). Si conv déjà handed_off → early return.
 *
 *   4. **`setHandoff` throw `ConflictError`** — filet ultime : deux runs
 *      concurrents sur la MÊME conv, le 2ème throw → catch → no-op.
 *
 * Limitation MVP connue (D3) : replay orphelins > 60s ne détecte PAS
 * l'audit précédent → re-notif possible dans le canal orphelins. Impact
 * = 2 pings visibles, dédup humain par le commercial team. Non compliance.
 * Mitigation future (PR6+) : flag `conv.handoff.orphanNotifiedAt`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ANTI-PII logs (strict)
 *
 * Loggables (scrubber-safe) :
 *   - `eventId`, `contactId`, `conversationId`, `draftMessageId`
 *   - `step`, `route.type`, `route.reason` (enums fermés)
 *   - `slackTs`, `slackChannel` (IDs Slack workspace, opaques)
 *   - `service` = "hubspot" | "airtable" | "slack" (constantes)
 *
 * INTERDITS :
 *   - `firstName`, `speciality`, `city`, `lastInboundBody` (PII PS)
 *   - `hubspotOwnerId` (semi-PII CRM, à hasher si besoin de trace forensic
 *      dans un audit — pour l'instant pas nécessaire)
 *   - `slackUserId` du commercial dans les logs applicatifs — c'est dans
 *      les audits Firestore uniquement (targetId `setHandoff` + payload
 *      `handoff_unassigned` avec Slack IDs qui sont OK par convention
 *      workspace)
 */
import { type Commercial, resolveCommercialByOwnerId } from "@/lib/airtable/commerciaux";
import { appendAuditLog } from "@/lib/firestore/audit-log";
import { getContact } from "@/lib/firestore/contacts";
import { getConversation, setHandoff } from "@/lib/firestore/conversations";
import { listRecentMessages } from "@/lib/firestore/messages";
import { getContactOwnerId } from "@/lib/hubspot/contacts";
import { getInngestClient } from "@/lib/inngest/client";
import { handoffRequested } from "@/lib/inngest/events";
import { getCoreEnv, getSlackEnv } from "@/lib/security/env";
import { sendHandoffNotification } from "@/lib/slack/notify-handoff";
import { ConfigError, ConflictError, NotFoundError } from "@/lib/utils/errors";
import type { HandoffUnassignedPayload, HandoffUnassignedReason } from "@/types/audit-log";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ID Inngest stable de la function. Modifier après le 1er déploiement =
 * perte d'historique côté cloud. Verrouillé par sentinelle test.
 */
const FUNCTION_ID = "slack-handoff";

/**
 * Notes forensiques attachées à `setHandoff` (branche DM). Contrainte
 * downstream : `notes.length >= 10` (validation `setHandoff` S6.4). Pas
 * de PII — constante fixe, pas d'injection dynamique (D7).
 *
 * 🔒 SENTINEL — verrouillé par test.
 */
const HANDOFF_NOTES = "Hand-off auto INTERESSE via Léa (S9.9)";

/**
 * Fallback si `NEXT_PUBLIC_APP_URL` absent (D5). URL Vercel prod fixe.
 * Warning loggé côté handler quand le fallback est utilisé — surface le
 * problème sans bloquer la feature.
 */
const DASHBOARD_URL_FALLBACK = "https://medere-prospection.vercel.app";

/**
 * Nombre de messages récents chargés pour extraire le dernier inbound.
 * 5 = généreux (couvre les cas où le PS envoie 2-3 SMS d'affilée + le
 * SMS auto déjà envoyé step 8d process-reply). La troncature à 300 chars
 * du body est faite downstream par `sendHandoffNotification` PR3.
 */
const LAST_INBOUND_HISTORY_LIMIT = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Types de retour du handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Résultat du pipeline `slack-handoff`. Discriminé sur `status` :
 *   - `already_handed_off` : replay >60s, court-circuit step 0.
 *   - `dm`                 : DM au commercial owner-actif. `setHandoff` OK
 *                            OU déjà en place (ConflictError catché idempotent).
 *   - `orphan`             : canal orphelins. `reason` discrimine la cause.
 */
export type SlackHandoffResult =
  | { status: "already_handed_off" }
  | {
      status: "dm";
      slackUserId: string;
      slackTs: string;
      slackChannel: string;
    }
  | {
      status: "orphan";
      reason: HandoffUnassignedReason;
      slackTs: string;
      slackChannel: string;
    };

// ─────────────────────────────────────────────────────────────────────────────
// Injection de dépendances (pattern process-reply / pre-send-check)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Injection optionnelle des dépendances pour tests unit. En production,
 * ne pas fournir — les implémentations réelles sont utilisées.
 *
 * @internal Public uniquement pour le testing.
 */
export interface SlackHandoffDeps {
  getConversation?: typeof getConversation;
  getContact?: typeof getContact;
  listRecentMessages?: typeof listRecentMessages;
  getContactOwnerId?: typeof getContactOwnerId;
  resolveCommercialByOwnerId?: typeof resolveCommercialByOwnerId;
  sendHandoffNotification?: typeof sendHandoffNotification;
  setHandoff?: typeof setHandoff;
  appendAuditLog?: typeof appendAuditLog;
  /**
   * Lecture optionnelle de `SLACK_ORPHAN_LEADS_CHANNEL_ID`. Injectable
   * pour tests sans avoir à mocker `getSlackEnv` global.
   */
  getOrphanChannelId?: () => string | undefined;
  /**
   * Lecture optionnelle de `NEXT_PUBLIC_APP_URL`. Injectable pour tests.
   */
  getDashboardBaseUrl?: () => string | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Forme du contexte Inngest reçu par le handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Forme minimale du contexte Inngest. Typage volontairement large — Inngest
 * type-check au site de `createFunction()`. Permet la fabrication d'un fake
 * context en tests.
 */
export interface SlackHandoffHandlerContext {
  event: {
    id?: string;
    name: string;
    data: {
      contactId: string;
      conversationId: string;
      draftMessageId: string;
    };
  };
  step: {
    run: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  };
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler — exporté pour tests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handler du pipeline `slack-handoff`. Voir JSDoc en-tête du fichier pour
 * le détail des 8 steps.
 */
export async function slackHandoffHandler(
  ctx: SlackHandoffHandlerContext,
  deps: SlackHandoffDeps = {},
): Promise<SlackHandoffResult> {
  const _getConversation = deps.getConversation ?? getConversation;
  const _getContact = deps.getContact ?? getContact;
  const _listRecentMessages = deps.listRecentMessages ?? listRecentMessages;
  const _getContactOwnerId = deps.getContactOwnerId ?? getContactOwnerId;
  const _resolveCommercial = deps.resolveCommercialByOwnerId ?? resolveCommercialByOwnerId;
  const _sendHandoffNotification = deps.sendHandoffNotification ?? sendHandoffNotification;
  const _setHandoff = deps.setHandoff ?? setHandoff;
  const _appendAuditLog = deps.appendAuditLog ?? appendAuditLog;
  const _getOrphanChannelId =
    deps.getOrphanChannelId ?? (() => getSlackEnv().SLACK_ORPHAN_LEADS_CHANNEL_ID);
  const _getDashboardBaseUrl = deps.getDashboardBaseUrl ?? (() => getCoreEnv().NEXT_PUBLIC_APP_URL);

  const { event, step, logger } = ctx;
  const { contactId, conversationId, draftMessageId } = event.data;

  logger.info("[slack-handoff] received", {
    eventId: event.id,
    name: event.name,
    contactId,
    conversationId,
    draftMessageId,
  });

  // ── Step 0 — check-already-handoff (sentinelle replay >60s) ───────────
  const alreadyHandedOff = await step.run("check-already-handoff", async () => {
    const conv = await _getConversation(conversationId);
    if (conv === null) {
      // Anomalie : la conv existait à l'émission handoff.requested (sinon
      // process-reply n'aurait pas généré de draft). Retry Inngest peut
      // résoudre un blip Firestore transient. Sinon fonction failed →
      // admin investigate.
      throw new NotFoundError({
        message: "slack-handoff: conversation not found",
        context: { conversationId },
      });
    }
    return conv.status === "handed_off";
  });

  if (alreadyHandedOff) {
    logger.info("[slack-handoff] already_handed_off — replay ignored", {
      eventId: event.id,
      contactId,
      conversationId,
    });
    return { status: "already_handed_off" };
  }

  // ── Step 1 — load-contact ─────────────────────────────────────────────
  const contactData = await step.run("load-contact", async () => {
    const contact = await _getContact(contactId);
    if (contact === null) {
      throw new NotFoundError({
        message: "slack-handoff: contact not found",
        context: { contactId },
      });
    }
    return {
      firstName: contact.firstName,
      speciality: contact.speciality,
      city: contact.city,
    };
  });

  // ── Step 2 — load-last-inbound ────────────────────────────────────────
  const lastInboundBody = await step.run("load-last-inbound", async () => {
    const history = await _listRecentMessages(conversationId, LAST_INBOUND_HISTORY_LIMIT);
    const lastInbound = history.filter((m) => m.direction === "inbound").at(-1);
    if (lastInbound === undefined) {
      // Anormal : le hand-off est émis en step 8e process-reply APRÈS store-inbound
      // step 4. Il devrait TOUJOURS y avoir un inbound. Race improbable possible
      // (cleanup, migration). Dégradé mais pas bloquant : Slack rendra un
      // blockquote vide.
      logger.warn("[slack-handoff] no inbound found — passing empty body", {
        eventId: event.id,
        contactId,
        conversationId,
      });
      return "";
    }
    return lastInbound.body;
  });

  // ── Step 3 — resolve-owner-hubspot (catch INTERNE, pas de retry Inngest) ─
  const ownerStep = await step.run("resolve-owner-hubspot", async () => {
    try {
      const ownerId = await _getContactOwnerId(contactId);
      return { ok: true as const, ownerId };
    } catch {
      logger.error("[slack-handoff] HubSpot unavailable — fallback orphan", {
        eventId: event.id,
        contactId,
        service: "hubspot",
      });
      return { ok: false as const };
    }
  });

  // ── Step 4 — resolve-commercial-airtable (catch INTERNE) ──────────────
  const commercialStep = await step.run("resolve-commercial-airtable", async () => {
    // Court-circuit interne si upstream ko OU pas d'owner → nom de step
    // stable + trace Inngest lisible (le step apparaît toujours dans le
    // cloud, même s'il no-op).
    if (!ownerStep.ok || ownerStep.ownerId === null) {
      return { ok: true as const, commercial: null as Commercial | null };
    }
    try {
      const commercial = await _resolveCommercial(ownerStep.ownerId);
      return { ok: true as const, commercial };
    } catch {
      logger.error("[slack-handoff] Airtable unavailable — fallback orphan", {
        eventId: event.id,
        service: "airtable",
      });
      return { ok: false as const };
    }
  });

  // ── Step 5 — decide-route (PURE, pas de step.run) ─────────────────────
  const route: RouteDecision = decideRoute({ ownerStep, commercialStep });

  logger.info("[slack-handoff] route decided", {
    eventId: event.id,
    contactId,
    conversationId,
    routeType: route.type,
    ...(route.type === "orphan" ? { reason: route.reason } : {}),
  });

  // Pré-résolution de la target Slack — fail-fast avant step 6 si orphan
  // sans channel configuré. Extraire dans une const permet à TS de narrow
  // proprement (union `{kind:"dm",...} | {kind:"channel",...}`) sans
  // recourir à un non-null assertion dans le closure step.run.
  const target: { kind: "dm"; slackUserId: string } | { kind: "channel"; channelId: string } =
    route.type === "dm"
      ? { kind: "dm", slackUserId: route.commercial.slackUserId }
      : (() => {
          const chan = _getOrphanChannelId();
          if (chan === undefined || chan === "") {
            throw new ConfigError({
              message:
                "slack-handoff: SLACK_ORPHAN_LEADS_CHANNEL_ID missing, cannot route orphan lead",
              context: { conversationId, reason: route.reason },
            });
          }
          return { kind: "channel", channelId: chan };
        })();

  // ── Step 6 — slack-notify (throw propage → Inngest retry) ─────────────
  const dashboardBase = _getDashboardBaseUrl();
  if (dashboardBase === undefined || dashboardBase === "") {
    logger.warn("[slack-handoff] NEXT_PUBLIC_APP_URL missing — using Vercel fallback", {
      eventId: event.id,
    });
  }
  const dashboardBaseResolved =
    dashboardBase !== undefined && dashboardBase !== "" ? dashboardBase : DASHBOARD_URL_FALLBACK;
  const dashboardUrl = `${dashboardBaseResolved}/conversations/${conversationId}`;

  const notifyResult = await step.run("slack-notify", async () => {
    return _sendHandoffNotification({
      target,
      firstName: contactData.firstName,
      speciality: contactData.speciality,
      city: contactData.city,
      lastInboundBody,
      conversationId,
      isOrphan: route.type === "orphan",
      dashboardUrl,
    });
  });

  logger.info("[slack-handoff] notification posted", {
    eventId: event.id,
    contactId,
    conversationId,
    routeType: route.type,
    slackTs: notifyResult.ts,
    slackChannel: notifyResult.channel,
  });

  // ── Step 7 — persist-and-audit (branché) ──────────────────────────────
  if (route.type === "dm") {
    // Branche DM : setHandoff → audit `handoff` posé auto en tx.
    // Catch ConflictError : race concurrente ou re-livraison event >60s
    // avec conv déjà transitionnée par une exec précédente → no-op.
    await step.run("persist-handoff-dm", async () => {
      try {
        await _setHandoff(conversationId, route.commercial.slackUserId, HANDOFF_NOTES);
      } catch (err) {
        if (err instanceof ConflictError) {
          logger.info("[slack-handoff] handoff already exists — idempotent no-op", {
            eventId: event.id,
            conversationId,
          });
          return;
        }
        throw err;
      }
    });

    return {
      status: "dm",
      slackUserId: route.commercial.slackUserId,
      slackTs: notifyResult.ts,
      slackChannel: notifyResult.channel,
    };
  }

  // Branche orphan : audit `handoff_unassigned`, PAS de setHandoff.
  // La conv reste `status="in_dialogue"` avec `intent="INTERESSE"`.
  await step.run("audit-handoff-unassigned", async () => {
    const payload: HandoffUnassignedPayload = {
      contactId,
      conversationId,
      draftMessageId,
      reason: route.reason,
      slackTs: notifyResult.ts,
      slackChannel: notifyResult.channel,
    };
    await _appendAuditLog({
      actorId: "system",
      actorType: "system",
      action: "handoff_unassigned",
      targetType: "conversation",
      targetId: conversationId,
      payload,
    });
  });

  return {
    status: "orphan",
    reason: route.reason,
    slackTs: notifyResult.ts,
    slackChannel: notifyResult.channel,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Décision de routage (fonction pure)
// ─────────────────────────────────────────────────────────────────────────────

type OwnerStepResult = { ok: true; ownerId: string | null } | { ok: false };
type CommercialStepResult = { ok: true; commercial: Commercial | null } | { ok: false };

/**
 * Sortie discriminée de `decideRoute`. Union fermée sur `type` :
 *   - `"dm"`     : DM au `commercial` (garanti `active=true` +
 *                   `slackUserId` non vide par construction PR2).
 *   - `"orphan"` : fallback canal orphelins, `reason` discriminant.
 */
export type RouteDecision =
  | { type: "dm"; commercial: Commercial }
  | { type: "orphan"; reason: HandoffUnassignedReason };

/**
 * Discrimine la route à partir des résultats des steps 3 et 4. Pure —
 * pas d'I/O, pas de log, entièrement testable en isolation.
 *
 * Ordre des checks (STRICT) :
 *   1. hubspot_unavailable > tout — sans owner_id on ne peut rien décider
 *   2. no_owner            — contact HubSpot sans owner assigné
 *   3. airtable_unavailable — même logique que #1 pour Airtable
 *   4. commercial_not_found — owner_id présent mais pas de ligne Airtable
 *   5. commercial_inactive  — ligne trouvée mais Statut ≠ "Actif"
 *   6. → DM au commercial actif
 */
export function decideRoute(input: {
  ownerStep: OwnerStepResult;
  commercialStep: CommercialStepResult;
}): RouteDecision {
  if (!input.ownerStep.ok) {
    return { type: "orphan", reason: "hubspot_unavailable" };
  }
  if (input.ownerStep.ownerId === null) {
    return { type: "orphan", reason: "no_owner" };
  }
  if (!input.commercialStep.ok) {
    return { type: "orphan", reason: "airtable_unavailable" };
  }
  if (input.commercialStep.commercial === null) {
    return { type: "orphan", reason: "commercial_not_found" };
  }
  if (!input.commercialStep.commercial.active) {
    return { type: "orphan", reason: "commercial_inactive" };
  }
  return { type: "dm", commercial: input.commercialStep.commercial };
}

// ─────────────────────────────────────────────────────────────────────────────
// Function Inngest — wrap autour du handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inngest function `slack-handoff` — pipeline 8 steps distincts (7
 * `step.run` + 1 branche `decide-route` pure).
 *
 * **Trigger** : event `medere/handoff.requested` (`HandoffRequestedDataSchema`).
 *
 * **Retries** : 3 (= default Inngest v4.x, EXPLICITE pour visibilité). Couvre :
 *   - blip Firestore transient sur `getConversation` / `getContact` /
 *     `setHandoff` / `appendAuditLog`
 *   - Slack 5xx transient sur `chat.postMessage`
 *
 * Ne couvre PAS (catch INTERNE au step) :
 *   - HubSpot down → orphelins immédiat
 *   - Airtable down → orphelins immédiat
 *   (D2 : un lead ne doit pas attendre 3× exp-backoff pour être routé.)
 *
 * **Handler** : `slackHandoffHandler` (exporté pour tests).
 */
export const slackHandoff = getInngestClient().createFunction(
  {
    id: FUNCTION_ID,
    triggers: [{ event: handoffRequested }],
    retries: 3,
  },
  slackHandoffHandler,
);

// ─────────────────────────────────────────────────────────────────────────────
// Exposés pour tests sentinelles
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export const __FUNCTION_ID_FOR_TESTS = FUNCTION_ID;

/** @internal */
export const __HANDOFF_NOTES_FOR_TESTS = HANDOFF_NOTES;

/** @internal */
export const __DASHBOARD_URL_FALLBACK_FOR_TESTS = DASHBOARD_URL_FALLBACK;

/** @internal */
export const __LAST_INBOUND_HISTORY_LIMIT_FOR_TESTS = LAST_INBOUND_HISTORY_LIMIT;
