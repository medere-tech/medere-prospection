/**
 * POST /api/webhooks/ovh-sms — endpoint webhook OVH pour les SMS entrants
 * (S9.6, ticket Notion INFRA-SMS-001).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rôle
 *
 * Reçoit les SMS entrants (réponses des PS) émis par OVH sur le numéro
 * Time2Chat `+33939070545` (service `sms-ng66707-1`), les parse, et émet
 * l'event Inngest typé `medere/sms.reply.received` consommé par le
 * pipeline `process-reply` (`src/lib/inngest/functions/process-reply.ts`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Chaîne de traitement (PR-NO-DROPPED-SMS)
 *
 *   1. Vérification token EN PREMIER (`verifyOvhWebhookToken`).
 *   2. Si token invalide → rate-limit anti-bruteforce (bucket dédié) →
 *      429 OU 401. Sentry warning avec compteur (W2) pour détecter une
 *      rotation mal faite.
 *   3. Si token valide → compteur anomalie `>300/min` sans jamais bloquer
 *      (W1). Les appels authentifiés OVH ne sont jamais rate-limités.
 *   4. Lecture body brut en mémoire via `req.text()` (une seule fois,
 *      réutilisable pour la persistance orphan en cas d'échec parse).
 *   5. Parse transport (JSON ou form-urlencoded) + parse Zod. Échec →
 *      stocke le payload brut dans `inbound_messages_orphans/`
 *      (reason="parse_failed", docId = `safeExternalIdHash(raw)`) +
 *      alerte canal Slack orphelins + Sentry error + répond 200.
 *      (W3/W4) Aucun SMS entrant ne doit plus être perdu, même sur un
 *      payload transport corrompu.
 *   6. `inngest.send` avec id déterministe. Échec → stocke best-effort
 *      en orphans (reason="enqueue_failed") + alerte canal + Sentry
 *      error + répond 500 (OVH retry naturellement). W5/W6.
 *   7. 200 ok si tout a réussi.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ANTI-PII — logs
 *
 * Logger Pino scrube `body` / `phone` (PII_KEYS). Discipline : on log
 * `bodyLength`/`ovhMessageIdFingerprint`, pas les valeurs brutes.
 * `safePhoneHash` (préfixe `hph_`) pour les cas où l'audit a besoin
 * d'un identifiant stable.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ANTI-LEAK — réponses HTTP
 *
 * Toute réponse d'erreur utilise un message générique — jamais le body
 * brut de la requête, jamais le détail Zod, jamais le sender.
 */
import { type NextRequest, NextResponse } from "next/server";

