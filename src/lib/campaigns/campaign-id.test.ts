/**
 * Tests `campaign-id.ts` — PR2b-2 round 2.
 *
 * Prouve que la résolution d'un nom de campagne fonctionne sur LES DEUX
 * formats (canonique Firestore `hubspot-list-6081` ET court HubSpot
 * `6081`), et que l'id brut n'est jamais retourné en tant que libellé.
 *
 * Mutation testing cibles :
 *   - `toCanonicalCampaignId` retourne l'`input` tel quel sur une entrée
 *     invalide → `rejette un format non reconnu` tombe.
 *   - `extractListId` sans la branche `LIST_ID_PATTERN` → `format court
 *     "6081" → "6081"` tombe.
 *   - `resolveCampaignName` renvoie `campaignId` au lieu de `null` sur
 *     absence → `absent de la map → null (jamais l'id brut)` tombe.
 */
import { describe, expect, it } from "vitest";

import {
  CAMPAIGN_ID_PATTERN,
  CAMPAIGN_ID_PREFIX,
  CAMPAIGN_UNKNOWN_LABEL,
  campaignDisplayLabel,
  extractListId,
  LIST_ID_PATTERN,
  resolveCampaignName,
  toCanonicalCampaignId,
} from "./campaign-id";

describe("constantes de contrat", () => {
  it("CAMPAIGN_ID_PREFIX = 'hubspot-list-' (verrouille le format Firestore)", () => {
    expect(CAMPAIGN_ID_PREFIX).toBe("hubspot-list-");
  });
  it("CAMPAIGN_ID_PATTERN matche exactement 'hubspot-list-{digits}'", () => {
    expect(CAMPAIGN_ID_PATTERN.test("hubspot-list-6081")).toBe(true);
    expect(CAMPAIGN_ID_PATTERN.test("hubspot-list-")).toBe(false);
    expect(CAMPAIGN_ID_PATTERN.test("hubspot-list-6081x")).toBe(false);
    expect(CAMPAIGN_ID_PATTERN.test("hubspot-list-abc")).toBe(false);
    expect(CAMPAIGN_ID_PATTERN.test("6081")).toBe(false);
  });
  it("LIST_ID_PATTERN matche uniquement les chiffres", () => {
    expect(LIST_ID_PATTERN.test("6081")).toBe(true);
    expect(LIST_ID_PATTERN.test("1")).toBe(true);
    expect(LIST_ID_PATTERN.test("hubspot-list-6081")).toBe(false);
    expect(LIST_ID_PATTERN.test("")).toBe(false);
    expect(LIST_ID_PATTERN.test("6081a")).toBe(false);
  });
});

describe("toCanonicalCampaignId", () => {
  it("format canonique → identité", () => {
    expect(toCanonicalCampaignId("hubspot-list-6081")).toBe("hubspot-list-6081");
    expect(toCanonicalCampaignId("hubspot-list-1")).toBe("hubspot-list-1");
  });

  it("format court → canonique", () => {
    expect(toCanonicalCampaignId("6081")).toBe("hubspot-list-6081");
    expect(toCanonicalCampaignId("1")).toBe("hubspot-list-1");
  });

  it("supporte le trim (whitespace tolérance pour l'URL state)", () => {
    expect(toCanonicalCampaignId("  6081  ")).toBe("hubspot-list-6081");
    expect(toCanonicalCampaignId(" hubspot-list-6081\n")).toBe("hubspot-list-6081");
  });

  it("rejette null/undefined/vide → null", () => {
    expect(toCanonicalCampaignId(null)).toBeNull();
    expect(toCanonicalCampaignId(undefined)).toBeNull();
    expect(toCanonicalCampaignId("")).toBeNull();
    expect(toCanonicalCampaignId("   ")).toBeNull();
  });

  it("rejette un format non reconnu → null (jamais l'input tel quel)", () => {
    expect(toCanonicalCampaignId("hubspot-list-abc")).toBeNull();
    expect(toCanonicalCampaignId("list-6081")).toBeNull();
    expect(toCanonicalCampaignId("abc")).toBeNull();
    expect(toCanonicalCampaignId("6081abc")).toBeNull();
  });
});

