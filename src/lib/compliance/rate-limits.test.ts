import type { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";

import { canSendMessage, type OutboundMessageRecord } from "./rate-limits";

// Référence temporelle figée pour tous les tests (un jeudi pour limiter
// les surprises hebdomadaires — on teste les jours et heures dans `hours.ts`).
const NOW = new Date("2026-05-28T12:00:00Z");

function daysAgo(n: number, ref: Date = NOW): Date {
  return new Date(ref.getTime() - n * 24 * 3600 * 1000);
}

function outbound(sentAt: Date): OutboundMessageRecord {
  return { direction: "outbound", sentAt };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cas signature (cas explicitement listé dans CLAUDE.md)
// ─────────────────────────────────────────────────────────────────────────────

describe("canSendMessage — cas signature 3 SMS J-1 / J-15 / J-25", () => {
  it("refuse le 4e (CAS NON NÉGOCIABLE)", () => {
    const messages = [outbound(daysAgo(1)), outbound(daysAgo(15)), outbound(daysAgo(25))];
    const r = canSendMessage(messages, NOW);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("3");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bornes de la fenêtre
// ─────────────────────────────────────────────────────────────────────────────

describe("canSendMessage — bornes fenêtre 30j", () => {
  it("3 SMS dont J-31 + J-15 + J-10 → autorise (J-31 hors fenêtre)", () => {
    const messages = [outbound(daysAgo(31)), outbound(daysAgo(15)), outbound(daysAgo(10))];
    const r = canSendMessage(messages, NOW);
    expect(r.allowed).toBe(true);
  });

  it("3 SMS PILE à J-30 → refuse (J-30 INCLUS, décision restrictive)", () => {
    const messages = [outbound(daysAgo(30)), outbound(daysAgo(30)), outbound(daysAgo(30))];
    const r = canSendMessage(messages, NOW);
    expect(r.allowed).toBe(false);
  });

  it("3 SMS à J-30, J-31, J-32 (1 dans la fenêtre) → autorise", () => {
    const messages = [outbound(daysAgo(30)), outbound(daysAgo(31)), outbound(daysAgo(32))];
    expect(canSendMessage(messages, NOW).allowed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sous le plafond
// ─────────────────────────────────────────────────────────────────────────────

describe("canSendMessage — sous le plafond", () => {
  it("liste vide → autorise", () => {
    expect(canSendMessage([], NOW).allowed).toBe(true);
  });

  it("1 SMS dans la fenêtre → autorise", () => {
    expect(canSendMessage([outbound(daysAgo(5))], NOW).allowed).toBe(true);
  });

  it("2 SMS dans la fenêtre → autorise", () => {
    expect(canSendMessage([outbound(daysAgo(5)), outbound(daysAgo(20))], NOW).allowed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Au-dessus du plafond
// ─────────────────────────────────────────────────────────────────────────────

describe("canSendMessage — au-dessus du plafond", () => {
  it("exactement 3 dans la fenêtre → refuse", () => {
    const messages = [outbound(daysAgo(2)), outbound(daysAgo(10)), outbound(daysAgo(25))];
    expect(canSendMessage(messages, NOW).allowed).toBe(false);
  });

  it("4 dans la fenêtre → refuse", () => {
    const messages = [
      outbound(daysAgo(1)),
      outbound(daysAgo(5)),
      outbound(daysAgo(15)),
      outbound(daysAgo(25)),
    ];
    const r = canSendMessage(messages, NOW);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("4");
  });

  it("5 dans la fenêtre → refuse, reason mentionne le compteur", () => {
    const messages = Array.from({ length: 5 }, (_, i) => outbound(daysAgo(i * 5 + 1)));
    const r = canSendMessage(messages, NOW);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("5");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Support des types Timestamp Firestore (méthode toDate())
// ─────────────────────────────────────────────────────────────────────────────

describe("canSendMessage — Timestamp Firestore (.toDate())", () => {
  it("sentAt en Timestamp Firestore → utilise .toDate()", () => {
    const fakeTimestamp = { toDate: () => daysAgo(1) } as unknown as Timestamp;
    const messages: OutboundMessageRecord[] = [
      { direction: "outbound", sentAt: fakeTimestamp },
      { direction: "outbound", sentAt: daysAgo(10) },
      { direction: "outbound", sentAt: daysAgo(20) },
    ];
    expect(canSendMessage(messages, NOW).allowed).toBe(false);
  });

  it("mix Timestamp + Date dans le même tableau → fonctionne", () => {
    const ts = { toDate: () => daysAgo(1) } as unknown as Timestamp;
    expect(
      canSendMessage(
        [
          { direction: "outbound", sentAt: ts },
          { direction: "outbound", sentAt: daysAgo(10) },
        ],
        NOW,
      ).allowed,
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Format du `reason`
// ─────────────────────────────────────────────────────────────────────────────

describe("canSendMessage — format reason", () => {
  it("mentionne le plafond 3/30j et le nombre comptabilisé", () => {
    const messages = [outbound(daysAgo(1)), outbound(daysAgo(15)), outbound(daysAgo(25))];
    const r = canSendMessage(messages, NOW);
    expect(r.reason).toMatch(/3\/30j/);
    expect(r.reason).toMatch(/3 envois/);
  });

  it("réponse autorisée n'a pas de reason", () => {
    const r = canSendMessage([], NOW);
    expect(r.allowed).toBe(true);
    expect(r.reason).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Défense TYPE-LEVEL — Option A validée par Déthié
// ─────────────────────────────────────────────────────────────────────────────

describe("canSendMessage — défense type-level (Option A)", () => {
  it("@ts-expect-error : refuse les inbound au COMPILE time", () => {
    // L'invariant testé est au compile time : si le test compile sans la
    // directive @ts-expect-error, alors la garde TypeScript ne tient pas.
    // Si la garde tient, TypeScript signale l'erreur et @ts-expect-error
    // l'absorbe ; sinon le test ne compilerait pas.
    const inbound = { direction: "inbound" as const, sentAt: NOW };
    // @ts-expect-error — canSendMessage exige OutboundMessageRecord[]
    canSendMessage([inbound], NOW);
    // Si on arrive ici sans erreur de compile, la garde tient.
    expect(true).toBe(true);
  });
});
