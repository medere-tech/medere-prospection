import { describe, expect, it } from "vitest";

import { isAllowedSendTime } from "./hours";

/**
 * Helper de lecture : construit un `Date` UTC pour un wallclock Paris attendu.
 * Été FR (mars → octobre) : Paris = UTC+2 → UTC = Paris - 2h.
 * Hiver FR (octobre → mars) : Paris = UTC+1 → UTC = Paris - 1h.
 * On utilise directement des littéraux UTC dans les tests pour rester
 * explicite ; ce helper sert uniquement à documenter le mapping en commentaire.
 */

// Helper pour lire plus rapidement les résultats.
function ok(date: Date): boolean {
  return isAllowedSendTime(date).allowed;
}

// ─────────────────────────────────────────────────────────────────────────────
// L-V — Mardi 12 mai 2026 (UTC+2 été)
// ─────────────────────────────────────────────────────────────────────────────

describe("isAllowedSendTime — semaine mardi (matin)", () => {
  it("10h00 Paris pile → autorisé", () => {
    expect(ok(new Date("2026-05-12T08:00:00Z"))).toBe(true);
  });
  it("11h00 Paris → autorisé", () => {
    expect(ok(new Date("2026-05-12T09:00:00Z"))).toBe(true);
  });
  it("12h59 Paris → autorisé", () => {
    expect(ok(new Date("2026-05-12T10:59:00Z"))).toBe(true);
  });
  it("13h00 PILE Paris → REFUSÉ (pause)", () => {
    expect(ok(new Date("2026-05-12T11:00:00Z"))).toBe(false);
  });
  it("13h30 Paris → REFUSÉ", () => {
    expect(ok(new Date("2026-05-12T11:30:00Z"))).toBe(false);
  });
  it("13h59 Paris → REFUSÉ (encore pause)", () => {
    expect(ok(new Date("2026-05-12T11:59:00Z"))).toBe(false);
  });
  it("9h59 Paris → REFUSÉ (trop tôt)", () => {
    expect(ok(new Date("2026-05-12T07:59:00Z"))).toBe(false);
  });
});

