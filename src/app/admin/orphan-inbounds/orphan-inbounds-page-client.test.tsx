// @vitest-environment jsdom

/**
 * Tests `<OrphanInboundsPageClient />` (PR2c tour 2b bloc B).
 *
 * Couverture utilisateur-visible :
 *   - États vides par onglet : titre + hint FR, pas d'identifiant.
 *   - `?id=<docId>` à l'ouverture → tiroir ouvert avec le détail du doc.
 *   - Table rend bien le nom résolu, le motif, l'état — jamais le docId.
 */
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// nuqs : simule l'URL state injectable. On type le retour comme une
// paire [string | null, fn] pour accepter aussi bien `null` initial que
// des valeurs d'onglet concrètes comme "dismissed" dans certains tests.
type NuqsReturn = readonly [string | null, (v: string | null) => void];
const useQueryStateMock = vi.fn<(key: string) => NuqsReturn>((key: string) => {
  if (key === "tab") return [null, vi.fn()] as NuqsReturn;
  if (key === "reason") return [null, vi.fn()] as NuqsReturn;
  if (key === "cursor") return [null, vi.fn()] as NuqsReturn;
  if (key === "id") return [null, vi.fn()] as NuqsReturn;
  return [null, vi.fn()] as NuqsReturn;
});
vi.mock("nuqs", () => ({
  useQueryState: useQueryStateMock,
}));

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

/**
 * Mock `fetch` qui expose, par clef d'URL, une promesse résolue
 * APRÈS que le mock a renvoyé le JSON du call correspondant.
 *
 * Pourquoi : les 3 tests dépendaient de `waitFor(…)` enveloppant plusieurs
 * assertions ; le `SheetTitle` est présent dès le mount (dépend uniquement
 * de `?id=`), tandis que le corps du tiroir et les libellés résolus ne
 * surviennent qu'APRÈS la résolution de `useOrphanDetail`. Sur machine
 * chargée (hook pre-push à 1755 ms observé), le waitFor par défaut (1 s)
 * expirait avant la fin du pipeline fetch → json → setState → re-render.
 *
 * La promesse `jsonResolved[key]` ne se résout que quand `response.json()`
 * du mock a été invoqué par react-query. Attendre cette promesse garantit
 * que le pipeline data a terminé AVANT les assertions DOM ; un `findBy*`
 * subséquent couvre les derniers micro-ticks de rendu React.
 */
function mockFetch(byUrl: Record<string, unknown>) {
  const jsonResolved: Record<string, Promise<void>> = {};
  const resolvers: Record<string, () => void> = {};
  for (const key of Object.keys(byUrl)) {
    jsonResolved[key] = new Promise<void>((r) => {
      resolvers[key] = r;
    });
  }
  const impl = vi.fn(async (url: string) => {
    for (const [key, body] of Object.entries(byUrl)) {
      if (url.startsWith(key)) {
        return {
          ok: true,
          json: async () => {
            // Signale APRÈS la lecture JSON ; react-query enchaîne setState
            // en microtask suivante → `findBy*` reste nécessaire pour couvrir
            // le dernier re-render.
            resolvers[key]?.();
            return body;
          },
        } as unknown as Response;
      }
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
  vi.stubGlobal("fetch", impl);
  return { impl, jsonResolved };
}

describe("<OrphanInboundsPageClient />", () => {
  it("onglet « À traiter » vide → copy FR explicite, aucun identifiant", async () => {
    useQueryStateMock.mockImplementation((key: string) => {
      if (key === "tab") return [null, vi.fn()] as NuqsReturn;
      return [null, vi.fn()] as NuqsReturn;
    });
    const { jsonResolved } = mockFetch({
      "/api/admin/orphan-inbounds/counts": {
        counts: { pending: 0, attached: 0, dismissed: 0, all: 0 },
      },
      "/api/admin/orphan-inbounds": { orphans: [], nextCursor: null, hasMore: false },
    });

    const { OrphanInboundsPageClient } = await import("./orphan-inbounds-page-client");
    render(wrap(<OrphanInboundsPageClient />));

    // Attend que la LISTE soit lue (c'est elle qui déclenche l'empty state).
    await jsonResolved["/api/admin/orphan-inbounds"];
    expect(await screen.findByText("Aucun SMS orphelin à traiter.")).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toContain("oih_");
    expect(document.body.textContent ?? "").not.toContain("processingState");
  });

  it("onglet « Classés sans suite » vide → copy FR distincte", async () => {
    useQueryStateMock.mockImplementation((key: string) => {
      if (key === "tab") return ["dismissed", vi.fn()] as NuqsReturn;
      return [null, vi.fn()] as NuqsReturn;
    });
    const { jsonResolved } = mockFetch({
      "/api/admin/orphan-inbounds/counts": {
        counts: { pending: 0, attached: 0, dismissed: 0, all: 0 },
      },
      "/api/admin/orphan-inbounds": { orphans: [], nextCursor: null, hasMore: false },
    });

    const { OrphanInboundsPageClient } = await import("./orphan-inbounds-page-client");
    render(wrap(<OrphanInboundsPageClient />));

    await jsonResolved["/api/admin/orphan-inbounds"];
    expect(await screen.findByText("Aucun SMS classé sans suite.")).toBeInTheDocument();
  });

  it("`?id=oih_abc` → tiroir ouvert avec le détail (SheetTitle rendu)", async () => {
    useQueryStateMock.mockImplementation((key: string) => {
      if (key === "id") return ["oih_abc123", vi.fn()] as NuqsReturn;
      return [null, vi.fn()] as NuqsReturn;
    });
    const { jsonResolved } = mockFetch({
      "/api/admin/orphan-inbounds/counts": {
        counts: { pending: 1, attached: 0, dismissed: 0, all: 1 },
      },
      "/api/admin/orphan-inbounds/oih_abc123": {
        orphan: {
          docId: "oih_abc123",
          reason: "unknown_contact",
          body: "Qui êtes-vous ?",
          source: "process-reply",
          contact: null,
          hasPhoneHash: true,
          receivedAtIso: "2026-10-27T10:00:00.000Z",
          processingState: "pending",
          isTestFixture: false,
        },
      },
      "/api/admin/orphan-inbounds": { orphans: [], nextCursor: null, hasMore: false },
    });

    const { OrphanInboundsPageClient } = await import("./orphan-inbounds-page-client");
    render(wrap(<OrphanInboundsPageClient />));

    // Déterministe : attend la fin de la requête DÉTAIL (ses promesses
    // mockées résolues). Le SheetTitle apparaît dès le mount (indépendant
    // de la requête), mais le corps dépend uniquement de ce fetch.
    await jsonResolved["/api/admin/orphan-inbounds/oih_abc123"];
    expect(await screen.findByText("Détail du SMS orphelin")).toBeInTheDocument();
    expect(await screen.findByText("Qui êtes-vous ?")).toBeInTheDocument();
    expect(await screen.findByText("Médecin inconnu")).toBeInTheDocument();
    // Libellé FR pour la raison, pas la clé technique
    expect(document.body.textContent ?? "").not.toContain("unknown_contact");
  });
});
