/**
 * Tests purs `resolveFilterLabel` — helper partagé PR2b-2 P1.
 *
 * Objectif : prouver qu'un identifiant technique (slackUserId, listId)
 * n'est JAMAIS retourné comme libellé affiché, même quand la liste source
 * est null ou que la value est absente de la liste. Mutation testing :
 * remplacer `display: nameOf(match)` par `display: value` doit casser.
 */
import { describe, expect, it } from "vitest";

import { resolveFilterLabel } from "./filter-value-label";

interface Commercial {
  slackUserId: string;
  name: string;
}

const COMMERCIAUX: Commercial[] = [
  { slackUserId: "U05UVHGBURX", name: "Déthié Faye" },
  { slackUserId: "U01DPF08TQV", name: "Harry Lambert" },
];

const BASE = {
  items: COMMERCIAUX,
  keyOf: (c: Commercial) => c.slackUserId,
  nameOf: (c: Commercial) => c.name,
  allLabel: "Tous les commerciaux",
  unknownLabel: "Commercial inconnu",
};

describe("resolveFilterLabel", () => {
  it("value=null → allLabel (known=true)", () => {
    const r = resolveFilterLabel({ ...BASE, value: null });
    expect(r).toEqual({ display: "Tous les commerciaux", known: true });
  });

  it('value="" → allLabel', () => {
    expect(resolveFilterLabel({ ...BASE, value: "" }).display).toBe("Tous les commerciaux");
  });

  it('value="__all__" (sentinelle par défaut) → allLabel', () => {
    expect(resolveFilterLabel({ ...BASE, value: "__all__" }).known).toBe(true);
    expect(resolveFilterLabel({ ...BASE, value: "__all__" }).display).toBe("Tous les commerciaux");
  });

  it("sentinelle personnalisée respectée (allSentinel='*')", () => {
    const r = resolveFilterLabel({ ...BASE, value: "*", allSentinel: "*" });
    expect(r).toEqual({ display: "Tous les commerciaux", known: true });
  });

  it("value connue → libellé humain (known=true), JAMAIS l'identifiant", () => {
    const r = resolveFilterLabel({ ...BASE, value: "U05UVHGBURX" });
    expect(r).toEqual({ display: "Déthié Faye", known: true });
    // Preuve mutation : si l'implémentation retournait la value brute,
    // ce test tomberait.
    expect(r.display).not.toBe("U05UVHGBURX");
    expect(r.display).not.toMatch(/^U[A-Z0-9]+$/);
  });

  it("value inconnue dans la liste → unknownLabel + known=false", () => {
    const r = resolveFilterLabel({ ...BASE, value: "UDELETED42" });
    expect(r).toEqual({ display: "Commercial inconnu", known: false });
    expect(r.display).not.toBe("UDELETED42");
  });

  it("items=null (Airtable down) + value définie → allLabel + known=true (évite 'Retirer' alors que le Select est disabled)", () => {
    const r = resolveFilterLabel({
      ...BASE,
      items: null,
      value: "U05UVHGBURX",
      allLabel: "Indisponible (Airtable)",
    });
    expect(r.known).toBe(true);
    expect(r.display).toBe("Indisponible (Airtable)");
    expect(r.display).not.toBe("U05UVHGBURX");
  });

  it("items=null + value vide → allLabel (prioritaire)", () => {
    const r = resolveFilterLabel({ ...BASE, items: null, value: null });
    expect(r.known).toBe(true);
    expect(r.display).toBe("Tous les commerciaux");
  });

  it("fonctionne pour un type arbitraire (campagne HubSpot)", () => {
    interface Campaign {
      listId: string;
      name: string;
    }
    const r = resolveFilterLabel<Campaign>({
      value: "6081",
      items: [{ listId: "6081", name: "SMS Dentistes IDF" }],
      keyOf: (c) => c.listId,
      nameOf: (c) => c.name,
      allLabel: "Toutes les campagnes",
      unknownLabel: "Campagne inconnue",
    });
    expect(r.display).toBe("SMS Dentistes IDF");
    expect(r.display).not.toMatch(/^hubspot-list-/);
    expect(r.display).not.toBe("6081");
  });

  it("value identique au contenu de allSentinel par défaut mais items la contient aussi → items gagne (edge)", () => {
    // Garde-fou documentaire : le shortcut `__all__` est reconnu AVANT la
    // recherche dans items. Un item avec key "__all__" serait masqué par
    // la sentinelle. Les callers doivent choisir une sentinelle qui ne
    // peut jamais être une vraie clé.
    const r = resolveFilterLabel({
      ...BASE,
      items: [{ slackUserId: "__all__", name: "N'arrive jamais" }],
      value: "__all__",
    });
    expect(r.display).toBe("Tous les commerciaux");
  });
});