describe("isAllowedSendTime — semaine mardi (après-midi)", () => {
  it("14h00 Paris PILE → autorisé (reprise)", () => {
    expect(ok(new Date("2026-05-12T12:00:00Z"))).toBe(true);
  });
  it("17h30 Paris → autorisé", () => {
    expect(ok(new Date("2026-05-12T15:30:00Z"))).toBe(true);
  });
  it("19h59 Paris → autorisé", () => {
    expect(ok(new Date("2026-05-12T17:59:00Z"))).toBe(true);
  });
  it("20h00 PILE Paris → REFUSÉ (trop tard)", () => {
    expect(ok(new Date("2026-05-12T18:00:00Z"))).toBe(false);
  });
  it("20h30 Paris → REFUSÉ", () => {
    expect(ok(new Date("2026-05-12T18:30:00Z"))).toBe(false);
  });
  it("reason mentionne l'heure et la plage L-V", () => {
    const r = isAllowedSendTime(new Date("2026-05-12T18:30:00Z"));
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/L-V/);
    expect(r.reason).toMatch(/20h30/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Samedi 16 mai 2026 (UTC+2 été)
// ─────────────────────────────────────────────────────────────────────────────

describe("isAllowedSendTime — samedi", () => {
  it("10h00 Paris → autorisé (samedi 10-13h)", () => {
    expect(ok(new Date("2026-05-16T08:00:00Z"))).toBe(true);
  });
  it("11h00 Paris → autorisé", () => {
    expect(ok(new Date("2026-05-16T09:00:00Z"))).toBe(true);
  });
  it("12h59 Paris → autorisé", () => {
    expect(ok(new Date("2026-05-16T10:59:00Z"))).toBe(true);
  });
  it("13h00 PILE Paris → REFUSÉ", () => {
    expect(ok(new Date("2026-05-16T11:00:00Z"))).toBe(false);
  });
  it("14h00 Paris → REFUSÉ (pas d'après-midi samedi)", () => {
    expect(ok(new Date("2026-05-16T12:00:00Z"))).toBe(false);
  });
  it("9h59 Paris → REFUSÉ", () => {
    expect(ok(new Date("2026-05-16T07:59:00Z"))).toBe(false);
  });
  it("reason samedi hors plage mentionne 'Samedi'", () => {
    const r = isAllowedSendTime(new Date("2026-05-16T12:00:00Z"));
    expect(r.reason).toMatch(/Samedi/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dimanche 17 mai 2026
// ─────────────────────────────────────────────────────────────────────────────

describe("isAllowedSendTime — dimanche (JAMAIS)", () => {
  it("dimanche 11h Paris → REFUSÉ", () => {
    expect(ok(new Date("2026-05-17T09:00:00Z"))).toBe(false);
  });
  it("dimanche 15h Paris → REFUSÉ", () => {
    expect(ok(new Date("2026-05-17T13:00:00Z"))).toBe(false);
  });
  it("dimanche 19h Paris → REFUSÉ", () => {
    expect(ok(new Date("2026-05-17T17:00:00Z"))).toBe(false);
  });
  it("reason mentionne 'Dimanche'", () => {
    const r = isAllowedSendTime(new Date("2026-05-17T09:00:00Z"));
    expect(r.reason).toMatch(/Dimanche/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Jours fériés FR
// ─────────────────────────────────────────────────────────────────────────────

describe("isAllowedSendTime — jours fériés FR", () => {
  it("1er mai 2026 (vendredi, Fête du Travail) → REFUSÉ", () => {
    expect(ok(new Date("2026-05-01T09:00:00Z"))).toBe(false);
  });
  it("14 juillet 2026 (mardi, Fête nationale) → REFUSÉ", () => {
    expect(ok(new Date("2026-07-14T09:00:00Z"))).toBe(false);
  });
  it("25 décembre 2026 (vendredi, Noël) → REFUSÉ", () => {
    // UTC+1 en hiver : 10:00 UTC = 11:00 Paris.
    expect(ok(new Date("2026-12-25T10:00:00Z"))).toBe(false);
  });

  it("FÉRIÉ qui tombe un SAMEDI 11h Paris → REFUSÉ (férié l'emporte)", () => {
    // 15 août 2026 (Assomption) tombe un samedi. Sans le férié, samedi 11h
    // serait autorisé — mais le férié prend la priorité.
    expect(ok(new Date("2026-08-15T09:00:00Z"))).toBe(false);
  });

  it("reason mentionne 'Jour férié' + date ISO", () => {
    const r = isAllowedSendTime(new Date("2026-07-14T09:00:00Z"));
    expect(r.reason).toMatch(/Jour férié/);
    expect(r.reason).toContain("2026-07-14");
  });

  it("2027 férié (1er janvier) → REFUSÉ (preuve hardcoding 2027)", () => {
    expect(ok(new Date("2027-01-01T10:00:00Z"))).toBe(false);
  });

  it("Lendemain d'un férié (2 mai 2026, samedi normal) → samedi 11h OK", () => {
    expect(ok(new Date("2026-05-02T09:00:00Z"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Heure d'hiver (UTC+1)
// ─────────────────────────────────────────────────────────────────────────────

describe("isAllowedSendTime — heure d'hiver UTC+1", () => {
  it("mardi 1er décembre 2026 11h Paris (= 10h UTC) → autorisé", () => {
    expect(ok(new Date("2026-12-01T10:00:00Z"))).toBe(true);
  });
  it("mardi 1er décembre 2026 9h59 Paris (= 8h59 UTC) → REFUSÉ", () => {
    expect(ok(new Date("2026-12-01T08:59:00Z"))).toBe(false);
  });
  it("mardi 1er décembre 2026 13h00 PILE Paris (= 12h UTC) → REFUSÉ", () => {
    expect(ok(new Date("2026-12-01T12:00:00Z"))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bascule de jour (UTC tardif ≠ Paris du lendemain)
// ─────────────────────────────────────────────────────────────────────────────

describe("isAllowedSendTime — bascule UTC → Paris (cross-day)", () => {
  it("mardi 12 mai 2026 22h30 UTC = mercredi 00h30 Paris → REFUSÉ", () => {
    // Le compliance Paris est mercredi 00:30 (hors plage L-V).
    expect(ok(new Date("2026-05-12T22:30:00Z"))).toBe(false);
  });

  it("samedi 16 mai 2026 23h UTC = dimanche 01h Paris → REFUSÉ (dimanche)", () => {
    expect(ok(new Date("2026-05-16T23:00:00Z"))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fail-safe MAX_VERIFIED_HOLIDAYS_YEAR (audit S4 ÉLEVÉ #2)
// Tant que FRENCH_HOLIDAYS n'a pas été étendu, on refuse toute date au-delà
// de l'année vérifiée. Sinon risque d'envoi un jour férié non répertorié.
// ─────────────────────────────────────────────────────────────────────────────

describe("isAllowedSendTime — fail-safe année > MAX_VERIFIED_HOLIDAYS_YEAR", () => {
  it("1er janvier 2028 (théoriquement samedi 10h-13h OK) → REFUSÉ avec reason actionnable", () => {
    // Sans le fail-safe, 1er janvier 2028 (samedi) à 11h Paris serait
    // autorisé puisque FRENCH_HOLIDAYS ne contient pas 2028-01-01.
    // → c'est exactement le cas de fuite que le fail-safe protège.
    const r = isAllowedSendTime(new Date("2028-01-01T10:00:00Z"));
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("holidays_not_verified_after_2027");
  });

  it("mardi 14 mars 2028 11h Paris (jour théoriquement OK) → REFUSÉ par fail-safe", () => {
    // 14 mars 2028 = mardi. Sans fail-safe, 11h Paris L-V serait autorisé.
    // Le fail-safe le refuse et oriente le dev vers la mise à jour.
    const r = isAllowedSendTime(new Date("2028-03-14T10:00:00Z"));
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("holidays_not_verified_after_2027");
  });

  it("31 décembre 2027 (dernière année vérifiée) → analyse normale", () => {
    // 2027-12-31 = vendredi. Pas dans FRENCH_HOLIDAYS. 11h Paris → autorisé.
    // Garantit que la borne MAX est INCLUSIVE (2027 OK, 2028 KO).
    const r = isAllowedSendTime(new Date("2027-12-31T10:00:00Z"));
    expect(r.allowed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Comportement par défaut (sans paramètre `date`)
// ─────────────────────────────────────────────────────────────────────────────

describe("isAllowedSendTime — appel sans argument", () => {
  it("ne throw pas et renvoie un résultat de la bonne forme", () => {
    const r = isAllowedSendTime();
    expect(typeof r.allowed).toBe("boolean");
    if (!r.allowed) expect(typeof r.reason).toBe("string");
  });
});
