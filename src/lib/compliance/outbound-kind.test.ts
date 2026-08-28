/**
 * Tests de `lib/compliance/outbound-kind.ts` (PR-OUTBOUNDKIND).
 *
 * Couverture exigée : 100 % (CLAUDE.md — `lib/compliance/`).
 *
 * Ces tests verrouillent la POLARITÉ du prédicat. Un seul d'entre eux qui
 * s'inverse et toute la base legacy sort du comptage du plafond L.34-5
 * CPCE, silencieusement.
 */
import { describe, expect, it } from "vitest";

import { countsAgainstCap, DEFAULT_OUTBOUND_KIND } from "./outbound-kind";

describe("countsAgainstCap (PR-OUTBOUNDKIND)", () => {
  it('"solicitation" → compté', () => {
    expect(countsAgainstCap({ outboundKind: "solicitation" })).toBe(true);
  });

  it('"reply" → NON compté (seul cas d\'exclusion)', () => {
    expect(countsAgainstCap({ outboundKind: "reply" })).toBe(false);
  });

  it("🔒 FAIL-CLOSED : champ ABSENT → compté", () => {
    // Le cas qui compte vraiment. Un doc legacy (écrit avant cette PR) ou
    // un futur chemin d'écriture qui aurait oublié de trancher DOIT être
    // comptabilisé. L'exclure serait un sous-comptage du plafond, donc une
    // infraction.
    expect(countsAgainstCap({})).toBe(true);
  });

  it("🔒 FAIL-CLOSED : champ explicitement `undefined` → compté", () => {
    // Distinct du cas précédent : un objet peut porter la clé avec la
    // valeur `undefined` (spread d'un objet partiel, projection). Même
    // traitement.
    expect(countsAgainstCap({ outboundKind: undefined })).toBe(true);
  });

  it("SENTINELLE : DEFAULT_OUTBOUND_KIND === 'solicitation'", () => {
    // Anti-drift. Si quelqu'un bascule ce défaut sur "reply", tous les
    // docs sans le champ sortent du comptage. Ce test casse AVANT que la
    // prod ne parte.
    expect(DEFAULT_OUTBOUND_KIND).toBe("solicitation");
  });

  it("SENTINELLE : le défaut est bien celui appliqué quand le champ manque", () => {
    // Verrouille le LIEN entre la constante et le comportement du prédicat
    // (et pas seulement la valeur de la constante prise isolément).
    expect(countsAgainstCap({})).toBe(countsAgainstCap({ outboundKind: DEFAULT_OUTBOUND_KIND }));
  });
});
