// @vitest-environment jsdom

/**
 * Tests `<CommercialSelect />` — PR2b-2 P1 (libellés lisibles).
 *
 * Objectif de la suite : prouver que le trigger du Select affiche
 * TOUJOURS un libellé humain, même quand :
 *   - la page est ouverte directement avec `?assignedTo=U05UVHGBURX`,
 *   - l'identifiant courant est absent de la liste (`UDELETED42`),
 *   - la liste est indisponible (Airtable down → `commerciaux=null`).
 *
 * Mutation testing : si `commercial-select.tsx` passait l'id brut au
 * trigger (`<SelectValue placeholder="..." />` sans render prop), le
 * cas "ouvre avec URL ?assignedTo=U05UVHGBURX → nom affiché, pas l'id"
 * tombe immédiatement.
 */
import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const nuqsMock = vi.hoisted(() => ({
  useQueryState: vi.fn(() => [null, vi.fn()] as [string | null, (v: string | null) => void]),
}));

vi.mock("nuqs", () => ({
  useQueryState: nuqsMock.useQueryState,
}));

import { CommercialSelect } from "./commercial-select";
import type { CommercialForClient } from "./types";

const COMMERCIAUX: readonly CommercialForClient[] = [
  { slackUserId: "U05UVHGBURX", name: "Déthié Faye", active: true },
  { slackUserId: "U01DPF08TQV", name: "Harry Lambert", active: true },
];

function mockUrlValue(value: string | null): () => void {
  const setter = vi.fn();
  nuqsMock.useQueryState.mockImplementation(() => [value, setter]);
  return () => setter.mockClear();
}

describe("CommercialSelect — libellés affichés par le trigger (PR2b-2 P1)", () => {
  afterEach(() => {
    nuqsMock.useQueryState.mockReset();
    nuqsMock.useQueryState.mockImplementation(() => [null, vi.fn()]);
  });

  it("état par défaut (URL vide) → trigger affiche 'Tous les commerciaux'", () => {
    mockUrlValue(null);
    render(<CommercialSelect commerciaux={COMMERCIAUX} />);
    expect(screen.getByLabelText("Filtrer par commercial")).toHaveTextContent(
      "Tous les commerciaux",
    );
  });

  it("ouvert directement avec ?assignedTo=U05UVHGBURX → trigger affiche 'Déthié Faye', PAS l'id", () => {
    mockUrlValue("U05UVHGBURX");
    render(<CommercialSelect commerciaux={COMMERCIAUX} />);
    const trigger = screen.getByLabelText("Filtrer par commercial");
    expect(trigger).toHaveTextContent("Déthié Faye");
    expect(trigger).not.toHaveTextContent("U05UVHGBURX");
    // Sentinelle plus large : aucun motif Slack userId visible dans tout
    // le composant rendu (ligne, filtre, zone d'avertissement).
    expect(document.body.textContent ?? "").not.toMatch(/\bU[A-Z0-9]{8,}\b/);
  });

  it("ouvert avec ?assignedTo=UDELETED42 (inconnu) → libellé 'Commercial inconnu' + bouton 'Retirer le filtre commercial'", () => {
    mockUrlValue("UDELETED42");
    render(<CommercialSelect commerciaux={COMMERCIAUX} />);
    expect(screen.getByLabelText("Filtrer par commercial")).toHaveTextContent("Commercial inconnu");
    expect(
      screen.getByRole("button", { name: "Retirer le filtre commercial" }),
    ).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(/UDELETED42/);
  });

  it("liste Airtable indisponible (commerciaux=null) + id dans URL → 'Indisponible (Airtable)', pas d'id brut", () => {
    mockUrlValue("U05UVHGBURX");
    render(<CommercialSelect commerciaux={null} />);
    const trigger = screen.getByLabelText("Filtrer par commercial");
    // Select disabled → affiche l'allLabel "Indisponible (Airtable)",
    // jamais l'identifiant brut.
    expect(trigger).toHaveTextContent("Indisponible (Airtable)");
    expect(trigger).not.toHaveTextContent("U05UVHGBURX");
    // Pas de bouton "Retirer le filtre" quand le composant est disabled :
    // l'utilisateur ne peut déjà pas interagir et la liste reviendra.
    expect(
      screen.queryByRole("button", { name: "Retirer le filtre commercial" }),
    ).not.toBeInTheDocument();
  });

  it("clic sur 'Retirer le filtre commercial' → setter nuqs appelé avec null", () => {
    const setter = vi.fn();
    nuqsMock.useQueryState.mockImplementation(() => ["UDELETED42", setter]);
    render(<CommercialSelect commerciaux={COMMERCIAUX} />);
    screen.getByRole("button", { name: "Retirer le filtre commercial" }).click();
    expect(setter).toHaveBeenCalledWith(null);
  });
});
