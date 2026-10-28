/**
 * POST /api/admin/orphan-inbounds/[id]/attach — rattache un orphan à une
 * conversation EXISTANTE (RBAC admin, PR2c tour 2a bis).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Body JSON — seulement `conversationId` (le contactId est dérivé de la
 * conv côté serveur, invariant anti-tamper : un client ne peut pas
 * demander à rattacher à une conv puis prétendre d'autres contactId).
 *
 *   { "conversationId": "<contactId>_<campaignId>" }
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Garanties
 *
 *   - Transaction atomique unique : `attachOrphanToConversation` lie
 *     message + update orphan + opt-out éventuel + 2 audits dans la
 *     MÊME tx. Une panne quelconque rollback TOUT (impossible de laisser
 *     attached + non-désabonné).
 *   - `isOptOut` calculé SERVEUR-SIDE sur orphan.body par le détecteur
 *     partagé (`compliance/opt-out.ts`), jamais reçu du client.
 *   - Léa (Inngest) jamais déclenchée (aucun dispatch d'event).
 *   - Notification Slack best-effort via l'unique résolveur
 *     `notifyOrphanAttachedBestEffort` :
 *       * actor testAccount → SLACK_TEST_CHANNEL_ID (fail-closed si
 *         manquant : log + rien envoyé, jamais de repli).
 *       * conv.handoff.assignedTo défini → DM titulaire (quel que soit
 *         le statut de la conv).
 *       * sinon → canal orphelins.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Note enqueue_failed — auto-relance impossible sans régression PII
 *
 *   Le doc orphan `enqueue_failed` porte `phoneHash` et `idempotencyKey`
 *   mais AUCUN numéro E.164 en clair. L'event Inngest `smsReplyReceived`
 *   exige `phone` en E.164 → impossible de relancer `process-reply` sans
 *   stocker le numéro en orphan (invariant anti-PII orphans). L'admin
 *   rattache manuellement après identification manuelle du PS.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { getContact } from "@/lib/firestore/contacts";
import {
  attachOrphanToConversation,
  OrphanProcessingStateConflict,
} from "@/lib/firestore/orphan-inbounds";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { notifyOrphanAttachedBestEffort } from "@/lib/slack/notify-orphan-action";
import { AppError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

const attachLimiter = createRateLimiter({
  limit: 30,
  window: "1 m",
  prefix: "admin-orphan-attach",
});

const BodySchema = z.object({
  conversationId: z
    .string()
    .regex(/^[^/]+_hubspot-list-\d+$/, "conversationId must match ${contactId}_${campaignId}"),
});

const IdSchema = z.string().regex(/^oih_[A-Za-z0-9_]+$/, "orphan docId must match /^oih_/");

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireRole("admin");

    const rateLimitResponse = await applyAdminRateLimit(attachLimiter, ctx.userId);
    if (rateLimitResponse) return rateLimitResponse;

    const { id } = await params;
    const parsedId = IdSchema.safeParse(id);
    if (!parsedId.success) {
      return NextResponse.json(
        { error: { code: "VALIDATION", message: "Identifiant orphelin invalide." } },
        { status: 400 },
      );
    }

    const rawBody = await request.json().catch(() => null);
    const parsedBody = BodySchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: { code: "VALIDATION", message: "Payload invalide." } },
        { status: 400 },
      );
    }

    // Transaction unique : message + orphan + opt-out + audits.
    const result = await attachOrphanToConversation({
      orphanDocId: parsedId.data,
      conversationId: parsedBody.data.conversationId,
      attachedBy: ctx.userId,
    });

    // Enrichissement notif : firstName/speciality/city depuis le contact
    // (hors tx — lecture seule, impact nul sur l'atomicité des writes).
    const contact = await getContact(result.contactId).catch(() => null);

    const notifyResult = await notifyOrphanAttachedBestEffort({
      actorTestAccount: ctx.testAccount,
      orphanDocId: parsedId.data,
      conversationId: parsedBody.data.conversationId,
      assignedToSlackUserId: result.assignedToSlackUserId,
      firstName: contact?.firstName,
      speciality: contact?.speciality,
      city: contact?.city,
      lastInboundBody: result.body,
      isOptOut: result.wasOptOut,
    });

    return NextResponse.json({
      ok: true,
      messageId: result.messageId,
      phoneMatch: result.phoneMatch,
      wasOptOut: result.wasOptOut,
      notified: notifyResult.kind,
    });
  } catch (err) {
    if (err instanceof OrphanProcessingStateConflict) {
      return NextResponse.json(err.toClientBody(), { status: err.statusCode });
    }
    if (err instanceof AppError) {
      logger.warn(err.toLogObject(), "[POST /api/admin/orphan-inbounds/:id/attach] AppError");
      return NextResponse.json(err.toClientBody(), { status: err.statusCode });
    }
    logger.error(
      {
        errName: err instanceof Error ? err.name : "unknown",
        errMessage: err instanceof Error ? err.message : undefined,
      },
      "[POST /api/admin/orphan-inbounds/:id/attach] unexpected error",
    );
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Une erreur est survenue. Réessayez plus tard." } },
      { status: 500 },
    );
  }
}
