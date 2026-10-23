/**
 * GET `/api/admin/conversations` — liste paginée pour `/admin/conversations`
 * (PR2a backend).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Droits (serveur, jamais côté UI)
 *
 *   - `requireRole("commercial")` : admin couvre commercial.
 *   - `admin`      → onglets `a_traiter` | `en_cours` | `cloturees` |
 *                    `toutes`. Peut filtrer par commercial via `assignedTo`.
 *   - `commercial` → onglets `a_traiter` | `cloturees` | `toutes` seulement.
 *                    `assignedTo` est FORCÉ sur son `slackUserId` serveur
 *                    (ignoré silencieusement si fourni dans la query).
 *   - sans rôle    → page `forbidden.tsx` via `requireRole` throw.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Paramètres de query (Zod strict)
 *
 *   - `tab`        : enum fermé — mapping serveur vers un `status in[...]`.
 *                    Un commercial qui passe `tab=en_cours` → 403.
 *   - `assignedTo` : Slack userId. IGNORÉ pour commercial. Pour admin,
 *                    permet de filtrer par commercial.
 *   - `campaignId` : HubSpot list id.
 *   - `q`          : recherche préfixe sur le nom (normalisée côté serveur
 *                    comme à l'écriture : lower + strip accents + collapse
 *                    whitespaces). ⚠️ En mode recherche, le tri bascule
 *                    sur `contactNameSearch asc` puis `lastMessageAt desc`
 *                    (contrainte Firestore inégalité). Documenté côté UI.
 *   - `cursor`     : docId opaque pour la pagination `startAfter`.
 *   - `limit`      : 1..100, défaut 25.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Sentinelle PII
 *
 *   La payload est passée à `containsFrenchPhoneNumber` (source partagée
 *   avec logger + sanitize preview). Si un numéro FR traîne (régression
 *   d'un sanitize à l'écriture), la route retourne 500 côté serveur
 *   plutôt que de leaker un numéro.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { normalizeContactNameSearch } from "@/lib/firestore/conversation-list-fields";
import { ALLOWED_TABS_BY_ROLE, statusesForTab } from "@/lib/firestore/conversation-list-tabs";
import {
  LIST_CONVERSATIONS_DEFAULT_LIMIT,
  LIST_CONVERSATIONS_MAX_LIMIT,
  listConversations,
  listConversationsByAssignee,
  type ListConversationsFilters,
} from "@/lib/firestore/conversations";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { SLACK_USER_ID_REGEX } from "@/lib/slack/slack-user-id";
import { ForbiddenError, UnauthorizedError, ValidationError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";
import { containsFrenchPhoneNumber } from "@/lib/utils/pii-scrubber";

// ─────────────────────────────────────────────────────────────────────────────
// Rate limit + validation
// ─────────────────────────────────────────────────────────────────────────────

const conversationsListLimiter = createRateLimiter({
  limit: 60,
  window: "1 m",
  prefix: "admin-conv-list",
});

const QuerySchema = z.object({
  tab: z.enum(["a_traiter", "en_cours", "cloturees", "toutes"]).optional(),
  // Partage la regex avec `assertSlackUserId` (source unique). Supporte
  // les préfixes U (user) et W (Enterprise Grid) — M-2 security review.
  assignedTo: z.string().regex(SLACK_USER_ID_REGEX, "slackUserId mal formé").optional(),
  campaignId: z.string().min(1).max(80).optional(),
  q: z.string().min(1).max(80).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(LIST_CONVERSATIONS_MAX_LIMIT).optional(),
});

/**
 * Sentinelle PII — lève si un numéro FR traîne dans la payload sérialisée.
 * Partage les regex avec le logger via `pii-scrubber`.
 */
