// @vitest-environment jsdom

/**
 * Tests `useListVersionWatch` — PR2b-2 P3.
 *
 * Prouve :
 *   L17a — polling cadence ~60 s uniquement document.visible,
 *   L17b — document hidden → 0 appel /version,
 *   L16a — delta version → `hasUpdate=true`,
 *   L16b — `acknowledge()` reset baseline → `hasUpdate=false`.
 *
 * Mutation testing :
 *   - virer le `visibilitychange` listener + le guard `visibilityState`
 *     dans `tick` → "hidden → 0 appel" tombe (le polling continue).
 *   - initialiser baselineRef à "" (jamais null) → `hasUpdate` passe à
 *     true dès le 1ᵉʳ poll → `hasUpdate reste faux au 1er poll` tombe.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useListVersionWatch } from "./use-list-version-watch";

function mockFetchSequence(versions: readonly (string | null)[]): ReturnType<typeof vi.fn> {
  let i = 0;
  return vi.fn(async () => {
    const v = versions[Math.min(i, versions.length - 1)] ?? null;
    i += 1;
    return {
      ok: true,
      json: async () => ({ version: v }),
    } as Response;
  });
}

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useListVersionWatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("1er tick capture la baseline sans déclencher hasUpdate", async () => {
    const fetchMock = mockFetchSequence(["v1"]);
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useListVersionWatch({ tab: "a_traiter", assignedTo: null, intervalMs: 60_000 }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.hasUpdate).toBe(false);
    expect(result.current.pollCount).toBe(1);
  });

  it("version qui change → hasUpdate=true ; acknowledge() reset", async () => {
    const fetchMock = mockFetchSequence(["v1", "v2"]);
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useListVersionWatch({ tab: "a_traiter", assignedTo: null, intervalMs: 60_000 }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.hasUpdate).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current.hasUpdate).toBe(true);

    act(() => result.current.acknowledge());
    expect(result.current.hasUpdate).toBe(false);
  });

  it("~125 s écoulés visible → au plus 3 appels (1 initial + 2 polls)", async () => {
    const fetchMock = mockFetchSequence(["v1"]);
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() =>
      useListVersionWatch({ tab: "a_traiter", assignedTo: null, intervalMs: 60_000 }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(125_000);
    });

    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("document.visibilityState='hidden' → 0 appel au-delà de l'init", async () => {
    const fetchMock = mockFetchSequence(["v1"]);
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() =>
      useListVersionWatch({ tab: "a_traiter", assignedTo: null, intervalMs: 60_000 }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const initial = fetchMock.mock.calls.length;

    await act(async () => {
      setVisibility("hidden");
      await vi.advanceTimersByTimeAsync(500_000); // ~8 min
    });

    expect(fetchMock.mock.calls.length).toBe(initial);
  });

  it("retour sur onglet visible → appel immédiat (pas d'attente du prochain tick)", async () => {
    const fetchMock = mockFetchSequence(["v1", "v1", "v2"]);
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() =>
      useListVersionWatch({ tab: "a_traiter", assignedTo: null, intervalMs: 60_000 }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      setVisibility("hidden");
      await vi.advanceTimersByTimeAsync(5000);
    });
    const beforeReturn = fetchMock.mock.calls.length;

    await act(async () => {
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(beforeReturn);
  });

  it("`disabled: true` → aucun appel (hook neutralisé en mode recherche)", async () => {
    const fetchMock = mockFetchSequence(["v1"]);
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() =>
      useListVersionWatch({
        tab: "a_traiter",
        assignedTo: null,
        intervalMs: 60_000,
        disabled: true,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("change de tab → reset baseline (prochain tick redevient 1er observation)", async () => {
    const fetchMock = mockFetchSequence(["vA1", "vB1", "vB2"]);
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ tab }) => useListVersionWatch({ tab, assignedTo: null, intervalMs: 60_000 }),
      { initialProps: { tab: "a_traiter" } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    rerender({ tab: "cloturees" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.hasUpdate).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current.hasUpdate).toBe(true);
  });
});
