// @vitest-environment jsdom

/**
 * Tests `<OrphanDetailSheet />` (PR2c tour 2b bloc B — post security
 * review, point 7). Deux chemins « introuvable » :
 *   - `?id=` au bon format mais 404 côté API.
 *   - `?id=` au mauvais format → 400 côté API, traité comme introuvable.
 * Les deux affichent le même message FR + un bouton Fermer qui ferme
 * le tiroir.
 */
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { OrphanDetailSheet } from "./orphan-detail-sheet";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

function mockFetchStatus(status: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        ({
          ok: false,
          status,
          json: async () => ({
            error: { code: "NOT_FOUND", message: "Orphelin introuvable." },
          }),
        }) as unknown as Response,
    ),
  );
}

describe("<OrphanDetailSheet /> — chemin introuvable (point 7)", () => {
  it("docId au bon format mais 404 → message « lien ancien » + bouton Fermer", async () => {
    mockFetchStatus(404);
    const onClose = vi.fn();
    render(wrap(<OrphanDetailSheet docId="oih_notfound_valid" onClose={onClose} />));
    await waitFor(() => {
      expect(
        screen.getByText(/Ce SMS orphelin est introuvable\. Le lien est peut-être ancien\./),
      ).toBeInTheDocument();
    });
    // Pas de leak du docId côté UI.
    expect(document.body.textContent ?? "").not.toContain("oih_notfound_valid");
    // Bouton Fermer déclenche onClose().
    const btn = screen.getByRole("button", { name: /^Fermer$/ });
    await userEvent.click(btn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("docId au mauvais format (400 côté serveur) → même message et même bouton Fermer", async () => {
    mockFetchStatus(400);
    const onClose = vi.fn();
    render(wrap(<OrphanDetailSheet docId="not-a-valid-id" onClose={onClose} />));
    await waitFor(() => {
      expect(
        screen.getByText(/Ce SMS orphelin est introuvable\. Le lien est peut-être ancien\./),
      ).toBeInTheDocument();
    });
    const btn = screen.getByRole("button", { name: /^Fermer$/ });
    await userEvent.click(btn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("500 (vraie panne) → message distinct « Impossible de charger ce SMS orphelin »", async () => {
    mockFetchStatus(500);
    render(wrap(<OrphanDetailSheet docId="oih_anything" onClose={vi.fn()} />));
    // `useOrphanDetail` retry une fois pour un non-404 → waitFor plus long.
    await waitFor(
      () => {
        expect(screen.getByText(/Impossible de charger ce SMS orphelin/)).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    // Le message « introuvable / lien ancien » ne doit PAS apparaître.
    expect(screen.queryByText(/Le lien est peut-être ancien/)).toBeNull();
  });
});
