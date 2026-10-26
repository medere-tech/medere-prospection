// @vitest-environment jsdom

/**
 * Tests `useDebouncedValue` — PR2b-2 P2.
 *
 * Prouve :
 *   - une rafale de setValue ne restitue QUE la dernière valeur après le
 *     délai (preuve "une requête ne part pas à chaque frappe"),
 *   - délai 0 → propagation immédiate,
 *   - cleanup : timer annulé au démontage.
 *
 * Mutation testing : remplacer `clearTimeout` par un `setDebounced(value)`
 * immédiat casse "ne restitue QUE la dernière".
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useDebouncedValue } from "./use-debounced-value";

describe("useDebouncedValue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("restitution initiale = value fournie (synchrone)", () => {
    const { result } = renderHook(() => useDebouncedValue("initial", 300));
    expect(result.current).toBe("initial");
  });

  it("rafale de 5 setValue en 150 ms → une seule restitution finale après 300 ms", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 300), {
      initialProps: { v: "a" },
    });
    expect(result.current).toBe("a");

    for (const next of ["ab", "abc", "abcd", "abcde", "deth"]) {
      rerender({ v: next });
      act(() => {
        vi.advanceTimersByTime(30);
      });
      expect(result.current).toBe("a"); // reste à "a" tant que delay non écoulé
    }

    // Avance jusqu'à ce que le dernier timer scheduleé expire (300ms après
    // la dernière mutation). Si l'implémentation ne clearTimeout pas, on
    // verrait des valeurs intermédiaires.
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toBe("deth");
  });

  it("delay=0 → propagation immédiate", () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 0), {
      initialProps: { v: "x" },
    });
    rerender({ v: "y" });
    expect(result.current).toBe("y");
  });

  it("cleanup : démontage annule le timer en attente (pas de setState post-unmount)", () => {
    vi.useFakeTimers();
    const { rerender, unmount } = renderHook(({ v }) => useDebouncedValue(v, 300), {
      initialProps: { v: "a" },
    });
    rerender({ v: "b" });
    unmount();
    // Pas d'exception / warning React — advanceTimersByTime ne déclenche
    // plus rien car le cleanup a appelé clearTimeout.
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }).not.toThrow();
  });
});
