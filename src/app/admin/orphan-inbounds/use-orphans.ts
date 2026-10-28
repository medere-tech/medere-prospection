"use client";

/**
 * Hooks data pour `/admin/orphan-inbounds` (PR2c tour 2b bloc B).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pas de polling
 *
 *   Le volume cible est très faible (quelques dizaines/mois) et chaque
 *   action admin invalide les 3 clés (`list`, `counts`, `detail`) → la
 *   fraîcheur est toujours < 1 s après une action utilisateur. Mettre un
 *   `refetchInterval` coûterait des reads Firestore pour zéro bénéfice
 *   UX. Seule une action utilisateur rafraîchit : c'est strictement
 *   suffisant pour le bloc B.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Invalidation croisée
 *
 *   Toutes les mutations (attach / dismiss / reopen) invalident :
 *     - `orphans-list` : la table (compteur relatif).
 *     - `orphans-counts` : le badge sidebar + les compteurs d'onglets.
 *     - `orphans-detail` : si un tiroir est ouvert, il relit.
 *
 *   Les erreurs serveur sont remontées via `error.message` lu depuis le
 *   `clientMessage` quand il existe (contrat `AppError.toClientBody`),
 *   sinon un fallback FR.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { OrphanInboundClientView } from "@/lib/firestore/orphan-inbounds-sanitize";

import type { OrphanDismissReason, OrphanReason, OrphanState } from "./orphan-labels";
import { ORPHAN_TOASTS } from "./orphan-labels";

export interface OrphansListInput {
  readonly tab: OrphanState | "all";
  readonly reason: OrphanReason | null;
  readonly cursor: string | null;
}

export interface OrphansListResponse {
  readonly orphans: readonly OrphanInboundClientView[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface OrphanCountsResponse {
  readonly counts: Record<OrphanState | "all", number>;
}

export const ORPHANS_LIST_QK = ["admin", "orphan-inbounds", "list"] as const;
export const ORPHANS_COUNTS_QK = ["admin", "orphan-inbounds", "counts"] as const;
export const ORPHANS_DETAIL_QK = ["admin", "orphan-inbounds", "detail"] as const;

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    const msg = body.error?.message;
    if (typeof msg === "string" && msg.length > 0) return msg;
  } catch {
    // body non-JSON → fallback générique
  }
  return `Erreur ${res.status}. Réessayez plus tard.`;
}

/**
 * Erreur « orphan 404 » typée — permet au composant tiroir de distinguer
 * un lien ancien d'une vraie panne, et d'afficher le message FR dédié.
 * Un `isTestFixture` qui échappe à la vue du compte réel passe aussi par
 * ce chemin (fail-closed `getOrphanInbound` → 404).
 */
export class OrphanDetailNotFoundError extends Error {
  readonly isOrphanNotFound = true;
  constructor() {
    super("orphan-detail-not-found");
    this.name = "OrphanDetailNotFoundError";
  }
}

/** Liste paginée. `tab === "all"` ne passe pas de `processingState`. */
export function useOrphansList(input: OrphansListInput) {
  return useQuery<OrphansListResponse, Error>({
    queryKey: [...ORPHANS_LIST_QK, input.tab, input.reason, input.cursor],
    queryFn: async ({ signal }) => {
      const search = new URLSearchParams();
      if (input.tab !== "all") search.set("processingState", input.tab);
      if (input.reason) search.set("reason", input.reason);
      if (input.cursor) search.set("cursor", input.cursor);
      const res = await fetch(`/api/admin/orphan-inbounds?${search.toString()}`, {
        signal,
        cache: "no-store",
      });
      if (!res.ok) throw new Error(await parseErrorMessage(res));
      return (await res.json()) as OrphansListResponse;
    },
    staleTime: 15_000,
    retry: 1,
  });
}

/**
 * Compteurs par état + total. Pas d'input serveur (filtre par JWT).
 *
 *   @param enabled  Désactive le fetch si `false` (ex. commercial dans la
 *                   sidebar — l'item orphans n'est pas rendu pour lui, le
 *                   fetch ferait un 403 bruyant côté console).
 */
export function useOrphanCounts(enabled = true) {
  return useQuery<OrphanCountsResponse, Error>({
    queryKey: ORPHANS_COUNTS_QK,
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/admin/orphan-inbounds/counts", { signal, cache: "no-store" });
      if (!res.ok) throw new Error(await parseErrorMessage(res));
      return (await res.json()) as OrphanCountsResponse;
    },
    enabled,
    staleTime: 15_000,
    retry: 1,
  });
}

