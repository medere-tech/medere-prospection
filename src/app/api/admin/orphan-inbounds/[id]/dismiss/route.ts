/**
 * POST /api/admin/orphan-inbounds/[id]/dismiss — marque un orphan traité
 * sans rattachement (RBAC admin, PR2c tour 2a).
 *
 * Transition atomique `pending → dismissed`. Motif figé par enum
 * (pas de texte libre).
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { dismissOrphan, OrphanProcessingStateConflict } from "@/lib/firestore/orphan-inbounds";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { AppError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

const dismissLimiter = createRateLimiter({
  limit: 60,
  window: "1 m",
  prefix: "admin-orphan-dismiss",
});

const BodySchema = z.object({
  dismissReason: z.enum([
    "unrelated_or_spam",
    "already_handled_elsewhere",
    "sender_not_identifiable",
  ]),
});

const IdSchema = z.string().regex(/^oih_[A-Za-z0-9_]+$/, "orphan docId must match /^oih_/");

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireRole("admin");

    const rateLimitResponse = await applyAdminRateLimit(dismissLimiter, ctx.userId);
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
        { error: { code: "VALIDATION", message: "Motif invalide." } },
        { status: 400 },
      );
    }

    await dismissOrphan({
      orphanDocId: parsedId.data,
      dismissReason: parsedBody.data.dismissReason,
      dismissedBy: ctx.userId,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof OrphanProcessingStateConflict) {
      return NextResponse.json(err.toClientBody(), { status: err.statusCode });
    }
    if (err instanceof AppError) {
      logger.warn(err.toLogObject(), "[POST /api/admin/orphan-inbounds/:id/dismiss] AppError");
      return NextResponse.json(err.toClientBody(), { status: err.statusCode });
    }
    logger.error(
      { errName: err instanceof Error ? err.name : "unknown" },
      "[POST /api/admin/orphan-inbounds/:id/dismiss] unexpected error",
    );
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Une erreur est survenue. Réessayez plus tard." } },
      { status: 500 },
    );
  }
}
