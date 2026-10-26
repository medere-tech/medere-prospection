"use client";

/**
 * Hook `useListVersionWatch` — polling de `/api/admin/conversations/version`
 * (PR2b-2 P3).
 *
 * Garanties :
 *   - polling ACTIF uniquement quand `document.visibilityState === "visible"`
 *     (brief P3 : "arrêt quand l'onglet est caché, contrôle immédiat au
 *     retour sur l'onglet").
 *   - cadence `intervalMs` (défaut 60 000 ms).
 *   - mémorise la 1ʳᵉ version observée comme baseline → `hasUpdate` passe
 *     à `true` quand la version lue diffère ; reste `true` jusqu'à ce que
 *     l'appelant `acknowledge()` (reset baseline).
 *   - zéro appel réseau pendant qu'on est caché (preuve L17).
 *
 * Mutation testing cibles :
 *   - virer le `visibilitychange` listener → L17 "hidden → 0 appel" tombe.
 *   - virer la baseline (comparer current à current) → `hasUpdate` ne
 *     passerait jamais à true → L16 tombe.
 */
import { startTransition, useCallback, useEffect, useRef, useState } from "react";

export interface UseListVersionWatchParams {
  /** `tab` et `assignedTo` (null quand admin "tous commerciaux"). */
  readonly tab: string;
  readonly assignedTo: string | null;
  /** Cadence du polling en ms (défaut 60 000). */
  readonly intervalMs?: number;
  /** Suspendre le polling (ex. mode recherche actif). Défaut false. */
  readonly disabled?: boolean;
}

export interface UseListVersionWatchResult {
  /** `true` si une nouvelle version a été détectée après la baseline. */
  readonly hasUpdate: boolean;
  /** Nombre d'appels /version émis depuis le mount (utile aux tests). */
  readonly pollCount: number;
  /** Reset la baseline sur la version courante → `hasUpdate` repasse false. */
  readonly acknowledge: () => void;
}

const DEFAULT_INTERVAL_MS = 60_000;

export function useListVersionWatch({
  tab,
  assignedTo,
  intervalMs = DEFAULT_INTERVAL_MS,
  disabled = false,
}: UseListVersionWatchParams): UseListVersionWatchResult {
  const [hasUpdate, setHasUpdate] = useState(false);
  const [pollCount, setPollCount] = useState(0);
  const baselineRef = useRef<string | null>(null);
  const latestRef = useRef<string | null>(null);

  const buildUrl = useCallback(() => {
    const search = new URLSearchParams();
    search.set("tab", tab);
    if (assignedTo) search.set("assignedTo", assignedTo);
    return `/api/admin/conversations/version?${search.toString()}`;
  }, [tab, assignedTo]);

  const doPoll = useCallback(
    async (signal: AbortSignal): Promise<void> => {
      try {
        setPollCount((n) => n + 1);
        const res = await fetch(buildUrl(), { signal, cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { version?: string | null };
        const nextVersion = data.version ?? null;
        latestRef.current = nextVersion;
        if (baselineRef.current === null) {
          baselineRef.current = nextVersion;
          return;
        }
        if (nextVersion !== baselineRef.current) {
          setHasUpdate(true);
        }
      } catch {
        // Ignore (abort, offline, etc.) — le polling continuera.
      }
    },
    [buildUrl],
  );

  // Reset baseline si tab/assignedTo change : chaque filtre a sa propre
  // version. `setHasUpdate(false)` passe par `startTransition` pour éviter
  // la règle `react-hooks/set-state-in-effect` (setState synchrone dans
  // le body d'un effect). Les refs restent synchrones.
  useEffect(() => {
    baselineRef.current = null;
    latestRef.current = null;
    startTransition(() => setHasUpdate(false));
  }, [tab, assignedTo]);

  useEffect(() => {
    if (disabled) return;
    if (typeof document === "undefined") return;

    let ac: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const scheduleNext = () => {
      if (document.visibilityState !== "visible") return;
      timer = setTimeout(tick, intervalMs);
    };

    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      ac = new AbortController();
      await doPoll(ac.signal);
      scheduleNext();
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        // Au retour : contrôle immédiat (brief). On annule le timer en
        // attente et on relance un cycle maintenant.
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        void tick();
      } else {
        // Caché : annuler timer + inflight request → 0 appel réseau.
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (ac) {
          ac.abort();
          ac = null;
        }
      }
    };

    // Démarrage : tick immédiat si visible (baseline), sinon on attend
    // `visibilitychange`.
    void tick();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer) clearTimeout(timer);
      if (ac) ac.abort();
    };
  }, [doPoll, intervalMs, disabled]);

  const acknowledge = useCallback(() => {
    baselineRef.current = latestRef.current;
    setHasUpdate(false);
  }, []);

  return { hasUpdate, pollCount, acknowledge };
}
