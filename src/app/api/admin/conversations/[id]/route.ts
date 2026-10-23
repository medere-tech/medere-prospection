/**
 * GET `/api/admin/conversations/[id]` — payload polling vue conversation
 * (VUE-CONVERSATION PR1).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rôle
 *
 *   Rafraîchit toutes les 30 s par le client React Query dans
 *   `conversation-detail-client.tsx`. Retourne EXACTEMENT la même shape
 *   (`ConversationDetailProps`) que le server component initial.
 *
 * RBAC + accès :
 *   - `requireRole("commercial")` (admin couvre commercial).
 *   - 403 si commercial non-titulaire (`loadConversationDetail` retourne
 *     `kind: "not_mine"`).
 *   - 404 si conversation / contact inconnu.
 *   - 500 opaque sur erreur I/O (pas de leak détail serveur).
 *
 * 🚨 ZÉRO PII dans la réponse : `sanitize.ts` strippe numéros/emails.
 * Sentinelle test grep la payload sérialisée.
 */
import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { loadConversationDetail } from "@/lib/conversations/load-conversation-detail";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { ForbiddenError, UnauthorizedError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

/**
 * Rate-limit : 60 req/min/user, même politique que les autres routes
 * admin (`/api/admin/campaigns`, `/api/admin/contacts`). Clé = Clerk
 * userId pour éviter les faux positifs de NAT.
 */
const conversationDetailLimiter = createRateLimiter({
  limit: 60,
  window: "1 m",
  prefix: "admin-conv-detail",
});

interface RouteParams {
  id: string;
}

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<RouteParams> },
): Promise<Response> {
  try {
    const { role, slackUserId, userId } = await requireRole("commercial");

    // Rate-limit (même politique que les autres routes admin).
    const rateLimitResponse = await applyAdminRateLimit(conversationDetailLimiter, userId);
    if (rateLimitResponse) return rateLimitResponse;

    const { id } = await params;

    const result = await loadConversationDetail(id, { role, slackUserId });

    if (result.kind === "not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (result.kind === "not_mine") {
      // 🔒 Fuite volontaire (décision VUE-CONVERSATION PR1) :
      //   - 403 vs 404 révèle que la conversation EXISTE pour un
      //     commercial authentifié non-titulaire ;
      //   - `assignedToName` révèle le nom public du commercial titulaire
      //     (table Airtable Commerciaux — nom salarié, pas PII du PS).
      //
      // Choix UX délibéré : facilite la demande de transfert d'un
      // commercial à l'autre. Pas une PII des professionnels de santé
      // (contact), uniquement du staff Médéré. Documenté par
      // security-reviewer PR1 (finding INFO [2]) et validé par Déthié.
      return NextResponse.json(
        { error: "forbidden", assignedToName: result.assignedToName },
        { status: 403 },
      );
    }
    if (result.kind === "error") {
      // Opaque — pas de détail serveur dans la réponse.
      return NextResponse.json({ error: "internal_error" }, { status: 500 });
    }

    return NextResponse.json(result.data, { status: 200 });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      // Clerk middleware aurait dû intercepter en amont. Fallback propre.
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    logger.error({ err }, "[GET /api/admin/conversations/[id]] unexpected error");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
