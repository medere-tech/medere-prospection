"use client";

/**
 * Petit avis sous un Select de filtre quand l'identifiant courant est
 * absent de la liste source (ex. `?assignedTo=UXXXX` d'un commercial
 * supprimé). Affiche un bouton "Retirer le filtre" qui réinitialise le
 * paramètre URL — jamais l'identifiant brut.
 *
 * Rôle `status` + `aria-live="polite"` pour que les lecteurs d'écran
 * annoncent la situation sans voler le focus.
 */
import { Button } from "@/components/ui/button";

export interface FilterUnknownNoticeProps {
  /** Libellé explicite rendu dans le bouton (ex. "Retirer le filtre commercial"). */
  readonly label: string;
  /** Reset du filtre. Pas d'`event` — l'UI parent gère son nuqs state. */
  readonly onClear: () => void;
}

export function FilterUnknownNotice({ label, onClear }: FilterUnknownNoticeProps) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">Identifiant non reconnu.</span>
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto p-0 text-xs"
        onClick={onClear}
      >
        {label}
      </Button>
    </div>
  );
}
