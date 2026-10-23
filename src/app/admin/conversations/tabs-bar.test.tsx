// @vitest-environment jsdom

/**
 * Tests `<TabsBar />` (PR2b-1).
 *
 * Couvre :
 *   - admin : 4 onglets (A traiter, En cours avec Léa, Clôturées, Toutes).
 *   - commercial : 3 onglets (pas "En cours avec Léa").
 *   - active par défaut : A traiter (quand `?tab` est absent).
 *   - clic sur un onglet → setTab + reset cursor via `onTabChange`.
 *   - compteurs rendus en Badge quand `counts.kind === "success"`.
 *
 * Mutation : si `tabsForRole` renvoyait les 4 onglets admin pour un
 * commercial, les tests "commercial : 3 onglets" + "en_cours absent"
 * tombent.
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

import { TabsBar } from "./tabs-bar";
import type { CountsFetchState } from "./types";

const SUCCESS_COUNTS: CountsFetchState = {
  kind: "success",
  data: { a_traiter: 3, cloturees: 5, toutes: 10, en_cours: 2 },
};

describe("<TabsBar />", () => {
  beforeEach(() => {
    setTabMock.mockClear();
  });

  it("admin : rend les 4 onglets dans l'ordre A traiter / En cours / Clôturées / Toutes", () => {
    render(<TabsBar role="admin" countsState={SUCCESS_COUNTS} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(4);
    expect(tabs[0]).toHaveTextContent("À traiter");
    expect(tabs[1]).toHaveTextContent("En cours avec Léa");
    expect(tabs[2]).toHaveTextContent("Clôturées");
    expect(tabs[3]).toHaveTextContent("Toutes");
  });

  it("commercial : rend 3 onglets, aucun 'En cours avec Léa'", () => {
    render(<TabsBar role="commercial" countsState={SUCCESS_COUNTS} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(screen.queryByText("En cours avec Léa")).toBeNull();
  });

  it("sans tab dans l'URL, 'À traiter' est actif par défaut", () => {
    render(<TabsBar role="admin" countsState={SUCCESS_COUNTS} />);
    const aTraiter = screen.getByRole("tab", { name: /À traiter/ });
    expect(aTraiter).toHaveAttribute("aria-selected", "true");
  });

  it("rend les compteurs quand countsState est success", () => {
    render(<TabsBar role="admin" countsState={SUCCESS_COUNTS} />);
    // On vérifie que les 4 valeurs du mock apparaissent exactement une fois.
    expect(screen.getByText("3")).toBeInTheDocument(); // a_traiter
    expect(screen.getByText("2")).toBeInTheDocument(); // en_cours
    expect(screen.getByText("5")).toBeInTheDocument(); // cloturees
    expect(screen.getByText("10")).toBeInTheDocument(); // toutes
  });

  it("n'affiche aucun compteur quand countsState est loading", () => {
    render(<TabsBar role="admin" countsState={{ kind: "loading" }} />);
    // Les Badges disparaissent — on ne doit pas trouver "3" dans le DOM.
    expect(screen.queryByText("3")).toBeNull();
  });

  it("clic sur un onglet → setTab + onTabChange", async () => {
    const onTabChange = vi.fn();
    render(<TabsBar role="admin" countsState={SUCCESS_COUNTS} onTabChange={onTabChange} />);
    await userEvent.click(screen.getByRole("tab", { name: /Clôturées/ }));
    expect(setTabMock).toHaveBeenCalledWith("cloturees");
    expect(onTabChange).toHaveBeenCalledTimes(1);
  });

  it("clic sur 'À traiter' (tab par défaut) → setTab(null) pour URL propre", async () => {
    const onTabChange = vi.fn();
    render(<TabsBar role="admin" countsState={SUCCESS_COUNTS} onTabChange={onTabChange} />);
    await userEvent.click(screen.getByRole("tab", { name: /À traiter/ }));
    expect(setTabMock).toHaveBeenCalledWith(null);
  });
});
