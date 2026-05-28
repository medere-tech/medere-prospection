import type { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";

import type { Contact } from "@/types/contact";

import { BLOCTEL_REASONS, canSendB2C } from "./bloctel";

// Référence temporelle figée pour tous les tests.
const NOW = new Date("2026-05-28T12:00:00Z");

function daysAgo(n: number, ref: Date = NOW): Date {
  return new Date(ref.getTime() - n * 24 * 3600 * 1000);
}

/**
 * Helper : construit un contact partiel avec uniquement les champs lus
 * par `canSendB2C`. Cast `as Contact` car les autres champs ne sont pas
 * lus — le typage du test reflète la zone testée.
 */
function makeContact(overrides: {
  segment: Contact["segment"];
  bloctelChecked?: boolean;
  bloctelOptOut?: boolean;
  bloctelCheckedAt?: Date | Timestamp;
}): Contact {
  return {
    segment: overrides.segment,
    bloctelChecked: overrides.bloctelChecked ?? false,
    bloctelOptOut: overrides.bloctelOptOut ?? false,
    bloctelCheckedAt: overrides.bloctelCheckedAt,
  } as Contact;
}

// ─────────────────────────────────────────────────────────────────────────────
// Court-circuit segment (B2B et unknown)
// ─────────────────────────────────────────────────────────────────────────────

describe("canSendB2C — court-circuit segment non concerné", () => {
  it("segment 'b2b_cabinet' → allowed (pas concerné par Bloctel)", () => {
    const r = canSendB2C(makeContact({ segment: "b2b_cabinet" }), NOW);
    expect(r.allowed).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it("segment 'unknown' → allowed (pas concerné)", () => {
    const r = canSendB2C(makeContact({ segment: "unknown" }), NOW);
    expect(r.allowed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B2C non vérifié / opt-out Bloctel
// ─────────────────────────────────────────────────────────────────────────────

describe("canSendB2C — B2C mobile perso", () => {
  it("bloctelChecked = false → refusé 'notChecked'", () => {
    const r = canSendB2C(makeContact({ segment: "b2c_mobile_perso", bloctelChecked: false }), NOW);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe(BLOCTEL_REASONS.notChecked);
  });

  it("bloctelOptOut = true → refusé 'optedOut'", () => {
    const r = canSendB2C(
      makeContact({
        segment: "b2c_mobile_perso",
        bloctelChecked: true,
        bloctelOptOut: true,
        bloctelCheckedAt: daysAgo(5),
      }),
      NOW,
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe(BLOCTEL_REASONS.optedOut);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bornes de validité 30j (décision restrictive : J+30 inclusif, J+31 KO)
// ─────────────────────────────────────────────────────────────────────────────

describe("canSendB2C — bornes validité 30j", () => {
  it("vérif faite à J-5 → autorisé", () => {
    const r = canSendB2C(
      makeContact({
        segment: "b2c_mobile_perso",
        bloctelChecked: true,
        bloctelCheckedAt: daysAgo(5),
      }),
      NOW,
    );
    expect(r.allowed).toBe(true);
  });

  it("vérif faite à J-29 → autorisé", () => {
    const r = canSendB2C(
      makeContact({
        segment: "b2c_mobile_perso",
        bloctelChecked: true,
        bloctelCheckedAt: daysAgo(29),
      }),
      NOW,
    );
    expect(r.allowed).toBe(true);
  });

  it("vérif faite à J-30 PILE → autorisé (J+30 inclusif)", () => {
    const r = canSendB2C(
      makeContact({
        segment: "b2c_mobile_perso",
        bloctelChecked: true,
        bloctelCheckedAt: daysAgo(30),
      }),
      NOW,
    );
    expect(r.allowed).toBe(true);
  });

  it("vérif faite à J-31 → REFUSÉ 'expiredPrefix'", () => {
    const r = canSendB2C(
      makeContact({
        segment: "b2c_mobile_perso",
        bloctelChecked: true,
        bloctelCheckedAt: daysAgo(31),
      }),
      NOW,
    );
    expect(r.allowed).toBe(false);
    expect(r.reason?.startsWith(BLOCTEL_REASONS.expiredPrefix)).toBe(true);
    expect(r.reason).toContain("31j");
  });

  it("vérif faite à J-90 → REFUSÉ avec compteur", () => {
    const r = canSendB2C(
      makeContact({
        segment: "b2c_mobile_perso",
        bloctelChecked: true,
        bloctelCheckedAt: daysAgo(90),
      }),
      NOW,
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("90j");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fail-safe : checked=true mais bloctelCheckedAt=undefined (anomalie data)
// ─────────────────────────────────────────────────────────────────────────────

describe("canSendB2C — fail-safe anomalie data", () => {
  it("bloctelChecked=true + bloctelCheckedAt=undefined → REFUSÉ 'missingTimestamp'", () => {
    const r = canSendB2C(
      makeContact({
        segment: "b2c_mobile_perso",
        bloctelChecked: true,
        bloctelOptOut: false,
        // bloctelCheckedAt VOLONTAIREMENT absent → anomalie data simulée
      }),
      NOW,
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe(BLOCTEL_REASONS.missingTimestamp);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Support Timestamp Firestore (.toDate())
// ─────────────────────────────────────────────────────────────────────────────

describe("canSendB2C — Timestamp Firestore (.toDate())", () => {
  it("bloctelCheckedAt en Timestamp Firestore → utilise .toDate()", () => {
    const fakeTimestamp = { toDate: () => daysAgo(10) } as unknown as Timestamp;
    const r = canSendB2C(
      makeContact({
        segment: "b2c_mobile_perso",
        bloctelChecked: true,
        bloctelCheckedAt: fakeTimestamp,
      }),
      NOW,
    );
    expect(r.allowed).toBe(true);
  });

  it("Timestamp Firestore avec date expirée (J-45) → refusé", () => {
    const fakeTimestamp = { toDate: () => daysAgo(45) } as unknown as Timestamp;
    const r = canSendB2C(
      makeContact({
        segment: "b2c_mobile_perso",
        bloctelChecked: true,
        bloctelCheckedAt: fakeTimestamp,
      }),
      NOW,
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("45j");
  });
});
