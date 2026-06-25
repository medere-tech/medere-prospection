/**
 * POST /api/admin/send-first-sms — déclenche le dispatch RÉEL du 1er SMS
 * pour un contact via Inngest (S10.1.4.c).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rôle métier
 *
 *   L'admin Médéré (Clerk RBAC) appelle cette route depuis le futur
 *   dashboard (S10.1.5+) pour déclencher l'envoi effectif du 1er SMS à
 *   un contact donné. La route :
 *
 *     1. Auth admin + sentinelle anti-CSRF (`confirm: true` obligatoire).
 *     2. Fetch contact + status guard (`pending` | `enriched` | `ready`).
 *     3. Génère le body Claude via `generateFirstSms` (MÊME fonction que
 *        preview S10.1.4.b — sentinelle anti-divergence en test).
 *     4. `getOrCreateInitialConversation` idempotent (précondition handler
 *        Inngest qui throw `NonRetriableError("Conversation not found")`).
 *     5. Audit `sms_send_initiated_by_admin` (actorId=Clerk userId,
 *        actorType="human", payload PII-free).
 *     6. `inngest.send(smsSendFirstRequested.create({ contactId, campaignId, body }))`.
 *     7. 202 Accepted avec `{ jobId, status: "queued", contactId, smsCharCount }`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Décisions S10.1.4.c (arbitrages Déthié)
 *
 *   D-c1 — `preSendCheck` NON ré-appelé côté route. Le handler Inngest
 *          `sendFirstSmsHandler` applique déjà `preSendCheckWithAudit`
 *          (step 2 du pipeline). Double check = risque divergence + coût
 *          inutile. La route fait confiance au pipeline Inngest.
 *
 *   D-c2 — `contact.status` NON modifié côté route. Évidence forensic via
 *          audit log + collection `messages/`. Cohérent avec le handler
 *          qui ne touche pas non plus à `contact.status`.
 *
 *   D-c3 — Idempotence route-level : NON. Inngest concurrency
 *          `{ key: contactId, limit: 1 }` + rate-limit règle 5 (3/30j)
 *          gèrent. UI désactive le bouton après click. 2 clics = 2 audits
 *          init + 1 SMS envoyé + 1 audit `send_blocked` — acceptable
 *          forensiquement.
 *
 *   D-c4 — `campaignId` dérivé de `contact.campaignId` (Q2.A). Source de
 *          vérité unique Firestore. Body request minimal :
 *          `{ contactId, confirm: true }` via `z.strictObject` (anti-drift
 *          futur dev qui ajouterait `campaignId` dans le body sans repenser
 *          le drift UI/DB).
 *
 *   D-c5 — `confirm: z.literal(true)` sentinelle anti-CSRF. Différent
 *          d'idempotence (D-c3) : protège contre un POST accidentel non
 *          intentionnel (cf. fetch wrappers qui POSTeraient `{}` par
 *          erreur). L'admin doit explicitement envoyer `{ confirm: true }`.
 *
 *   D-c6 — Ordre `audit AVANT inngest.send`. Si `inngest.send` throw,
 *          l'audit reste posé (trace forensic "init tenté"). Si on
 *          inversait, un audit échoué laisserait un event Inngest queued
 *          sans trace d'initiation — trou compliance L.34-5 CPCE.
 */
