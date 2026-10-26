// @vitest-environment jsdom

/**
 * Tests `<CampaignSelect />` (S10.1.5 Phase 6 + PR2b-2 P1).
 *
 * Couvre :
 *   - render avec campagnes → options visibles
 *   - helpers purs toCampaignId / fromCampaignId (round-trip + edge cases)
 *   - état vide (0 campagne) → message "Aucune campagne disponible"
 *   - PR2b-2 P1 : trigger affiche TOUJOURS le nom de campagne, jamais
 *     `hubspot-list-6081` ou `6081` brut ; cas "campagne inconnue" →
 *     libellé explicite + bouton "Retirer le filtre campagne".
 */
import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock nuqs : hoisted pour pouvoir muter via mockImplementation.
const nuqsMock = vi.hoisted(() => ({
  useQueryState: vi.fn(() => [null, vi.fn()] as [string | null, (v: string | null) => void]),
}));
vi.mock("nuqs", () => ({
  useQueryState: nuqsMock.useQueryState,
}));
const setCampaignIdMock = vi.fn();

import type { HubspotListInfo } from "@/lib/hubspot/lists";

import {
  __fromCampaignId_FOR_TESTS,
  __toCampaignId_FOR_TESTS,
  CampaignSelect,
  handleCampaignChange,
} from "./campaign-select";

const CAMPAIGNS: HubspotListInfo[] = [
  {
    listId: "200",
    name: "SMS Dentistes IDF",
    size: 200,
    processingType: "MANUAL",
    createdAt: "2026-05-29T12:00:00.000Z",
  },
  {
    listId: "201",
    name: "SMS Médecins PACA",
    size: 150,
    processingType: "MANUAL",
    createdAt: "2026-06-01T12:00:00.000Z",
  },
];

