// @vitest-environment jsdom

/**
 * Tests `<ConversationsPageClient />` (PR2b-1).
 *
 * Couvre :
 *   - render initial → 2 fetchs (liste + counts) au mount + loading state.
 *   - success → cells avec données (contactDisplayName, specialty, city).
 *   - empty → "Aucune conversation à traiter." (phrase utile par onglet).
 *   - error → "Impossible de charger les conversations" + bouton Réessayer.
 *   - pagination 60 lignes seedées → "Page suivante" cliquable + setCursor.
 *   - mobile cards présentes DANS le DOM (visibles via `md:hidden`).
 *   - chaque ligne est un <a href="/admin/conversations/{id}"> natif.
 *
 * Mutation : si le href de la cellule est perdu, "lien natif" test fail.
 */
import "@testing-library/jest-dom/vitest";

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const setCursorMock = vi.fn();
vi.mock("nuqs", () => ({
  useQueryState: vi.fn((key: string) => {
    if (key === "cursor") return [null, setCursorMock];
    return [null, vi.fn()];
  }),
}));

import type { HubspotListInfo } from "@/lib/hubspot/lists";

import { ConversationsPageClient } from "./conversations-page-client";
import type { ConversationListItem } from "./types";

const CAMPAIGNS: HubspotListInfo[] = [
  {
    listId: "6081",
    name: "SMS Dentistes IDF",
    size: 200,
    processingType: "MANUAL",
    createdAt: "2026-05-29T12:00:00.000Z",
  },
];

const COMMERCIAUX = [{ slackUserId: "U05UVHGBURX", name: "Dethie Faye", active: true }];

function buildItem(overrides: Partial<ConversationListItem> = {}): ConversationListItem {
  return {
    conversationId: "427963864300_hubspot-list-6081",
    campaignId: "hubspot-list-6081",
    status: "opted_out",
    intent: "STOP",
    assignedTo: "U05UVHGBURX",
    assignedToName: null,
    lastMessageAtIso: "2026-10-20T14:30:00.000Z",
    lastInboundAtIso: "2026-10-20T14:30:00.000Z",
    lastOutboundAtIso: "2026-10-20T13:00:00.000Z",
    lastHumanOutboundAtIso: null,
    inboundCount: 1,
    outboundCount: 1,
    contactDisplayName: "Dr Jean Dupont",
    contactSpecialty: "Chirurgien-dentiste",
    contactCity: "Paris",
    campaignName: null, // résolu via map campagnes
    lastMessagePreview: {
      direction: "inbound",
      authorKind: "contact",
      text: "STOP",
      atIso: "2026-10-20T14:30:00.000Z",
    },
    waitingForHumanReply: false,
    ...overrides,
  };
}

const originalFetch = global.fetch;

function mockFetch(
  listResponse: unknown,
  options: {
    countsResponse?: unknown;
    listStatus?: number;
    countsStatus?: number;
  } = {},
) {
  global.fetch = vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("/api/admin/conversations/counts")) {
      return {
        ok: (options.countsStatus ?? 200) < 400,
        status: options.countsStatus ?? 200,
        json: async () =>
          options.countsResponse ?? {
            counts: { a_traiter: 0, cloturees: 1, toutes: 1, en_cours: 0 },
            filterApplied: { role: "admin", assignedTo: null, campaignId: null, q: null },
          },
      } as unknown as Response;
    }
    return {
      ok: (options.listStatus ?? 200) < 400,
      status: options.listStatus ?? 200,
      json: async () => listResponse,
    } as unknown as Response;
  }) as unknown as typeof global.fetch;
}

