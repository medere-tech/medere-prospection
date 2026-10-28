/**
 * POST /api/admin/orphan-inbounds/[id]/reopen — remet un orphan dismissed
 * en pending (RBAC admin, PR2c tour 2a). Seule transition
 * `dismissed → pending`.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { OrphanProcessingStateConflict, reopenOrphan } from "@/lib/firestore/orphan-inbounds";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { AppError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

const reopenLimiter = createRateLimiter({
  limit: 60,
  window: "1 m",
  prefix: "admin-orphan-reopen",
});

const IdSchema = z.string().regex(/^oih_[A-Za-z0-9_]+$/, "orphan docId must match /^oih_/");

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireRole("admin");

    const rateLimitResponse = await applyAdminRateLimit(reopenLimiter, ctx.userId);
    if (rateLimitResponse) return rateLimitResponse;

    const { id } = await params;
    const parsedId = IdSchema.safeParse(id);
    if (!parsedId.success) {
      return NextResponse.json(
        { error: { code: "VALIDATION", message: "Identifiant orphelin invalide." } },
        { status: 400 },
      );
    }

    await reopenOrphan({
      orphanDocId: parsedId.data,
      reopenedBy: ctx.userId,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof OrphanProcessingStateConflict) {
      return NextResponse.json(err.toClientBody(), { status: err.statusCode });
    }
    if (err instanceof AppError) {
      logger.warn(err.toLogObject(), "[POST /api/admin/orphan-inbounds/:id/reopen] AppError");
      return NextResponse.json(err.toClientBody(), { status: err.statusCode });
    }
    logger.error(
      { errName: err instanceof Error ? err.name : "unknown" },
      "[POST /api/admin/orphan-inbounds/:id/reopen] unexpected error",
    );
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Une erreur est survenue. Réessayez plus tard." } },
      { status: 500 },
    );
  }
}
