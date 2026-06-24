// @vitest-environment jsdom

/**
 * Tests `<ContactsPageClient />` (S10.1.5 Phase 6).
 *
 * Couvre :
 *   - render initial → fetch /api/admin/contacts au mount + loading state
 *   - success → render rows TanStack avec données + count "X contact(s) affiché(s)"
 *   - empty → "Aucun contact trouvé"
 *   - error → message d'erreur lisible
 *   - pagination "Page suivante" → setCursor(nextCursor)
 *   - "Première page" disabled si pas de cursor en URL
 */
import "@testing-library/jest-dom/vitest";

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock nuqs : useQueryState retourne [value, setter] standard.
const setCursorMock = vi.fn();
vi.mock("nuqs", () => ({
  useQueryState: vi.fn((key: string) => {
    if (key === "cursor") return [null, setCursorMock];
    return [null, vi.fn()];
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import type { HubspotListInfo } from "@/lib/hubspot/lists";
import type { Contact } from "@/types/contact";

import { ContactsPageClient } from "./contacts-page-client";

const CAMPAIGNS: HubspotListInfo[] = [
  {
    listId: "200",
    name: "SMS Dentistes IDF",
    size: 200,
    processingType: "MANUAL",
    createdAt: "2026-05-29T12:00:00.000Z",
  },
];

function buildContact(overrides: Partial<Contact> = {}): Contact {
  const now = Timestamp.now();
  return {
    hubspotId: "hs_test_1",
    firstName: "Jean",
    lastName: "Dupont",
    civilite: "Dr",
    speciality: "Chirurgien-dentiste",
    city: "Paris",
    postalCode: "75001",
    email: "jean.dupont@cabinet-test.fr",
    phone: {
      e164: "+33612345678",
      raw: "06 12 34 56 78",
      type: "mobile",
      valid: true,
      lookupAt: now,
    },
    segment: "b2c_mobile_perso",
    bloctelChecked: true,
    bloctelOptOut: false,
    consent: {
      legitimateInterest: "Prospection B2B intérêt légitime documenté",
      optedOut: false,
    },
    enrichment: { source: "hubspot", enrichedAt: now },
    status: "ready",
    campaignId: "hubspot-list-200",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ContactsPageClient (S10.1.5 Phase 6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("render initial → headers + filtres + fetch /api/admin/contacts appelé", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(jsonResponse({ contacts: [], nextCursor: null, hasMore: false }));

    render(<ContactsPageClient initialCampaigns={CAMPAIGNS} />);

    expect(screen.getByRole("heading", { name: "Contacts", level: 1 })).toBeInTheDocument();
    expect(screen.getByLabelText("Sélectionner une campagne")).toBeInTheDocument();
    expect(screen.getByLabelText("Filtrer par statut")).toBeInTheDocument();

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^\/api\/admin\/contacts\?/),
        expect.objectContaining({ signal: expect.anything() }),
      );
    });
  });

  it("success avec contacts → render row(s) + count 'X contacts affichés'", async () => {
    const contact = buildContact({ firstName: "Marie", lastName: "Curie" });
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ contacts: [contact], nextCursor: null, hasMore: false }),
    );

    render(<ContactsPageClient initialCampaigns={CAMPAIGNS} />);

    // S10.1.7-Q1-D : tous les expects dans le MÊME waitFor — re-poll
    // jusqu'à ce que TOUT le sous-arbre settle (row Marie Curie +
    // counter + speciality, ET le setState async interne de
    // DropdownMenuTrigger base-ui dans ActionsCell). Sinon, les
    // expects sync post-waitFor ratent le setState non-drainé
    // → warning "An update to MenuTrigger inside a test was not
    // wrapped in act(...)" en pre-push.
    await waitFor(() => {
      expect(screen.getByText(/Dr Marie Curie/)).toBeInTheDocument();
      expect(screen.getByText(/1 contact affiché/)).toBeInTheDocument();
      expect(screen.getByText(/Chirurgien-dentiste/)).toBeInTheDocument();
    });
  });

  it("empty state → 'Aucun contact trouvé' + suggestion", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ contacts: [], nextCursor: null, hasMore: false }),
    );

    render(<ContactsPageClient initialCampaigns={CAMPAIGNS} />);

    await waitFor(() => {
      expect(screen.getByText(/Aucun contact trouvé pour ces filtres/)).toBeInTheDocument();
    });
  });

  it("error state → message d'erreur avec status + texte api", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ error: { code: "INTERNAL", message: "Firestore down" } }, 500),
    );

    render(<ContactsPageClient initialCampaigns={CAMPAIGNS} />);

    await waitFor(() => {
      expect(screen.getByText(/Impossible de charger les contacts \(500\)/)).toBeInTheDocument();
    });
    expect(screen.getByText("Firestore down")).toBeInTheDocument();
  });

  it("hasMore=true → bouton 'Page suivante' actif, clic appelle setCursor(nextCursor)", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({
        contacts: [buildContact()],
        nextCursor: "hs_next_cursor_xxx",
        hasMore: true,
      }),
    );

    render(<ContactsPageClient initialCampaigns={CAMPAIGNS} />);

    const nextBtn = await screen.findByRole("button", { name: "Page suivante" });
    await waitFor(() => expect(nextBtn).not.toBeDisabled());

    await userEvent.click(nextBtn);
    expect(setCursorMock).toHaveBeenCalledWith("hs_next_cursor_xxx");
  });

  it("hasMore=false → bouton 'Page suivante' disabled", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ contacts: [buildContact()], nextCursor: null, hasMore: false }),
    );

    render(<ContactsPageClient initialCampaigns={CAMPAIGNS} />);

    const nextBtn = await screen.findByRole("button", { name: "Page suivante" });
    await waitFor(() => expect(nextBtn).toBeDisabled());
  });

  it("'Première page' disabled si cursor null en URL", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ contacts: [buildContact()], nextCursor: null, hasMore: false }),
    );

    render(<ContactsPageClient initialCampaigns={CAMPAIGNS} />);

    const firstBtn = await screen.findByRole("button", { name: "Première page" });
    expect(firstBtn).toBeDisabled();
  });

  // ───────────────────────────────────────────────────────────────────────
  // S10.1.7-M2 : couverture pagination + refetch après send success
  // ───────────────────────────────────────────────────────────────────────

  it("'Première page' actif si cursor en URL → clic → setCursor(null)", async () => {
    // Override useQueryState mock : "cursor" retourne une valeur non-null
    const { useQueryState } = await import("nuqs");
    vi.mocked(useQueryState).mockImplementation((key: string) => {
      if (key === "cursor") return ["some-cursor-value", setCursorMock];
      return [null, vi.fn()];
    });

    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ contacts: [buildContact()], nextCursor: null, hasMore: false }),
    );

    render(<ContactsPageClient initialCampaigns={CAMPAIGNS} />);

    const firstBtn = await screen.findByRole("button", { name: "Première page" });
    await waitFor(() => expect(firstBtn).not.toBeDisabled());

    await userEvent.click(firstBtn);
    expect(setCursorMock).toHaveBeenCalledWith(null);
  });

  it("count contact unique → 'X contact affiché' (singulier sans s)", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ contacts: [buildContact()], nextCursor: null, hasMore: false }),
    );

    render(<ContactsPageClient initialCampaigns={CAMPAIGNS} />);

    await waitFor(() => {
      // "1 contact affiché" — singulier (vs pluriel testé plus haut)
      expect(screen.getByText(/^1 contact affiché$/)).toBeInTheDocument();
    });
  });
});
