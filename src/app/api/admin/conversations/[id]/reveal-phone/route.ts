/**
 * POST /api/admin/conversations/[id]/reveal-phone — révèle le numéro
 * du contact de la conversation, avec audit (VUE-CONVERSATION PR3).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Discipline
 *
 *   - RBAC : `requireRole("commercial")` (admin + commercial titulaire
 *     passent). La règle d'accès fine (admin OU commercial titulaire)
 *     vit dans `revealContactPhone` (`src/lib/contacts/`). On ne la
 *     recopie PAS ici.
 *   - Rate-limit : 60/min par `userId`.
 *   - Zod strict : `{ method: "display" | "copy" | "call" }`.
 *   - Audit `contact_phone_accessed` écrit AVANT la réponse (fail-closed
 *     dans `revealContactPhone`).
 *   - `contactId` dérivé de `conv.contactId` SERVEUR-SIDE — JAMAIS du
 *     body ni de l'URL (anti-tamper client, miroir
 *     `attachOrphanToConversation`).
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { revealContactPhone } from "@/lib/contacts/reveal-contact-phone";
import { getConversation } from "@/lib/firestore/conversations";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { AppError, NotFoundError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";

/**
 * Rate-limit UNIQUE (partagé avec la route `/api/admin/contacts/[id]/reveal-phone`
 * via le même préfixe) : un admin ne doit pas pouvoir contourner le plafond
 * en alternant les 2 points d'accès.
 */
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
    const ctx = await requireRole("commercial");

    const rateLimitResponse = await applyAdminRateLimit(revealLimiter, ctx.userId);
    if (rateLimitResponse) return rateLimitResponse;

    const { id } = await params;
    const parsedId = IdSchema.safeParse(id);
    if (!parsedId.success) {
      return NextResponse.json(
        { error: { code: "VALIDATION", message: "Identifiant conversation invalide." } },
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

    // Résolution `contactId` SERVEUR-SIDE depuis la conv (anti-tamper).
    const conv = await getConversation(parsedId.data);
    if (conv === null) {
      throw new NotFoundError({
        message: "reveal-phone: conversation not found",
        context: { conversationId: parsedId.data },
      });
    }

    const result = await revealContactPhone({
      actor: {
        userId: ctx.userId,
        role: ctx.role,
        slackUserId: ctx.slackUserId,
        testAccount: ctx.testAccount,
      },
      contactId: conv.contactId,
      conversationId: parsedId.data,
      method: parsedBody.data.method,
    });

    return NextResponse.json(result, {
      status: 200,
      headers: { "Cache-Control": "private, no-store, must-revalidate" },
    });
  } catch (err) {
    if (err instanceof AppError) {
      logger.warn(err.toLogObject(), "[POST /api/admin/conversations/:id/reveal-phone] AppError");
      return NextResponse.json(err.toClientBody(), { status: err.statusCode });
    }
    logger.error(
      {
        errName: err instanceof Error ? err.name : "unknown",
        errMessage: err instanceof Error ? err.message : undefined,
      },
      "[POST /api/admin/conversations/:id/reveal-phone] unexpected error",
    );
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Une erreur est survenue. Réessayez plus tard." } },
      { status: 500 },
    );
  }
}
