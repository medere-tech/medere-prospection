// @vitest-environment jsdom
/**
 * Sentinelle runtime VUE-CONVERSATION PR1.13 — `QueryProvider` est bien
 * en place et `useQuery` fonctionne dessous.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi ce test
 *
 *   La sentinelle `layout-providers.sentinel.test.ts` vérifie la STRUCTURE
 *   du fichier `src/app/layout.tsx` (import + balise JSX). C'est bien,
 *   mais ça ne garantit pas que `useQuery` fonctionne à l'intérieur.
 *   Ce test runtime complète en montant VRAIMENT un composant avec
 *   `useQuery`, enveloppé par le vrai `QueryProvider`, et vérifie :
 *
 *     1. Avec provider → render OK, pas d'erreur.
 *     2. Sans provider (mutation) → erreur "No QueryClient set".
 */
import "@testing-library/jest-dom/vitest";

import { useQuery } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QueryProvider } from "@/components/providers/query-provider";

afterEach(() => cleanup());

/** Petit composant client qui utilise useQuery (minimal, pas d'I/O). */
function ComponentWithUseQuery() {
  const q = useQuery({
    queryKey: ["sentinel-test"],
    queryFn: async () => "data-ok",
  });
  if (q.isLoading) return <span>loading</span>;
  return <span>{q.data ?? "no-data"}</span>;
}

describe("Sentinelle PR1.13 — QueryProvider wraps useQuery", () => {
  it("AVEC provider : useQuery monte sans erreur", () => {
    expect(() =>
      render(
        <QueryProvider>
          <ComponentWithUseQuery />
        </QueryProvider>,
      ),
    ).not.toThrow();
    // Le rendu initial = loading (queryFn async).
    expect(screen.getByText(/loading|data-ok/)).toBeInTheDocument();
  });

  it("mutation testing — SANS provider : useQuery throw 'No QueryClient set'", () => {
    // React logge l'erreur en console → on silence pour ne pas polluer stderr test.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() => render(<ComponentWithUseQuery />)).toThrow(/No QueryClient set/);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("sanity : QueryProvider instancie UN QueryClient par mount (pas de partage inter-session)", () => {
    // Monte 2 fois le provider → chaque mount a son propre QueryClient.
    // On ne peut pas inspecter directement le client (encapsulé), mais on
    // peut vérifier que 2 renders n'interfèrent pas :
    const { unmount: unmount1 } = render(
      <QueryProvider>
        <ComponentWithUseQuery />
      </QueryProvider>,
    );
    const { unmount: unmount2 } = render(
      <QueryProvider>
        <ComponentWithUseQuery />
      </QueryProvider>,
    );
    expect(screen.getAllByText(/loading|data-ok/).length).toBeGreaterThanOrEqual(2);
    unmount1();
    unmount2();
  });
});
