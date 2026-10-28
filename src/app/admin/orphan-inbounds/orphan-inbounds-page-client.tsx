"use client";

/**
 * Orchestrateur client `/admin/orphan-inbounds` (PR2c tour 2b bloc B).
 *
 *   - URL state (nuqs) : `tab`, `reason`, `cursor`, `id` (tiroir détail).
 *   - Data : TanStack Query via `useOrphans*`. Invalidation croisée après
 *     chaque mutation — pas de polling (volume faible, cf. commentaire
 *     `use-orphans.ts`).
 *   - Mobile < md : rendu en cartes. Desktop ≥ md : table.
 *   - Tiroir détail ouvert via `?id=<docId>` (lien Slack ou clic ligne).
 */
import { useQueryState } from "nuqs";
import { useCallback } from "react";

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

import { OrphanDetailSheet } from "./orphan-detail-sheet";
import { OrphanReasonFilter } from "./orphan-reason-filter";
import { OrphanRow } from "./orphan-row";
import { OrphanRowCard } from "./orphan-row-card";
import { DEFAULT_ORPHAN_TAB, isOrphanTab, type OrphanTab, OrphanTabsBar } from "./orphan-tabs-bar";
import { useOrphanCounts, useOrphansList } from "./use-orphans";

const ORPHAN_COLUMN_COUNT = 5;

const EMPTY_COPY_BY_TAB: Record<OrphanTab, { title: string; hint: string }> = {
  pending: {
    title: "Aucun SMS orphelin à traiter.",
    hint: "Dès qu'un SMS entrant ne pourra pas être rattaché automatiquement, il apparaîtra ici.",
  },
  attached: {
    title: "Aucun SMS orphelin rattaché.",
    hint: "Les SMS que vous rattachez à une conversation apparaîtront ici pour mémoire.",
  },
  dismissed: {
    title: "Aucun SMS classé sans suite.",
    hint: "Les SMS que vous classez sans suite restent consultables ici.",
  },
  all: {
    title: "Aucun SMS orphelin.",
    hint: "Rien à décider pour l'instant.",
  },
};

