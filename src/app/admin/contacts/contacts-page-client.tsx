"use client";

/**
 * Orchestrateur client `/admin/contacts` (S10.1.5 Phase 5).
 *
 * - Source URL state (nuqs) : `campaignId`, `status`, `cursor`.
 * - Fetch `/api/admin/contacts?...` via fetch + AbortController (B1 manuel).
 * - TanStack Table v8 server-side pagination (`manualPagination: true`).
 * - Pagination cursor : "Suivant" + "Première page" (pas de "Précédent"
 *   multi-page MVP — pattern stack futur S10.2).
 * - Reset cursor automatique quand filtres changent (sinon cursor stale
 *   pointe sur un doc d'une autre query).
 * - `refetchKey` bumpé après send success → trigger refetch des contacts
 *   (le contact envoyé peut changer de status side server).
 */
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { useQueryState } from "nuqs";
import { useCallback, useEffect, useState } from "react";

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
import type { Contact } from "@/types/contact";

import { CampaignSelect } from "./campaign-select";
import { contactColumns } from "./columns";
import { PreviewDialog } from "./preview-dialog";
import { StatusFilter } from "./status-filter";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ContactsApiResponse {
  contacts: Contact[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface ApiErrorBody {
  error: { code: string; message: string };
}

type FetchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; data: ContactsApiResponse }
  | { kind: "error"; message: string; status: number };

// ─────────────────────────────────────────────────────────────────────────────
// Helper fetch (manuel — pas de TanStack Query, cf. décision B1)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchContacts(
  params: { campaignId: string | null; status: string | null; cursor: string | null },
  signal: AbortSignal,
): Promise<FetchState> {
  const search = new URLSearchParams();
  if (params.campaignId) search.set("campaignId", params.campaignId);
  if (params.status) search.set("status", params.status);
  if (params.cursor) search.set("cursor", params.cursor);

  try {
    const res = await fetch(`/api/admin/contacts?${search.toString()}`, { signal });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
      const message = body?.error?.message ?? `Erreur ${res.status}`;
      return { kind: "error", message, status: res.status };
    }
    const data = (await res.json()) as ContactsApiResponse;
    return { kind: "success", data };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { kind: "idle" };
    }
    return { kind: "error", message: "Erreur réseau. Réessayez.", status: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ContactsPageClient
// ─────────────────────────────────────────────────────────────────────────────

export interface ContactsPageClientProps {
  /**
   * Liste initiale des campagnes HubSpot fetched côté server (page.tsx).
   * Le client peut re-query `/api/admin/campaigns` plus tard si besoin de
   * refresh (futur S10.2+).
   */
  initialCampaigns: readonly HubspotListInfo[];
}

export function ContactsPageClient({ initialCampaigns }: ContactsPageClientProps) {
  const [campaignId] = useQueryState("campaignId");
  const [status] = useQueryState("status");
  const [cursor, setCursor] = useQueryState("cursor");

  const [state, setState] = useState<FetchState>({ kind: "idle" });
  /**
   * S10.1.6 — on stocke le Contact COMPLET (pas juste l'ID) pour que la
   * modal puisse rendre son header riche (nom, ville, phone masqué) sans
   * fetch supplémentaire. Data déjà en cache via `/api/admin/contacts`.
   */
  const [previewContact, setPreviewContact] = useState<Contact | null>(null);
  /** Bumpé après send success → trigger refetch sans bouger filtres/cursor. */
  const [refetchKey, setRefetchKey] = useState(0);

  // Reset cursor quand l'admin change un filtre — sinon le cursor pointe
  // sur un doc d'une query précédente, l'API renvoie ValidationError.
  const resetCursor = useCallback(() => {
    void setCursor(null);
  }, [setCursor]);

  useEffect(() => {
    const ac = new AbortController();
    setState({ kind: "loading" });
    void fetchContacts({ campaignId, status, cursor }, ac.signal).then((next) => {
      if (!ac.signal.aborted) setState(next);
    });
    return () => ac.abort();
  }, [campaignId, status, cursor, refetchKey]);

  const data = state.kind === "success" ? state.data.contacts : [];
  const hasMore = state.kind === "success" ? state.data.hasMore : false;
  const nextCursor = state.kind === "success" ? state.data.nextCursor : null;

  const table = useReactTable<Contact>({
    data,
    columns: contactColumns as ColumnDef<Contact>[],
    manualPagination: true,
    pageCount: -1,
    getCoreRowModel: getCoreRowModel(),
    meta: {
      onPreview: setPreviewContact,
    },
  });

  const columnCount = contactColumns.length;

  return (
    // S10.1.7-M6 : TooltipProvider hoisté ici (vs S10.1.6 où chaque
    // ActionsCell instanciait son propre TooltipProvider — N×provider
    // dans le DOM pour N contacts). Un seul provider global pour toute
    // la page suffit (delay partagé, idempotent côté base-ui).
    <TooltipProvider delay={150}>
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight">Contacts</h1>
          <p className="text-sm text-muted-foreground">
            Liste des professionnels de santé prospects. Sélectionnez une campagne pour filtrer.
          </p>
        </header>

        <div className="flex flex-wrap items-end gap-3">
          <CampaignSelect campaigns={initialCampaigns} onChange={resetCursor} />
          <StatusFilter onChange={resetCursor} />
        </div>

        {/* S10.1.5-FIX-UX : `overflow-x-auto` évite que les 5 colonnes
          débordent sur iPad portrait (768px) — sinon casse le layout
          de la page entière. */}
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
            <TableBody aria-live="polite" aria-busy={state.kind === "loading"}>
              {state.kind === "loading" &&
                Array.from({ length: 5 }).map((_, idx) => (
                  <TableRow key={`skel-${idx}`}>
                    <TableCell colSpan={columnCount}>
                      <Skeleton className="h-8 w-full" />
                    </TableCell>
                  </TableRow>
                ))}

              {state.kind === "error" && (
                <TableRow>
                  <TableCell colSpan={columnCount}>
                    <div className="flex flex-col items-center gap-1 py-8 text-sm">
                      <span className="font-medium text-destructive">
                        Impossible de charger les contacts ({state.status})
                      </span>
                      <span className="text-muted-foreground">{state.message}</span>
                    </div>
                  </TableCell>
                </TableRow>
              )}

              {state.kind === "success" && data.length === 0 && (
                <TableRow>
                  <TableCell colSpan={columnCount}>
                    <div className="flex flex-col items-center gap-2 py-8 text-sm text-muted-foreground">
                      <span>Aucun contact trouvé pour ces filtres.</span>
                      <span className="text-xs">
                        Essayez une autre campagne ou un autre statut.
                      </span>
                    </div>
                  </TableCell>
                </TableRow>
              )}

              {state.kind === "success" &&
                data.length > 0 &&
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground tabular-nums">
            {state.kind === "success"
              ? `${data.length} contact${data.length > 1 ? "s" : ""} affiché${data.length > 1 ? "s" : ""}`
              : ""}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!cursor || state.kind === "loading"}
              onClick={() => void setCursor(null)}
            >
              Première page
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!hasMore || nextCursor === null || state.kind === "loading"}
              onClick={() => nextCursor && void setCursor(nextCursor)}
            >
              Page suivante
            </Button>
          </div>
        </div>

        <PreviewDialog
          contact={previewContact}
          onClose={() => setPreviewContact(null)}
          onSendSuccess={() => setRefetchKey((k) => k + 1)}
        />
      </div>
    </TooltipProvider>
  );
}
