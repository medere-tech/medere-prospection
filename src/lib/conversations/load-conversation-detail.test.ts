/**
 * Tests PR1.14.2 — `computeViewerIsOwner` (fix S5 bug applicatif).
 *
 * Avant le fix : `viewerIsOwner: isAdmin || (…)` — un admin sans
 * slackUserId était faussement marqué owner, cachant la bannière
 * « Mode admin » sur une conv qu'il ne suit pas.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/campaigns/campaigns-cache", () => ({
  getCachedSmsCampaigns: vi.fn(),
  campaignNameByListIdFrom: (list: Array<{ listId: string; name: string }>) => {
    const m = new Map<string, string>();
    for (const c of list) m.set(c.listId, c.name);
    return m;
  },
}));

vi.mock("@/lib/utils/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getCachedSmsCampaigns } from "@/lib/campaigns/campaigns-cache";

import { computeViewerIsOwner, resolveCampaignNameServerSide } from "./load-conversation-detail";

const mockGetCachedSmsCampaigns = vi.mocked(getCachedSmsCampaigns);

describe("computeViewerIsOwner — fix S5", () => {
  it("admin SANS slackUserId sur conv assignée → false (jamais owner)", () => {
    expect(computeViewerIsOwner(undefined, "U05UVHGBURX")).toBe(false);
  });

  it("admin avec slackUserId === assignedToSlack → true (vraiment titulaire)", () => {
    expect(computeViewerIsOwner("U05UVHGBURX", "U05UVHGBURX")).toBe(true);
  });

  it("admin avec slackUserId !== assignedToSlack → false (observe une conv d'un autre)", () => {
    expect(computeViewerIsOwner("UAUTRE1234", "U05UVHGBURX")).toBe(false);
  });

  it("admin avec slackUserId sur conv SANS handoff (null) → false", () => {
    expect(computeViewerIsOwner("U05UVHGBURX", null)).toBe(false);
  });

  it("commercial titulaire (slackUserId === assignedToSlack) → true", () => {
    expect(computeViewerIsOwner("UCOMMERCIAL", "UCOMMERCIAL")).toBe(true);
  });

  it("commercial non-titulaire (slackUserId !== assignedToSlack) → false", () => {
    // Ne devrait pas arriver (bloqué 403 en amont), mais fail-safe.
    expect(computeViewerIsOwner("UCOMMERCIAL", "UDIFFERENT")).toBe(false);
  });

  it("viewer undefined + handoff null → false (double absence)", () => {
    expect(computeViewerIsOwner(undefined, null)).toBe(false);
  });

  // SENTINELLE régression S5 — formulation du cas réel qui a cassé.
  it("REGRESSION S5 — e2e-admin (slackUserId undefined) sur A (assignée U05UVHGBURX) → false → bannière Mode admin AFFICHÉE", () => {
    const result = computeViewerIsOwner(undefined, "U05UVHGBURX");
    expect(result, "si true, bannière Mode admin cachée pour un admin non-titulaire (bug S5)").toBe(
      false,
    );
  });
});

/**
 * Durcissement PR1.14.2 (2026-10-23) — règle stricte « deux chaînes non
 * vides et égales ». Les 7 cas listés par Déthié pour verrouiller
 * tout retour accidentel de `true` sur une absence.
 */
