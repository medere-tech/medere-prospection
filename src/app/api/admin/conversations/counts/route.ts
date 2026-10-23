/**
 * GET `/api/admin/conversations/counts` — compteurs par onglet (PR2a).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rôle
 *
 *   Exécute une agrégation `count()` par onglet autorisé pour le rôle. Pas
 *   de pagination, pas de documents retournés — seulement un total par
 *   onglet. 3 ou 4 agrégations maximum par appel (3 pour commercial, 4
 *   pour admin). Chaque `count()` compte comme 1 lecture Firestore
 *   facturée (indépendante du nombre de docs comptés).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Droits (identiques à GET /api/admin/conversations)
 *
 *   - commercial : FORCÉ sur `assignedTo == viewer.slackUserId`.
 *   - admin      : libre, filtre `assignedTo` autorisé.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { normalizeContactNameSearch } from "@/lib/firestore/conversation-list-fields";
import { TAB_TO_STATUSES } from "@/lib/firestore/conversation-list-tabs";
import { countConversations, type ListConversationsFilters } from "@/lib/firestore/conversations";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { SLACK_USER_ID_REGEX } from "@/lib/slack/slack-user-id";
import { ForbiddenError, UnauthorizedError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";
import { containsFrenchPhoneNumber } from "@/lib/utils/pii-scrubber";
import type { ConversationStatus } from "@/types/conversation";

const countsLimiter = createRateLimiter({
  limit: 60,
  window: "1 m",
  prefix: "admin-conv-counts",
});

const QuerySchema = z.object({
  // Partage la regex avec `assertSlackUserId` (source unique).
  assignedTo: z.string().regex(SLACK_USER_ID_REGEX, "slackUserId mal formé").optional(),
  campaignId: z.string().min(1).max(80).optional(),
  q: z.string().min(1).max(80).optional(),
});

/**
 * Défense en profondeur — bien que /counts ne retourne que des entiers,
 * un `filterApplied.q` normalisé est renvoyé en clair. On applique la
 * sentinelle PII sur la payload complète.
 */
function assertNoPhoneInPayload(payload: unknown): void {
  if (containsFrenchPhoneNumber(JSON.stringify(payload))) {
    throw new Error("Phone leak detected in /api/admin/conversations/counts response");
  }
}

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    const { role, slackUserId, userId } = await requireRole("commercial");

    // ⚠ BOLA fix — commercial sans slackUserId → 403 fail-closed.
    // Même pattern que /api/admin/conversations.
    if (role === "commercial" && !slackUserId) {
      logger.warn(
        { userId },
        "[/api/admin/conversations/counts] commercial sans slackUserId — accès refusé",
      );
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const rl = await applyAdminRateLimit(countsLimiter, userId);
    if (rl) return rl;

    const url = new URL(req.url);
    const parsed = QuerySchema.safeParse({
      assignedTo: url.searchParams.get("assignedTo") ?? undefined,
      campaignId: url.searchParams.get("campaignId") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json({ error: "validation_error" }, { status: 400 });
    }

    const effectiveAssignedTo =
      role === "commercial" ? (slackUserId ?? null) : (parsed.data.assignedTo ?? null);

    const nameSearch = parsed.data.q ? normalizeContactNameSearch(parsed.data.q) : undefined;

    const baseFilters = (statuses?: ConversationStatus[]): ListConversationsFilters => ({
      ...(statuses && statuses.length > 0 && { statusIn: statuses }),
      ...(parsed.data.campaignId && { campaignId: parsed.data.campaignId }),
      ...(nameSearch && nameSearch.length > 0 && { contactNameSearch: nameSearch }),
    });

    const assigneeFilter = effectiveAssignedTo
      ? ({ kind: "specific", slackUserId: effectiveAssignedTo } as const)
      : ({ kind: "none" } as const);

    // Lance les agrégations en parallèle — 3 lectures pour commercial, 4
    // pour admin.
    const [aTraiter, cloturees, toutes, enCoursMaybe] = await Promise.all([
      countConversations({
        filters: baseFilters(TAB_TO_STATUSES.a_traiter),
        assigneeFilter,
      }),
      countConversations({
        filters: baseFilters(TAB_TO_STATUSES.cloturees),
        assigneeFilter,
      }),
      countConversations({
        filters: baseFilters(),
        assigneeFilter,
      }),
      role === "admin"
        ? countConversations({
            filters: baseFilters(TAB_TO_STATUSES.en_cours),
            assigneeFilter,
          })
        : Promise.resolve<number | null>(null),
    ]);

    const counts: Record<string, number> = {
      a_traiter: aTraiter,
      cloturees,
      toutes,
    };
    if (enCoursMaybe !== null) counts.en_cours = enCoursMaybe;

    const payload = {
      counts,
      filterApplied: {
        role,
        assignedTo: effectiveAssignedTo,
        campaignId: parsed.data.campaignId ?? null,
        q: nameSearch ?? null,
      },
    };

    assertNoPhoneInPayload(payload);

    // security-reviewer PR2b-1 M-1 — même défense en profondeur que /list.
    return NextResponse.json(payload, {
      status: 200,
      headers: { "Cache-Control": "private, no-store, must-revalidate" },
    });
  } catch (err) {
    if (err instanceof UnauthorizedError)
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (err instanceof ForbiddenError)
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    logger.error({ err }, "[/api/admin/conversations/counts] unexpected error");
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