/** Détail single-doc. Désactivé si `docId === null` (tiroir fermé). */
export function useOrphanDetail(docId: string | null) {
  return useQuery<{ orphan: OrphanInboundClientView }, Error>({
    queryKey: [...ORPHANS_DETAIL_QK, docId],
    queryFn: async ({ signal }) => {
      if (!docId) throw new Error("docId manquant");
      const res = await fetch(`/api/admin/orphan-inbounds/${encodeURIComponent(docId)}`, {
        signal,
        cache: "no-store",
      });
      // 404 ET 400 → erreur typée pour que l'UI affiche le message FR
      // dédié (« lien ancien »). 400 couvre les `?id=` au format
      // invalide — même ressenti utilisateur qu'un 404. Retry désactivé
      // spécifiquement sur ces cas.
      if (res.status === 404 || res.status === 400) {
        throw new OrphanDetailNotFoundError();
      }
      if (!res.ok) throw new Error(await parseErrorMessage(res));
      return (await res.json()) as { orphan: OrphanInboundClientView };
    },
    enabled: docId !== null,
    staleTime: 0,
    retry: (failureCount, error) => {
      if (error instanceof OrphanDetailNotFoundError) return false;
      return failureCount < 1;
    },
  });
}

function invalidateAll(qc: ReturnType<typeof useQueryClient>): void {
  // Invalide par préfixe — toutes les variantes de pagination et de
  // filtre sont rafraîchies en une passe.
  void qc.invalidateQueries({ queryKey: ORPHANS_LIST_QK });
  void qc.invalidateQueries({ queryKey: ORPHANS_COUNTS_QK });
  void qc.invalidateQueries({ queryKey: ORPHANS_DETAIL_QK });
}

export interface AttachOrphanBody {
  readonly orphanDocId: string;
  readonly conversationId: string;
  readonly optOutConfirmed: boolean;
}

export function useAttachOrphan(opts?: {
  onSuccess?: (result: { wasOptOut: boolean }) => void;
  onError?: (error: Error) => void;
}) {
  const qc = useQueryClient();
  return useMutation<{ wasOptOut: boolean }, Error, AttachOrphanBody>({
    mutationFn: async (body) => {
      const res = await fetch(
        `/api/admin/orphan-inbounds/${encodeURIComponent(body.orphanDocId)}/attach`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: body.conversationId,
            optOutConfirmed: body.optOutConfirmed,
          }),
        },
      );
      if (!res.ok) throw new Error(await parseErrorMessage(res));
      return (await res.json()) as { wasOptOut: boolean };
    },
    onSuccess: (result) => {
      invalidateAll(qc);
      opts?.onSuccess?.(result);
    },
    onError: (err) => opts?.onError?.(err),
  });
}

export interface DismissOrphanBody {
  readonly orphanDocId: string;
  readonly dismissReason: OrphanDismissReason;
}

export function useDismissOrphan(opts?: {
  onSuccess?: () => void;
  onError?: (error: Error) => void;
}) {
  const qc = useQueryClient();
  return useMutation<void, Error, DismissOrphanBody>({
    mutationFn: async (body) => {
      const res = await fetch(
        `/api/admin/orphan-inbounds/${encodeURIComponent(body.orphanDocId)}/dismiss`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dismissReason: body.dismissReason }),
        },
      );
      if (!res.ok) throw new Error(await parseErrorMessage(res));
    },
    onSuccess: () => {
      invalidateAll(qc);
      opts?.onSuccess?.();
    },
    onError: (err) => opts?.onError?.(err),
  });
}

export function useReopenOrphan(opts?: {
  onSuccess?: () => void;
  onError?: (error: Error) => void;
}) {
  const qc = useQueryClient();
  return useMutation<void, Error, { orphanDocId: string }>({
    mutationFn: async (body) => {
      const res = await fetch(
        `/api/admin/orphan-inbounds/${encodeURIComponent(body.orphanDocId)}/reopen`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(await parseErrorMessage(res));
    },
    onSuccess: () => {
      invalidateAll(qc);
      opts?.onSuccess?.();
    },
    onError: (err) => opts?.onError?.(err),
  });
}

/** Barre toast message helpers — bind au module de libellés unique. */
export const TOAST_MESSAGES = ORPHAN_TOASTS;
