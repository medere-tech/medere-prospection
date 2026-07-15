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
 * pipeline `process-reply` (`src/lib/inngest/functions/process-reply.ts`
 * S9.3-S9.4).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Chaîne de traitement
 *
 *   1. Rate-limit Upstash par IP (`x-forwarded-for`), fail-closed. Court-
 *      circuit AVANT toute lecture du body → protection anti-DDoS et
 *      anti-brute-force du token.
 *   2. `verifyOvhWebhookToken` sur `?token=` en query param — OVH ne signe
 *      PAS nativement, notre "signature" = shared secret timing-safe
 *      (`src/lib/security/webhook-signatures.ts:113-135`). Token absent
 *      ou invalide → 401 sans traitement.
 *   3. Lecture défensive du body : `application/json` par défaut, fallback
 *      `application/x-www-form-urlencoded` si OVH envoie ainsi (format du
 *      POST callback NON confirmé — la capture réelle S9.6-EXPLORE vient
 *      d'un GET incoming/{id} en JSON).
 *   4. `parseIncomingOvhSms` (parser pur, Zod strict) → mappe vers
 *      `{phone, body, ovhMessageId}`. Throw ValidationError → 400.
 *   5. `inngest.send(smsReplyReceived.create({...}))` — event typé Standard
 *      Schema, Zod re-validation runtime en défense.
 *   6. Réponse 200 immédiate (Inngest traite en async côté worker).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * DÉCISION S9.6 — format du body callback OVH (défensif)
 *
 * La capture S9.6-EXPLORE a été réalisée via `GET /sms/{svc}/incoming/{id}`,
 * qui renvoie du JSON strict. Le format du POST callback OVH n'est PAS
 * confirmé — la doc historique OVH mentionne `application/x-www-form-
 * urlencoded` sur certains callbacks legacy. On lit `Content-Type` et on
 * gère les 2 :
 *
 *   - `application/json` (défaut si absent) → `req.json()`
 *   - `application/x-www-form-urlencoded` (ou `multipart/form-data`) →
 *     `req.formData()` puis conversion en objet ; le champ `id` (STRING
 *     via formData) est parsé en NUMBER pour matcher le contrat strict du
 *     parser (`z.number().int()`). Aucune tolérance côté parser — la
 *     conversion vit ICI, single-source-of-truth transport.
 *
 * Un premier SMS réel via callback confirmera le vrai format et on pourra
 * durcir en supprimant la branche inutile en S10+.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ANTI-PII — discipline log
 *
 * Le logger Pino scrube automatiquement les clés `body`, `phone` (via
 * `PII_KEYS` `src/lib/utils/logger.ts:80-123`) et applique un regex phone/
 * email sur toutes les valeurs — mais la discipline reste : on log
 * `bodyLength`/`ovhMessageId` (non-PII par construction), on utilise
 * `maskPhone` pour tout téléphone tracé volontairement.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ANTI-LEAK — réponses HTTP
 *
 * Toute réponse d'erreur utilise `AppError.toClientBody()` (message
 * générique) ou un objet équivalent — jamais le body brut de la requête,
 * jamais le détail Zod, jamais le sender.
 */
import { type NextRequest, NextResponse } from "next/server";