function assertNoPhoneInPayload(payload: unknown): void {
  const s = JSON.stringify(payload);
  if (containsFrenchPhoneNumber(s)) {
    throw new Error("Phone leak detected in /api/admin/conversations response");
  }
}

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    const { role, slackUserId, userId } = await requireRole("commercial");

    // ⚠ BOLA fix (security review PR2a) — un commercial dont le compte
    // Clerk n'a pas (encore) de `publicMetadata.slackUserId` serait
    // autrement traité comme "sans assignee" → `listConversations()`
    // retournerait TOUTES les conversations de l'équipe. Fail-closed.
    // Même pattern que `load-conversation-detail.ts` PR1.
    if (role === "commercial" && !slackUserId) {
      logger.warn(
        { userId },
        "[/api/admin/conversations] commercial sans slackUserId — accès refusé",
      );
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const rl = await applyAdminRateLimit(conversationsListLimiter, userId);
    if (rl) return rl;

    const url = new URL(req.url);
    const parsed = QuerySchema.safeParse({
      tab: url.searchParams.get("tab") ?? undefined,
      assignedTo: url.searchParams.get("assignedTo") ?? undefined,
      campaignId: url.searchParams.get("campaignId") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "validation_error",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            code: i.code,
          })),
        },
        { status: 400 },
      );
    }

    const tab = parsed.data.tab ?? "toutes";
    const allowedTabs = ALLOWED_TABS_BY_ROLE[role === "admin" ? "admin" : "commercial"];
    if (!allowedTabs.includes(tab)) {
      // Commercial qui demande `en_cours` → 403 explicite serveur, pas 400.
      return NextResponse.json({ error: "forbidden_tab" }, { status: 403 });
    }

    const statuses = statusesForTab(tab);
    const limit = parsed.data.limit ?? LIST_CONVERSATIONS_DEFAULT_LIMIT;

    // Dispatch droits serveur.
    //  - commercial : FORCÉ sur son slackUserId (ignore `assignedTo` query).
    //  - admin      : libre (peut passer assignedTo pour filtrer par commercial).
    const effectiveAssignedTo =
      role === "commercial" ? (slackUserId ?? null) : (parsed.data.assignedTo ?? null);

    // Normalisation serveur de la recherche (miroir
    // `normalizeContactNameSearch` utilisée à l'écriture → tout préfixe
    // envoyé par l'UI matche la version écrite dans Firestore).
    const nameSearch = parsed.data.q ? normalizeContactNameSearch(parsed.data.q) : undefined;

    const filters: ListConversationsFilters = {
      ...(statuses && statuses.length > 0 && { statusIn: statuses }),
      ...(parsed.data.campaignId && { campaignId: parsed.data.campaignId }),
      ...(nameSearch && nameSearch.length > 0 && { contactNameSearch: nameSearch }),
    };

    const listInput = {
      limit,
      cursor: parsed.data.cursor,
      filters,
    };

    const result = effectiveAssignedTo
      ? await listConversationsByAssignee(effectiveAssignedTo, listInput)
      : await listConversations(listInput);

    // Payload défensive — champs minimaux pour la liste. La route détail
    // `/api/admin/conversations/[id]` reste la source pour la vue complète.
    const items = result.conversations.map((c) => ({
      conversationId: c.conversationId,
      campaignId: c.campaignId,
      status: c.status,
      intent: c.intent,
      assignedTo: c.assignedTo ?? null,
      lastMessageAt: c.lastMessageAt ?? null,
      lastInboundAt: c.lastInboundAt ?? null,
      lastOutboundAt: c.lastOutboundAt ?? null,
      lastHumanOutboundAt: c.lastHumanOutboundAt ?? null,
      inboundCount: c.inboundCount,
      outboundCount: c.outboundCount,
      contactDisplayName: c.contactDisplayName ?? null,
      contactSpecialty: c.contactSpecialty ?? null,
      contactCity: c.contactCity ?? null,
      campaignName: c.campaignName ?? null,
      lastMessagePreview: c.lastMessagePreview ?? null,
      // Signal « le médecin attend une réponse » dérivé serveur :
      //   true si un inbound existe depuis la dernière intervention humaine
      //   (ou si aucune intervention humaine et un inbound existe).
      waitingForHumanReply: Boolean(
        c.lastInboundAt &&
        (!c.lastHumanOutboundAt || c.lastInboundAt.toMillis() > c.lastHumanOutboundAt.toMillis()),
      ),
    }));

    const payload = {
      items,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      filterApplied: {
        role,
        tab,
        assignedTo: effectiveAssignedTo,
        statuses: statuses ?? null,
        campaignId: parsed.data.campaignId ?? null,
        q: nameSearch ?? null,
        searchMode: Boolean(nameSearch),
      },
    };

    assertNoPhoneInPayload(payload);

    return NextResponse.json(payload, { status: 200 });
  } catch (err) {
    if (err instanceof UnauthorizedError)
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (err instanceof ForbiddenError)
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    if (err instanceof ValidationError)
      return NextResponse.json(
        { error: "validation_error", message: err.clientMessage },
        { status: 400 },
      );
    logger.error({ err }, "[/api/admin/conversations] unexpected error");
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
