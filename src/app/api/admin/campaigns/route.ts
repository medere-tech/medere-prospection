/**
 * GET /api/admin/campaigns — liste les campagnes HubSpot (RBAC admin).
 *
 * Wrap `listSmsLists()` derrière l'auth Clerk admin pour que le client
 * dashboard `/admin/contacts` (S10.1.5) puisse refresh dynamiquement la
 * liste des campagnes sans tirer le SDK HubSpot dans le bundle client.
 *
 * Au SSR initial, la page `/admin/contacts/page.tsx` appelle `listSmsLists`
 * direct (server-side, plus rapide qu'un round-trip API) — cf. décision
 * S10.1.5-A1 override Phase 5. Cette route est utilisée pour les refetch
 * client-side ultérieurs (refresh manuel, future invalidation cache).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pattern identique S10.1.4.a/b/c — auth → safeParse (N/A ici, pas de
 * query params) → call wrapper → toClientBody / 500 catch.
 */
import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { listSmsLists } from "@/lib/hubspot/lists";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { AppError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

/**
 * Rate-limit Upstash (S10.1.9 RATELIMIT-001) : 60 req/min par admin (clé
 * Clerk userId). Lecture HubSpot read-only — pas de coût LLM/SMS — mais
 * un token compromis qui spam pourrait épuiser le quota HubSpot API
 * partagé par le projet.
 *
 * Lazy : aucun I/O à l'import (cf. test rate-limit.test.ts).
 */
const campaignsListLimiter = createRateLimiter({
  limit: 60,
  window: "1 m",
  prefix: "admin-campaigns-list",
});

// Pas de paramètre — Next.js accepte la signature `GET()` sans request,
// la route ne lit aucun query param ni body (cf. campaigns/route.ts JSDoc).
export async function GET(): Promise<NextResponse> {
  try {
    const { userId } = await requireRole("admin");

    // ── Rate-limit Upstash (S10.1.9 RATELIMIT-001) ────────────────────────
    const rateLimitResponse = await applyAdminRateLimit(campaignsListLimiter, userId);
    if (rateLimitResponse) return rateLimitResponse;

    const campaigns = await listSmsLists("SMS");

    return NextResponse.json({ campaigns });
  } catch (err) {
    if (err instanceof AppError) {
      logger.warn(err.toLogObject(), "[GET /api/admin/campaigns] AppError");
      return NextResponse.json(err.toClientBody(), { status: err.statusCode });
    }
    logger.error(
      { errName: err instanceof Error ? err.name : "unknown" },
      "[GET /api/admin/campaigns] unexpected error",
    );
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Une erreur est survenue. Réessayez plus tard." } },
      { status: 500 },
    );
  }
}
