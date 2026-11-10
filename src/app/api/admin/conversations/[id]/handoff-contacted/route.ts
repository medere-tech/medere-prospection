/**
 * POST + DELETE `/api/admin/conversations/[id]/handoff-contacted`
 * — PR4 « J'ai contacté le médecin ».
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Discipline (identique aux autres routes admin)
 *
 *   1. `requireRole("commercial")` — admin + commercial passent le
 *      portail RBAC ; le filtre fin (titulaire pour mark, auteur pour
 *      unmark) vit dans le core `markHandoffContacted` /
 *      `unmarkHandoffContacted`. On ne le recopie PAS ici.
 *   2. `applyAdminRateLimit` (30/min par userId, préfixe
 *      `admin-handoff-contacted` — partagé POST/DELETE : un rep ne
 *      doit pas pouvoir alterner pour contourner).
 *   3. Zod `IdSchema` strict sur `params.id`.
 *   4. Délégation au core — toute la logique transactionnelle
 *      (existence → droits → statut → idempotence → écriture+audit)
 *      est là, PAS ici.
 *   5. Mapping `AppError → status + body client`, 500 générique
 *      sinon. Les détails restent côté serveur (`logger.warn/error`).
 *
 * La route reste un wrapper mince (~30 lignes utiles), les tests
 * couvrent chaque garde (rôle avant rate-limit, Zod après rate-limit).
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import {
  markHandoffContacted,
  unmarkHandoffContacted,
} from "@/lib/conversations/mark-handoff-contacted";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { AppError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";

const handoffContactedLimiter = createRateLimiter({
  limit: 30,
  window: "1 m",
  prefix: "admin-handoff-contacted",
});

const IdSchema = z.string().min(1).max(256);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireRole("commercial");

    const rateLimitResponse = await applyAdminRateLimit(handoffContactedLimiter, ctx.userId);
    if (rateLimitResponse) return rateLimitResponse;

    const { id } = await params;
    const parsedId = IdSchema.safeParse(id);
    if (!parsedId.success) {
      return NextResponse.json(
        { error: { code: "VALIDATION", message: "Identifiant conversation invalide." } },
        { status: 400 },
      );
    }

    const result = await markHandoffContacted({
      actor: {
        userId: ctx.userId,
        role: ctx.role,
        slackUserId: ctx.slackUserId,
        testAccount: ctx.testAccount,
      },
      conversationId: parsedId.data,
    });

    return NextResponse.json(result, {
      status: 200,
      headers: { "Cache-Control": "private, no-store, must-revalidate" },
    });
  } catch (err) {
    return mapError(err, "POST");
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireRole("commercial");

    const rateLimitResponse = await applyAdminRateLimit(handoffContactedLimiter, ctx.userId);
    if (rateLimitResponse) return rateLimitResponse;

    const { id } = await params;
    const parsedId = IdSchema.safeParse(id);
    if (!parsedId.success) {
      return NextResponse.json(
        { error: { code: "VALIDATION", message: "Identifiant conversation invalide." } },
        { status: 400 },
      );
    }

    await unmarkHandoffContacted({
      actor: {
        userId: ctx.userId,
        role: ctx.role,
        slackUserId: ctx.slackUserId,
        testAccount: ctx.testAccount,
      },
      conversationId: parsedId.data,
    });

    return NextResponse.json(
      {},
      {
        status: 200,
        headers: { "Cache-Control": "private, no-store, must-revalidate" },
      },
    );
  } catch (err) {
    return mapError(err, "DELETE");
  }
}

function mapError(err: unknown, method: "POST" | "DELETE"): NextResponse {
  if (err instanceof AppError) {
    logger.warn(
      err.toLogObject(),
      `[${method} /api/admin/conversations/:id/handoff-contacted] AppError`,
    );
    return NextResponse.json(err.toClientBody(), { status: err.statusCode });
  }
  logger.error(
    {
      errName: err instanceof Error ? err.name : "unknown",
      errMessage: err instanceof Error ? err.message : undefined,
    },
    `[${method} /api/admin/conversations/:id/handoff-contacted] unexpected error`,
  );
  return NextResponse.json(
    { error: { code: "INTERNAL", message: "Une erreur est survenue. Réessayez plus tard." } },
    { status: 500 },
  );
}
