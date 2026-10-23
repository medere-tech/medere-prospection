"use client";

/**
 * Colonnes TanStack Table pour `/admin/conversations` (PR2b-1).
 *
 * - Chaque LIGNE est un <Link> à part entière (via `TableRow asChild`
 *   impossible → Link enveloppant construit dans `conversations-page-client.tsx`).
 *   Les cellules ne sont PAS cliquables en JavaScript seul — le comportement
 *   natif du <Link> gère Ctrl/Cmd+clic, Entrée, nouvel onglet.
 * - Les timestamps sont des ISO strings (serveur → client).
 * - `contactCity` et `contactDisplayName` sont des PII pro acceptées (base
 *   légale documentée, cf. compliance-auditor PR2a).
 */
import type { ColumnDef } from "@tanstack/react-table";

import { ConversationStatusBadge } from "@/components/conversations/conversation-status-badge";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDateTimeParis } from "@/lib/utils/format-paris";

import type { ConversationListItem } from "./types";

/**
 * Table meta — accessible depuis chaque cell via
 * `cell.getContext().table.options.meta`. Permet d'injecter des maps de
 * résolution (campagne, commercial) sans fetch par ligne.
 */
export interface ConversationsTableMeta {
  campaignNameById: Map<string, string>;
  commercialNameBySlackId: Map<string, string>;
  viewerSlackUserId: string | null;
  role: "admin" | "commercial";
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "à l'instant";
  const min = Math.floor(sec / 60);
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const days = Math.floor(h / 24);
  if (days < 7) return `il y a ${days} j`;
  // Au-delà de 7 jours : date courte Paris (ex. "15 oct.").
  return d.toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "short",
    timeZone: "Europe/Paris",
  });
}

function authorLabel(preview: ConversationListItem["lastMessagePreview"]): string {
  if (!preview) return "";
  if (preview.direction === "inbound") return "Médecin";
  if (preview.authorKind === "human") return "Commercial";
  return "Léa";
}

export const conversationColumns: ColumnDef<ConversationListItem>[] = [
  {
    id: "contact",
    header: "Médecin",
    cell: ({ row }) => {
      const r = row.original;
      const name = r.contactDisplayName ?? "—";
      const sub = [r.contactSpecialty, r.contactCity].filter(Boolean).join(" · ");
      return (
        <div className="flex flex-col leading-tight">
          <span className="font-medium">{name}</span>
          {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
        </div>
      );
    },
  },
  {
    id: "campaign",
    header: "Campagne",
    cell: ({ row, table }) => {
      const r = row.original;
      const meta = table.options.meta as ConversationsTableMeta | undefined;
      const resolved = meta?.campaignNameById.get(r.campaignId);
      const label = r.campaignName ?? resolved ?? r.campaignId;
      return <span className="text-sm">{label}</span>;
    },
  },
  {
    id: "lastMessage",
    header: "Dernier message",
    cell: ({ row }) => {
      const p = row.original.lastMessagePreview;
      if (!p) return <span className="text-xs text-muted-foreground">Aucun message</span>;
      return (
        <div className="flex flex-col leading-tight max-w-xs">
          <span className="text-xs text-muted-foreground">
            {authorLabel(p)} · {p.direction === "inbound" ? "entrant" : "sortant"}
          </span>
          <span className="truncate text-sm">{p.text}</span>
        </div>
      );
    },
  },
  {
    id: "date",
    header: "Date",
    cell: ({ row }) => {
      const iso = row.original.lastMessageAtIso;
      if (!iso) return <span className="text-xs text-muted-foreground">—</span>;
      return (
        <Tooltip>
          <TooltipTrigger
            render={<span className="text-sm tabular-nums">{formatRelative(iso)}</span>}
          />
          <TooltipContent side="top">{formatDateTimeParis(new Date(iso))}</TooltipContent>
        </Tooltip>
      );
    },
  },
  {
    id: "status",
    header: "Statut",
    cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <ConversationStatusBadge status={row.original.status} />
        {row.original.waitingForHumanReply && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Badge
                  variant="destructive"
                  aria-label="Le médecin attend une réponse"
                  className="whitespace-nowrap"
                >
                  attend réponse
                </Badge>
              }
            />
            <TooltipContent side="top">
              Le médecin attend une réponse (dernier message entrant postérieur à la dernière
              intervention humaine).
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    ),
  },
  {
    id: "assignee",
    header: "Titulaire",
    cell: ({ row, table }) => {
      const r = row.original;
      const meta = table.options.meta as ConversationsTableMeta | undefined;
      if (!r.assignedTo) return <span className="text-xs text-muted-foreground">—</span>;
      if (meta && r.assignedTo === meta.viewerSlackUserId) {
        return <span className="text-sm">Vous</span>;
      }
      const name = meta?.commercialNameBySlackId.get(r.assignedTo);
      // Les commerciaux voient leurs propres conversations UNIQUEMENT → ne
      // devraient jamais rencontrer `assignedTo ≠ viewerSlackUserId` ici.
      // Fallback neutre : « un autre commercial » (même libellé que PR1).
      return <span className="text-sm">{name || "Un autre commercial"}</span>;
    },
  },
];

export const CONVERSATION_COLUMN_COUNT = conversationColumns.length;