describe("extractListId", () => {
  it("format court '6081' → '6081'", () => {
    expect(extractListId("6081")).toBe("6081");
  });

  it("format canonique 'hubspot-list-6081' → '6081'", () => {
    expect(extractListId("hubspot-list-6081")).toBe("6081");
  });

  it("null/vide/invalide → null", () => {
    expect(extractListId(null)).toBeNull();
    expect(extractListId(undefined)).toBeNull();
    expect(extractListId("")).toBeNull();
    expect(extractListId("hubspot-list-abc")).toBeNull();
    expect(extractListId("abc")).toBeNull();
  });

  it("round-trip toCanonical ∘ extractListId sur un listId valide = canonique", () => {
    for (const id of ["1", "200", "6081", "999999"]) {
      expect(toCanonicalCampaignId(extractListId(id)!)).toBe(`${CAMPAIGN_ID_PREFIX}${id}`);
    }
  });
});

describe("resolveCampaignName", () => {
  const nameByListId = new Map<string, string>([
    ["6081", "SMS Dentistes IDF"],
    ["200", "SMS Médecins PACA"],
  ]);

  it("format canonique 'hubspot-list-6081' + liste HubSpot → nom", () => {
    expect(resolveCampaignName("hubspot-list-6081", nameByListId)).toBe("SMS Dentistes IDF");
  });

  it("format court '6081' + liste HubSpot → même nom (symétrie formats)", () => {
    expect(resolveCampaignName("6081", nameByListId)).toBe("SMS Dentistes IDF");
  });

  it("campagne vraiment absente de HubSpot → null (JAMAIS l'id brut)", () => {
    const r = resolveCampaignName("hubspot-list-999999", nameByListId);
    expect(r).toBeNull();
    // Mutation testing : si l'implémentation revenait à renvoyer l'input,
    // `r` serait un string et ces assertions tomberaient.
    expect(typeof r).not.toBe("string");
    expect(String(r)).not.toMatch(/hubspot-list-999999/);
  });

  it("format invalide → null", () => {
    expect(resolveCampaignName("hubspot-list-abc", nameByListId)).toBeNull();
    expect(resolveCampaignName("", nameByListId)).toBeNull();
    expect(resolveCampaignName(null, nameByListId)).toBeNull();
  });

  it("map vide → null quel que soit le format", () => {
    const empty = new Map<string, string>();
    expect(resolveCampaignName("hubspot-list-6081", empty)).toBeNull();
    expect(resolveCampaignName("6081", empty)).toBeNull();
  });
});

describe("campaignDisplayLabel — un seul fallback 'Campagne inconnue'", () => {
  const nameByListId = new Map<string, string>([["6081", "SMS Dentistes IDF"]]);

  it("denormalizedName présent → prioritaire (évite round-trip API)", () => {
    expect(
      campaignDisplayLabel("hubspot-list-6081", "SMS Dentistes IDF (copie)", nameByListId),
    ).toBe("SMS Dentistes IDF (copie)");
  });

  it("denormalizedName vide/espaces → tombe sur la résolution HubSpot", () => {
    expect(campaignDisplayLabel("hubspot-list-6081", "", nameByListId)).toBe("SMS Dentistes IDF");
    expect(campaignDisplayLabel("hubspot-list-6081", "   ", nameByListId)).toBe(
      "SMS Dentistes IDF",
    );
    expect(campaignDisplayLabel("hubspot-list-6081", null, nameByListId)).toBe("SMS Dentistes IDF");
  });

  it("format canonique ET format court résolvent le MÊME libellé (symétrie)", () => {
    expect(campaignDisplayLabel("hubspot-list-6081", null, nameByListId)).toBe("SMS Dentistes IDF");
    expect(campaignDisplayLabel("6081", null, nameByListId)).toBe("SMS Dentistes IDF");
  });

  it("campagne absente de HubSpot → 'Campagne inconnue' (pas d'id brut)", () => {
    const r = campaignDisplayLabel("hubspot-list-999999", null, nameByListId);
    expect(r).toBe(CAMPAIGN_UNKNOWN_LABEL);
    expect(r).not.toMatch(/hubspot-list-\d+/);
    expect(r).not.toMatch(/999999/);
  });

  it("campaignId null/invalide + pas de denormalizedName → 'Campagne inconnue'", () => {
    expect(campaignDisplayLabel(null, null, nameByListId)).toBe("Campagne inconnue");
    expect(campaignDisplayLabel("", null, nameByListId)).toBe("Campagne inconnue");
    expect(campaignDisplayLabel("not-a-campaign", null, nameByListId)).toBe("Campagne inconnue");
  });

  it("CAMPAIGN_UNKNOWN_LABEL verrouillé = 'Campagne inconnue' (source unique utilisée partout)", () => {
    expect(CAMPAIGN_UNKNOWN_LABEL).toBe("Campagne inconnue");
  });
});
