/**
 * GET /api/admin/orphan-inbounds/[id] — détail d'un orphan (RBAC admin,
 * PR2c tour 2a).
 *
 * Fail-closed `isTestFixture` : un orphan `isTestFixture: true` n'est
 * accessible qu'aux comptes `testAccount`. Pour un admin réel, l'id
 * renvoie 404 (comme s'il n'existait pas — ne jamais confirmer son existence).
 *
 * `phoneHash` et `idempotencyKey` sont strippés par `sanitizeOrphanInboundForClient`.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { enrichOrphanWithContact } from "@/lib/firestore/orphan-enrich";
import { getOrphanInbound } from "@/lib/firestore/orphan-inbounds";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { AppError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

const orphanDetailLimiter = createRateLimiter({
  limit: 60,
  window: "1 m",
  prefix: "admin-orphan-detail",
});

const IdSchema = z.string().regex(/^oih_[A-Za-z0-9_]+$/, "orphan docId must match /^oih_/");

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireRole("admin");

    const rateLimitResponse = await applyAdminRateLimit(orphanDetailLimiter, ctx.userId);
    if (rateLimitResponse) return rateLimitResponse;

    const { id } = await params;
    const parsed = IdSchema.safeParse(id);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: "VALIDATION", message: "Identifiant orphelin invalide." } },
        { status: 400 },
      );
    }

    const view = await getOrphanInbound(parsed.data, { includeTestFixtures: ctx.testAccount });
    if (view === null) {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "Orphelin introuvable." } },
        { status: 404 },
      );
    }

    const orphan = await enrichOrphanWithContact(view);
    return NextResponse.json({ orphan });
  } catch (err) {
    if (err instanceof AppError) {
      logger.warn(err.toLogObject(), "[GET /api/admin/orphan-inbounds/:id] AppError");
      return NextResponse.json(err.toClientBody(), { status: err.statusCode });
    }
    logger.error(
      { errName: err instanceof Error ? err.name : "unknown" },
      "[GET /api/admin/orphan-inbounds/:id] unexpected error",
    );
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Une erreur est survenue. Réessayez plus tard." } },
      { status: 500 },
    );
  }
}
