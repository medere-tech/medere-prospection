"use client";

/**
 * Définitions de colonnes TanStack Table v8 pour `/admin/contacts` (S10.1.5).
 *
 * - Cellule `phone` : masquée par défaut + toggle œil (décision A2 —
 *   anti-shoulder-surfing, acte conscient admin).
 * - Cellule `status` : Badge shadcn avec variant par status.
 * - Cellule `actions` : DropdownMenu (Preview / Copier ID).
 *
 * `onPreview` est injecté par le parent via `meta` TanStack (pattern
 * canonique pour passer des callbacks aux cell renderers sans recréer
 * les columns à chaque render).
 */
import type { ColumnDef } from "@tanstack/react-table";
import { Copy, Eye, EyeOff, MoreHorizontal, Send } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Contact, ContactStatus } from "@/types/contact";

// ─────────────────────────────────────────────────────────────────────────────
// Meta typée pour callbacks parent → cells
// ─────────────────────────────────────────────────────────────────────────────

declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface TableMeta<TData> {
    onPreview?: (contactId: string) => void;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers visuels
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Masque un téléphone E.164 pour affichage UI :
 *   `+33612345678` → `+33 6•• ••• •78`
 *
 * Différent de `maskPhone()` (lib/utils/phone) qui sert aux logs/audit
 * forensic — ici, c'est juste un masquage VISUEL réversible côté admin.
 */
function maskPhoneForUI(e164: string): string {
  if (e164.length < 5) return "••••";
  const head = e164.slice(0, 4); // +336 ou +337 etc.
  const tail = e164.slice(-2);
  return `${head} •• ••• •${tail}`;
}

/**
 * Variants Badge par status — sémantique visuelle :
 *   - `ready`           → default (primary)   : prêt à envoyer
 *   - `pending`         → secondary           : import OK, enrichissement à venir
 *   - `enriched`        → secondary           : enrichi, validation Twilio pending
 *   - `in_conversation` → outline             : conversation IA en cours
 *   - `qualified`       → default             : intent positif, à hand-off
 *   - `opted_out`       → destructive         : STOP reçu
 *   - `archived`        → outline             : inactif
 */
function statusVariant(status: ContactStatus): "default" | "secondary" | "outline" | "destructive" {
  switch (status) {
    case "ready":
    case "qualified":
      return "default";
    case "pending":
    case "enriched":
      return "secondary";
    case "opted_out":
      return "destructive";
    case "in_conversation":
    case "archived":
      return "outline";
  }
}

const STATUS_LABEL_FR: Record<ContactStatus, string> = {
  pending: "Importé",
  enriched: "Enrichi",
  ready: "Prêt",
  in_conversation: "Conversation",
  qualified: "Qualifié",
  opted_out: "STOP",
  archived: "Archivé",
};

// ─────────────────────────────────────────────────────────────────────────────
// PhoneCell — toggle masqué/clair par ligne
// ─────────────────────────────────────────────────────────────────────────────

function PhoneCell({ e164 }: { e164: string }) {
  const [revealed, setRevealed] = useState(false);
  const displayed = revealed ? e164 : maskPhoneForUI(e164);
  const Icon = revealed ? EyeOff : Eye;
  const label = revealed ? "Masquer le numéro" : "Afficher le numéro complet";

  return (
    <div className="flex items-center gap-1.5">
      <span
        className="font-mono text-sm tabular-nums"
        // S10.1.5-FIX-A11Y : aria-label lit le numéro complet quand révélé
        // (utile pour screen reader qui sinon entendrait juste le pattern
        // de bullets) ; texte explicite quand masqué.
        aria-label={revealed ? `Numéro complet : ${e164}` : "Numéro masqué"}
      >
        {displayed}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="size-7 p-0"
        onClick={() => setRevealed((v) => !v)}
        aria-label={label}
        title={label}
      >
        <Icon className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ActionsCell — menu Preview / Copier ID
// ─────────────────────────────────────────────────────────────────────────────

function ActionsCell({
  contact,
  onPreview,
}: {
  contact: Contact;
  onPreview?: (contactId: string) => void;
}) {
  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(contact.hubspotId);
      toast.success("ID copié dans le presse-papier");
    } catch {
      toast.error("Impossible de copier l'ID");
    }
  };

  const previewDisabled = !["pending", "enriched", "ready"].includes(contact.status);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="size-8 p-0"
            aria-label="Actions sur le contact"
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Actions</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onPreview?.(contact.hubspotId)} disabled={previewDisabled}>
          <Send className="size-3.5" aria-hidden />
          Prévisualiser le 1er SMS
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleCopyId}>
          <Copy className="size-3.5" aria-hidden />
          Copier l&apos;ID HubSpot
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Column definitions
// ─────────────────────────────────────────────────────────────────────────────

export const contactColumns: ColumnDef<Contact>[] = [
  {
    id: "name",
    header: "Contact",
    cell: ({ row }) => {
      const c = row.original;
      const civilite = c.civilite ? `${c.civilite} ` : "";
      return (
        <div className="flex flex-col">
          <span className="text-sm font-medium">
            {civilite}
            {c.firstName} {c.lastName}
          </span>
          <span className="text-xs text-muted-foreground">{c.speciality}</span>
        </div>
      );
    },
  },
  {
    id: "location",
    header: "Ville",
    cell: ({ row }) => {
      const c = row.original;
      return (
        <div className="flex flex-col">
          <span className="text-sm">{c.city}</span>
          <span className="text-xs text-muted-foreground tabular-nums">{c.postalCode}</span>
        </div>
      );
    },
  },
  {
    id: "phone",
    header: "Téléphone",
    cell: ({ row }) => <PhoneCell e164={row.original.phone.e164} />,
  },
  {
    id: "status",
    header: "Statut",
    cell: ({ row }) => {
      const s = row.original.status;
      return <Badge variant={statusVariant(s)}>{STATUS_LABEL_FR[s]}</Badge>;
    },
  },
  {
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    cell: ({ row, table }) => (
      <ActionsCell contact={row.original} onPreview={table.options.meta?.onPreview} />
    ),
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Exposés pour tests
// ─────────────────────────────────────────────────────────────────────────────

export { maskPhoneForUI as __maskPhoneForUI_FOR_TESTS };
export { STATUS_LABEL_FR as __STATUS_LABEL_FR_FOR_TESTS };
