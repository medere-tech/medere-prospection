/**
 * POST /api/admin/preview-first-sms — prévisualise le 1er SMS pour un contact.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rôle métier (S10.1.4.b)
 *
 *   Permet à l'admin Médéré de prévisualiser, depuis le futur dashboard
 *   (S10.1.5+), le body Claude qui SERAIT envoyé à un contact donné, sans
 *   déclencher d'envoi OVH ni de mutation Firestore.
 *
 *   Pipeline :
 *     1. Auth Clerk + RBAC "admin" (defense-in-depth).
 *     2. Parse body Zod strict (contactId).
 *     3. `getContact(contactId)` Firestore → 404 si absent.
 *     4. Status guard `["pending", "enriched", "ready"]` → 409 sinon.
 *     5. `generateFirstSms({ contact: subset })` → body + reasoning + metadata.
 *     6. `preSendCheck` en DRY-RUN (fonction pure, no-op par design) sur
 *        `recentOutboundMessages: []` + `messageCount: 0` (1er SMS).
 *     7. Response JSON : { smsBody, reasoning, charCount, preSendCheck* }.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Décisions S10.1.4.b
 *
 *   D-b1 — Statuses autorisés : `["pending", "enriched", "ready"]`. Hors
 *          de cet ensemble, la preview n'a pas de sens (contact déjà
 *          engagé/archivé). On renvoie 409 avec `currentStatus` +
 *          `allowedStatuses` dans le body. Arbitrage Déthié.
 *
 *   D-b2 — `preSendCheck` appelé en preview MAIS sans audit log (caller
 *          responsibility per pre-send-check.ts l.47-50). Aucune mutation
 *          Firestore. La route est 100% read + Claude API call.
 *
 *   D-b3 — `humanReason` NON exposé dans la response. C'est un texte
 *          server-only per JSDoc preSendCheck l.52-55 (info disclosure
 *          mineur). On expose `code` + `rule` typés — l'UI mappera côté
 *          frontend vers un label FR utilisateur.
 *
 *   D-b4 — `recentOutboundMessages: []` + `conversation.messageCount: 0`
 *          pour la preview. Cohérent avec le scope (status
 *          "pending"/"enriched"/"ready" = contact pas encore engagé).
 *          La règle 5 (rate-limit 3/30j) ne se déclenche donc pas en
 *          preview ; c'est OK car ces contacts n'ont pas d'historique.
 *
 *   Pas d'audit log READ — cohérent S10.1.4.a (lecture pure sans impact
 *   compliance critique).
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { generateFirstSms } from "@/lib/claude/first-sms-generator";
import { preSendCheck } from "@/lib/compliance/pre-send-check";
import { getContact } from "@/lib/firestore/contacts";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { AppError, ConflictError, NotFoundError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas + constantes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Firestore document IDs sont alphanumériques + tirets + underscore. On
 * borne à 128 chars (largement au-dessus des hubspotId réels ~10 chars,
 * anti-DoS sur input arbitrairement long).
 */
const BodySchema = z.object({
  contactId: z.string().min(1).max(128),
});

/**
 * 🔒 Statuses autorisés pour preview (D-b1). Hors de cet ensemble, le
 * contact est déjà engagé/archivé — preview d'un 1er SMS sans valeur.
 *
 * Sentinelle test : si un nouveau status est ajouté à ContactStatus
 * (S10.1.4.b+), arbitrer s'il rejoint cette liste ou pas.
 */
const PREVIEW_ALLOWED_STATUSES = ["pending", "enriched", "ready"] as const;
type PreviewAllowedStatus = (typeof PREVIEW_ALLOWED_STATUSES)[number];

function isPreviewAllowed(status: string): status is PreviewAllowedStatus {
  return (PREVIEW_ALLOWED_STATUSES as readonly string[]).includes(status);
}

/**
 * Rate-limit Upstash (S10.1.9 RATELIMIT-001) : 30 req/min par admin (clé
 * Clerk userId). La preview déclenche une génération Claude (~0.02€/req +
 * ~2s latence) — un admin compromis pourrait spammer la route et engendrer
 * des coûts non maîtrisés. Limit 30/min = ~1 toutes les 2s, largement
 * suffisant pour un usage humain interactif depuis le dashboard.
 *
 * Lazy : `createRateLimiter` n'effectue aucun I/O à l'import, l'instance
 * Upstash n'est construite qu'au 1er `check()` (cf. tests rate-limit l.127).
 */
