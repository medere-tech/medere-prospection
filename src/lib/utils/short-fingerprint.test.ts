/**
 * Tests `short-fingerprint.ts` — djb2 hash 8 chars hex.
 *
 * Couverture : format de sortie, déterminisme, sensibilité aux modifs,
 * cas edge (empty string, unicode). Pas d'assertion de valeurs hex figées
 * pour ne pas coupler les tests à une révision d'algo future — on teste
 * le CONTRAT (format + propriétés), pas l'output précis.
 */
import { describe, expect, it } from "vitest";

import { shortFingerprint } from "./short-fingerprint";

describe("shortFingerprint — format de sortie", () => {
  it("retourne EXACTEMENT 8 chars hex", () => {
    const out = shortFingerprint("MEDERE");
    expect(out).toMatch(/^[0-9a-f]{8}$/);
    expect(out).toHaveLength(8);
  });

  it("préserve le format 8 chars sur input court (padding zéros à gauche)", () => {
    // Un input très court peut produire un hash "petit" nécessitant
    // padding. On vérifie qu'on obtient bien 8 chars même dans ce cas.
    const out = shortFingerprint("a");
    expect(out).toHaveLength(8);
    expect(out).toMatch(/^[0-9a-f]{8}$/);
  });

  it("préserve le format 8 chars sur input long (E.164 12 chars)", () => {
    const out = shortFingerprint("+33939070545");
    expect(out).toHaveLength(8);
    expect(out).toMatch(/^[0-9a-f]{8}$/);
  });

  it("empty string retourne '00001505' (djb2 initial 5381 → hex)", () => {
    // Cas edge documenté dans le JSDoc — le caller est responsable de
    // valider si un empty check est requis. Le test sert de sentinelle
    // documentaire (si on change l'algo, l'edge doit rester géré).
    expect(shortFingerprint("")).toBe("00001505");
  });
});

describe("shortFingerprint — déterminisme", () => {
  it("input identique → output identique (pure function)", () => {
    const a = shortFingerprint("MEDERE");
    const b = shortFingerprint("MEDERE");
    expect(a).toBe(b);
  });

  it("input identique appelé 100× → même output (stabilité)", () => {
    const outputs = new Set<string>();
    for (let i = 0; i < 100; i++) outputs.add(shortFingerprint("+33939070545"));
    expect(outputs.size).toBe(1);
  });
});

describe("shortFingerprint — sensibilité", () => {
  it("inputs différents → fingerprints différents (basique, pas garantie crypto)", () => {
    // Les 3 sender candidats en prod. Pas de collision attendue avec un
    // hash 32-bit sur si peu de valeurs.
    const a = shortFingerprint("MEDERE");
    const b = shortFingerprint("+33939070545");
    const c = shortFingerprint("DRY_RUN_SENDER");
    const d = shortFingerprint("NESF");
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it("case sensitive : 'medere' ≠ 'MEDERE'", () => {
    expect(shortFingerprint("medere")).not.toBe(shortFingerprint("MEDERE"));
  });

  it("préfixe '+' compte : '33939070545' ≠ '+33939070545'", () => {
    expect(shortFingerprint("33939070545")).not.toBe(shortFingerprint("+33939070545"));
  });
});

describe("shortFingerprint — unicode / edge cases", () => {
  it("gère les caractères non-ASCII (émoji, accents)", () => {
    // Sentinelle : djb2 travaille sur `charCodeAt` qui gère UTF-16 code
    // units. Pas de crash sur unicode.
    const a = shortFingerprint("Léa");
    const b = shortFingerprint("Lea");
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(b).toMatch(/^[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });
});
