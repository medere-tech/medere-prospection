"use client";

/**
 * Carte mobile — remplace la table sous `md` (< 768 px). PR2b-1.
 *
 * - Toute la carte est un `<Link>` (navigation native : Entrée, Ctrl+clic,
 *   nouvel onglet).
 * - Même source d'information que les colonnes desktop → `columns.tsx`
 *   reste la référence du contenu rendu ; cette vue mobile se contente de
 *   REDISPOSER sans renommer ni enrichir.
 * - Aucun scroll horizontal : la carte prend 100 % de la largeur.
 */
import Link from "next/link";

import { ConversationStatusBadge } from "@/components/conversations/conversation-status-badge";
import { Badge } from "@/components/ui/badge";
import { formatDateTimeParis } from "@/lib/utils/format-paris";

import type { ConversationListItem } from "./types";

function authorLabel(preview: ConversationListItem["lastMessagePreview"]): string {
  if (!preview) return "";
  if (preview.direction === "inbound") return "Médecin";
  if (preview.authorKind === "human") return "Commercial";
  return "Léa";
}

export interface ConversationRowCardProps {
  item: ConversationListItem;
  campaignName: string;
  commercialName: string | null;
  isViewerOwner: boolean;
}

export function ConversationRowCard({
  item,
  campaignName,
  commercialName,
  isViewerOwner,
}: ConversationRowCardProps) {
  const sub = [item.contactSpecialty, item.contactCity].filter(Boolean).join(" · ");
  const p = item.lastMessagePreview;
  const dateLabel = item.lastMessageAtIso
    ? formatDateTimeParis(new Date(item.lastMessageAtIso))
    : null;
  const assigneeLabel = !item.assignedTo
    ? "—"
    : isViewerOwner
      ? "Vous"
      : commercialName || "Un autre commercial";

  return (
    <Link
      href={`/admin/conversations/${encodeURIComponent(item.conversationId)}`}
      className="block rounded-lg border border-border p-3 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`Ouvrir la conversation de ${item.contactDisplayName ?? "ce médecin"}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="font-medium leading-tight">{item.contactDisplayName ?? "—"}</p>
          {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
          <p className="mt-1 text-xs text-muted-foreground">{campaignName}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <ConversationStatusBadge status={item.status} />
          {item.waitingForHumanReply && (
            <Badge
              variant="destructive"
              aria-label="Le médecin attend une réponse"
              className="whitespace-nowrap"
            >
              attend réponse
            </Badge>
          )}
        </div>
      </div>

      {p && (
        <p className="mt-2 line-clamp-2 text-sm">
          <span className="text-xs text-muted-foreground">{authorLabel(p)} · </span>
          <span>{p.text}</span>
        </p>
      )}

      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>{assigneeLabel}</span>
        {dateLabel && <span className="tabular-nums">{dateLabel}</span>}
      </div>
    </Link>
  );
}
