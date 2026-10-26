"use client";

/**
 * Champ de recherche "Rechercher un médecin" — PR2b-2 P2.
 *
 * - État source = URL `?q=...` via nuqs (partagé avec le parent qui
 *   déclenche le fetch sur `q`).
 * - État local = raw saisie (mise à jour synchrone pour un typing fluide).
 * - `useDebouncedValue(raw, 300)` → une seule requête après 300 ms
 *   d'inactivité clavier (prouvé par `use-debounced-value.test.ts`).
 * - Minimum 2 caractères : en-dessous, `q` est effacé de l'URL (pas de
 *   recherche d'une seule lettre côté serveur — Firestore `>=` + `<`
 *   deviennent inutilement larges, et UX bruitée).
 * - Bouton 'Effacer' visible dès que le champ est non vide, remet raw="".
 * - Reset du curseur de pagination à chaque changement effectif de `q`
 *   (callback `onEffectiveChange`).
 *
 * Mutation testing : virer le debounce (restituer `raw` directement
 * dans l'useEffect) → `use-debounced-value.test.ts` casse ET
 * `L15 — aucune requête par frappe` casse.
 */
import { XIcon } from "lucide-react";
import { useQueryState } from "nuqs";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/lib/utils/use-debounced-value";

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_DEBOUNCE_MS = 300;

export interface ConversationsSearchInputProps {
  /** Callback appelé à chaque changement de la valeur effective (après
   * debounce et seuil min). Utilisé pour reset le cursor. */
  onEffectiveChange?: (q: string | null) => void;
}

export function ConversationsSearchInput({ onEffectiveChange }: ConversationsSearchInputProps) {
  const [q, setQ] = useQueryState("q");
  const [raw, setRaw] = useState<string>(q ?? "");
  const debounced = useDebouncedValue(raw, SEARCH_DEBOUNCE_MS);
  const lastSyncedRef = useRef<string | null>(q);

  // Push debounced → URL state, en respectant le seuil min.
  useEffect(() => {
    const trimmed = debounced.trim();
    const effective = trimmed.length >= SEARCH_MIN_CHARS ? trimmed : null;
    if (effective === lastSyncedRef.current) return;
    lastSyncedRef.current = effective;
    void setQ(effective);
    onEffectiveChange?.(effective);
  }, [debounced, setQ, onEffectiveChange]);

  // Resync descendante : si une autre partie du monde modifie `?q=`
  // (ex. retour navigation), on recoche l'input.
  useEffect(() => {
    const external = q ?? "";
    if (external !== raw && external !== lastSyncedRef.current) {
      setRaw(external);
      lastSyncedRef.current = q;
    }
    // Volontairement pas de `raw` en dép : on NE veut PAS re-sync à
    // chaque frappe locale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const showClear = raw.length > 0;

  return (
    <div className="flex min-w-[220px] flex-col gap-1.5">
      <label htmlFor="conversations-search" className="text-xs font-medium text-muted-foreground">
        Rechercher un médecin
      </label>
      <div className="relative">
        <Input
          id="conversations-search"
          type="search"
          inputMode="search"
          autoComplete="off"
          spellCheck={false}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="Nom (préfixe, 2 caractères minimum)"
          aria-describedby="conversations-search-hint"
          className="pr-9"
        />
        {showClear && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setRaw("")}
            aria-label="Effacer la recherche"
            className="absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 p-0"
          >
            <XIcon className="size-4" />
          </Button>
        )}
      </div>
      <span id="conversations-search-hint" className="sr-only">
        Appuyez sur Entrée après avoir saisi au moins 2 caractères. La recherche se déclenche
        automatiquement après 300 millisecondes d&apos;inactivité.
      </span>
    </div>
  );
}
