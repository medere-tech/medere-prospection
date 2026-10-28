/**
 * Constantes de filtre `/admin/orphan-inbounds` extraites comme module
 * pur (sans JSX, sans "use client"). Partagées entre la barre d'onglets
 * (`orphan-tabs-bar.tsx`), le filtre motif (`orphan-reason-filter.tsx`)
 * et le test de couverture d'index (`orphan-index-coverage.test.ts`).
 *
 * Objectif : un test qui dérive dynamiquement TOUTES les combinaisons
 * UI (onglets × motifs × isTestFixture) doit s'appuyer sur les MÊMES
 * constantes que la page. Pas de liste recopiée côté test — garantit
 * que l'ajout futur d'une 5e raison casse immédiatement le test de
 * couverture d'index.
 */
import type { OrphanInboundClientView } from "@/lib/firestore/orphan-inbounds-sanitize";

export type OrphanReason = OrphanInboundClientView["reason"];
export type OrphanState = OrphanInboundClientView["processingState"];
export type OrphanTab = OrphanState | "all";

/** 4 onglets dans leur ordre d'affichage. */
export const ORPHAN_TAB_ORDER: readonly OrphanTab[] = [
  "pending",
  "attached",
  "dismissed",
  "all",
] as const;

/** Onglet actif par défaut (quand `?tab` est absent). */
export const DEFAULT_ORPHAN_TAB: OrphanTab = "pending";

/** 4 raisons disponibles dans le filtre « Motif ». */
export const ORPHAN_REASON_VALUES: readonly OrphanReason[] = [
  "no_conversation",
  "unknown_contact",
  "parse_failed",
  "enqueue_failed",
] as const;
