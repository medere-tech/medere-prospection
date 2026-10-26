/**
 * Tests `handleShowBanner` — PR2b-2 round 2.
 *
 * Dette fermée : mutation `acknowledge()` oublié → test tombe.
 */
import { describe, expect, it, vi } from "vitest";

import { handleShowBanner } from "./handle-show-banner";

describe("handleShowBanner", () => {
  function makeDeps() {
    return {
      setCursor: vi.fn(),
      setRefreshKey: vi.fn(),
      setBanner: vi.fn(),
      resetBaseline: vi.fn(),
      acknowledge: vi.fn(),
    };
  }

  it("appelle les 5 dépendances exactement une fois", () => {
    const deps = makeDeps();
    handleShowBanner(deps);
    expect(deps.setCursor).toHaveBeenCalledTimes(1);
    expect(deps.setRefreshKey).toHaveBeenCalledTimes(1);
    expect(deps.setBanner).toHaveBeenCalledTimes(1);
    expect(deps.resetBaseline).toHaveBeenCalledTimes(1);
    expect(deps.acknowledge).toHaveBeenCalledTimes(1);
  });

  it("reset cursor avec null (page 1)", () => {
    const deps = makeDeps();
    handleShowBanner(deps);
    expect(deps.setCursor).toHaveBeenCalledWith(null);
  });

  it("incrémente refreshKey (updater function k → k+1)", () => {
    const deps = makeDeps();
    handleShowBanner(deps);
    const updater = deps.setRefreshKey.mock.calls[0]?.[0] as (k: number) => number;
    expect(updater(0)).toBe(1);
    expect(updater(42)).toBe(43);
  });

  it("masque le bandeau (visible=false, delta=null)", () => {
    const deps = makeDeps();
    handleShowBanner(deps);
    expect(deps.setBanner).toHaveBeenCalledWith({ visible: false, delta: null });
  });

  it("MUTATION : si acknowledge est omis → le test fail (dette fermée PR2b-2 round 2)", () => {
    // Simule la mutation en pré-condition : si l'implémentation
    // supprimait `deps.acknowledge()`, le mock recevrait 0 appel et
    // l'assertion ci-dessous casse. C'est précisément la régression
    // dont Déthié voulait un filet.
    const deps = makeDeps();
    handleShowBanner(deps);
    expect(deps.acknowledge).toHaveBeenCalledTimes(1);
  });

  it("MUTATION : si resetBaseline est omis → le test fail", () => {
    const deps = makeDeps();
    handleShowBanner(deps);
    expect(deps.resetBaseline).toHaveBeenCalledTimes(1);
  });
});
