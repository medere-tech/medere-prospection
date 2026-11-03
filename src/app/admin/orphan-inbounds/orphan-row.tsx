"use client";

/**
 * Ligne de table desktop ≥ md pour `/admin/orphan-inbounds` (PR2c tour 2b).
 *
 * - Toute la ligne est cliquable (navigation vers `?id=<docId>`) — Entrée,
 *   Ctrl+clic, double-clic : comportement natif d'un bouton.
 * - Aucun identifiant visible : nom, motif, état et date sont rendus via
 *   la table FR unique `orphan-labels.ts`.
 * - Les cellules sont des `<td>`, la cliquabilité est portée par un
 *   bouton transparent dans la 1re cellule (même pattern que `/admin/
 *   conversations/columns.tsx` → mais ici on ouvre un tiroir, pas une
 *   nouvelle page). On évite le `<Link>` pour cette raison.
 */
import { Badge } from "@/components/ui/badge";
import { TableCell, TableRow } from "@/components/ui/table";
import type { OrphanInboundClientView } from "@/lib/firestore/orphan-inbounds-sanitize";
import { formatDateTimeParis } from "@/lib/utils/format-paris";

import {
  ORPHAN_REASON_EXPLANATIONS,
  ORPHAN_REASON_LABELS,
  ORPHAN_STATE_LABELS,
  UNKNOWN_SENDER_LABEL,
} from "./orphan-labels";

/** Troncature très courte pour l'extrait de SMS en table. */
function truncate(s: string, max = 90): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export interface OrphanRowProps {
  readonly orphan: OrphanInboundClientView;
  readonly onOpen: (docId: string) => void;
}

export function OrphanRow({ orphan, onOpen }: OrphanRowProps) {
  const senderName = orphan.contact?.displayName ?? UNKNOWN_SENDER_LABEL;
  const senderSub = [orphan.contact?.speciality, orphan.contact?.city]
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .join(" · ");

  return (
    <TableRow className="relative">
      <TableCell className="relative">
        <button
          type="button"
          aria-label={`Ouvrir le détail du SMS orphelin de ${senderName}`}
          onClick={() => onOpen(orphan.docId)}
          className="absolute inset-0 z-10 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="sr-only">Ouvrir le détail du SMS orphelin de {senderName}</span>
        </button>
        <span className="relative z-0 text-sm tabular-nums">
          {formatDateTimeParis(new Date(orphan.receivedAtIso))}
        </span>
      </TableCell>
      <TableCell>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-medium">{ORPHAN_REASON_LABELS[orphan.reason]}</span>
          <span className="text-xs text-muted-foreground">
            {ORPHAN_REASON_EXPLANATIONS[orphan.reason]}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-medium">{senderName}</span>
          {senderSub && <span className="text-xs text-muted-foreground">{senderSub}</span>}
        </div>
      </TableCell>
      <TableCell className="max-w-xs">
        <span className="line-clamp-2 text-sm">{truncate(orphan.body)}</span>
      </TableCell>
      <TableCell>
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
      </TableCell>
    </TableRow>
  );
}