import { NonRetriableError } from "inngest";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { generateFirstSms } from "@/lib/claude/first-sms-generator";
import { appendAuditLog } from "@/lib/firestore/audit-log";
import { getContact } from "@/lib/firestore/contacts";
import { getOrCreateInitialConversation } from "@/lib/firestore/conversations";
import { getInngestClient } from "@/lib/inngest/client";
import { smsSendFirstRequested } from "@/lib/inngest/events";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { AppError, ConflictError, NotFoundError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas + constantes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 🔒 `z.strictObject` (vs `z.object`) — verrouille la surface API. Un body
 * avec champs surnuméraires (ex: `campaignId` que l'UI tenterait d'envoyer)
 * → 400 `VALIDATION`. Sentinelle anti-régression contre un futur dev qui
 * ajouterait silencieusement `campaignId` au body sans repenser le drift
 * UI ↔ Firestore (D-c4).
 *
 *   - `contactId` : ID Firestore opaque (`min(1).max(128)` — anti-DoS).
 *   - `confirm`   : sentinelle anti-CSRF (D-c5) — `z.literal(true)`.
 */
const BodySchema = z.strictObject({
  contactId: z.string().min(1).max(128),
  confirm: z.literal(true),
});

/**
 * 🔒 Statuses autorisés pour l'envoi initial. Cohérent avec S10.1.4.b
 * (preview) — un contact `in_conversation`/`qualified`/`opted_out`/
 * `archived` ne doit JAMAIS recevoir un nouveau 1er SMS.
 *
 * Cf. CLAUDE.md règles compliance #2 + #6 + #7.
 */
const SEND_ALLOWED_STATUSES = ["pending", "enriched", "ready"] as const;
type SendAllowedStatus = (typeof SEND_ALLOWED_STATUSES)[number];

function isSendAllowed(status: string): status is SendAllowedStatus {
  return (SEND_ALLOWED_STATUSES as readonly string[]).includes(status);
}

/**
 * Rate-limit Upstash (S10.1.9 RATELIMIT-001) : 10 req/min par admin (clé
 * Clerk userId) — plus restrictif que preview (30/min) car chaque appel
 * déclenche un envoi SMS RÉEL via Inngest → OVH (coût ~0.07€/SMS + impact
 * compliance L.34-5 CPCE si un admin compromis vide la liste "ready" en
 * 30s). Inngest concurrency `{ key: contactId, limit: 1 }` protège déjà
 * contre le double-send sur le MÊME contact, mais un attaquant peut
 * itérer sur 200 contactIds différents — d'où le plafond global par admin.
 *
 * Lazy : aucun I/O à l'import (cf. test rate-limit.test.ts "ne lit pas
 * l'env tant que check() n'est pas appelé").
 */
const sendFirstSmsLimiter = createRateLimiter({
  limit: 10,
  window: "1 m",
  prefix: "admin-send-first-sms",
});

// ─────────────────────────────────────────────────────────────────────────────
// Handler POST
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // ── 1. Auth Clerk + RBAC admin (récupère userId pour actorId audit) ──
    const { userId: adminUserId } = await requireRole("admin");

    // ── 1.bis. Rate-limit Upstash (S10.1.9 RATELIMIT-001) ─────────────────
    // Court-circuit AVANT le parse + Claude + Inngest — la défense la plus
    // précoce possible contre un admin compromis qui voudrait spammer les
    // envois SMS réels (~0.07€/SMS + impact compliance).
    const rateLimitResponse = await applyAdminRateLimit(sendFirstSmsLimiter, adminUserId);
    if (rateLimitResponse) return rateLimitResponse;

    // ── 2. Parse body strict (anti-CSRF + anti-drift champs surnuméraires) ──
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
        message: "send-first-sms: contact not found",
        context: { contactId },
      });
    }

    // ── 4. Status guard (cohérent S10.1.4.b preview) ──────────────────────
    if (!isSendAllowed(contact.status)) {
      throw new ConflictError({
        message: `send-first-sms: send not allowed for status="${contact.status}"`,
        clientMessage: "Envoi indisponible pour ce contact (statut incompatible).",
        context: {
          contactId,
          currentStatus: contact.status,
          allowedStatuses: SEND_ALLOWED_STATUSES,
        },
      });
    }

    // ── 5. campaignId dérivé du contact (D-c4 — source de vérité Firestore) ──
    const { campaignId } = contact;

    // ── 6. Génération Claude (SAME fonction que preview S10.1.4.b) ────────
    // Sentinelle anti-divergence preview/send : test route.test.ts vérifie
    // qu'EXACTEMENT 2 fichiers prod importent `generateFirstSms` (preview
    // + send). Cf. follow-up Notion S10.1.4-FOLLOWUP-SENTINEL-
    // GENERATEFIRSTSMS-001.
    const generation = await generateFirstSms({
      contact: {
        firstName: contact.firstName,
        lastName: contact.lastName,
        civilite: contact.civilite,
        speciality: contact.speciality,
        city: contact.city,
      },
    });

    // ── 7. getOrCreateInitialConversation (précondition handler Inngest) ──
    const { conversationId } = await getOrCreateInitialConversation(contactId, campaignId);

    // ── 8. Audit `sms_send_initiated_by_admin` AVANT inngest.send (D-c6) ──
    // Payload PII-free (S6.2 scrubber + GUARD-002) : contactId opaque,
    // campaignId regex-conforme, smsCharCount numérique, conversationId
    // composite scrubber-safe. Pas de phone, pas de body, pas de nom.
    const auditId = await appendAuditLog({
      actorId: adminUserId,
      actorType: "human",
      action: "sms_send_initiated_by_admin",
      targetType: "contact",
      targetId: contactId,
      payload: {
        contactId,
        campaignId,
        conversationId,
        smsCharCount: generation.body.length,
      },
    });

    // ── 9. Queue Inngest event ────────────────────────────────────────────
    // Event.id NON forgé manuellement — laisse Inngest générer un UUID v4
    // (cf. events.ts l.66-73, règle anti-PII dans event.id).
    const inngest = getInngestClient();
    const event = smsSendFirstRequested.create({
      contactId,
      campaignId,
      body: generation.body,
    });
    const sendResult = await inngest.send(event);
    const jobId = sendResult.ids?.[0] ?? null;

    if (jobId === null) {
      // Cas anormal : Inngest a accepté l'event mais n'a pas retourné d'ID.
      // L'audit est déjà posé (trace forensic "init tenté"). On surface
      // l'anomalie via 500 — l'admin pourra re-cliquer après debug.
      logger.error(
        { auditId, contactId, conversationId },
        "[POST /api/admin/send-first-sms] inngest.send returned no jobId",
      );
      return NextResponse.json(
        {
          error: {
            code: "INTERNAL",
            message: "Envoi queued mais aucun jobId retourné. Vérifiez le dashboard Inngest.",
          },
        },
        { status: 500 },
      );
    }

    // ── 10. Response 202 Accepted ─────────────────────────────────────────
    return NextResponse.json(
      {
        jobId,
        status: "queued" as const,
        contactId,
        smsCharCount: generation.body.length,
      },
      { status: 202 },
    );
  } catch (err) {
    // AppError = surface client connue (401, 403, 404, 409, 400…).
    if (err instanceof AppError) {
      logger.warn(err.toLogObject(), "[POST /api/admin/send-first-sms] AppError");
      return NextResponse.json(err.toClientBody(), { status: err.statusCode });
    }

    // NonRetriableError (Inngest) → renvoyée côté caller via `inngest.send`
    // throw potentiel (rare — Inngest accepte normalement les events sans
    // valider la cible). On log + 500 générique sans fuite.
    if (err instanceof NonRetriableError) {
      logger.error(
        { errName: err.name, errMessage: err.message },
        "[POST /api/admin/send-first-sms] NonRetriableError",
      );
      return NextResponse.json(
        { error: { code: "INTERNAL", message: "Erreur côté pipeline d'envoi." } },
        { status: 500 },
      );
    }

    // Inattendu (Firestore HS, Claude HS, Inngest cloud HS) → 500 générique.
    // Log `errName + errMessage + errCode` (S10.1.12-LIST-CONTACTS-
    // DIAGNOSIS-001) — aligné avec le catch NonRetriableError ci-dessus
    // qui logge déjà errMessage. PAS de `err.stack` (verbeux).
    logger.error(
      {
        errName: err instanceof Error ? err.name : "unknown",
        errMessage: err instanceof Error ? err.message : undefined,
        errCode: (err as { code?: unknown })?.code,
      },
      "[POST /api/admin/send-first-sms] unexpected error",
    );
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Une erreur est survenue. Réessayez plus tard." } },
      { status: 500 },
    );
  }
}