export function OrphanInboundsPageClient() {
  const [tabRaw] = useQueryState("tab");
  const [reasonRaw] = useQueryState("reason");
  const [cursor, setCursor] = useQueryState("cursor");
  const [idRaw, setId] = useQueryState("id");

  const activeTab: OrphanTab = isOrphanTab(tabRaw) ? tabRaw : DEFAULT_ORPHAN_TAB;
  const reason =
    reasonRaw === "no_conversation" ||
    reasonRaw === "unknown_contact" ||
    reasonRaw === "parse_failed" ||
    reasonRaw === "enqueue_failed"
      ? reasonRaw
      : null;

  // `?id=<docId>` ouvre le tiroir — qu'il soit valide, invalide ou
  // 404. Le tiroir affiche un message explicite « Ce SMS orphelin est
  // introuvable. Le lien est peut-être ancien. » dans les 3 cas (via
  // `OrphanDetailNotFoundError`). Garantit qu'un lien Slack ancien ne
  // laisse pas l'utilisateur sans retour visible.
  const selectedDocId = typeof idRaw === "string" && idRaw.length > 0 ? idRaw : null;

  const resetCursor = useCallback(() => {
    void setCursor(null);
  }, [setCursor]);

  const list = useOrphansList({ tab: activeTab, reason, cursor });
  const counts = useOrphanCounts();

  const orphans = list.data?.orphans ?? [];
  const hasMore = list.data?.hasMore ?? false;
  const nextCursor = list.data?.nextCursor ?? null;
  const emptyCopy = EMPTY_COPY_BY_TAB[activeTab] ?? EMPTY_COPY_BY_TAB.pending;

  const handleOpenOrphan = useCallback(
    (docId: string) => {
      void setId(docId);
    },
    [setId],
  );
  const handleCloseSheet = useCallback(() => {
    void setId(null);
  }, [setId]);

  // Change d'onglet : reset du cursor pour repartir en page 1.
  const handleTabChange = useCallback(() => {
    resetCursor();
    // On ne ferme pas le tiroir — si l'utilisateur a ouvert un doc puis
    // change d'onglet, le tiroir reste utile tant que le doc existe.
  }, [resetCursor]);

  const countsValue =
    counts.data !== undefined
      ? {
          pending: counts.data.counts.pending,
          attached: counts.data.counts.attached,
          dismissed: counts.data.counts.dismissed,
          all: counts.data.counts.all,
        }
      : null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">SMS orphelins</h1>
        <p className="text-sm text-muted-foreground">
          Les SMS entrants qu&apos;aucune conversation n&apos;a pu accueillir. Rattachez-les ou
          classez-les.
        </p>
      </header>

      <OrphanTabsBar counts={countsValue} onTabChange={handleTabChange} />

      <div className="flex flex-wrap items-end gap-3">
        <OrphanReasonFilter onChange={resetCursor} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void list.refetch();
            void counts.refetch();
          }}
          aria-label="Actualiser la liste"
        >
          Actualiser
        </Button>
      </div>

      <div
        id="orphan-inbounds-panel"
        role="tabpanel"
        aria-labelledby={`tab-${activeTab}`}
        className="contents"
      >
        {list.isError && (
          <div
            role="alert"
            className="flex flex-col items-center gap-2 rounded-md border p-6 text-sm"
          >
            <span className="font-medium text-destructive">
              Impossible de charger les SMS orphelins
            </span>
            <span className="text-muted-foreground">
              {list.error?.message ?? "Erreur réseau. Réessayez."}
            </span>
            <Button type="button" variant="outline" size="sm" onClick={() => void list.refetch()}>
              Réessayer
            </Button>
          </div>
        )}

        {!list.isError && list.isSuccess && orphans.length === 0 && (
          <div
            role="status"
            aria-live="polite"
            className="flex flex-col items-center gap-1 rounded-md border p-6 text-center text-sm"
          >
            <span className="font-medium text-foreground">{emptyCopy.title}</span>
            <span className="text-muted-foreground">{emptyCopy.hint}</span>
          </div>
        )}

        {(list.isLoading || (list.isSuccess && orphans.length > 0)) && (
          <div className="hidden md:block">
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Reçu le</TableHead>
                    <TableHead>Motif</TableHead>
                    <TableHead>Médecin</TableHead>
                    <TableHead>Message</TableHead>
                    <TableHead>État</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody aria-live="polite" aria-busy={list.isLoading}>
                  {list.isLoading &&
                    Array.from({ length: 5 }).map((_, i) => (
                      <TableRow key={`skel-${i}`}>
                        <TableCell colSpan={ORPHAN_COLUMN_COUNT}>
                          <Skeleton className="h-8 w-full" />
                        </TableCell>
                      </TableRow>
                    ))}
                  {list.isSuccess &&
                    orphans.map((o) => (
                      <OrphanRow key={o.docId} orphan={o} onOpen={handleOpenOrphan} />
                    ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        {(list.isLoading || (list.isSuccess && orphans.length > 0)) && (
          <div className="flex flex-col gap-3 md:hidden" aria-live="polite">
            {list.isLoading &&
              Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={`skel-m-${i}`} className="h-28 w-full rounded-lg" />
              ))}
            {list.isSuccess &&
              orphans.map((o) => (
                <OrphanRowCard key={o.docId} orphan={o} onOpen={handleOpenOrphan} />
              ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground tabular-nums">
          {list.isSuccess
            ? `${orphans.length} SMS${orphans.length > 1 ? "s" : ""} affiché${
                orphans.length > 1 ? "s" : ""
              }`
            : ""}
        </span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!cursor || list.isLoading}
            onClick={() => void setCursor(null)}
          >
            Première page
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!hasMore || nextCursor === null || list.isLoading}
            onClick={() => nextCursor && void setCursor(nextCursor)}
          >
            Page suivante
          </Button>
        </div>
      </div>

      <OrphanDetailSheet docId={selectedDocId} onClose={handleCloseSheet} />
    </div>
  );
}