import { getInngestClient } from "@/lib/inngest/client";
import { smsReplyReceived } from "@/lib/inngest/events";
import { parseIncomingOvhSms } from "@/lib/ovh/parse-incoming";
import { getOvhEnv } from "@/lib/security/env";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { verifyOvhWebhookToken } from "@/lib/security/webhook-signatures";
import { AppError, ValidationError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

// ─────────────────────────────────────────────────────────────────────────────
// Rate-limit — module-level lazy singleton
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rate-limit fail-closed par IP. 60 requêtes / minute — large pour un flux
 * OVH légitime (au plus quelques dizaines de réponses PS par minute sur le
 * MVP 200 dentistes, budget scale 26k = burst possible mais très en-deçà),
 * et suffisant pour absorber un burst OVH sans bloquer, tout en freinant un
 * attaquant qui bruteforce le token.
 *
 * Lazy : aucun I/O à l'import (pattern S10.1.9 RATELIMIT-001).
 */
const ovhWebhookLimiter = createRateLimiter({
  limit: 60,
  window: "1 m",
  prefix: "ovh-webhook",
  // failureMode défaut "closed" — safe pour webhook public.
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers privés
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extrait l'IP client depuis les headers Vercel/proxy. Fallback `"unknown"`
 * pour ne jamais throw (fail-closed via rate-limit sur clé stable).
 */
function extractClientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    // XFF peut contenir une liste `client, proxy1, proxy2` — le premier
    // est le client d'origine (le plus à gauche est le plus proche du
    // client, cf. RFC 7239).
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xri = req.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

/**
 * Lecture défensive du body : JSON par défaut, form-urlencoded en fallback.
 * Le champ `id` reçu en string via formData est parsé en NUMBER pour
 * matcher le contrat strict du parser. Toute autre transformation reste
 * inconnue et laissée telle quelle (le parser Zod re-valide).
 *
 * @throws Erreur brute si la lecture du transport échoue (JSON malformé,
 *   formData corrompue). Catchée en amont → 400 générique.
 */
async function readRawPayload(req: NextRequest): Promise<unknown> {
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const form = await req.formData();
    const obj: Record<string, unknown> = {};
    for (const [k, v] of form.entries()) {
      const str = typeof v === "string" ? v : "";
      // Conversion transport-specifique : `id` NUMBER pour le parser Zod.
      if (k === "id" && /^\d+$/.test(str)) {
        obj[k] = Number.parseInt(str, 10);
        continue;
      }
      if (k === "credits" && /^-?\d+$/.test(str)) {
        obj[k] = Number.parseInt(str, 10);
        continue;
      }
      obj[k] = str;
    }
    return obj;
  }

  // Défaut JSON (Content-Type absent, `application/json`, ou autre).
  return await req.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler POST
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // ── 1. Rate-limit par IP (fail-closed) ────────────────────────────────
    // Court-circuit tout traitement avant lecture du body / vérif token.
    const ip = extractClientIp(req);
    const rl = await ovhWebhookLimiter.check(`ip:${ip}`);
    if (!rl.success) {
      logger.warn(
        { rlReason: rl.reason, rlRemaining: rl.remaining },
        "[POST /api/webhooks/ovh-sms] rate-limit blocked",
      );
      return NextResponse.json(
        { error: { code: "RATE_LIMITED", message: "Trop de requêtes. Réessayez plus tard." } },
        {
          status: 429,
          headers: {
            "Retry-After": Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000)).toString(),
          },
        },
      );
    }

    // ── 2. Vérif token OVH (shared secret timing-safe) ────────────────────
    // OVH ne signe pas nativement — on utilise un secret partagé passé en
    // query param `?token=<OVH_WEBHOOK_SECRET>`. Anti-bypass déjà présent
    // dans `verifyOvhWebhookToken` (rejette expected="" et received="").
    const expected = getOvhEnv().OVH_WEBHOOK_SECRET;
    const received = req.nextUrl.searchParams.get("token");
    if (!verifyOvhWebhookToken({ expected, received })) {
      logger.warn(
        { hasToken: received !== null },
        "[POST /api/webhooks/ovh-sms] invalid or missing token",
      );
      return NextResponse.json(
        { error: { code: "UNAUTHORIZED", message: "Authentification requise." } },
        { status: 401 },
      );
    }

    // ── 3. Lecture défensive du body (JSON ou form-urlencoded) ────────────
    let rawPayload: unknown;
    try {
      rawPayload = await readRawPayload(req);
    } catch {
      // JSON malformé, formData corrompue, transport HS. On ne fuit AUCUN
      // détail (message générique) — le body brut pourrait contenir un
      // sender/message PII même si mal formé.
      return NextResponse.json(
        { error: { code: "VALIDATION", message: "Données invalides." } },
        { status: 400 },
      );
    }

    // TODO S9.6-FIX: retirer ce bloc DIAGNOSTIC TEMPORAIRE après capture du
    // format réel envoyé par le callback push OVH (qui diffère du GET
    // /sms/{svc}/incoming/{id} sur lequel le parser a été codé). Objectif :
    // voir la SHAPE du payload (Content-Type + clés + types) SANS logger
    // les valeurs (anti-PII). Pour `sender` spécifiquement, on ajoute
    // typeof + longueur (jamais le numéro complet) pour comprendre le
    // mismatch de type que Zod rejette.
    {
      const contentType = req.headers.get("content-type") ?? "(absent)";
      const isObj =
        rawPayload !== null && typeof rawPayload === "object" && !Array.isArray(rawPayload);
      const asRecord = isObj ? (rawPayload as Record<string, unknown>) : {};
      const keys = isObj ? Object.keys(asRecord) : [];
      const typesByKey = Object.fromEntries(
        Object.entries(asRecord).map(([k, v]) => [
          k,
          Array.isArray(v) ? `array(${v.length})` : v === null ? "null" : typeof v,
        ]),
      );
      // Sender uniquement — typeof + longueur pour disambiguer
      // string("+33..."/"33..."/"0..." vs number vs undefined vs autre).
      const senderRaw = isObj ? asRecord.sender : undefined;
      const senderShape = {
        typeof: typeof senderRaw,
        isArray: Array.isArray(senderRaw),
        isNull: senderRaw === null,
        length: typeof senderRaw === "string" ? senderRaw.length : null,
      };
      logger.info(
        {
          diag: "S9.6-FIX",
          contentType,
          payloadType: typeof rawPayload,
          isObj,
          keys,
          typesByKey,
          senderShape,
        },
        "[POST /api/webhooks/ovh-sms] DIAGNOSTIC payload shape (TODO S9.6-FIX: retirer)",
      );
    }

    // ── 4. Parse strict (Zod + validation E.164 stricte) ──────────────────
    let eventData;
    try {
      eventData = parseIncomingOvhSms(rawPayload);
    } catch (err) {
      if (err instanceof ValidationError) {
        // Log le context (issues Zod) côté serveur ; jamais côté client.
        logger.warn(err.toLogObject(), "[POST /api/webhooks/ovh-sms] parse failed");
        return NextResponse.json(err.toClientBody(), { status: err.statusCode });
      }
      throw err;
    }

    // ── 5. Émission event Inngest (Zod re-validation en 2e couche) ────────
    // `.create()` re-valide via Standard Schema — une régression du parser
    // qui laisserait passer un payload mal formé serait attrapée ici et
    // ferait remonter un throw. Défense-en-profondeur.
    //
    // event.id NON forgé manuellement — laisse Inngest générer un UUID v4
    // (règle anti-PII `events.ts:49-73` : `phone` / `ovhMessageId` interdits
    // dans le forge d'event.id).
    const inngest = getInngestClient();
    const event = smsReplyReceived.create(eventData);
    await inngest.send(event);

    // ── 6. Ack 200 rapide (OVH attend < 3s côté callback) ─────────────────
    // Log post-envoi avec `bodyLength` / `ovhMessageId` uniquement (PII-safe
    // par construction — le logger scrube en plus les valeurs).
    logger.info(
      {
        ovhMessageId: eventData.ovhMessageId,
        bodyLength: eventData.body.length,
      },
      "[POST /api/webhooks/ovh-sms] event queued",
    );
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    // AppError = 4xx/5xx métier connue.
    if (err instanceof AppError) {
      logger.warn(err.toLogObject(), "[POST /api/webhooks/ovh-sms] AppError");
      return NextResponse.json(err.toClientBody(), { status: err.statusCode });
    }
    // Inattendu (Inngest cloud HS, env manquante hors OVH, etc.) → 500
    // générique sans fuite. Le logger scrube `err.message` via serializer.
    logger.error(
      {
        errName: err instanceof Error ? err.name : "unknown",
        errMessage: err instanceof Error ? err.message : undefined,
      },
      "[POST /api/webhooks/ovh-sms] unexpected error",
    );
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Une erreur est survenue. Réessayez plus tard." } },
      { status: 500 },
    );
  }
}
