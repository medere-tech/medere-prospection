import { describe, expect, it } from "vitest";

import { ADVERTISER_PATTERN, hasAdvertiserIdentification } from "./advertiser-identification";

// ─────────────────────────────────────────────────────────────────────────────
// Sentinelle GUARD-003 — verrouille la valeur exacte du pattern.
// Toute modification (élargissement ou restriction) doit casser ce test
// volontairement. Repasser par compliance-auditor + mettre à jour GUARD-003
// Notion AVANT de toucher au pattern.
// ─────────────────────────────────────────────────────────────────────────────

describe("ADVERTISER_PATTERN — sentinelle GUARD-003", () => {
  it("verrouille la source exacte du pattern (anti-drift)", () => {
    expect(ADVERTISER_PATTERN.source).toBe("m[ée]d[ée]r[ée]");
    expect(ADVERTISER_PATTERN.flags).toBe("i");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Variantes acceptées — toutes combinaisons {é,e}³ × casse libre.
// ─────────────────────────────────────────────────────────────────────────────

describe("hasAdvertiserIdentification — variantes acceptées", () => {
  it("forme canonique 'Médéré' → true", () => {
    expect(hasAdvertiserIdentification("Bonjour, Léa de Médéré pour vous.")).toBe(true);
  });

  it("forme sans accent 'Medere' (strip GSM-7) → true", () => {
    expect(hasAdvertiserIdentification("Bonjour, c'est Medere a l'appareil.")).toBe(true);
  });

  it("forme uppercase 'MEDERE' → true", () => {
    expect(hasAdvertiserIdentification("— L'equipe MEDERE")).toBe(true);
  });

  it("forme mixed-case partiellement accentuée 'Médere' → true", () => {
    expect(hasAdvertiserIdentification("Signe Médere.")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Positions dans le body — n'importe où (la loi n'impose pas de position).
// ─────────────────────────────────────────────────────────────────────────────

describe("hasAdvertiserIdentification — positions dans le body", () => {
  it("mention en fin de message → true", () => {
    expect(
      hasAdvertiserIdentification("Formation DPC gratuite. STOP au 36111. Cordialement, Médéré."),
    ).toBe(true);
  });

  it("mention en début de message → true", () => {
    expect(hasAdvertiserIdentification("Médéré : bonjour, êtes-vous disponible ?")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Anti-typosquatting — fermes les substitutions courantes sur la 6e voyelle
// ou les ajouts de consonnes parasites.
// ─────────────────────────────────────────────────────────────────────────────

describe("hasAdvertiserIdentification — anti-typosquatting", () => {
  it("rejette 'Mederro' (double 'r' parasite) → false", () => {
    expect(hasAdvertiserIdentification("Bonjour de Mederro.")).toBe(false);
  });

  it("rejette 'Medera' (6e voyelle 'a' au lieu de é/e) → false", () => {
    expect(hasAdvertiserIdentification("Bonjour de Medera.")).toBe(false);
  });

  it("rejette 'Médéro' (6e voyelle 'o' au lieu de é/e) → false", () => {
    expect(hasAdvertiserIdentification("Bonjour de Médéro.")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Robustesse linguistique — pas de débordement sur des mots français
// courants susceptibles d'apparaître dans un SMS médical.
// ─────────────────────────────────────────────────────────────────────────────

describe("hasAdvertiserIdentification — robustesse linguistique", () => {
  it("rejette 'Médecin' (mot du lexique médical, 5e lettre 'c' ≠ 'r') → false", () => {
    expect(hasAdvertiserIdentification("Bonjour Médecin, êtes-vous dispo ?")).toBe(false);
  });

  it("rejette un body vide → false", () => {
    expect(hasAdvertiserIdentification("")).toBe(false);
  });
});
