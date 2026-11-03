"use client";

/**
 * Barre d'onglets `/admin/orphan-inbounds` (PR2c tour 2b bloc B).
 *
 *   - 4 onglets : `pending` (défaut) | `attached` | `dismissed` | `all`.
 *   - Compteurs = valeurs renvoyées par `/api/admin/orphan-inbounds/counts`
 *     — le compteur `all` est l'agrégat strict côté serveur.
 *   - URL state via nuqs (`?tab=...`).
 *   - Libellés via la source unique `orphan-labels.ts`.
 */
import { useQueryState } from "nuqs";
import { useCallback } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { DEFAULT_ORPHAN_TAB, ORPHAN_TAB_ORDER, type OrphanTab } from "./orphan-filter-constants";
import { ORPHAN_TAB_LABELS } from "./orphan-labels";

// Ré-exports historiques — permet aux imports existants
// (`page-client`, `tests`) de continuer à importer depuis
// `./orphan-tabs-bar` sans refactor. La source unique vit dans
// `./orphan-filter-constants`.
export { DEFAULT_ORPHAN_TAB, ORPHAN_TAB_ORDER, type OrphanTab };

export interface OrphanTabsBarProps {
  /** Compteurs serveur. `null` → compteur masqué (loading). */
  readonly counts: Record<OrphanTab, number> | null;
  /** Callback appelé au clic d'un onglet — utilisé pour reset le cursor. */
  readonly onTabChange?: () => void;
}

export function OrphanTabsBar({ counts, onTabChange }: OrphanTabsBarProps) {
  const [tab, setTab] = useQueryState("tab");
  const activeTab: OrphanTab = isOrphanTab(tab) ? tab : DEFAULT_ORPHAN_TAB;

  const handleClick = useCallback(
    (next: OrphanTab) => {
      void setTab(next === DEFAULT_ORPHAN_TAB ? null : next);
      onTabChange?.();
    },
    [setTab, onTabChange],
  );

  return (
    <div
      role="tablist"
      aria-label="Filtrer les SMS orphelins par état"
      className="flex flex-wrap gap-1 border-b border-border"
    >
      {ORPHAN_TAB_ORDER.map((t) => {
        const isActive = activeTab === t;
        const n = counts?.[t] ?? null;
        return (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls="orphan-inbounds-panel"
            onClick={() => handleClick(t)}
            className={cn(
              "inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              isActive
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <span>{ORPHAN_TAB_LABELS[t]}</span>
            {n !== null && (
              <Badge variant="outline" className="tabular-nums">
                {n}
              </Badge>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function isOrphanTab(v: unknown): v is OrphanTab {
  return v === "pending" || v === "attached" || v === "dismissed" || v === "all";
}
