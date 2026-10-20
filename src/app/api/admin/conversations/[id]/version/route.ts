/**
 * GET `/api/admin/conversations/[id]/version` — endpoint LÉGER de polling
 * (VUE-CONVERSATION PR1 — polling économique).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rôle
 *
 *   Rafraîchit toutes les 30 s par le client React Query. Lit UNIQUEMENT
 *   la conversation (1 read Firestore, pas 245 comme l'endpoint détail).
 *   Si la signature de version a changé entre 2 polls → le client
 *   déclenche un refetch de l'endpoint `/[id]` complet. Sinon rien.
 *
 *   Impact lecture Firestore :
 *     - Avant (polling direct `/[id]`) : jusqu'à **245 reads/poll**
 *       (1 getConversation + 1 getContact + 201 listMessagesInConversation
 *       + 2×21 listAuditLogByTarget).
 *     - Après (polling `/version` seul) : **1 read/poll** quand rien ne
 *       change. 245 reads uniquement quand une mutation réelle est
 *       détectée. Gain ~**99.6 %** sur les polls "quiet".
 *
 *   Pour 10 commerciaux × 1 onglet × 8 h/j :
 *     - Avant : ~2.3 M reads/jour (29k/h × 8h × 10).
 *     - Après (90 % de polls quiet) : ~290k reads/jour (dont 10% × 245
 *       pour les polls "noisy"). Gain ~**87 %**.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Signature de version — champs retournés
 *
 *   `{ updatedAtIso, status, assignedTo, inboundCount, outboundCount,
 *      lastInboundAtIso, lastOutboundAtIso }`
 *
 *   Le client compare la signature complète (JSON.stringify) entre 2
 *   polls. Si différente → refetch détail.
 *
 *   Fiabilité du marqueur `updatedAt` — chemins qui le bump :
 *   - `incrementMessageCount` (`src/lib/firestore/conversations.ts:1151`)
 *     → appelé par addOutbound/addInbound + leurs variantes InTx.
 *   - `setHandoff` (`src/lib/firestore/conversations.ts:1247`).
 *   - `markOptedOut` (`src/lib/firestore/contacts.ts` dans la tx atomique
 *     contact + conversation).
 *   - `setConversationIntent` (`src/lib/firestore/conversations.ts:1384`).
 *   - `updateMessageStatus` (`src/lib/firestore/messages.ts:2127` — bump
 *     ajouté en VUE-CONVERSATION PR1 pour signaler les DLR OVH).
 *   - Scripts manuels `close-stale-orphans.mjs` + `close-duplicate-inbound.mjs`
 *     mettent à jour `updatedAt`.
 *   - PR4 `markHandoffContacted` à venir : écrira `updatedAt` dans la
 *     même tx que `handoff.contactedAt` (contrat fixé).
 *
 *   Chemins qui N'INFLUENCENT PAS la vue conversation et ne touchent
 *   PAS `updatedAt` (volontaire) :
 *   - `appendAuditLog` / `appendAuditLogTx` : collection `audit_log/`
 *     indépendante. Les actions qui apparaissent dans le journal
 *     latéral (handoff, opt_out, intent_classified) viennent de
 *     mutations qui touchent `conv.updatedAt` dans la MÊME tx. Donc
 *     l'audit log suit toujours une mutation conv détectée.
 *     Exceptions :
 *       - `inbound_relayed_to_human` (process-reply sur handed_off) : la
 *         même pipeline fait `markOptedOut` ou `addInbound` dans la même
 *         exécution → `conv.updatedAt` bougerait. ✓
 *       - `contact_phone_accessed` (PR3) : cible `targetType: "contact"`,
 *         pas la conv. Pas pertinent pour le journal conv de la vue.
 *         À reconsidérer en PR3 UI.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * RBAC + rate-limit
 *
 *   - `requireRole("commercial")` (admin couvre commercial).
 *   - `applyAdminRateLimit` 60 req/min/user (même politique que
 *     `/api/admin/campaigns`, `/api/admin/contacts`). Avec 30 s polling,
 *     1 req/poll → 2 req/min/onglet. 60/min laisse marge pour
 *     ~30 onglets simultanés par admin — généreux.
 *   - Même contrôle d'accès que `/[id]` complet : commercial non-titulaire
 *     reçoit 403 (sans leak sur la version — on retourne 403 avant lecture).
 *   - 404 opaque si conv absente.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 Zéro PII dans la réponse
 *
 *   Les champs retournés sont tous techniques (compteurs, timestamps,
 *   enum, Slack userId). Pas de body, pas de contact, pas d'audit.
 *   Sentinelle test grep `+33`/`0033`/`@` sur la réponse.
 */
import { NextResponse } from "next/server";

import { resolveCommercialBySlackUserId } from "@/lib/airtable/commerciaux";
import { requireRole } from "@/lib/auth/require-role";
import { getConversation } from "@/lib/firestore/conversations";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { ForbiddenError, UnauthorizedError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

/** Rate-limit : 60 req/min/user. Même politique que les autres routes admin. */
const versionLimiter = createRateLimiter({
  limit: 60,
  window: "1 m",
  prefix: "admin-conv-version",
});

interface RouteParams {
  id: string;
}

export const dynamic = "force-dynamic";

/**
 * Shape de la version. Compare `JSON.stringify(prev) !== JSON.stringify(next)`
 * côté client suffit — tous les champs sont des primitives/ISO.
 */
interface ConversationVersion {
  updatedAtIso: string;
  status: string;
  assignedTo: string | null;
  inboundCount: number;
  outboundCount: number;
  lastInboundAtIso: string | null;
  lastOutboundAtIso: string | null;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<RouteParams> },
): Promise<Response> {
  try {
    const { role, slackUserId, userId } = await requireRole("commercial");

    // Rate-limit (même politique que les autres routes admin).
    const rateLimitResponse = await applyAdminRateLimit(versionLimiter, userId);
    if (rateLimitResponse) return rateLimitResponse;

    const { id } = await params;

    // Lecture conversation seule (1 read Firestore).
    const conv = await getConversation(id);
    if (conv === null) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    // Contrôle d'accès : commercial non-titulaire → 403 (sans leak version).
    const assignedTo = conv.handoff?.assignedTo ?? null;
    if (role !== "admin") {
      if (!slackUserId || slackUserId !== assignedTo) {
        const commercial = assignedTo
          ? await resolveCommercialBySlackUserId(assignedTo).catch(() => null)
          : null;
        return NextResponse.json(
          {
            error: "forbidden",
            // Même choix UX que `/[id]` complet : nom public salarié
            // Médéré pour faciliter le transfert (fuite documentée).
            assignedToName: commercial?.name ?? null,
          },
          { status: 403 },
        );
      }
    }

    const version: ConversationVersion = {
      updatedAtIso: conv.updatedAt.toDate().toISOString(),
      status: conv.status,
      assignedTo,
      inboundCount: conv.inboundCount,
      outboundCount: conv.outboundCount,
      lastInboundAtIso: conv.lastInboundAt?.toDate().toISOString() ?? null,
      lastOutboundAtIso: conv.lastOutboundAt?.toDate().toISOString() ?? null,
    };

    return NextResponse.json(version, { status: 200 });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    logger.error({ err }, "[GET /api/admin/conversations/[id]/version] unexpected error");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