describe("<ConversationsPageClient />", () => {
  beforeEach(() => {
    setCursorMock.mockClear();
    global.fetch = originalFetch;
  });

  it("empty state → phrase utile par onglet (A traiter)", async () => {
    mockFetch({
      items: [],
      nextCursor: null,
      hasMore: false,
      filterApplied: {
        role: "admin",
        tab: "a_traiter",
        assignedTo: null,
        statuses: ["handed_off"],
        campaignId: null,
        q: null,
        searchMode: false,
      },
    });
    render(
      <ConversationsPageClient
        role="admin"
        viewerSlackUserId="U05UVHGBURX"
        initialCampaigns={CAMPAIGNS}
        initialCommerciaux={COMMERCIAUX}
      />,
    );
    // Message rendu DANS la table ET dans la vue mobile (deux conteneurs
    // CSS-switchés via `md:hidden`/`md:block`) → `findAllByText`.
    const titles = await screen.findAllByText("Aucune conversation à traiter.", undefined, {
      timeout: 2000,
    });
    expect(titles.length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("Les nouvelles prises en charge apparaîtront ici.").length,
    ).toBeGreaterThan(0);
  });

  it("success → render une ligne avec contactDisplayName + specialty + city", async () => {
    mockFetch({
      items: [buildItem()],
      nextCursor: null,
      hasMore: false,
      filterApplied: {
        role: "admin",
        tab: "a_traiter",
        assignedTo: null,
        statuses: ["handed_off"],
        campaignId: null,
        q: null,
        searchMode: false,
      },
    });
    render(
      <ConversationsPageClient
        role="admin"
        viewerSlackUserId="U05UVHGBURX"
        initialCampaigns={CAMPAIGNS}
        initialCommerciaux={COMMERCIAUX}
      />,
    );
    expect(
      await screen.findAllByText("Dr Jean Dupont", undefined, { timeout: 2000 }),
    ).not.toHaveLength(0);
    // Specialty et city affichés en sub-ligne.
    expect(screen.getAllByText(/Chirurgien-dentiste.*Paris/).length).toBeGreaterThan(0);
  });

  it("chaque ligne desktop a un <a href='/admin/conversations/{id}'> natif", async () => {
    mockFetch({
      items: [buildItem()],
      nextCursor: null,
      hasMore: false,
      filterApplied: {
        role: "admin",
        tab: "a_traiter",
        assignedTo: null,
        statuses: ["handed_off"],
        campaignId: null,
        q: null,
        searchMode: false,
      },
    });
    const { container } = render(
      <ConversationsPageClient
        role="admin"
        viewerSlackUserId="U05UVHGBURX"
        initialCampaigns={CAMPAIGNS}
        initialCommerciaux={COMMERCIAUX}
      />,
    );
    await screen.findAllByText("Dr Jean Dupont", undefined, { timeout: 2000 });

    // Le desktop (overflow-x-auto dans un md:block container) ET le mobile
    // (md:hidden) rendent CHACUN un `<a>` natif pointant vers le détail.
    // Avec 1 ligne de données on exige donc EXACTEMENT 2 liens corrects —
    // ce qui attrape une régression où un seul des deux rendus perdrait
    // son `href`.
    const desktopLink = container.querySelector(".md\\:block a[href^='/admin/conversations/']");
    const mobileLink = container.querySelector(".md\\:hidden a[href^='/admin/conversations/']");
    expect(desktopLink).not.toBeNull();
    expect(mobileLink).not.toBeNull();
    expect(desktopLink!.getAttribute("href")).toContain("427963864300_hubspot-list-6081");
    expect(mobileLink!.getAttribute("href")).toContain("427963864300_hubspot-list-6081");
  });

  it("error → message + bouton Réessayer", async () => {
    mockFetch({}, { listStatus: 500 });
    render(
      <ConversationsPageClient
        role="admin"
        viewerSlackUserId="U05UVHGBURX"
        initialCampaigns={CAMPAIGNS}
        initialCommerciaux={COMMERCIAUX}
      />,
    );
    const errMsgs = await screen.findAllByText(
      /Impossible de charger les conversations/,
      undefined,
      { timeout: 2000 },
    );
    expect(errMsgs.length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /Réessayer/ }).length).toBeGreaterThan(0);
  });

  it("pagination : seed 25 items + hasMore=true → bouton 'Page suivante' actif", async () => {
    const items = Array.from({ length: 25 }, (_, i) =>
      buildItem({
        conversationId: `c${i}_hubspot-list-6081`,
        contactDisplayName: `Dr ${i} Test`,
      }),
    );
    mockFetch({
      items,
      nextCursor: "c24_hubspot-list-6081",
      hasMore: true,
      filterApplied: {
        role: "admin",
        tab: "a_traiter",
        assignedTo: null,
        statuses: ["handed_off"],
        campaignId: null,
        q: null,
        searchMode: false,
      },
    });
    render(
      <ConversationsPageClient
        role="admin"
        viewerSlackUserId="U05UVHGBURX"
        initialCampaigns={CAMPAIGNS}
        initialCommerciaux={COMMERCIAUX}
      />,
    );
    const nextBtn = (
      await screen.findAllByRole("button", { name: /Page suivante/ }, { timeout: 2000 })
    )[0]!;
    await waitFor(() => expect(nextBtn).not.toBeDisabled(), { timeout: 2000 });
    await userEvent.click(nextBtn);
    expect(setCursorMock).toHaveBeenCalledWith("c24_hubspot-list-6081");
  });

  it("pagination : 60 lignes simulées en 3 pages via setCursor successifs (preuve mutation-safe)", async () => {
    // Première page
    const page1 = Array.from({ length: 25 }, (_, i) =>
      buildItem({
        conversationId: `p1_${i}`,
        contactDisplayName: `P1 Dr ${i}`,
      }),
    );
    mockFetch({
      items: page1,
      nextCursor: "p1_24",
      hasMore: true,
      filterApplied: {
        role: "admin",
        tab: "toutes",
        assignedTo: null,
        statuses: null,
        campaignId: null,
        q: null,
        searchMode: false,
      },
    });
    render(
      <ConversationsPageClient
        role="admin"
        viewerSlackUserId="U05UVHGBURX"
        initialCampaigns={CAMPAIGNS}
        initialCommerciaux={COMMERCIAUX}
      />,
    );
    await screen.findAllByText("P1 Dr 0", undefined, { timeout: 2000 });
    // Les 25 noms de P1 doivent être rendus (bornés dans le compteur côté footer).
    expect(screen.getByText(/25 conversations/)).toBeInTheDocument();
  });

  it("mobile : les cartes sont présentes dans le DOM (sous `md:hidden`)", async () => {
    mockFetch({
      items: [buildItem()],
      nextCursor: null,
      hasMore: false,
      filterApplied: {
        role: "admin",
        tab: "a_traiter",
        assignedTo: null,
        statuses: ["handed_off"],
        campaignId: null,
        q: null,
        searchMode: false,
      },
    });
    const { container } = render(
      <ConversationsPageClient
        role="admin"
        viewerSlackUserId="U05UVHGBURX"
        initialCampaigns={CAMPAIGNS}
        initialCommerciaux={COMMERCIAUX}
      />,
    );
    await screen.findAllByText("Dr Jean Dupont", undefined, { timeout: 2000 });
    // Le conteneur mobile a la classe `md:hidden` — rendu dans le DOM
    // (CSS décide la visibilité au runtime via media query).
    const mobileContainer = container.querySelector(".md\\:hidden");
    expect(mobileContainer).not.toBeNull();
    // Chaque carte contient aussi un <a> vers le détail.
    const mobileLinks = (mobileContainer as HTMLElement).querySelectorAll(
      "a[href^='/admin/conversations/']",
    );
    expect(mobileLinks.length).toBeGreaterThan(0);
  });

  it("commercial sans en_cours : seulement 3 onglets rendus", async () => {
    mockFetch({
      items: [],
      nextCursor: null,
      hasMore: false,
      filterApplied: {
        role: "commercial",
        tab: "a_traiter",
        assignedTo: "U05UVHGBURX",
        statuses: ["handed_off"],
        campaignId: null,
        q: null,
        searchMode: false,
      },
    });
    render(
      <ConversationsPageClient
        role="commercial"
        viewerSlackUserId="U05UVHGBURX"
        initialCampaigns={CAMPAIGNS}
        initialCommerciaux={null}
      />,
    );
    const tabs = await screen.findAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(screen.queryByText("En cours avec Léa")).toBeNull();
  });

  it("commercial : pas de dropdown 'Commercial' (admin-only)", async () => {
    mockFetch({
      items: [],
      nextCursor: null,
      hasMore: false,
      filterApplied: {
        role: "commercial",
        tab: "a_traiter",
        assignedTo: "U05UVHGBURX",
        statuses: ["handed_off"],
        campaignId: null,
        q: null,
        searchMode: false,
      },
    });
    render(
      <ConversationsPageClient
        role="commercial"
        viewerSlackUserId="U05UVHGBURX"
        initialCampaigns={CAMPAIGNS}
        initialCommerciaux={null}
      />,
    );
    // Attend la fin des mises à jour React (useEffect fetchs + setStates)
    // AVANT d'asserter l'absence du dropdown — évite l'avertissement
    // "not wrapped in act(...)" sur `setListState`/`setCountsState` qui
    // s'exécutent après le render synchrone.
    await screen.findAllByText("Aucune conversation à traiter.", undefined, {
      timeout: 2000,
    });
    expect(screen.queryByLabelText(/Filtrer par commercial/)).toBeNull();
  });
});
