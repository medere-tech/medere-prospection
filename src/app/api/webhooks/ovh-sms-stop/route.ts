/**
 * POST / GET /api/webhooks/ovh-sms-stop — endpoint d'OBSERVATION du
 * callback OVH `stopCallBack` (fix DIAG-STOP-OVH).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rôle
 *
 * Capture CHAQUE appel OVH sur le champ `sms.Account.stopCallBack`
 * (callback dédié aux STOP, cf. schéma OVH `/sms/{serviceName}`). Les
 * logs Vercel ne gardent qu'1h, donc on persiste la metadata de chaque
 * appel dans Firestore `ovh_stop_callbacks/` pour forensique long-terme.
 * L'objectif de cet endpoint est UNIQUEMENT d'apprendre le format réel
 * — on NE traite PAS d'opt-out à ce stade.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pattern d'exports — Next.js App Router
 *
 * Ce fichier n'exporte QUE les handlers HTTP (`GET`, `POST`). Toute la
 * logique métier (masquage anti-PII, persist Firestore) vit dans
 * `src/lib/ovh/stop-callback.ts` — module testable en isolation et
 * importable sans contrainte Next.js. Les tests unitaires de la route
 * mockent les mêmes imports.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Chaîne de traitement
 *
 *   1. Rate-limit par IP (fail-closed, bucket distinct de /ovh-sms).
 *   2. `verifyOvhWebhookToken` sur `?token=` — MÊME helper partagé que
 *      `/api/webhooks/ovh-sms` (`src/lib/security/webhook-signatures.ts:133`).
 *      Token invalide → 401 + log sans token.
 *   3. Lecture défensive : GET ou POST (OVH n'a pas documenté le verbe),
 *      content-type JSON / form-urlencoded, body ignoré sur GET.
 *   4. Masquage AVANT persist : `summarizeParams` + `maskValueForStopCallback`
 *      (voir `src/lib/ovh/stop-callback.ts`).
 *   5. Persist Firestore via `persistCallback` (Admin SDK, timestamp serveur).
 *   6. Réponse 200 systématique si token valide. AUCUN traitement d'opt-out.
 */
import { type NextRequest, NextResponse } from "next/server";

import { type ParamSummary, persistCallback, summarizeParams } from "@/lib/ovh/stop-callback";
import { getOvhEnv } from "@/lib/security/env";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { verifyOvhWebhookToken } from "@/lib/security/webhook-signatures";
import { logger } from "@/lib/utils/logger";

// ─────────────────────────────────────────────────────────────────────────────
// Rate-limit — bucket SÉPARÉ de /api/webhooks/ovh-sms
// ─────────────────────────────────────────────────────────────────────────────

