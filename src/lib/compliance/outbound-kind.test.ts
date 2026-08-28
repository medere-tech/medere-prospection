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

import {
  __OUTBOUND_KIND_CAP_REGIME_FOR_TESTS,
  countsAgainstCap,
  countsAsReply,
  DEFAULT_OUTBOUND_KIND,
} from "./outbound-kind";

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

describe("countsAsReply (PR-BARRIERE-2)", () => {
  it('"reply" → est une réponse (compte contre le plafond de VOLUME)', () => {
    expect(countsAsReply({ outboundKind: "reply" })).toBe(true);
  });

  it('"solicitation" → n\'est PAS une réponse', () => {
    expect(countsAsReply({ outboundKind: "solicitation" })).toBe(false);
  });

  it("🔒 champ ABSENT (legacy) → PAS une réponse", () => {
    // Polarité INVERSÉE vs `countsAgainstCap`, et c'est délibéré : pour le
    // plafond de VOLUME, sur-bloquer ferait taire un PS en conversation
    // réelle. Le défaut penche donc vers « ne pas bloquer ».
    expect(countsAsReply({})).toBe(false);
    expect(countsAsReply({ outboundKind: undefined })).toBe(false);
  });

  it("🔒 PARTITION STRICTE : countsAsReply === !countsAgainstCap", () => {
    // Les deux plafonds partitionnent rigoureusement les sortants : tout
    // message compte soit contre le légal, soit contre le volume, jamais
    // les deux, jamais aucun. Si quelqu'un réécrivait `countsAsReply` en
    // `=== "reply"` à la main, un legacy tomberait dans AUCUN plafond.
    for (const m of [
      { outboundKind: "reply" as const },
      { outboundKind: "solicitation" as const },
      {},
      { outboundKind: undefined },
    ]) {
      expect(countsAsReply(m)).toBe(!countsAgainstCap(m));
    }
  });
});

describe("🔒 SENTINELLE de cardinalité MessageOutboundKind (MAJEUR-2)", () => {
  it("l'enum a EXACTEMENT 2 valeurs, chacune rattachée à un plafond", () => {
    // La partition `countsAgainstCap` / `countsAsReply` est une paire de
    // BOOLÉENS : elle n'est exhaustive que pour 2 valeurs. Avec une 3e,
    // celle-ci hériterait silencieusement du régime des RÉPONSES (bornée
    // à 10/24h, hors plafond légal) — or une relance est juridiquement une
    // SOLLICITATION et doit compter contre le 4/30j.
    //
    // La table `OUTBOUND_KIND_CAP_REGIME` casse au COMPILE si l'enum
    // s'étend ; ce test casse au RUNTIME si quelqu'un y ajoute une entrée
    // sans repasser par compliance-auditor.
    expect(Object.keys(__OUTBOUND_KIND_CAP_REGIME_FOR_TESTS)).toEqual(["solicitation", "reply"]);
  });

  it("chaque valeur est cohérente avec le prédicat qui la classe", () => {
    for (const [kind, regime] of Object.entries(__OUTBOUND_KIND_CAP_REGIME_FOR_TESTS)) {
      const m = { outboundKind: kind as keyof typeof __OUTBOUND_KIND_CAP_REGIME_FOR_TESTS };
      expect(countsAgainstCap(m)).toBe(regime === "legal_cap");
      expect(countsAsReply(m)).toBe(regime === "volume_cap");
    }
  });
});
