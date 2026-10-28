"use client";

/**
 * Carte mobile < md pour `/admin/orphan-inbounds` (PR2c tour 2b).
 *
 * Même source d'information que la ligne de table — redispose pour un
 * écran étroit sans scroll horizontal.
 */
import { Badge } from "@/components/ui/badge";
import type { OrphanInboundClientView } from "@/lib/firestore/orphan-inbounds-sanitize";
import { formatDateTimeParis } from "@/lib/utils/format-paris";

import {
  ORPHAN_REASON_EXPLANATIONS,
  ORPHAN_REASON_LABELS,
  ORPHAN_STATE_LABELS,
  UNKNOWN_SENDER_LABEL,
} from "./orphan-labels";

function truncate(s: string, max = 140): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export interface OrphanRowCardProps {
  readonly orphan: OrphanInboundClientView;
  readonly onOpen: (docId: string) => void;
}

export function OrphanRowCard({ orphan, onOpen }: OrphanRowCardProps) {
  const senderName = orphan.contact?.displayName ?? UNKNOWN_SENDER_LABEL;
  const senderSub = [orphan.contact?.speciality, orphan.contact?.city]
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .join(" · ");

  return (
    <button
      type="button"
      onClick={() => onOpen(orphan.docId)}
      className="block w-full rounded-lg border border-border p-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`Ouvrir le détail du SMS orphelin de ${senderName}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="font-medium leading-tight">{senderName}</p>
          {senderSub && <p className="text-xs text-muted-foreground">{senderSub}</p>}
          <p className="mt-1 text-xs text-muted-foreground">
            {ORPHAN_REASON_LABELS[orphan.reason]}
          </p>
        </div>
        <Badge
          variant={
            orphan.processingState === "pending"
              ? "default"
              : orphan.processingState === "attached"
                ? "secondary"
                : "outline"
          }
        >
          {ORPHAN_STATE_LABELS[orphan.processingState]}
        </Badge>
      </div>
      <p className="mt-2 text-xs italic text-muted-foreground">
        {ORPHAN_REASON_EXPLANATIONS[orphan.reason]}
      </p>
      <p className="mt-2 line-clamp-2 text-sm">{truncate(orphan.body)}</p>
      <p className="mt-2 text-xs tabular-nums text-muted-foreground">
        Reçu le {formatDateTimeParis(new Date(orphan.receivedAtIso))}
      </p>
    </button>
  );
}