import { isOptOut } from "@/lib/compliance/opt-out";
import { appendAuditLog } from "@/lib/firestore/audit-log";
import { addOrphanInboundIdempotent } from "@/lib/firestore/orphan-inbounds";
import { getInngestClient } from "@/lib/inngest/client";
import { smsReplyReceived } from "@/lib/inngest/events";
import { parseIncomingOvhSms } from "@/lib/ovh/parse-incoming";
import { getCoreEnv, getOvhEnv, getSlackEnv } from "@/lib/security/env";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { verifyOvhWebhookToken } from "@/lib/security/webhook-signatures";
import { sendInboundOnInactiveConversationNotification } from "@/lib/slack/notify-inbound-on-inactive-conversation";
import { ValidationError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";
import { captureMonitoringWarning } from "@/lib/utils/observability";
import { hashPii, safeExternalIdHash, safePhoneHash } from "@/lib/utils/pii-detector";
import { shortFingerprint } from "@/lib/utils/short-fingerprint";
import type {
  InboundOnInactiveConversationPayload,
  InboundOnInactiveConversationReason,
  InboundOnInactiveNotifiedVia,
} from "@/types/audit-log";

// ─────────────────────────────────────────────────────────────────────────────
// Rate-limiters — buckets dédiés
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rate-limit APPLIQUÉ sur les appels AVEC TOKEN INVALIDE uniquement
 * (anti-bruteforce). Les appels authentifiés OVH ne sont jamais limités
 * (W1). Fail-closed par IP.
 */
const unauthRateLimiter = createRateLimiter({
  limit: 10,
  window: "1 m",
  prefix: "ovh-webhook-unauth",
});

/**
 * Rate-limit OBSERVÉ sur les appels authentifiés — ne bloque JAMAIS, il
 * sert uniquement de compteur pour émettre une alerte Sentry si on
 * dépasse 300 req/min (anomalie trafic OVH). Fail-OPEN implicite : si
 * Upstash est HS, on continue à traiter les SMS, on perd juste le
 * monitoring (defense-in-depth).
 */
const authObservedRateLimiter = createRateLimiter({
  limit: 300,
  window: "1 m",
  prefix: "ovh-webhook-auth-observed",
  failureMode: "open",
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers privés
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extrait l'IP client depuis les headers Vercel/proxy. Fallback `"unknown"`.
 */
function extractClientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xri = req.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

interface RawPayload {
  rawBody: string;
  contentType: string;
  /** Parsed object OR null si parse transport a échoué. */
  parsed: Record<string, unknown> | null;
  parseError?: string;
}

/**
 * Lit le body brut en texte via `req.text()` (une seule fois), puis
 * tente un parse JSON ou form-urlencoded selon le Content-Type. Garde
 * TOUJOURS le rawBody pour persistance orphan en cas d'échec.
 */
async function readRawPayloadWithPreserved(req: NextRequest): Promise<RawPayload> {
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (err) {
    return {
      rawBody: "",
      contentType,
      parsed: null,
      parseError: err instanceof Error ? err.name : "transport-read-failed",
    };
  }

  // Form-urlencoded parse manuel via URLSearchParams (compatible avec le
  // body texte deja consomme).
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    // multipart ne se parse pas via URLSearchParams. On tente quand meme ;
    // s'il n'y a aucun `=` reconnu, les keys seront vides -> le parser Zod
    // en aval echouera et declenchera la branche orphans.
    try {
      const params = new URLSearchParams(rawBody);
      const obj: Record<string, unknown> = {};
      for (const [k, v] of params.entries()) {
        if (k === "id" && /^\d+$/.test(v)) {
          obj[k] = Number.parseInt(v, 10);
          continue;
        }
        if (k === "credits" && /^-?\d+$/.test(v)) {
          obj[k] = Number.parseInt(v, 10);
          continue;
        }
        obj[k] = v;
      }
      return { rawBody, contentType, parsed: obj };
    } catch (err) {
      return {
        rawBody,
        contentType,
        parsed: null,
        parseError: err instanceof Error ? err.name : "urlencoded-parse-failed",
      };
    }
  }

  // JSON par defaut (Content-Type absent, application/json, ou autre).
  if (rawBody.length === 0) {
    return { rawBody, contentType, parsed: {} };
  }
  try {
    const value: unknown = JSON.parse(rawBody);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return { rawBody, contentType, parsed: value as Record<string, unknown> };
    }
    return {
      rawBody,
      contentType,
      parsed: null,
      parseError: "non-object-json",
    };
  } catch (err) {
    return {
      rawBody,
      contentType,
      parsed: null,
      parseError: err instanceof Error ? err.name : "json-parse-failed",
    };
  }
}

/**
 * URL de fallback vers la future vue admin des orphans. Pour les cas
 * `parse_failed` / `enqueue_failed` ou aucun `conversationId` lisible, le
 * lien pointe vers une vue de triage admin (a creer en S11+ — pour
 * l'instant, un placeholder stable qui ne crashe pas Slack).
 */
function buildOrphansDashboardUrl(): string {
  const base = getCoreEnv().NEXT_PUBLIC_APP_URL ?? "https://medere-prospection.vercel.app";
  return `${base.replace(/\/+$/, "")}/admin/orphan-inbounds`;
}

/**
 * Notification canal orphelins pour les cas parse_failed / enqueue_failed.
 * Best-effort : si la notif Slack echoue, on log + continue sans throw
 * (le forensic est deja persiste dans `inbound_messages_orphans/`).
 *
 * Point 5 round 3 : plus de check `if (channelId === undefined)`.
 * `SLACK_ORPHAN_LEADS_CHANNEL_ID` est REQUIRED dans getSlackEnv() depuis
 * Finding 5 PR-NO-DROPPED-SMS — le boot throw ConfigError si absent.
 *
 * @returns `notifiedVia` effectif pour l'audit downstream.
 */
async function notifyOrphanChannelBestEffort(params: {
  reason: "parse_failed" | "enqueue_failed";
  lastInboundBody: string;
  orphanDocId: string;
  /**
   * Opt-out detecte dans le body (fix compliance-auditor HIGH Finding 1
   * PR-NO-DROPPED-SMS). Pour W5/W6 (enqueue_failed) le body est LISIBLE
   * -> le caller DOIT passer `isOptOut(eventData.body)`. Pour W3/W4
   * (parse_failed) le body est illisible -> le caller passe `false`.
   */
  wasOptOut: boolean;
  phoneLast4?: string;
  phoneHash?: string;
}): Promise<InboundOnInactiveNotifiedVia> {
  const slackEnv = getSlackEnv();
  const channelId = slackEnv.SLACK_ORPHAN_LEADS_CHANNEL_ID;
  try {
    const r = await sendInboundOnInactiveConversationNotification({
      target: { kind: "channel", channelId },
      reason: params.reason,
      wasOptOut: params.wasOptOut,
      lastInboundBody: params.lastInboundBody,
      dashboardUrl: buildOrphansDashboardUrl(),
      includeHereMention: true,
      orphanDocId: params.orphanDocId,
      ...(params.phoneLast4 !== undefined ? { phoneLast4: params.phoneLast4 } : {}),
    });
    // Point 2 round 3 : mapping precis decision.kind -> notifiedVia.
    if (r.kind === "send") return "orphan_channel";
    if (r.kind === "send_digest") return "digest";
    return "suppressed";
  } catch (err) {
    logger.error(
      {
        reason: params.reason,
        orphanDocId: params.orphanDocId,
        errName: err instanceof Error ? err.name : "unknown",
      },
      "[ovh-sms] orphan channel notification failed",
    );
    return "notify_failed";
  }
}

/**
 * Pose un audit `inbound_on_inactive_conversation` best-effort pour les
 * branches webhook (Finding 4 compliance-auditor PR-NO-DROPPED-SMS).
 *
 * Catch sans propager : l'audit est un complement forensic (le body est
 * deja persiste en `inbound_messages_orphans/`, le canal Slack a deja
 * notifie, Sentry a deja alerte). Un echec appendAuditLog ne doit JAMAIS
 * casser la reponse 200/500 OVH.
 *
 * Point 6 round 3 : en cas d'echec appendAuditLog -> captureMonitoringWarning
 * level=error pour signaler explicitement une perte d'audit (le forensic
 * doc orphan reste mais l'audit_log perd l'entree).
 */
async function recordWebhookOrphanAuditBestEffort(params: {
  reason: InboundOnInactiveConversationReason;
  orphanDocId: string;
  wasOptOut: boolean;
  notifiedVia: InboundOnInactiveNotifiedVia;
  phoneHash?: string;
}): Promise<void> {
  try {
    const payload: InboundOnInactiveConversationPayload = {
      reason: params.reason,
      wasOptOut: params.wasOptOut,
      orphanDocId: params.orphanDocId,
      notifiedVia: params.notifiedVia,
      ...(params.phoneHash !== undefined ? { phoneHash: params.phoneHash } : {}),
    };
    await appendAuditLog({
      actorId: "system",
      actorType: "system",
      action: "inbound_on_inactive_conversation",
      targetType: "message",
      targetId: params.orphanDocId,
      payload,
    });
  } catch (err) {
    const errName = err instanceof Error ? err.name : "unknown";
    logger.error(
      {
        reason: params.reason,
        orphanDocId: params.orphanDocId,
        errName,
      },
      "[ovh-sms] audit inbound_on_inactive_conversation failed (best-effort)",
    );
    // Point 6 round 3 : Sentry error pour que l'astreinte voie la perte
    // d'entree audit_log. Le forensic doc orphan reste disponible.
    captureMonitoringWarning("ovh_webhook.audit_failed", {
      level: "error",
      tags: { reason: params.reason, err_name: errName },
      extra: {
        orphanDocId: params.orphanDocId,
        wasOptOut: params.wasOptOut ? "true" : "false",
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler POST
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // ── 1. Vérif token OVH EN PREMIER (W1 PR-NO-DROPPED-SMS) ──────────────
    const expected = getOvhEnv().OVH_WEBHOOK_SECRET;
    const received = req.nextUrl.searchParams.get("token");
    const tokenValid = verifyOvhWebhookToken({ expected, received });

    const ip = extractClientIp(req);

    if (!tokenValid) {
      // ── W2 : token invalide → rate-limit anti-bruteforce + 401 + Sentry ─
      const rl = await unauthRateLimiter.check(`ip:${ip}`);
      if (!rl.success) {
        logger.warn(
          { rlReason: rl.reason, rlRemaining: rl.remaining },
          "[POST /api/webhooks/ovh-sms] rate-limit blocked (unauth)",
        );
        return NextResponse.json(
          {
            error: {
              code: "RATE_LIMITED",
              message: "Trop de requêtes. Réessayez plus tard.",
            },
          },
          {
            status: 429,
            headers: {
              "Retry-After": Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000)).toString(),
            },
          },
        );
      }
      captureMonitoringWarning("ovh_webhook.invalid_token", {
        level: "warning",
        tags: { has_token: received !== null ? "true" : "false" },
        extra: { ipFingerprint: shortFingerprint(ip) },
      });
      logger.warn(
        { hasToken: received !== null },
        "[POST /api/webhooks/ovh-sms] invalid or missing token",
      );
      return NextResponse.json(
        { error: { code: "UNAUTHORIZED", message: "Authentification requise." } },
        { status: 401 },
      );
    }

    // ── W1 : token valide → compteur observé (jamais bloquant) ───────────
    const observed = await authObservedRateLimiter.check(`ip:${ip}`);
    if (!observed.success) {
      captureMonitoringWarning("ovh_webhook.high_rate_authenticated", {
        level: "warning",
        tags: { bucket: "ovh-webhook-auth-observed" },
        extra: {
          ipFingerprint: shortFingerprint(ip),
          remaining: observed.remaining,
        },
      });
      // PAS de 429 — on continue à traiter le SMS.
    }

    // ── 2. Lecture body brut avec préservation (W3) ───────────────────────
    const payload = await readRawPayloadWithPreserved(req);

    // ── W3 : parse transport échoué (JSON malformé / formData corrompue) ─
    if (payload.parsed === null) {
      // Fix Finding 8 compliance-auditor : idempotencyKey deterministe
      // pour un payload vide (sinon chaque retry OVH cree un nouveau doc).
      const idempotencyKey = payload.rawBody.length > 0 ? payload.rawBody : "empty_payload";
      const orphanResult = await addOrphanInboundIdempotent({
        reason: "parse_failed",
        body: payload.rawBody,
        idempotencyKey,
        source: "webhook-ovh-sms",
      }).catch((err: unknown) => {
        logger.error(
          {
            errName: err instanceof Error ? err.name : "unknown",
          },
          "[ovh-sms] orphan persist failed on parse_failed",
        );
        return { docId: `orphan_parse_failed_${shortFingerprint(idempotencyKey)}`, created: false };
      });
      const notifiedViaW3 = await notifyOrphanChannelBestEffort({
        reason: "parse_failed",
        // Body illisible -> on ne peut pas detecter d'opt-out ici (le parse
        // a echoue avant la normalisation phone/body). wasOptOut=false
        // documentee par la signature.
        wasOptOut: false,
        lastInboundBody: payload.rawBody.length > 0 ? payload.rawBody : "(payload vide)",
        orphanDocId: orphanResult.docId,
      });
      captureMonitoringWarning("ovh_webhook.parse_failed", {
        level: "error",
        tags: { parse_error: payload.parseError ?? "unknown" },
        extra: {
          orphanDocId: orphanResult.docId,
          contentType: payload.contentType,
          rawBodyLength: payload.rawBody.length,
          created: orphanResult.created ? "true" : "false",
        },
      });
      // Finding 4 PR-NO-DROPPED-SMS : audit unifie avec le pipeline
      // (process-reply.ts handleInactiveInbound pose aussi
      // `inbound_on_inactive_conversation`). Best-effort.
      // Point 3 round 3 : propage le `notifiedVia` effectif (orphan_channel /
      // digest / suppressed / notify_failed) depuis notifyOrphanChannelBestEffort.
      await recordWebhookOrphanAuditBestEffort({
        reason: "parse_failed",
        orphanDocId: orphanResult.docId,
        wasOptOut: false,
        notifiedVia: notifiedViaW3,
      });
      // 200 : on ack a OVH pour eviter les retries en boucle. Le forensic
      // vit dans inbound_messages_orphans/ + audit_log + canal Slack + Sentry.
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    // ── 3. Parse Zod strict ──────────────────────────────────────────────
    let eventData;
    try {
      eventData = parseIncomingOvhSms(payload.parsed);
    } catch (err) {
      if (err instanceof ValidationError) {
        // W4 : Zod échoue (phone pas E.164, body manquant, etc.) → orphans.
        const idempotencyKey = payload.rawBody;
        const orphanResult = await addOrphanInboundIdempotent({
          reason: "parse_failed",
          body: payload.rawBody,
          idempotencyKey,
          source: "webhook-ovh-sms",
        }).catch((persistErr: unknown) => {
          logger.error(
            {
              errName: persistErr instanceof Error ? persistErr.name : "unknown",
            },
            "[ovh-sms] orphan persist failed on zod_parse_failed",
          );
          return {
            docId: `orphan_zod_failed_${shortFingerprint(idempotencyKey)}`,
            created: false,
          };
        });
        const notifiedViaW4 = await notifyOrphanChannelBestEffort({
          reason: "parse_failed",
          // W4 Zod echoue : phone pas E.164 ou body manquant.
          // L'invariant du parse Zod exige phone + body ensemble (cf.
          // SmsReplyReceivedDataSchema) ; si Zod rejette, on n'a aucune
          // garantie sur la forme de body -> ne pas tenter isOptOut sur
          // rawBody serializé. wasOptOut=false acte.
          wasOptOut: false,
          lastInboundBody: payload.rawBody,
          orphanDocId: orphanResult.docId,
        });
        captureMonitoringWarning("ovh_webhook.zod_parse_failed", {
          level: "error",
          tags: { parse_error: "zod" },
          extra: {
            orphanDocId: orphanResult.docId,
            created: orphanResult.created ? "true" : "false",
          },
        });
        // Finding 4 PR-NO-DROPPED-SMS : audit unifie, cf. W3.
        await recordWebhookOrphanAuditBestEffort({
          reason: "parse_failed",
          orphanDocId: orphanResult.docId,
          wasOptOut: false,
          notifiedVia: notifiedViaW4,
        });
        logger.warn(err.toLogObject(), "[POST /api/webhooks/ovh-sms] zod parse failed");
        return NextResponse.json({ ok: true }, { status: 200 });
      }
      throw err;
    }

    // ── 4. Émission event Inngest avec id déterministe ───────────────────
    const inngest = getInngestClient();
    const event = smsReplyReceived.create(eventData);
    const deterministicEventId = `sms.reply.${safeExternalIdHash(eventData.ovhMessageId)}`;
    try {
      await inngest.send({ ...event, id: deterministicEventId });
    } catch (err) {
      // W5/W6 : Inngest HS → persistance orphan best-effort + Sentry error
      // + 500 (OVH retry naturellement). Le phoneHash est connu — on le
      // joint a l'orphan pour correlation forensic.
      // Fix Finding 1 compliance-auditor (HIGH) : body est LISIBLE ici
      // (parse Zod a reussi juste avant). On calcule isOptOut pour que
      // l'humain qui triage le canal voie le signal "Desabonnement
      // detecte". Sans ca, un STOP tombant pile pendant une panne Inngest
      // passerait inapercu -> infraction L.34-5 CPCE.
      const wasOptOut = isOptOut(eventData.body);
      const digitsOnly = eventData.phone.replace(/\D/g, "");
      const phoneLast4 = digitsOnly.slice(-4);
      const phoneHash = safePhoneHash(eventData.phone, hashPii);
      const orphanResult = await addOrphanInboundIdempotent({
        reason: "enqueue_failed",
        body: eventData.body,
        idempotencyKey: eventData.ovhMessageId,
        source: "webhook-ovh-sms",
        phoneHash,
        wasOptOut,
      }).catch((persistErr: unknown) => {
        logger.error(
          {
            errName: persistErr instanceof Error ? persistErr.name : "unknown",
          },
          "[ovh-sms] orphan persist failed on enqueue_failed",
        );
        return {
          docId: `orphan_enqueue_failed_${shortFingerprint(eventData.ovhMessageId)}`,
          created: false,
        };
      });
      const notifiedViaW5 = await notifyOrphanChannelBestEffort({
        reason: "enqueue_failed",
        wasOptOut,
        lastInboundBody: eventData.body,
        orphanDocId: orphanResult.docId,
        phoneLast4,
        phoneHash,
      });
      captureMonitoringWarning("ovh_webhook.enqueue_failed", {
        // Bump level a "error" (deja le cas) + tag was_opt_out pour
        // pagination d'astreinte prioritaire si STOP latent (Finding 5).
        level: "error",
        tags: {
          stage: "inngest_send",
          was_opt_out: wasOptOut ? "true" : "false",
        },
        extra: {
          orphanDocId: orphanResult.docId,
          ovhMessageIdFingerprint: shortFingerprint(eventData.ovhMessageId),
          created: orphanResult.created ? "true" : "false",
          errName: err instanceof Error ? err.name : "unknown",
        },
      });
      // Finding 4 PR-NO-DROPPED-SMS : audit unifie avec le pipeline.
      await recordWebhookOrphanAuditBestEffort({
        reason: "enqueue_failed",
        orphanDocId: orphanResult.docId,
        wasOptOut,
        phoneHash,
        notifiedVia: notifiedViaW5,
      });
      return NextResponse.json(
        { error: { code: "INTERNAL", message: "Une erreur est survenue. Réessayez plus tard." } },
        { status: 500 },
      );
    }

    // ── 5. Ack 200 rapide ─────────────────────────────────────────────────
    logger.info(
      {
        ovhMessageIdFingerprint: shortFingerprint(eventData.ovhMessageId),
        eventId: deterministicEventId,
        bodyLength: eventData.body.length,
      },
      "[POST /api/webhooks/ovh-sms] event queued",
    );
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    // Inattendu (env manquante, autre). Message generique, pas de fuite.
    logger.error(
      {
        errName: err instanceof Error ? err.name : "unknown",
      },
      "[POST /api/webhooks/ovh-sms] unexpected error",
    );
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Une erreur est survenue. Réessayez plus tard." } },
      { status: 500 },
    );
  }
}
