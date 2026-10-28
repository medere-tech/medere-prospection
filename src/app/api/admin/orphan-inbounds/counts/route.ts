/**
 * GET /api/admin/orphan-inbounds/counts — compteurs par processingState
 * (RBAC admin, PR2c tour 2a).
 *
 * Fail-closed `isTestFixture` identique à la route liste.
 */
import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { countOrphanInboundsByState } from "@/lib/firestore/orphan-inbounds";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { AppError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

const orphansCountsLimiter = createRateLimiter({
  limit: 60,
  window: "1 m",
  prefix: "admin-orphans-counts",
});

export async function GET(): Promise<NextResponse> {
  try {
    const ctx = await requireRole("admin");

    const rateLimitResponse = await applyAdminRateLimit(orphansCountsLimiter, ctx.userId);
    if (rateLimitResponse) return rateLimitResponse;

    const counts = await countOrphanInboundsByState({
      includeTestFixtures: ctx.testAccount,
    });

    return NextResponse.json({ counts });
  } catch (err) {
    if (err instanceof AppError) {
      logger.warn(err.toLogObject(), "[GET /api/admin/orphan-inbounds/counts] AppError");
      return NextResponse.json(err.toClientBody(), { status: err.statusCode });
    }
    logger.error(
      {
        errName: err instanceof Error ? err.name : "unknown",
      },
      "[GET /api/admin/orphan-inbounds/counts] unexpected error",
    );
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Une erreur est survenue. Réessayez plus tard." } },
      { status: 500 },
    );
  }
}
