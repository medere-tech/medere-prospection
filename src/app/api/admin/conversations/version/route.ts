/**
 * GET `/api/admin/conversations/version` — version light de la liste
 * (PR2a, pour le polling 60 s UI PR2b).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rôle & signature
 *
 *   Lit UN SEUL doc : la query filtrée par rôle + onglet + filtres,
 *   triée par `updatedAt desc`, limitée à 1 doc. Retourne un hash
 *   `version` = `${updatedAtMs}_${docId}` que le client compare pour
 *   détecter un changement sans refetcher la liste complète. 1 lecture
 *   Firestore par appel.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi `updatedAt` (et pas `lastMessageAt`)
 *
 *   `lastMessageAt` ne bouge qu'à l'arrivée d'un message. Mais la liste
 *   affiche aussi le statut (`handed_off → closed`), l'assignation, et
 *   l'intent — toutes mutables SANS nouveau message. Si on polle sur
 *   `lastMessageAt`, un changement de statut est invisible côté UI
 *   jusqu'au prochain SMS.
 *
 *   `updatedAt` est bumpé par TOUTES les mutations de conversation :
 *     - `_bumpConversationCountersTx` (messages in/out)
 *     - `setHandoff` (handed_off)
 *     - `setConversationIntent` (intent + nextStatus)
 *     - `markOptedOut` (opt-out, sync conv)
 *     - `updateMessageStatus` (DLR OVH, bump `conv.updatedAt` explicite)
 *   → polling fiable.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Droits (identiques à /api/admin/conversations)
 *
 *   - commercial : FORCÉ sur `assignedTo == viewer.slackUserId`.
 *   - admin      : libre, filtre `assignedTo` autorisé.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { ALLOWED_TABS_BY_ROLE, statusesForTab } from "@/lib/firestore/conversation-list-tabs";
import { queryConversationListVersion } from "@/lib/firestore/conversation-list-version-query";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { SLACK_USER_ID_REGEX } from "@/lib/slack/slack-user-id";
import { ForbiddenError, UnauthorizedError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";
import { containsFrenchPhoneNumber } from "@/lib/utils/pii-scrubber";

const versionLimiter = createRateLimiter({
  limit: 120,
  window: "1 m",
  prefix: "admin-conv-list-version",
});

/**
 * `/version` ne prend QUE les filtres du rôle (`assignedTo`) et de
 * l'onglet (`tab`). Les filtres `campaignId` et `q` ne polluent pas la
 * version : les mutations qui comptent (status, assignation, intent,
 * nouveau message) bougent `conv.updatedAt` indépendamment de ces
 * filtres. Côté UI (PR2b), un changement de `q` ou `campaignId`
 * déclenche de toute façon un refetch complet de la page 1 — pas besoin
 * de polling sur ces axes.
 *
 * Garder la surface d'index minime : limiter aux 4 combinaisons role×tab
 * (admin seul, admin + status, commercial seul, commercial + status).
 */
const QuerySchema = z.object({
  tab: z.enum(["a_traiter", "en_cours", "cloturees", "toutes"]).optional(),
  // Partage la regex avec `assertSlackUserId` (source unique).
  assignedTo: z.string().regex(SLACK_USER_ID_REGEX, "slackUserId mal formé").optional(),
});

/**
 * Sentinelle PII — défense en profondeur. `topConversationId` renvoyé est
 * `${hubspotId}_${campaignId}` ; un hubspotId numérique ne matche
 * normalement pas `FRENCH_PHONE_ANYWHERE_REGEX`, mais on refuse par
 * principe toute payload qui porterait un numéro.
 */
function assertNoPhoneInPayload(payload: unknown): void {
  if (containsFrenchPhoneNumber(JSON.stringify(payload))) {
    throw new Error("Phone leak detected in /api/admin/conversations/version response");
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
        "[/api/admin/conversations/version] commercial sans slackUserId — accès refusé",
      );
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const rl = await applyAdminRateLimit(versionLimiter, userId);
    if (rl) return rl;

    const url = new URL(req.url);
    const parsed = QuerySchema.safeParse({
      tab: url.searchParams.get("tab") ?? undefined,
      assignedTo: url.searchParams.get("assignedTo") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json({ error: "validation_error" }, { status: 400 });
    }

    const tab = parsed.data.tab ?? "toutes";
    const allowedTabs = ALLOWED_TABS_BY_ROLE[role === "admin" ? "admin" : "commercial"];
    if (!allowedTabs.includes(tab)) {
      return NextResponse.json({ error: "forbidden_tab" }, { status: 403 });
    }

    const statuses = statusesForTab(tab);

    const effectiveAssignedTo =
      role === "commercial" ? (slackUserId ?? null) : (parsed.data.assignedTo ?? null);

    const payload = await queryConversationListVersion({
      statusIn: statuses,
      assignedTo: effectiveAssignedTo,
    });

    assertNoPhoneInPayload(payload);

    return NextResponse.json(payload, { status: 200 });
  } catch (err) {
    if (err instanceof UnauthorizedError)
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (err instanceof ForbiddenError)
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    logger.error({ err }, "[/api/admin/conversations/version] unexpected error");
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
