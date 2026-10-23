"use client";

/**
 * Barre d'onglets `/admin/conversations` (PR2b-1).
 *
 * - Onglets selon le rôle : admin = 4 (`a_traiter`, `en_cours`,
 *   `cloturees`, `toutes`) ; commercial = 3 (pas `en_cours`).
 *   Source unique : `src/lib/firestore/conversation-list-tabs.ts`
 *   (`ADMIN_TABS` / `COMMERCIAL_TABS`).
 * - Compteurs : prop `counts` (0 si en cours de chargement, Badge affiché).
 * - État URL : `?tab=...` (nuqs).
 * - Onglet par défaut (si URL vide) : `a_traiter`.
 */
import { useQueryState } from "nuqs";
import { useCallback } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import type { CountsFetchState, Tab } from "./types";

export type { Tab };

/** Libellés FR des onglets — courts, affichés tels quels. */
export const TAB_LABELS: Record<Tab, string> = {
  a_traiter: "À traiter",
  en_cours: "En cours avec Léa",
  cloturees: "Clôturées",
  toutes: "Toutes",
};

export const ADMIN_TAB_ORDER: readonly Tab[] = ["a_traiter", "en_cours", "cloturees", "toutes"];

export const COMMERCIAL_TAB_ORDER: readonly Tab[] = ["a_traiter", "cloturees", "toutes"];

export const DEFAULT_TAB: Tab = "a_traiter";

export function tabsForRole(role: "admin" | "commercial"): readonly Tab[] {
  return role === "admin" ? ADMIN_TAB_ORDER : COMMERCIAL_TAB_ORDER;
}

export interface TabsBarProps {
  role: "admin" | "commercial";
  countsState: CountsFetchState;
  onTabChange?: () => void;
}

export function TabsBar({ role, countsState, onTabChange }: TabsBarProps) {
  const [tab, setTab] = useQueryState("tab");
  const activeTab: Tab = (tab as Tab | null) ?? DEFAULT_TAB;
  const tabs = tabsForRole(role);

  const handleClick = useCallback(
    (next: Tab) => {
      void setTab(next === DEFAULT_TAB ? null : next);
      onTabChange?.();
    },
    [setTab, onTabChange],
  );

  return (
    <div
      role="tablist"
      aria-label="Filtrer les conversations par onglet"
      className="flex flex-wrap gap-1 border-b border-border"
    >
      {tabs.map((t) => {
        const isActive = activeTab === t;
        const count =
          countsState.kind === "success"
            ? (countsState.data[t as keyof typeof countsState.data] ?? 0)
            : null;
        return (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls="conversations-panel"
            onClick={() => handleClick(t)}
            className={cn(
              "inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              isActive
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <span>{TAB_LABELS[t]}</span>
            {count !== null && (
              <Badge variant="outline" className="tabular-nums">
                {count}
              </Badge>
            )}
          </button>
        );
      })}
    </div>
  );
}