const previewFirstSmsLimiter = createRateLimiter({
  limit: 30,
  window: "1 m",
  prefix: "admin-preview-first-sms",
});

// ─────────────────────────────────────────────────────────────────────────────
// Handler POST
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // ── 1. Auth Clerk + RBAC admin ────────────────────────────────────────
    const { userId } = await requireRole("admin");

    // ── 1.bis. Rate-limit Upstash (S10.1.9 RATELIMIT-001) ─────────────────
    // Court-circuit AVANT le parse + fetch + Claude — refuse l'abus dès
    // l'auth validée (le bénéfice du rate-limit est nul si on a déjà payé
    // les ms Firestore + le call Claude).
    const rateLimitResponse = await applyAdminRateLimit(previewFirstSmsLimiter, userId);
    if (rateLimitResponse) return rateLimitResponse;

    // ── 2. Parse body Zod strict ──────────────────────────────────────────
    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return NextResponse.json(
        { error: { code: "VALIDATION", message: "Corps de requête JSON invalide." } },
        { status: 400 },
      );
    }
    const bodyResult = BodySchema.safeParse(rawBody);
    if (!bodyResult.success) {
      return NextResponse.json(
        {
          error: { code: "VALIDATION", message: "Paramètres de requête invalides." },
          issues: bodyResult.error.issues.map((i) => ({
            path: i.path.join("."),
            code: i.code,
          })),
        },
        { status: 400 },
      );
    }
    const { contactId } = bodyResult.data;

    // ── 3. Fetch contact ──────────────────────────────────────────────────
    const contact = await getContact(contactId);
    if (contact === null) {
      throw new NotFoundError({
        message: "preview-first-sms: contact not found",
        context: { contactId },
      });
    }

    // ── 4. Status guard (D-b1) ────────────────────────────────────────────
    if (!isPreviewAllowed(contact.status)) {
      throw new ConflictError({
        message: `preview-first-sms: preview not allowed for status="${contact.status}"`,
        clientMessage: "Preview indisponible pour ce contact (statut incompatible).",
        context: {
          contactId,
          currentStatus: contact.status,
          allowedStatuses: PREVIEW_ALLOWED_STATUSES,
        },
      });
    }

    // ── 5. Génération Claude (1er SMS) ────────────────────────────────────
    // Mapping `Contact` → `FirstSmsContact` (subset 5 champs) — surface PII
    // minimale passée à Claude (pas de phone, pas d'email, pas de hubspotId).
    const result = await generateFirstSms({
      contact: {
        firstName: contact.firstName,
        lastName: contact.lastName,
        civilite: contact.civilite,
        speciality: contact.speciality,
        city: contact.city,
      },
    });

    // ── 6. preSendCheck en preview (pure, no-op) ──────────────────────────
    // `recentOutboundMessages: []` + `messageCount: 0` (D-b4). preSendCheck
    // NE log RIEN et N'AUDITE RIEN par design — safe en preview.
    const check = preSendCheck({
      contact,
      message: result.body,
      conversation: { messageCount: 0 },
      recentOutboundMessages: [],
    });

    // ── 7. Response ───────────────────────────────────────────────────────
    // `humanReason` exclu volontairement (D-b3, server-only). Code + rule
    // typés suffisent — l'UI mappera vers un label FR utilisateur.
    return NextResponse.json({
      smsBody: result.body,
      reasoning: result.reasoning,
      charCount: result.body.length,
      preSendCheckPassed: check.ok,
      ...(check.ok
        ? {}
        : {
            preSendCheckCode: check.failure.code,
            preSendCheckRule: check.failure.rule,
          }),
    });
  } catch (err) {
    // AppError = surface client connue (401, 403, 404, 409, 400…).
    if (err instanceof AppError) {
      logger.warn(err.toLogObject(), "[POST /api/admin/preview-first-sms] AppError");
      return NextResponse.json(err.toClientBody(), { status: err.statusCode });
    }

    // Inattendu (bug, Claude API HS, Firestore HS) → 500 générique.
    // On log juste `err.name` — pas la stack (qui pourrait fuiter du
    // PII via fragments de docId/prompt). Sanitizer Pino couvre en aval.
    logger.error(
      { errName: err instanceof Error ? err.name : "unknown" },
      "[POST /api/admin/preview-first-sms] unexpected error",
    );
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Une erreur est survenue. Réessayez plus tard." } },
      { status: 500 },
    );
  }
}
