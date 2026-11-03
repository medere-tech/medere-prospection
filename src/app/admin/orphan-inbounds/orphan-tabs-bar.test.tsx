// @vitest-environment jsdom

/**
 * Tests `<OrphanTabsBar />` (PR2c tour 2b bloc B).
 *
 * Couvre :
 *   - 4 onglets exacts dans l'ordre `pending` / `attached` / `dismissed` / `all`.
 *   - Compteurs rendus en Badge et strictement égaux aux valeurs API.
 *   - « À traiter » actif par défaut quand `?tab` absent.
 *   - Clic sur un onglet → setTab + onTabChange.
 *   - `counts === null` → Badges absents (jamais de « 0 » par défaut).
 */
import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const setTabMock = vi.fn();
vi.mock("nuqs", () => ({
  useQueryState: vi.fn((key: string) => {
    if (key === "tab") return [null, setTabMock];
    return [null, vi.fn()];
  }),
}));

import { OrphanTabsBar } from "./orphan-tabs-bar";

const COUNTS = { pending: 3, attached: 7, dismissed: 2, all: 12 };

describe("<OrphanTabsBar />", () => {
  beforeEach(() => setTabMock.mockClear());

  it("rend 4 onglets dans l'ordre À traiter / Rattachés / Classés sans suite / Tous", () => {
    render(<OrphanTabsBar counts={COUNTS} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(4);
    expect(tabs[0]).toHaveTextContent("À traiter");
    expect(tabs[1]).toHaveTextContent("Rattachés");
    expect(tabs[2]).toHaveTextContent("Classés sans suite");
    expect(tabs[3]).toHaveTextContent("Tous");
  });

  it("rend des compteurs STRICTEMENT égaux aux valeurs fournies", () => {
    render(<OrphanTabsBar counts={COUNTS} />);
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("counts=null → aucun badge, pas de '0' par défaut", () => {
    render(<OrphanTabsBar counts={null} />);
    expect(screen.queryByText("0")).toBeNull();
  });

  it("sans ?tab, « À traiter » est actif par défaut", () => {
    render(<OrphanTabsBar counts={COUNTS} />);
    const pending = screen.getByRole("tab", { name: /À traiter/ });
    expect(pending).toHaveAttribute("aria-selected", "true");
  });

  it("clic sur « Tous » → setTab('all') + onTabChange", async () => {
    const onTabChange = vi.fn();
    render(<OrphanTabsBar counts={COUNTS} onTabChange={onTabChange} />);
    await userEvent.click(screen.getByRole("tab", { name: /^Tous/ }));
    expect(setTabMock).toHaveBeenCalledWith("all");
    expect(onTabChange).toHaveBeenCalledTimes(1);
  });

  it("clic sur « À traiter » (défaut) → setTab(null) pour URL propre", async () => {
    render(<OrphanTabsBar counts={COUNTS} />);
    await userEvent.click(screen.getByRole("tab", { name: /À traiter/ }));
    expect(setTabMock).toHaveBeenCalledWith(null);
  });
});
