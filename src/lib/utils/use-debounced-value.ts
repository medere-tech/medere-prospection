"use client";

/**
 * Hook `useDebouncedValue(value, delayMs)` — retourne une version
 * "stabilisée" de `value` : elle ne reflète la dernière valeur reçue
 * qu'après un délai d'inactivité `delayMs`.
 *
 * Usage canonique PR2b-2 P2 — recherche médecin :
 *   const [raw, setRaw] = useState("");
 *   const debounced = useDebouncedValue(raw, 300);
 *   useEffect(() => void fetchList({ q: debounced }), [debounced]);
 *
 * Garanties :
 *   - Changements rapides consécutifs : seule la DERNIÈRE valeur est
 *     restituée après `delayMs` d'inactivité (preuve mutation testing :
 *     virer le `clearTimeout` publierait chaque frappe).
 *   - Démontage : timer annulé (`clearTimeout` dans le cleanup) — aucun
 *     setState post-unmount.
 *   - `delayMs <= 0` : propagation immédiate (utile pour tests).
 */
import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    // delayMs <= 0 : court-circuité par la valeur de retour calculée
    // ci-dessous — PAS de setState synchrone dans l'effect (règle
    // `react-hooks/set-state-in-effect`).
    if (delayMs <= 0) return;
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  // Si l'appelant demande 0 ms, on by-passe l'état interne et on expose
  // directement la value courante (propagation immédiate).
  return delayMs <= 0 ? value : debounced;
}