describe("computeViewerIsOwner — règle stricte (deux chaînes non vides et égales)", () => {
  it("(undefined, undefined) → false", () => {
    expect(computeViewerIsOwner(undefined, undefined)).toBe(false);
  });
  it("(null, null) → false", () => {
    expect(computeViewerIsOwner(null, null)).toBe(false);
  });
  it("(undefined, null) → false", () => {
    expect(computeViewerIsOwner(undefined, null)).toBe(false);
  });
  it('("", "") → false — PROTÈGE le cas pervers de la double absence stringifiée', () => {
    expect(computeViewerIsOwner("", "")).toBe(false);
  });
  it('(undefined, "U123") → false', () => {
    expect(computeViewerIsOwner(undefined, "U123")).toBe(false);
  });
  it('("U123", null) → false', () => {
    expect(computeViewerIsOwner("U123", null)).toBe(false);
  });
  it('("U123", "U123") → true — SEUL cas qui doit matcher', () => {
    expect(computeViewerIsOwner("U123", "U123")).toBe(true);
  });

  // Compléments défensifs (asymétries)
  it('("", "U123") → false (viewer vide)', () => {
    expect(computeViewerIsOwner("", "U123")).toBe(false);
  });
  it('("U123", "") → false (assigné vide)', () => {
    expect(computeViewerIsOwner("U123", "")).toBe(false);
  });
});

/**
 * Tests `resolveCampaignNameServerSide` — PR2b-2 round 3 R3-P1.
 *
 * Verrouille la cascade :
 *   1) copie dénormalisée Firestore → identité,
 *   2) sinon cache HubSpot → nom résolu,
 *   3) sinon null (jamais l'id brut).
 *
 * Mutation testing : retirer la branche cache HubSpot ferait tomber le
 * cas "campaignName absent mais présent côté HubSpot → nom résolu". Le
 * défaut production R3 est exactement ce cas (A sans campaignName
 * dénormalisé mais hubspot-list-6081 dans HubSpot).
 */
describe("resolveCampaignNameServerSide (R3-P1)", () => {
  const CAMPAIGNS = [
    {
      listId: "6081",
      name: "SMS Dentistes IDF",
      size: 10,
      processingType: "MANUAL",
      createdAt: "2026-05-29T12:00:00.000Z",
    },
  ];

  beforeEach(() => {
    mockGetCachedSmsCampaigns.mockReset();
  });

  it("campaignName dénormalisé présent → identité (évite round-trip HubSpot)", async () => {
    const name = await resolveCampaignNameServerSide("hubspot-list-6081", "Nom cache figé");
    expect(name).toBe("Nom cache figé");
    expect(mockGetCachedSmsCampaigns).not.toHaveBeenCalled();
  });

  it("campaignName dénormalisé vide → trim+fallback cache HubSpot", async () => {
    mockGetCachedSmsCampaigns.mockResolvedValue(CAMPAIGNS);
    const name = await resolveCampaignNameServerSide("hubspot-list-6081", "   ");
    expect(name).toBe("SMS Dentistes IDF");
  });

  it("REGRESSION R3-P1 — campaignName undefined (cas A réel) + id dans HubSpot → vrai nom résolu", async () => {
    mockGetCachedSmsCampaigns.mockResolvedValue(CAMPAIGNS);
    const name = await resolveCampaignNameServerSide("hubspot-list-6081", undefined);
    expect(name).toBe("SMS Dentistes IDF");
    expect(name).not.toMatch(/hubspot-list-/);
  });

  it("campaignName absent + id absent de HubSpot → null (jamais l'id brut)", async () => {
    mockGetCachedSmsCampaigns.mockResolvedValue(CAMPAIGNS);
    const name = await resolveCampaignNameServerSide("hubspot-list-999999", undefined);
    expect(name).toBeNull();
  });

  it("HubSpot down (cache throw) → null, pas d'exception propagée (dégradation gracieuse)", async () => {
    mockGetCachedSmsCampaigns.mockRejectedValue(new Error("HubSpot 503"));
    const name = await resolveCampaignNameServerSide("hubspot-list-6081", undefined);
    expect(name).toBeNull();
  });

  it("campaignId au format court '6081' est aussi reconnu via le helper central", async () => {
    mockGetCachedSmsCampaigns.mockResolvedValue(CAMPAIGNS);
    const name = await resolveCampaignNameServerSide("6081", undefined);
    expect(name).toBe("SMS Dentistes IDF");
  });
});
