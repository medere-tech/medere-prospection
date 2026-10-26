"use client";

/**
 * Orchestrateur client `/admin/conversations` (PR2b-1).
 *
 * - URL state (nuqs) : `tab`, `assignedTo`, `campaignId`, `cursor`.
 * - Fetchs manuels + AbortController (même pattern que /admin/contacts) :
 *   `/api/admin/conversations?...` et `/api/admin/conversations/counts?...`.
 * - Table TanStack Table v8 server-pagination (`manualPagination: true`).
 * - Chaque ligne est un VRAI lien natif Next (`<Link>` + `absolute inset-0`)
 *   → Ctrl/Cmd+clic ouvre un nouvel onglet, Entrée navigue, aucun handler
 *   JavaScript seul.
 * - Mobile < md : rendu en cartes (`ConversationRowCard`). Même source
 *   d'information, pas de défilement horizontal.
 * - Rechargement : au retour sur l'onglet (`visibilitychange` → `document.hidden`
 *   false) + bouton Actualiser. Pas de polling (PR2b-2).
 */
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import Link from "next/link";
import { useQueryState } from "nuqs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { HubspotListInfo } from "@/lib/hubspot/lists";

import { CampaignSelect } from "../contacts/campaign-select";
import {
  CONVERSATION_COLUMN_COUNT,
  conversationColumns,
  type ConversationsTableMeta,
} from "./columns";
import { CommercialSelect } from "./commercial-select";
import { ConversationRowCard } from "./conversation-row-card";
import { DEFAULT_TAB, TAB_LABELS, TabsBar } from "./tabs-bar";
import type { Tab } from "./types";
import type {
  CommercialForClient,
  ConversationListItem,
  ConversationsCountsApiResponse,
  ConversationsListApiResponse,
  CountsFetchState,
  ListFetchState,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Fetch helpers (manuel — pattern identique à /admin/contacts)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchList(
  params: {
    tab: Tab;
    assignedTo: string | null;
    campaignId: string | null;
    cursor: string | null;
  },
  signal: AbortSignal,
): Promise<ListFetchState> {
  const search = new URLSearchParams();
  search.set("tab", params.tab);
  if (params.assignedTo) search.set("assignedTo", params.assignedTo);
  if (params.campaignId) search.set("campaignId", params.campaignId);
  if (params.cursor) search.set("cursor", params.cursor);

  try {
    const res = await fetch(`/api/admin/conversations?${search.toString()}`, {
      signal,
      cache: "no-store",
    });
    if (!res.ok) {
      return {
        kind: "error",
        message: `Chargement impossible (${res.status}).`,
        status: res.status,
      };
    }
    const data = (await res.json()) as ConversationsListApiResponse;
    return { kind: "success", data };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { kind: "idle" };
    }
    return { kind: "error", message: "Erreur réseau. Réessayez.", status: 0 };
  }
}

