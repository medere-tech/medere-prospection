// @vitest-environment jsdom

/**
 * Tests `<RefreshBanner />` — PR2b-2 P3.
 *
 * Objectif : couverture visuelle + accessibilité du bandeau. Mutation :
 * remplacer `delta > 0` par `delta >= 0` → le cas delta=0 n'affiche plus
 * "La liste a été mise à jour" mais "0 nouvelles conversations".
 */
import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RefreshBanner } from "./refresh-banner";

describe("RefreshBanner", () => {
  it("visible=false → ne rend rien", () => {
    const { container } = render(<RefreshBanner visible={false} delta={5} onShow={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("delta=3 → '3 nouvelles conversations' + bouton Afficher accessible", () => {
    render(<RefreshBanner visible={true} delta={3} onShow={vi.fn()} />);
    expect(screen.getByText("3 nouvelles conversations")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Afficher les nouvelles conversations" }),
    ).toBeInTheDocument();
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
  });

  it("delta=1 → singulier 'nouvelle conversation'", () => {
    render(<RefreshBanner visible={true} delta={1} onShow={vi.fn()} />);
    expect(screen.getByText("1 nouvelle conversation")).toBeInTheDocument();
  });

  it("delta=null → 'La liste a été mise à jour'", () => {
    render(<RefreshBanner visible={true} delta={null} onShow={vi.fn()} />);
    expect(screen.getByText("La liste a été mise à jour")).toBeInTheDocument();
  });

  it("delta=0 → même message 'La liste a été mise à jour' (jamais '0 nouvelles')", () => {
    render(<RefreshBanner visible={true} delta={0} onShow={vi.fn()} />);
    expect(screen.getByText("La liste a été mise à jour")).toBeInTheDocument();
    expect(screen.queryByText(/0 nouvelle/)).not.toBeInTheDocument();
  });

  it("delta négatif (count a baissé) → 'La liste a été mise à jour'", () => {
    render(<RefreshBanner visible={true} delta={-2} onShow={vi.fn()} />);
    expect(screen.getByText("La liste a été mise à jour")).toBeInTheDocument();
    expect(screen.queryByText(/-2/)).not.toBeInTheDocument();
  });

  it("clic 'Afficher' → onShow invoqué", () => {
    const onShow = vi.fn();
    render(<RefreshBanner visible={true} delta={5} onShow={onShow} />);
    screen.getByRole("button", { name: "Afficher les nouvelles conversations" }).click();
    expect(onShow).toHaveBeenCalledTimes(1);
  });
});