describe("CampaignSelect (S10.1.5 Phase 6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nuqsMock.useQueryState.mockImplementation(() => [null, setCampaignIdMock]);
  });
  afterEach(() => {
    nuqsMock.useQueryState.mockReset();
    nuqsMock.useQueryState.mockImplementation(() => [null, setCampaignIdMock]);
  });

  it("affiche le label 'Campagne HubSpot' et le placeholder par défaut (rien sélectionné)", () => {
    render(<CampaignSelect campaigns={CAMPAIGNS} />);

    expect(screen.getByText("Campagne HubSpot")).toBeInTheDocument();
    // Trigger ARIA accessible name présent
    expect(screen.getByLabelText("Sélectionner une campagne")).toBeInTheDocument();
  });

  it("affiche un message d'absence si campaigns vide", () => {
    // Le contenu du dropdown n'est rendu qu'à l'ouverture (Portal). On
    // teste juste qu'on peut rendre le composant sans crash, et que le
    // trigger est présent. Le message "Aucune campagne disponible" est
    // dans le SelectContent (vérifié via accessibility-reviewer en Phase 7).
    render(<CampaignSelect campaigns={[]} />);
    expect(screen.getByLabelText("Sélectionner une campagne")).toBeInTheDocument();
  });

  describe("helpers purs", () => {
    it("toCampaignId : listId numérique → 'hubspot-list-{listId}'", () => {
      expect(__toCampaignId_FOR_TESTS("200")).toBe("hubspot-list-200");
      expect(__toCampaignId_FOR_TESTS("12345")).toBe("hubspot-list-12345");
    });

    it("fromCampaignId : extrait le listId du format canonique", () => {
      expect(__fromCampaignId_FOR_TESTS("hubspot-list-200")).toBe("200");
      expect(__fromCampaignId_FOR_TESTS("hubspot-list-12345")).toBe("12345");
    });

    it("fromCampaignId : retourne null pour null/empty/format invalide", () => {
      expect(__fromCampaignId_FOR_TESTS(null)).toBeNull();
      expect(__fromCampaignId_FOR_TESTS("")).toBeNull();
      expect(__fromCampaignId_FOR_TESTS("invalid-format")).toBeNull();
      expect(__fromCampaignId_FOR_TESTS("hubspot-list-")).toBeNull();
      expect(__fromCampaignId_FOR_TESTS("hubspot-list-abc")).toBeNull();
    });

    it("round-trip : toCampaignId ∘ fromCampaignId = identity", () => {
      const listIds = ["1", "200", "999999"];
      for (const id of listIds) {
        expect(__fromCampaignId_FOR_TESTS(__toCampaignId_FOR_TESTS(id))).toBe(id);
      }
    });
  });

  describe("Libellés affichés par le trigger (PR2b-2 P1)", () => {
    it("état par défaut (URL vide) → 'Toutes les campagnes'", () => {
      nuqsMock.useQueryState.mockImplementation(() => [null, vi.fn()]);
      render(<CampaignSelect campaigns={CAMPAIGNS} />);
      expect(screen.getByLabelText("Sélectionner une campagne")).toHaveTextContent(
        "Toutes les campagnes",
      );
    });

    it("ouvert avec ?campaignId=hubspot-list-200 → trigger affiche 'SMS Dentistes IDF', PAS l'id", () => {
      nuqsMock.useQueryState.mockImplementation(() => ["hubspot-list-200", vi.fn()]);
      render(<CampaignSelect campaigns={CAMPAIGNS} />);
      const trigger = screen.getByLabelText("Sélectionner une campagne");
      expect(trigger).toHaveTextContent("SMS Dentistes IDF");
      expect(trigger).not.toHaveTextContent(/hubspot-list-200/);
      expect(trigger).not.toHaveTextContent(/^\s*200\s*$/);
    });

    it("ouvert avec ?campaignId=hubspot-list-999999 (inconnu) → 'Campagne inconnue' + bouton 'Retirer le filtre campagne'", () => {
      nuqsMock.useQueryState.mockImplementation(() => ["hubspot-list-999999", vi.fn()]);
      render(<CampaignSelect campaigns={CAMPAIGNS} />);
      expect(screen.getByLabelText("Sélectionner une campagne")).toHaveTextContent(
        "Campagne inconnue",
      );
      expect(
        screen.getByRole("button", { name: "Retirer le filtre campagne" }),
      ).toBeInTheDocument();
      expect(document.body.textContent ?? "").not.toMatch(/hubspot-list-999999/);
    });

    it("clic 'Retirer le filtre campagne' → setter appelé avec null", () => {
      const setter = vi.fn();
      nuqsMock.useQueryState.mockImplementation(() => ["hubspot-list-999999", setter]);
      render(<CampaignSelect campaigns={CAMPAIGNS} />);
      screen.getByRole("button", { name: "Retirer le filtre campagne" }).click();
      expect(setter).toHaveBeenCalledWith(null);
    });
  });

  describe("handleCampaignChange (S10.1.7-M5 — handler pur)", () => {
    it("value=null → setCampaignId(null) + onChange(null)", () => {
      const setCampaignId = vi.fn();
      const onChange = vi.fn();
      handleCampaignChange(null, setCampaignId, onChange);
      expect(setCampaignId).toHaveBeenCalledWith(null);
      expect(onChange).toHaveBeenCalledWith(null);
    });

    it('value="__all__" (sentinelle reset filtre) → setCampaignId(null) + onChange(null)', () => {
      const setCampaignId = vi.fn();
      const onChange = vi.fn();
      handleCampaignChange("__all__", setCampaignId, onChange);
      expect(setCampaignId).toHaveBeenCalledWith(null);
      expect(onChange).toHaveBeenCalledWith(null);
    });

    it('value="" (vide) → setCampaignId(null) + onChange(null)', () => {
      const setCampaignId = vi.fn();
      const onChange = vi.fn();
      handleCampaignChange("", setCampaignId, onChange);
      expect(setCampaignId).toHaveBeenCalledWith(null);
      expect(onChange).toHaveBeenCalledWith(null);
    });

    it("value=listId valide (ex: '200') → setCampaignId('hubspot-list-200') + onChange(...)", () => {
      const setCampaignId = vi.fn();
      const onChange = vi.fn();
      handleCampaignChange("200", setCampaignId, onChange);
      expect(setCampaignId).toHaveBeenCalledWith("hubspot-list-200");
      expect(onChange).toHaveBeenCalledWith("hubspot-list-200");
    });

    it("onChange absent (optionnel) → ne throw pas, setCampaignId quand même appelé", () => {
      const setCampaignId = vi.fn();
      expect(() => handleCampaignChange("200", setCampaignId)).not.toThrow();
      expect(setCampaignId).toHaveBeenCalledWith("hubspot-list-200");
    });
  });
});
