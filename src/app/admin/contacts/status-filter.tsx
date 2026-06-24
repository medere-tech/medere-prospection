"use client";

/**
 * Dropdown filtre status pour `/admin/contacts` (S10.1.5 Phase 3).
 *
 * Options = `CONTACT_STATUS_VALUES` (source unique S10.1.2.c). État
 * persistant via nuqs `?status=ready`. Default route-level S10.1.4.a est
 * `"ready"` — l'UI reflète ce default avec un label "Statut courant".
 *
 * 🚨 Si CONTACT_STATUS_VALUES change (ajout/retrait/rename), le label FR
 * de la map locale doit être mis à jour. Test sentinelle à ajouter si on
 * voit la dérive.
 */
import { useQueryState } from "nuqs";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
// S10.1.5-FIX-SEC : import depuis @/types/contact (module pur, zéro
// dépendance Admin SDK) plutôt que @/lib/firestore/contacts qui tire
// `firebase-admin/firestore` dans le bundle browser.
import { CONTACT_STATUS_VALUES, type ContactStatus } from "@/types/contact";

/** Type guard runtime — évite le cast `as ContactStatus` aveugle dans handler. */
function isContactStatus(value: string): value is ContactStatus {
  return (CONTACT_STATUS_VALUES as readonly string[]).includes(value);
}

const STATUS_LABEL_FR: Record<ContactStatus, string> = {
  pending: "Importé",
  enriched: "Enrichi",
  ready: "Prêt à envoyer",
  in_conversation: "En conversation",
  qualified: "Qualifié",
  opted_out: "Opt-out STOP",
  archived: "Archivé",
};

export interface StatusFilterProps {
  /** Optionnel : appelé après changement (utile pour reset le cursor). */
  onChange?: (status: ContactStatus | null) => void;
}

/**
 * Handler pur (S10.1.7-M4 — extrait pour testabilité). Branche la Base UI
 * Select `onValueChange` → setStatus nuqs + callback parent. Type guard
 * runtime sécurise le narrowing vers ContactStatus (anti-cast aveugle).
 */
export function handleStatusChange(
  value: string | null,
  setStatus: (v: string | null) => void,
  onChange?: (status: ContactStatus | null) => void,
): void {
  if (value === null || value === "" || !isContactStatus(value)) {
    void setStatus(null);
    onChange?.(null);
    return;
  }
  void setStatus(value);
  onChange?.(value);
}

// Exposé pour tests — type guard pur, testable indépendamment.
export { isContactStatus as __isContactStatus_FOR_TESTS };

export function StatusFilter({ onChange }: StatusFilterProps) {
  const [status, setStatus] = useQueryState("status");

  const handleChange = (value: string | null) => handleStatusChange(value, setStatus, onChange);

  return (
    <div className="flex min-w-[180px] flex-col gap-1.5">
      <label htmlFor="status-filter" className="text-xs font-medium text-muted-foreground">
        Statut
      </label>
      {/*
        🚨 Pas d'option "Tous les statuts" — cohérent contrat API S10.1.4.a
        (D1) : la route applique TOUJOURS un default `"ready"` même si
        `?status=` est omis. Une option "Tous" UI créerait un mismatch
        confus (l'UI dit "Tous" mais filtrage serveur reste "ready"). Pour
        élargir, il faudrait modifier `listContacts` wrapper côté API.
      */}
      <Select value={status ?? "ready"} onValueChange={handleChange}>
        <SelectTrigger id="status-filter" aria-label="Filtrer par statut">
          <SelectValue placeholder="Prêt à envoyer" />
        </SelectTrigger>
        <SelectContent>
          {CONTACT_STATUS_VALUES.map((s) => (
            <SelectItem key={s} value={s}>
              {STATUS_LABEL_FR[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
