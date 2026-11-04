/**
 * POST /api/admin/contacts/[id]/reveal-phone — révèle le numéro d'un
 * contact depuis la page `/admin/contacts` (admin uniquement), avec audit.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Droits
 *
 *   `requireRole("admin")` — même règle que `GET /api/admin/contacts`
 *   (`route.ts:48`). Un commercial ne peut pas lire la liste des contacts,
 *   donc ne peut pas non plus demander la révélation hors contexte conv.
 *   La règle « commercial titulaire » n'a pas de sens ici (pas de conv).
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { revealContactPhone } from "@/lib/contacts/reveal-contact-phone";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { AppError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";

/** Même préfixe que la route conv — plafond admin partagé. */
const revealLimiter = createRateLimiter({
  limit: 60,
  window: "1 m",
  prefix: "admin-reveal-phone",
});

const BodySchema = z.object({
  method: z.enum(["display", "copy", "call"]),
});

const IdSchema = z.string().min(1).max(256);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireRole("admin");

    const rateLimitResponse = await applyAdminRateLimit(revealLimiter, ctx.userId);
    if (rateLimitResponse) return rateLimitResponse;

    const { id } = await params;
    const parsedId = IdSchema.safeParse(id);
    if (!parsedId.success) {
      return NextResponse.json(
        { error: { code: "VALIDATION", message: "Identifiant contact invalide." } },
        { status: 400 },
      );
    }

    const rawBody = await request.json().catch(() => null);
    const parsedBody = BodySchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: { code: "VALIDATION", message: "Méthode invalide." } },
        { status: 400 },
      );
    }

    const result = await revealContactPhone({
      actor: {
        userId: ctx.userId,
        role: ctx.role,
        slackUserId: ctx.slackUserId,
        testAccount: ctx.testAccount,
      },
      contactId: parsedId.data,
      // Pas de conversationId — contexte liste `/admin/contacts`.
      method: parsedBody.data.method,
    });

    return NextResponse.json(result, {
      status: 200,
      headers: { "Cache-Control": "private, no-store, must-revalidate" },
    });
  } catch (err) {
    if (err instanceof AppError) {
      logger.warn(err.toLogObject(), "[POST /api/admin/contacts/:id/reveal-phone] AppError");
      return NextResponse.json(err.toClientBody(), { status: err.statusCode });
    }
    logger.error(
      {
        errName: err instanceof Error ? err.name : "unknown",
        errMessage: err instanceof Error ? err.message : undefined,
      },
      "[POST /api/admin/contacts/:id/reveal-phone] unexpected error",
    );
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Une erreur est survenue. Réessayez plus tard." } },
      { status: 500 },
    );
  }
}
