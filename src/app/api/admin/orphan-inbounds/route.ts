/**
 * GET /api/admin/orphan-inbounds — liste paginée des SMS orphelins (RBAC admin).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Query params (optionnels) :
 *   - `processingState` : "pending" | "attached" | "dismissed"
 *   - `reason`          : "no_conversation" | "unknown_contact" |
 *                         "parse_failed" | "enqueue_failed"
 *   - `cursor`          : docId `oih_...` pour pagination
 *   - `limit`           : 1..100 (défaut 50)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Fail-closed `isTestFixture`
 *
 *   Les docs `isTestFixture: true` ne sont inclus QUE si le claim JWT
 *   `testAccount === true` du compte Clerk courant. Jamais depuis un
 *   query param client — le claim est l'unique source. En prod,
 *   `testAccount === true` est refusé par `requireRole` → aucune
 *   fixture n'est jamais retournée en prod.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import {
  LIST_ORPHAN_INBOUNDS_MAX_LIMIT,
  listOrphanInbounds,
} from "@/lib/firestore/orphan-inbounds";
import { sanitizeOrphanInboundForClient } from "@/lib/firestore/orphan-inbounds-sanitize";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { AppError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

const orphansListLimiter = createRateLimiter({
  limit: 60,
  window: "1 m",
  prefix: "admin-orphans-list",
});

const QuerySchema = z.object({
  processingState: z.enum(["pending", "attached", "dismissed"]).optional(),
  reason: z
    .enum(["no_conversation", "unknown_contact", "parse_failed", "enqueue_failed"])
    .optional(),
  cursor: z
    .string()
    .regex(/^oih_[A-Za-z0-9_]+$/, "cursor must be a valid orphan docId")
    .optional(),
  limit: z.coerce.number().int().min(1).max(LIST_ORPHAN_INBOUNDS_MAX_LIMIT).optional(),
});

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireRole("admin");

    const rateLimitResponse = await applyAdminRateLimit(orphansListLimiter, ctx.userId);
    if (rateLimitResponse) return rateLimitResponse;

    const url = new URL(request.url);
    const parsed = QuerySchema.safeParse({
      processingState: url.searchParams.get("processingState") ?? undefined,
      reason: url.searchParams.get("reason") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });

    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: "VALIDATION", message: "Paramètres invalides." } },
        { status: 400 },
      );
    }

    const result = await listOrphanInbounds({
      filters: {
        ...(parsed.data.processingState !== undefined
          ? { processingState: parsed.data.processingState }
          : {}),
        ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
      },
      ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
      ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
      includeTestFixtures: ctx.testAccount,
    });

    return NextResponse.json({
      orphans: result.orphans.map((o) => sanitizeOrphanInboundForClient(o)),
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    });
  } catch (err) {
    if (err instanceof AppError) {
      logger.warn(err.toLogObject(), "[GET /api/admin/orphan-inbounds] AppError");
      return NextResponse.json(err.toClientBody(), { status: err.statusCode });
    }
    logger.error(
      {
        errName: err instanceof Error ? err.name : "unknown",
        errMessage: err instanceof Error ? err.message : undefined,
      },
      "[GET /api/admin/orphan-inbounds] unexpected error",
    );
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Une erreur est survenue. Réessayez plus tard." } },
      { status: 500 },
    );
  }
}