async function fetchCounts(
  params: { assignedTo: string | null; campaignId: string | null },
  signal: AbortSignal,
): Promise<CountsFetchState> {
  const search = new URLSearchParams();
  if (params.assignedTo) search.set("assignedTo", params.assignedTo);
  if (params.campaignId) search.set("campaignId", params.campaignId);
  try {
    const res = await fetch(`/api/admin/conversations/counts?${search.toString()}`, {
      signal,
      cache: "no-store",
    });
    if (!res.ok) return { kind: "error" };
    const data = (await res.json()) as ConversationsCountsApiResponse;
    return { kind: "success", data: data.counts };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { kind: "idle" };
    }
    return { kind: "error" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Empty / error copy par onglet (phrases utiles — brief point 7)
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_COPY_BY_TAB: Record<Tab, { title: string; hint: string }> = {
  a_traiter: {
    title: "Aucune conversation à traiter.",
    hint: "Les nouvelles prises en charge apparaîtront ici.",
  },
  en_cours: {
    title: "Aucune conversation en cours avec Léa.",
    hint: "Léa gère les échanges actifs jusqu'au premier intérêt du médecin.",
  },
  cloturees: {
    title: "Aucune conversation clôturée.",
    hint: "Les conversations opt-out, bloquées ou closes apparaîtront ici.",
  },
  toutes: {
    title: "Aucune conversation.",
    hint: "Dès qu'un médecin recevra un premier SMS, sa conversation apparaîtra ici.",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// ConversationsPageClient
// ─────────────────────────────────────────────────────────────────────────────

export interface ConversationsPageClientProps {
  role: "admin" | "commercial";
  /** `null` pour un admin sans slackUserId, cas documenté PR0. */
  viewerSlackUserId: string | null;
  initialCampaigns: readonly HubspotListInfo[];
  /** `null` si Airtable down côté serveur (fallback dégradé non bloquant). */
  initialCommerciaux: readonly CommercialForClient[] | null;
}

export function ConversationsPageClient({
  role,
  viewerSlackUserId,
  initialCampaigns,
  initialCommerciaux,
}: ConversationsPageClientProps) {
  const [tab] = useQueryState("tab");
  const [assignedTo] = useQueryState("assignedTo");
  const [campaignId] = useQueryState("campaignId");
  const [cursor, setCursor] = useQueryState("cursor");

  const activeTab: Tab = (tab as Tab | null) ?? DEFAULT_TAB;

  const [listState, setListState] = useState<ListFetchState>({ kind: "idle" });
  const [countsState, setCountsState] = useState<CountsFetchState>({ kind: "idle" });
  const [refreshKey, setRefreshKey] = useState(0);

  const resetCursor = useCallback(() => {
    void setCursor(null);
  }, [setCursor]);

  // Fetch liste
  useEffect(() => {
    const ac = new AbortController();
    setListState({ kind: "loading" });
    void fetchList({ tab: activeTab, assignedTo, campaignId, cursor }, ac.signal).then((next) => {
      if (!ac.signal.aborted) setListState(next);
    });
    return () => ac.abort();
  }, [activeTab, assignedTo, campaignId, cursor, refreshKey]);

  // Fetch compteurs
  useEffect(() => {
    const ac = new AbortController();
    setCountsState({ kind: "loading" });
    void fetchCounts({ assignedTo, campaignId }, ac.signal).then((next) => {
      if (!ac.signal.aborted) setCountsState(next);
    });
    return () => ac.abort();
  }, [assignedTo, campaignId, refreshKey]);

  // Rechargement au retour sur l'onglet (visibilitychange).
  // Pas de polling — PR2b-2.
  const lastHiddenAtRef = useRef<number | null>(null);
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        lastHiddenAtRef.current = Date.now();
      } else if (lastHiddenAtRef.current !== null) {
        lastHiddenAtRef.current = null;
        setRefreshKey((k) => k + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Maps de résolution — passées à TanStack via meta
  const campaignNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of initialCampaigns) m.set(`hubspot-list-${c.listId}`, c.name);
    return m;
  }, [initialCampaigns]);

  const commercialNameBySlackId = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of initialCommerciaux ?? []) m.set(c.slackUserId, c.name);
    return m;
  }, [initialCommerciaux]);

  const items: ConversationListItem[] = listState.kind === "success" ? listState.data.items : [];
  const hasMore = listState.kind === "success" ? listState.data.hasMore : false;
  const nextCursor = listState.kind === "success" ? listState.data.nextCursor : null;

  const tableMeta: ConversationsTableMeta = {
    campaignNameById,
    commercialNameBySlackId,
    viewerSlackUserId,
    role,
  };

  const table = useReactTable<ConversationListItem>({
    data: items,
    columns: conversationColumns as ColumnDef<ConversationListItem>[],
    manualPagination: true,
    pageCount: -1,
    getCoreRowModel: getCoreRowModel(),
    // TanStack 8 `meta` est typé `TableMeta<T>` qui est une interface
    // augmentable mais vide par défaut → cast nécessaire. On re-cast dans
    // les cells via `ConversationsTableMeta`.
    meta: tableMeta as unknown as Record<string, unknown>,
  });

  const emptyCopy = EMPTY_COPY_BY_TAB[activeTab] ?? EMPTY_COPY_BY_TAB.toutes;

  return (
    <TooltipProvider delay={150}>
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight">Conversations</h1>
          <p className="text-sm text-muted-foreground">
            Suivez les échanges SMS avec les médecins. Sélectionnez un onglet pour filtrer.
          </p>
        </header>

        <TabsBar role={role} countsState={countsState} onTabChange={resetCursor} />

        <div className="flex flex-wrap items-end gap-3">
          {role === "admin" && (
            <CommercialSelect commerciaux={initialCommerciaux} onChange={resetCursor} />
          )}
          <CampaignSelect campaigns={initialCampaigns} onChange={resetCursor} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setRefreshKey((k) => k + 1)}
            aria-label="Actualiser la liste"
          >
            Actualiser
          </Button>
        </div>

        {/* État vide et erreur rendus UNE SEULE FOIS, hors des deux
            variantes CSS (desktop table / mobile cartes). Évite la
            duplication qui faisait tomber Playwright en strict mode
            (empty state présent dans les 2 conteneurs CSS-switchés
            simultanément dans le DOM). */}
        <div
          id="conversations-panel"
          role="tabpanel"
          aria-labelledby={`tab-${activeTab}`}
          className="contents"
        >
          {listState.kind === "error" && (
            <div
              role="alert"
              className="flex flex-col items-center gap-2 rounded-md border p-6 text-sm"
            >
              <span className="font-medium text-destructive">
                Impossible de charger les conversations ({listState.status})
              </span>
              <span className="text-muted-foreground">{listState.message}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setRefreshKey((k) => k + 1)}
              >
                Réessayer
              </Button>
            </div>
          )}
          {listState.kind === "success" && items.length === 0 && (
            <div
              role="status"
              aria-live="polite"
              className="flex flex-col items-center gap-1 rounded-md border p-6 text-center text-sm"
            >
              <span className="font-medium text-foreground">{emptyCopy.title}</span>
              <span className="text-muted-foreground">{emptyCopy.hint}</span>
            </div>
          )}

          {/* Desktop ≥ md — table. Rendue UNIQUEMENT quand on a des lignes
              ou pendant le loading (skeleton table). */}
          {(listState.kind === "loading" || (listState.kind === "success" && items.length > 0)) && (
            <div className="hidden md:block">
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    {table.getHeaderGroups().map((hg) => (
                      <TableRow key={hg.id}>
                        {hg.headers.map((h) => (
                          <TableHead key={h.id}>
                            {h.isPlaceholder
                              ? null
                              : flexRender(h.column.columnDef.header, h.getContext())}
                          </TableHead>
                        ))}
                      </TableRow>
                    ))}
                  </TableHeader>
                  <TableBody aria-live="polite" aria-busy={listState.kind === "loading"}>
                    {listState.kind === "loading" &&
                      Array.from({ length: 5 }).map((_, idx) => (
                        <TableRow key={`skel-${idx}`}>
                          <TableCell colSpan={CONVERSATION_COLUMN_COUNT}>
                            <Skeleton className="h-8 w-full" />
                          </TableCell>
                        </TableRow>
                      ))}
                    {listState.kind === "success" &&
                      items.length > 0 &&
                      table.getRowModel().rows.map((row) => (
                        <TableRow key={row.id} className="relative">
                          {row.getVisibleCells().map((cell, idx) => (
                            <TableCell key={cell.id} className={idx === 0 ? "relative" : undefined}>
                              {idx === 0 && (
                                <Link
                                  href={`/admin/conversations/${encodeURIComponent(row.original.conversationId)}`}
                                  className="absolute inset-0 z-10 focus-visible:ring-2 focus-visible:ring-ring"
                                  aria-label={`Ouvrir la conversation de ${row.original.contactDisplayName ?? "ce médecin"}`}
                                >
                                  <span className="sr-only">
                                    Ouvrir la conversation de{" "}
                                    {row.original.contactDisplayName ?? "ce médecin"}
                                  </span>
                                </Link>
                              )}
                              <span className="relative z-0">
                                {flexRender(cell.column.columnDef.cell, cell.getContext())}
                              </span>
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {/* Mobile < md — cartes. Même règle que la table. */}
          {(listState.kind === "loading" || (listState.kind === "success" && items.length > 0)) && (
            <div className="flex flex-col gap-3 md:hidden" aria-live="polite">
              {listState.kind === "loading" &&
                Array.from({ length: 3 }).map((_, idx) => (
                  <Skeleton key={`skel-m-${idx}`} className="h-24 w-full rounded-lg" />
                ))}
              {listState.kind === "success" &&
                items.length > 0 &&
                items.map((it) => (
                  <ConversationRowCard
                    key={it.conversationId}
                    item={it}
                    campaignName={
                      it.campaignName ?? campaignNameById.get(it.campaignId) ?? it.campaignId
                    }
                    commercialName={
                      it.assignedTo ? (commercialNameBySlackId.get(it.assignedTo) ?? null) : null
                    }
                    isViewerOwner={it.assignedTo !== null && it.assignedTo === viewerSlackUserId}
                  />
                ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground tabular-nums">
            {listState.kind === "success"
              ? `${items.length} conversation${items.length > 1 ? "s" : ""} — onglet ${TAB_LABELS[activeTab] ?? ""}`
              : ""}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!cursor || listState.kind === "loading"}
              onClick={() => void setCursor(null)}
            >
              Première page
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!hasMore || nextCursor === null || listState.kind === "loading"}
              onClick={() => nextCursor && void setCursor(nextCursor)}
            >
              Page suivante
            </Button>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
