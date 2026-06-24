"use client";

/**
 * Définitions de colonnes TanStack Table v8 pour `/admin/contacts` (S10.1.5).
 *
 * - Cellule `phone` : masquée par défaut + toggle œil (décision A2 —
 *   anti-shoulder-surfing, acte conscient admin).
 * - Cellule `status` : Badge shadcn avec variant par status.
 * - Cellule `actions` : DropdownMenu (Preview / Copier ID).
 *     - S10.1.6 B1 : tooltip explicatif sur l'item Preview désactivé,
 *       précisant les statuts compatibles. Le tooltip s'attache au
 *       wrapper du DropdownMenuItem (qui reste focusable même quand
 *       l'item interne est `data-disabled`).
 *
 * `onPreview` est injecté par le parent via `meta` TanStack (pattern
 * canonique pour passer des callbacks aux cell renderers sans recréer
 * les columns à chaque render).
 *
 * 🚨 S10.1.6 — signature `onPreview` passe de `(contactId: string) => void`
 * à `(contact: Contact) => void` car le PreviewDialog a maintenant besoin
 * du Contact complet pour afficher le header riche (nom, ville, phone
 * masqué). Pas de fetch supplémentaire côté modal — data déjà en cache.
 */
import type { ColumnDef } from "@tanstack/react-table";
import { Copy, Eye, EyeOff, MoreHorizontal, Send } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Contact, ContactStatus } from "@/types/contact";

// ─────────────────────────────────────────────────────────────────────────────
// Meta typée pour callbacks parent → cells
// ─────────────────────────────────────────────────────────────────────────────

declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface TableMeta<TData> {
    /**
     * S10.1.6 — reçoit le Contact complet (pas juste le hubspotId) pour
     * que la modal puisse rendre son header riche sans fetch supplémentaire.
     */
    onPreview?: (contact: Contact) => void;
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
 *
 * 🚨 S10.1.6 — exporté pour réutilisation par `preview-dialog.tsx`
 * (header riche du Dialog réutilise le même masquage que la cellule
 * table, cohérence visuelle).
 */
export function maskPhoneForUI(e164: string): string {
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

/**
 * Statuts pour lesquels la preview du 1er SMS est disponible. Source de
 * vérité côté serveur : `PREVIEW_ALLOWED_STATUSES` dans
 * `src/app/api/admin/preview-first-sms/route.ts` (D-b1). Dupliquer ici
 * pour le UI guard est ACCEPTABLE — le serveur reste autoritatif.
 *
 * Si un nouveau statut est ajouté côté serveur, mettre à jour ici aussi
 * (sentinelle test S10.1.4.b).
 */
const PREVIEW_ALLOWED_STATUSES: readonly ContactStatus[] = ["pending", "enriched", "ready"];

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
// ActionsCell — menu Preview / Copier ID (S10.1.6 — tooltip B1)
// ─────────────────────────────────────────────────────────────────────────────

function ActionsCell({
  contact,
  onPreview,
}: {
  contact: Contact;
  onPreview?: (contact: Contact) => void;
}) {
  // useId : génère un ID unique par instance pour `aria-describedby`.
  // Évite les collisions HTML quand plusieurs ActionsCell sont rendues
  // (1 par contact dans la table) — même si seul un DropdownMenuContent
  // est mounted à la fois (Portal), garantit la robustesse en cas de
  // refonte future (multi-select avec actions groupées, etc.).
  const previewHelpId = useId();
  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(contact.hubspotId);
      toast.success("ID copié dans le presse-papier");
    } catch {
      toast.error("Impossible de copier l'ID");
    }
  };

  const previewDisabled = !PREVIEW_ALLOWED_STATUSES.includes(contact.status);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            // S10.1.8 BLQ-2 : 36px minimum (cible iPad doigts larges).
            // WCAG 2.5.8 AA (24px) + iOS HIG (44px idéal) — compromis acceptable
            // dans une TableCell dense, cohérent avec le hamburger header (44px).
            className="size-9 p-0"
            aria-label="Actions sur le contact"
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {/*
          S10.1.7-M3-FIX : DropdownMenuLabel = MenuPrimitive.GroupLabel sous
          le capot — exige un MenuPrimitive.Group parent (`DropdownMenuGroup`).
          L'omission en S10.1.5 throw `MenuGroupContext is missing` en jsdom
          (et probablement en strict dev en prod, masqué par le portal).
        */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Actions</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {previewDisabled ? (
            // S10.1.7-M7 : item disabled + Tooltip via render={<DropdownMenuItem
            // disabled .../>} (pas de <span tabIndex={0}> intermédiaire qui
            // sortait du roving-tabindex du DropdownMenu base-ui). Le tooltip
            // se déclenche au pointer hover et au focus clavier si l'item
            // disabled reçoit le focus (comportement base-ui : ArrowDown
            // s'arrête sur les disabled items "focusables non-activables",
            // cf. ARIA APG Menu pattern + Base UI menu).
            //
            // `aria-describedby` ajouté pour les screen readers : annonce
            // l'explication compliance même si le tooltip visuel n'est pas
            // perçu (cf. WCAG 1.4.13 Content on Hover or Focus + 4.1.2 Name).
            <Tooltip>
              <TooltipTrigger
                render={
                  <DropdownMenuItem disabled aria-disabled="true" aria-describedby={previewHelpId}>
                    <Send className="size-3.5" aria-hidden />
                    Prévisualiser le 1er SMS
                  </DropdownMenuItem>
                }
              />
              <TooltipContent side="left">
                Disponible uniquement pour les statuts <strong>Importé</strong>,{" "}
                <strong>Enrichi</strong> ou <strong>Prêt</strong>.
              </TooltipContent>
            </Tooltip>
          ) : (
            <DropdownMenuItem onClick={() => onPreview?.(contact)}>
              <Send className="size-3.5" aria-hidden />
              Prévisualiser le 1er SMS
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={handleCopyId}>
            <Copy className="size-3.5" aria-hidden />
            Copier l&apos;ID HubSpot
          </DropdownMenuItem>
        </DropdownMenuGroup>
        {/*
          Span sr-only avec id unique : cible de `aria-describedby` sur le
          DropdownMenuItem disabled. Toujours rendu dans le DropdownMenuContent
          pour que la référence aria-describedby soit valide quand
          previewDisabled=true. Pas visible visuellement (sr-only). Hors
          DropdownMenuGroup pour ne pas perturber le composite widget pattern.
        */}
        <span id={previewHelpId} className="sr-only">
          Prévisualisation disponible uniquement pour les statuts Importé, Enrichi ou Prêt.
        </span>
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
// Exposés pour tests (S10.1.6 — `maskPhoneForUI` est désormais exporté
// directement ci-dessus pour réutilisation par `preview-dialog.tsx`).
// On garde l'alias `__FOR_TESTS` pour rétrocompat avec les tests existants.
// ─────────────────────────────────────────────────────────────────────────────

export { maskPhoneForUI as __maskPhoneForUI_FOR_TESTS };
export { STATUS_LABEL_FR as __STATUS_LABEL_FR_FOR_TESTS };
// S10.1.7-M3 — exposés pour tests unitaires composants internes (couverture
// ≥90%). Pattern projet : suffixe `__FOR_TESTS` pour signaler qu'on ne
// consomme pas ces exports en prod.
export { PhoneCell as __PhoneCell_FOR_TESTS };
export { ActionsCell as __ActionsCell_FOR_TESTS };
export { statusVariant as __statusVariant_FOR_TESTS };
