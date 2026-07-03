/**
 * Tests du helper indemnisation par spécialité (S10.2.3).
 *
 * Couverture 100% requise (cf. vitest.config.ts `src/lib/claude/prompts/**`).
 *
 * Sentinelles :
 *   - Valeurs explicites par spécialité (7×945, 1×792, 1×532, 2×473, 10×fallback).
 *   - Exhaustivité (`it.each` sur les 21 valeurs de `CONTACT_SPECIALITY_VALUES`) :
 *     ne throw jamais, label non vide.
 *   - Longueur : label ≤ 20 chars.
 *   - Charset GSM-7 : whitelist ASCII printable + `€` + accents FR usuels.
 *   - Anti-dérive marketing : aucun label ne contient
 *     ["gratuit","offert","exceptionnel","unique","meilleur","promo","remise"].
 *   - Anti-mensonge : aucun label chiffré ne contient "gratuit"/"offert"
 *     (indemnisé ≠ gratuit).
 *   - Montants : seuls `{945, 792, 532, 473}` autorisés en non-null.
 *   - Pureté du module : le source du helper ne référence aucune lib
 *     `firebase` (defense-in-depth anti-coupling vers le SDK Admin).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CONTACT_SPECIALITY_VALUES } from "@/lib/firestore/contacts";

import { getIndemnisationForSpeciality, type IndemnisationInfo } from "./indemnisation";

const HELPER_SOURCE_PATH = join(__dirname, "indemnisation.ts");

// ─────────────────────────────────────────────────────────────────────────────
// Valeurs explicites par spécialité
// ─────────────────────────────────────────────────────────────────────────────

describe("getIndemnisationForSpeciality — valeurs par spécialité", () => {
  it.each([
    "Médecin",
    "Pédiatre",
    "Psychiatre",
    "Gynécologue",
    "Radiologue",
    "Dermatologue",
    "Médecin vasculaire",
  ] as const)('renvoie 945€/an pour "%s"', (spe) => {
    expect(getIndemnisationForSpeciality(spe)).toEqual<IndemnisationInfo>({
      amount: 945,
      label: "945€/an",
    });
  });

  it('renvoie 792€/an pour "Chirurgien-dentiste"', () => {
    expect(getIndemnisationForSpeciality("Chirurgien-dentiste")).toEqual<IndemnisationInfo>({
      amount: 792,
      label: "792€/an",
    });
  });

  it('renvoie 532€/an pour "MKDE"', () => {
    expect(getIndemnisationForSpeciality("MKDE")).toEqual<IndemnisationInfo>({
      amount: 532,
      label: "532€/an",
    });
  });

  it.each(["IDE", "Infirmier"] as const)('renvoie 473€/an pour "%s"', (spe) => {
    expect(getIndemnisationForSpeciality(spe)).toEqual<IndemnisationInfo>({
      amount: 473,
      label: "473€/an",
    });
  });

  it.each([
    "Sage-Femme",
    "Orthophoniste",
    "Pharmacien",
    "Psychologue",
    "Pédicure-podologue",
    "Assistant(e) dentaire",
    "Aide-soignante",
    "Autre profession paramédicale",
    "Étudiant",
    "Autre",
  ] as const)('renvoie le fallback "100% pris en charge" pour "%s"', (spe) => {
    expect(getIndemnisationForSpeciality(spe)).toEqual<IndemnisationInfo>({
      amount: null,
      label: "100% pris en charge",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sentinelles globales (it.each sur les 21 valeurs)
// ─────────────────────────────────────────────────────────────────────────────

describe("getIndemnisationForSpeciality — sentinelles globales", () => {
  /**
   * GSM-7 only : ASCII printable + `€` + accents FR usuels. Bloque emoji,
   * espace insécable, superlatif typographique, ponctuation exotique.
   */
  const GSM7_LABEL_REGEX = /^[A-Za-z0-9 %€/àâäçèéêëîïôùûüÿÉÀÈ]+$/u;

  /**
   * Mots interdits dans tout label — anti-dérive marketing. Le secteur
   * médical exige du factuel (Bencivenga + compliance AI Act / L.34-5 CPCE).
   */
  const FORBIDDEN_LABEL_WORDS = [
    "gratuit",
    "offert",
    "exceptionnel",
    "unique",
    "meilleur",
    "promo",
    "remise",
  ] as const;

  /**
   * Set des seuls montants non-null tolérés. Toute valeur hors de cet
   * ensemble = régression business non validée (re-validation Déthié + Harry).
   */
  const ALLOWED_AMOUNTS = new Set<number>([945, 792, 532, 473]);

  it.each(CONTACT_SPECIALITY_VALUES)(
    'exhaustivité — "%s" ne throw jamais et renvoie un label non vide',
    (spe) => {
      const info = getIndemnisationForSpeciality(spe);
      expect(info).toBeDefined();
      expect(typeof info.label).toBe("string");
      expect(info.label.length).toBeGreaterThan(0);
    },
  );

  it.each(CONTACT_SPECIALITY_VALUES)('longueur — label pour "%s" ≤ 20 chars', (spe) => {
    const { label } = getIndemnisationForSpeciality(spe);
    expect(label.length).toBeLessThanOrEqual(20);
  });

  it.each(CONTACT_SPECIALITY_VALUES)(
    'charset GSM-7 — label pour "%s" matche le whitelist regex',
    (spe) => {
      const { label } = getIndemnisationForSpeciality(spe);
      expect(label).toMatch(GSM7_LABEL_REGEX);
    },
  );

  it.each(CONTACT_SPECIALITY_VALUES)(
    'anti-dérive marketing — label pour "%s" ne contient aucun terme banni',
    (spe) => {
      const { label } = getIndemnisationForSpeciality(spe);
      const lower = label.toLowerCase();
      for (const forbidden of FORBIDDEN_LABEL_WORDS) {
        expect(lower).not.toContain(forbidden);
      }
    },
  );

  it("montants — seules les valeurs {945, 792, 532, 473} sont autorisées en non-null", () => {
    for (const spe of CONTACT_SPECIALITY_VALUES) {
      const { amount } = getIndemnisationForSpeciality(spe);
      if (amount !== null) {
        expect(ALLOWED_AMOUNTS.has(amount)).toBe(true);
      }
    }
  });

  it("anti-mensonge — aucun label chiffré ne contient 'gratuit' ou 'offert' (indemnisé ≠ gratuit)", () => {
    for (const spe of CONTACT_SPECIALITY_VALUES) {
      const { amount, label } = getIndemnisationForSpeciality(spe);
      if (amount !== null) {
        const lower = label.toLowerCase();
        expect(lower).not.toContain("gratuit");
        expect(lower).not.toContain("offert");
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pureté du module — sentinelle anti-coupling (defense-in-depth)
// ─────────────────────────────────────────────────────────────────────────────

describe("indemnisation.ts — pureté du module", () => {
  it("le source du helper ne référence aucune lib `firebase` (anti-coupling SDK Admin)", () => {
    const source = readFileSync(HELPER_SOURCE_PATH, "utf-8");
    expect(source).not.toMatch(/firebase/i);
  });
});
