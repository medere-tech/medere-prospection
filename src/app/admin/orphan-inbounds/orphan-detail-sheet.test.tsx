// @vitest-environment jsdom

/**
 * Tests `<OrphanDetailSheet />` (PR2c tour 2b bloc B — post security
 * review, point 7). Deux chemins « introuvable » :
 *   - `?id=` au bon format mais 404 côté API.
 *   - `?id=` au mauvais format → 400 côté API, traité comme introuvable.
 * Les deux affichent le même message FR + un bouton Fermer qui ferme
 * le tiroir.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Déterminisme PR2c bloc C bis (hook pre-push)
 *
 *   Même défaut structurel que `orphan-inbounds-page-client.test.tsx` :
 *   `waitFor(...)` par défaut à 1 s expirait AVANT la fin du pipeline
 *   fetch → json → setState → re-render sur machine chargée (observé
 *   « Chargement… » toujours visible à t=1 s dans le hook pre-push).
 *   Correction : `mockFetchStatus` expose `waitForNthJson(n)` — attend
 *   que le mock ait rendu la Nème réponse JSON (useOrphanDetail retry
 *   une fois sur non-404 → N=2 pour les 500). `findBy*` subséquent
 *   couvre les derniers micro-ticks de rendu React.
 */
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { OrphanDetailSheet } from "./orphan-detail-sheet";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

/**
 * Mock `fetch` qui expose `waitForNthFetchReturn(n)` : promesse
 * résolue APRÈS que le mock a renvoyé sa Nème réponse. On signale au
 * niveau du `fetch` (pas de `json()`), parce que `useOrphanDetail`
 * court-circuite `.json()` sur 404/400 et throw `OrphanDetailNotFoundError`
 * directement — un signal `json()` ne se déclencherait jamais.
 *
 * `useOrphanDetail` retry une fois sur non-404/400 (voir `use-orphans.ts`
 * ligne 144-147) → attendre `n=2` sur les tests 500, `n=1` sur 404/400.
 */
function mockFetchStatus(status: number) {
  let callCount = 0;
  const resolvers = new Map<number, () => void>();
  const promises = new Map<number, Promise<void>>();
  for (let i = 1; i <= 5; i++) {
    promises.set(i, new Promise<void>((r) => resolvers.set(i, r)));
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      callCount++;
      const response = {
        ok: false,
        status,
        json: async () => ({
          error: { code: "NOT_FOUND", message: "Orphelin introuvable." },
        }),
      } as unknown as Response;
      // Signale APRÈS que la Response est construite — react-query a
      // déjà `await`ed `fetch(url)` à ce point ; les étapes suivantes
      // (status check, throw ou retry) sont dans la microtask qui suit.
      resolvers.get(callCount)?.();
      return response;
    }),
  );
  return {
    waitForNthFetchReturn: (n: number): Promise<void> => promises.get(n)!,
  };
}

describe("<OrphanDetailSheet /> — chemin introuvable (point 7)", () => {
  it("docId au bon format mais 404 → message « lien ancien » + bouton Fermer", async () => {
    const { waitForNthFetchReturn } = mockFetchStatus(404);
    const onClose = vi.fn();
    render(wrap(<OrphanDetailSheet docId="oih_notfound_valid" onClose={onClose} />));
    await waitForNthFetchReturn(1);
    expect(
      await screen.findByText(/Ce SMS orphelin est introuvable\. Le lien est peut-être ancien\./),
    ).toBeInTheDocument();
    // Pas de leak du docId côté UI.
    expect(document.body.textContent ?? "").not.toContain("oih_notfound_valid");
    // Bouton Fermer déclenche onClose().
    const btn = screen.getByRole("button", { name: /^Fermer$/ });
    await userEvent.click(btn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("docId au mauvais format (400 côté serveur) → même message et même bouton Fermer", async () => {
    const { waitForNthFetchReturn } = mockFetchStatus(400);
    const onClose = vi.fn();
    render(wrap(<OrphanDetailSheet docId="not-a-valid-id" onClose={onClose} />));
    await waitForNthFetchReturn(1);
    expect(
      await screen.findByText(/Ce SMS orphelin est introuvable\. Le lien est peut-être ancien\./),
    ).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /^Fermer$/ });
    await userEvent.click(btn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("500 (vraie panne) → message distinct « Impossible de charger ce SMS orphelin »", async () => {
    const { waitForNthFetchReturn } = mockFetchStatus(500);
    render(wrap(<OrphanDetailSheet docId="oih_anything" onClose={vi.fn()} />));
    // `useOrphanDetail` retry une fois pour un non-404 → attendre les
    // 2 réponses JSON avant de laisser `findBy*` capter la dernière
    // re-render.
    await waitForNthFetchReturn(2);
    expect(await screen.findByText(/Impossible de charger ce SMS orphelin/)).toBeInTheDocument();
    // Le message « introuvable / lien ancien » ne doit PAS apparaître.
    expect(screen.queryByText(/Le lien est peut-être ancien/)).toBeNull();
  });
});
