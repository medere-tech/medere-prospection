/**
 * GET /api/admin/commerciaux — liste des commerciaux Airtable (admin only).
 *
 * Même pattern que `/api/admin/campaigns` (S10.1.5) : wrap
 * `listCommerciauxForFilter()` derrière Clerk admin pour permettre au test
 * E2E L11 de lire le vrai nom à la SOURCE sans avoir à inventer de valeur.
 *
 * Zéro PII — on ne renvoie QUE les champs déjà exposés par la page SSR
 * `/admin/conversations` au client (`slackUserId`, `name`, `active`).
 */
import { NextResponse } from "next/server";

import { listCommerciauxForFilter } from "@/lib/airtable/commerciaux";
import { requireRole } from "@/lib/auth/require-role";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { AppError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

const commerciauxListLimiter = createRateLimiter({
  limit: 60,
  window: "1 m",
  prefix: "admin-commerciaux-list",
});

export async function GET(): Promise<NextResponse> {
  try {
    const { userId } = await requireRole("admin");

    const rateLimitResponse = await applyAdminRateLimit(commerciauxListLimiter, userId);
    if (rateLimitResponse) return rateLimitResponse;

    const all = await listCommerciauxForFilter();
    // Projection minimale miroir de celle exposée par
    // `src/app/admin/conversations/page.tsx:60-66`. Toute surface étendue
    // ultérieurement DOIT être justifiée en security review (contient
    // slackUserId → scope workspace).
    const commerciaux = all.map((c) => ({
      slackUserId: c.slackUserId,
      name: c.name,
      active: c.active,
    }));

    return NextResponse.json({ commerciaux });
  } catch (err) {
    if (err instanceof AppError) {
      logger.warn(err.toLogObject(), "[GET /api/admin/commerciaux] AppError");
      return NextResponse.json(err.toClientBody(), { status: err.statusCode });
    }
    logger.error(
      {
        errName: err instanceof Error ? err.name : "unknown",
        errMessage: err instanceof Error ? err.message : undefined,
        errCode: (err as { code?: unknown })?.code,
      },
      "[GET /api/admin/commerciaux] unexpected error",
    );
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Une erreur est survenue. Réessayez plus tard." } },
      { status: 500 },
    );
  }
}
