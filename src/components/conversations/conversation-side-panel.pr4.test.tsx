// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

/**
 * Tests unitaires jsdom — Section hand-off du panneau latéral (PR4 B1).
 *
 * Invariants :
 *   - « Contacté le {date Paris} par {nom} » quand `contactedByName` est posé.
 *   - Date seule quand `contactedByName === null` (pas d'identifiant brut).
 *   - « Annuler le contact » visible seulement si `canUndoContact`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConversationSidePanel } from "./conversation-side-panel";
import type { ConversationDetailProps } from "./types";

const CONV_ID = "427963864300_hubspot-list-999999";

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function baseData(overrides: Partial<ConversationDetailProps> = {}): ConversationDetailProps {
  return {
    conversationId: CONV_ID,
    contactId: "427963864300",
    status: "handed_off",
    intent: "INTERESSE",
    campaignId: "hubspot-list-999999",
    campaignName: "Dentistes IDF",
    createdAtIso: "2026-11-01T09:00:00.000Z",
    updatedAtIso: "2026-11-09T10:00:00.000Z",
    lastInboundAtIso: null,
    lastOutboundAtIso: null,
    inboundCount: 0,
    outboundCount: 1,
    summary: null,
    handoff: {
      assignedToName: "Vanessa Rabba",
      assignedToSlackId: "U_VANESSA",
      assignedAtIso: "2026-11-02T09:00:00.000Z",
      contactedAtIso: "2026-11-09T10:00:00.000Z",
      contactedBy: "user_vanessa",
      contactedByName: "Vanessa Rabba",
    },
    contact: {
      contactId: "427963864300",
      civilite: "Dr",
      firstName: "Dethie",
      lastName: "Faye",
      speciality: "Dentiste",
      city: "Paris",
      optedOut: false,
      phoneLast4: null,
    },
    messages: [],
    journal: [],
    viewerIsOwner: true,
    canMarkContacted: false,
    canUndoContact: false,
    ...overrides,
  };
}

describe("ConversationSidePanel — section hand-off PR4", () => {
  it("affiche « Contacté le … par {nom} » quand contactedByName est posé", () => {
    renderWithQuery(<ConversationSidePanel data={baseData()} onAudited={vi.fn()} />);
    // Le composant utilise `formatDateTimeParis(iso)` — on ne verrouille
    // pas le format exact (local), on vérifie la présence du suffixe.
    expect(screen.getByText(/par Vanessa Rabba/)).toBeInTheDocument();
  });

  it("date SEULE quand contactedByName est null (pas d'identifiant brut)", () => {
    const data = baseData({
      handoff: {
        assignedToName: "Vanessa Rabba",
        assignedToSlackId: "U_VANESSA",
        assignedAtIso: "2026-11-02T09:00:00.000Z",
        contactedAtIso: "2026-11-09T10:00:00.000Z",
        contactedBy: "user_disparu",
        contactedByName: null,
      },
    });
    const { container } = renderWithQuery(
      <ConversationSidePanel data={data} onAudited={vi.fn()} />,
    );
    expect(screen.queryByText(/par /)).toBeNull();
    // Garantie absolue : `user_disparu` (contactedBy brut) n'apparaît
    // NULLE PART dans le DOM.
    expect(container.textContent ?? "").not.toContain("user_disparu");
  });

  it("« Annuler le contact » absent si canUndoContact=false", () => {
    renderWithQuery(<ConversationSidePanel data={baseData()} onAudited={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Annuler le contact/i })).toBeNull();
  });

  it("« Annuler le contact » présent si canUndoContact=true ET onAudited fourni", () => {
    renderWithQuery(
      <ConversationSidePanel data={baseData({ canUndoContact: true })} onAudited={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /Annuler le contact/i })).toBeInTheDocument();
  });

  it("« Annuler le contact » absent sans onAudited (dégradation gracieuse story/tests)", () => {
    renderWithQuery(<ConversationSidePanel data={baseData({ canUndoContact: true })} />);
    expect(screen.queryByRole("button", { name: /Annuler le contact/i })).toBeNull();
  });
});
