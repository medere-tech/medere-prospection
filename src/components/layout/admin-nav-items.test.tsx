// @vitest-environment jsdom

/**
 * Tests `<AdminNavItems />` — visibilité de l'entrée « SMS orphelins »
 * selon le rôle (PR2c tour 2b bloc B).
 *
 * Mutations manuelles vérifiées par ces tests :
 *   - M3 : si on retirait `adminOnly: true` sur l'entrée orphelins,
 *          le test « commercial ne voit pas SMS orphelins » tomberait.
 */
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/contacts",
}));

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

function mockFetchCounts(pending: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/orphan-inbounds/counts")) {
        return {
          ok: true,
          json: async () => ({
            counts: { pending, attached: 0, dismissed: 0, all: pending },
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }),
  );
}

describe("<AdminNavItems />", () => {
  it("admin : voit l'entrée « SMS orphelins » et le badge pending > 0", async () => {
    mockFetchCounts(5);
    const { AdminNavItems } = await import("./admin-nav-items");
    render(wrap(<AdminNavItems role="admin" />));
    expect(screen.getByText("SMS orphelins")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText(/5 SMS orphelins à traiter/)).toBeInTheDocument();
    });
  });

  it("admin : pending = 0 → badge absent (jamais afficher « 0 » par défaut)", async () => {
    mockFetchCounts(0);
    const { AdminNavItems } = await import("./admin-nav-items");
    render(wrap(<AdminNavItems role="admin" />));
    expect(screen.getByText("SMS orphelins")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByLabelText(/SMS orphelin(s)? à traiter/)).toBeNull();
    });
  });

  it("commercial : NE voit PAS l'entrée « SMS orphelins » (admin-only)", async () => {
    mockFetchCounts(5); // ignoré : hook désactivé pour commercial
    const { AdminNavItems } = await import("./admin-nav-items");
    render(wrap(<AdminNavItems role="commercial" />));
    expect(screen.queryByText("SMS orphelins")).toBeNull();
  });
});