const stopWebhookLimiter = createRateLimiter({
  limit: 60,
  window: "1 m",
  prefix: "ovh-webhook-stop",
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (privés locaux)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Même logique d'extraction IP que `/api/webhooks/ovh-sms/route.ts:110-120`.
 * Dupliquée volontairement (5 lignes, pattern simple) plutôt que de
 * refactorer la route existante — zéro risque de régression. Si un 3e
 * webhook OVH apparaît, extraire alors dans un helper partagé.
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

/**
 * Convertit un `URLSearchParams` en objet `Record<string,string>` plat.
 * Les clés multi-valuées ne sont pas gérées (OVH n'en envoie pas).
 *
 * 🔒 `Object.create(null)` au lieu de `{}` : defense-en-profondeur contre
 * la prototype pollution. Si une entrée `__proto__` arrivait (improbable
 * sur URLSearchParams natif mais pattern appliqué par symétrie avec
 * `captureBody` qui parse du JSON), le setter d'`Object.prototype` ne
 * serait pas invoqué — l'écriture reste une propriété own.
 */
function searchParamsToObject(sp: URLSearchParams): Record<string, string> {
  const obj: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [k, v] of sp.entries()) obj[k] = v;
  return obj;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lecture body (POST uniquement)
// ─────────────────────────────────────────────────────────────────────────────

interface BodyCapture {
  contentType: string;
  params: Record<string, string>;
  parseError?: string;
}

async function captureBody(req: NextRequest): Promise<BodyCapture> {
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    try {
      const form = await req.formData();
      // 🔒 Object.create(null) : defense-en-profondeur anti prototype
      // pollution (cf. JSDoc `searchParamsToObject`).
      const obj: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const [k, v] of form.entries()) {
        obj[k] = typeof v === "string" ? v : "";
      }
      return { contentType, params: obj };
    } catch (err) {
      return {
        contentType,
        params: {},
        parseError: err instanceof Error ? err.name : "unknown",
      };
    }
  }
  if (contentType.includes("application/json") || contentType === "") {
    try {
      const raw = await req.text();
      if (raw.length === 0) return { contentType, params: {} };
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        // 🔒 Object.create(null) : defense-en-profondeur anti prototype
        // pollution. Un payload `{"__proto__": {...}}` ferait un no-op
        // ici car l'assignement `obj.__proto__ = <string>` sur un objet
        // sans prototype est un simple set de propriete own.
        const obj: Record<string, string> = Object.create(null) as Record<string, string>;
        for (const [k, v] of Object.entries(parsed)) {
          obj[k] = typeof v === "string" ? v : JSON.stringify(v);
        }
        return { contentType, params: obj };
      }
      return { contentType, params: {}, parseError: "non-object-json" };
    } catch (err) {
      return {
        contentType,
        params: {},
        parseError: err instanceof Error ? err.name : "unknown",
      };
    }
  }
  // Content-type inconnu : on log mais on n'essaie pas de parser.
  return { contentType, params: {}, parseError: "unknown-content-type" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler commun GET/POST
// ─────────────────────────────────────────────────────────────────────────────

async function handle(req: NextRequest, method: "GET" | "POST"): Promise<NextResponse> {
  try {
    // 1. Rate-limit par IP
    const ip = extractClientIp(req);
    const rl = await stopWebhookLimiter.check(`ip:${ip}`);
    if (!rl.success) {
      logger.warn(
        { rlReason: rl.reason, rlRemaining: rl.remaining },
        "[ovh-sms-stop] rate-limit blocked",
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

    // 2. Vérif token — MEME helper partagé que /api/webhooks/ovh-sms.
    //    En cas d'invalidité : log SANS inclure la valeur reçue (anti-leak).
    const { OVH_WEBHOOK_SECRET } = getOvhEnv();
    const received = req.nextUrl.searchParams.get("token");
    if (!verifyOvhWebhookToken({ expected: OVH_WEBHOOK_SECRET, received })) {
      logger.warn({ hasToken: received !== null }, "[ovh-sms-stop] invalid or missing token");
      return NextResponse.json(
        { error: { code: "UNAUTHORIZED", message: "Authentification requise." } },
        { status: 401 },
      );
    }

    // 3. Capture requête — AVANT persist, tout est masqué par
    //    summarizeParams. La clé `token` est filtrée systématiquement.
    const queryObj = searchParamsToObject(req.nextUrl.searchParams);
    const queryParams: ParamSummary[] = summarizeParams(queryObj);

    let bodyCapture: BodyCapture | undefined;
    if (method === "POST") {
      bodyCapture = await captureBody(req);
    }
    const bodyParams: ParamSummary[] | undefined =
      bodyCapture !== undefined ? summarizeParams(bodyCapture.params) : undefined;

    // 4. Persist
    const docId = await persistCallback({
      method,
      queryParams,
      contentType: bodyCapture?.contentType ?? "",
      bodyParams,
      bodyParseError: bodyCapture?.parseError,
    });

    logger.info(
      {
        docId,
        method,
        queryParamsCount: queryParams.length,
        bodyParamsCount: bodyParams?.length ?? 0,
        contentType: bodyCapture?.contentType ?? "n/a",
      },
      "[ovh-sms-stop] callback captured",
    );

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    // Patch M3 : on NE log PAS `err.message` (risque theorique de fuite
    // si un driver tiers echo du payload dans la stringification).
    // `errName` seul suffit pour corréler avec Vercel runtime logs si
    // besoin de forensic approfondi.
    logger.error(
      { errName: err instanceof Error ? err.name : "unknown" },
      "[ovh-sms-stop] unexpected error",
    );
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Une erreur est survenue. Réessayez plus tard." } },
      { status: 500 },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports Next.js — handlers HTTP UNIQUEMENT
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(req, "GET");
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(req, "POST");
}
