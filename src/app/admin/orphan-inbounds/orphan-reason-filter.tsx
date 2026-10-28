"use client";

/**
 * Filtre « Motif » — Select Base UI, 4 valeurs + « Tous les motifs ».
 *
 *   - Valeurs : `no_conversation` | `unknown_contact` | `parse_failed` |
 *     `enqueue_failed` + sentinelle `__all__`.
 *   - Libellés via `resolveFilterLabel` + `FilterUnknownNotice` (helpers
 *     partagés avec `/admin/conversations`).
 *   - URL state via nuqs (`?reason=...`).
 */
import { useQueryState } from "nuqs";
import { useCallback } from "react";

import { FilterUnknownNotice } from "@/components/filters/filter-unknown-notice";
import { resolveFilterLabel } from "@/components/filters/filter-value-label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { ORPHAN_REASON_VALUES, type OrphanReason } from "./orphan-filter-constants";
import { ORPHAN_REASON_LABELS } from "./orphan-labels";

const ALL_REASONS: readonly OrphanReason[] = ORPHAN_REASON_VALUES;

const ALL_SENTINEL = "__all__";

export interface OrphanReasonFilterProps {
  readonly onChange?: () => void;
}

export function OrphanReasonFilter({ onChange }: OrphanReasonFilterProps) {
  const [reason, setReason] = useQueryState("reason");

  const items = ALL_REASONS.map((r) => ({ value: r, label: ORPHAN_REASON_LABELS[r] }));
  const resolved = resolveFilterLabel({
    value: reason,
    items,
    keyOf: (it) => it.value,
    nameOf: (it) => it.label,
    allLabel: "Tous les motifs",
    unknownLabel: "Motif non reconnu",
    allSentinel: ALL_SENTINEL,
  });

  const handleValueChange = useCallback(
    (next: string | null) => {
      void setReason(next === null || next === ALL_SENTINEL ? null : next);
      onChange?.();
    },
    [setReason, onChange],
  );

  const handleClear = useCallback(() => {
    void setReason(null);
    onChange?.();
  }, [setReason, onChange]);

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted-foreground" htmlFor="orphan-reason-filter">
        Motif
      </label>
      <Select value={reason ?? ALL_SENTINEL} onValueChange={handleValueChange}>
        <SelectTrigger id="orphan-reason-filter" className="w-56">
          <SelectValue aria-label="Motif sélectionné">{resolved.display}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_SENTINEL}>Tous les motifs</SelectItem>
          {ALL_REASONS.map((r) => (
            <SelectItem key={r} value={r}>
              {ORPHAN_REASON_LABELS[r]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!resolved.known && (
        <FilterUnknownNotice label="Retirer le filtre motif" onClear={handleClear} />
      )}
    </div>
  );
}
