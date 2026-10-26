"use client";

/**
 * Dropdown « Commercial » pour `/admin/conversations` (PR2b-1).
 *
 * - Admin uniquement : le parent (`ConversationsPageClient`) n'affiche
 *   le composant que pour `role === "admin"`.
 * - Source : prop `commerciaux` (preload Airtable server-side via
 *   `listCommerciauxForFilter`). Si Airtable est down côté serveur,
 *   la prop vaut `null` → placeholder « Indisponible » (filtre
 *   effectivement désactivé mais le reste de la page reste utilisable).
 * - État URL : `?assignedTo=U...` (sentinelle `__all__` interne).
 */
import { useQueryState } from "nuqs";

import { FilterUnknownNotice } from "@/components/filters/filter-unknown-notice";
import { resolveFilterLabel } from "@/components/filters/filter-value-label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import type { CommercialForClient } from "./types";

export interface CommercialSelectProps {
  commerciaux: readonly CommercialForClient[] | null;
  onChange?: (slackUserId: string | null) => void;
}

/**
 * Handler pur extrait pour testabilité — miroir de `handleCampaignChange`
 * de `/admin/contacts`.
 */
export function handleCommercialChange(
  value: string | null,
  setAssignedTo: (v: string | null) => void,
  onChange?: (slackUserId: string | null) => void,
): void {
  if (value === null || value === "__all__" || value === "") {
    void setAssignedTo(null);
    onChange?.(null);
    return;
  }
  void setAssignedTo(value);
  onChange?.(value);
}

export function CommercialSelect({ commerciaux, onChange }: CommercialSelectProps) {
  const [assignedTo, setAssignedTo] = useQueryState("assignedTo");
  const handleChange = (value: string | null) =>
    handleCommercialChange(value, setAssignedTo, onChange);

  const disabled = commerciaux === null;

  // PR2b-2 P1 — Base UI `SelectValue` sans render prop `children` affiche
  // la value brute (ici `slackUserId`). On passe un render prop qui mappe
  // via le helper partagé → le trigger affiche TOUJOURS un libellé humain.
  const label = resolveFilterLabel({
    value: assignedTo,
    items: commerciaux,
    keyOf: (c) => c.slackUserId,
    nameOf: (c) => c.name || "Commercial sans nom",
    allLabel: disabled ? "Indisponible (Airtable)" : "Tous les commerciaux",
    unknownLabel: "Commercial inconnu",
  });

  return (
    <div className="flex min-w-[220px] flex-col gap-1.5">
      <label htmlFor="commercial-select" className="text-xs font-medium text-muted-foreground">
        Commercial
      </label>
      <Select value={assignedTo ?? "__all__"} onValueChange={handleChange} disabled={disabled}>
        <SelectTrigger id="commercial-select" aria-label="Filtrer par commercial">
          <SelectValue>{() => label.display}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">Tous les commerciaux</SelectItem>
          {commerciaux === null ? null : commerciaux.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">Aucun commercial actif</div>
          ) : (
            commerciaux.map((c) => (
              <SelectItem key={c.slackUserId} value={c.slackUserId}>
                <span className="flex items-center gap-2">
                  <span>{c.name || "Commercial sans nom"}</span>
                  {!c.active && <span className="text-xs text-muted-foreground">(inactif)</span>}
                </span>
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
      {!label.known && !disabled && (
        <FilterUnknownNotice
          label="Retirer le filtre commercial"
          onClear={() => handleChange(null)}
        />
      )}
    </div>
  );
}
