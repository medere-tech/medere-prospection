import type { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";

import {
  canSendMessage,
  countSolicitationsInWindow,
  type OutboundMessageRecord,
  RATE_LIMIT_MAX_MESSAGES,
  RATE_LIMIT_WINDOW_DAYS,
} from "./rate-limits";

// Référence temporelle figée pour tous les tests (un jeudi pour limiter
// les surprises hebdomadaires — on teste les jours et heures dans `hours.ts`).
const NOW = new Date("2026-05-28T12:00:00Z");

function daysAgo(n: number, ref: Date = NOW): Date {
  return new Date(ref.getTime() - n * 24 * 3600 * 1000);
}

/** Sortant qui COMPTE : sollicitation (1er SMS, relance). */
function outbound(sentAt: Date): OutboundMessageRecord {
  return { direction: "outbound", sentAt, outboundKind: "solicitation" };
}

/** Sortant qui NE COMPTE PAS : réponse à un PS qui a écrit en premier. */
function reply(sentAt: Date): OutboundMessageRecord {
  return { direction: "outbound", sentAt, outboundKind: "reply" };
}

/** Sortant LEGACY (doc écrit avant PR #42, sans `outboundKind`). */
function legacy(sentAt: Date): OutboundMessageRecord {
  return { direction: "outbound", sentAt };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sentinelle de plafond
// ─────────────────────────────────────────────────────────────────────────────

describe("RATE_LIMIT_MAX_MESSAGES — sentinelle de conformité", () => {
  it("🔒 le plafond est 4 (et non 3) sollicitations / 30 jours", () => {
    // L.34-5 CPCE autorise 4 sollicitations/30j. Depuis
    // PR-FILTRE-SOLLICITATION on retient exactement cette valeur : il n'y
    // a PLUS de marge de sécurité. Toute modification passe par
    // compliance-auditor.
    expect(RATE_LIMIT_MAX_MESSAGES).toBe(4);
    expect(RATE_LIMIT_WINDOW_DAYS).toBe(30);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cas signature (cas explicitement listé dans CLAUDE.md)
// ─────────────────────────────────────────────────────────────────────────────

describe("canSendMessage — cas signature 4 sollicitations J-1 / J-10 / J-15 / J-25", () => {
  it("refuse la 5e (CAS NON NÉGOCIABLE)", () => {
    const messages = [
      outbound(daysAgo(1)),
      outbound(daysAgo(10)),
      outbound(daysAgo(15)),
      outbound(daysAgo(25)),
    ];
    const r = canSendMessage(messages, NOW);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("4");
  });

  it("3 sollicitations → autorise (sous le plafond)", () => {
    const messages = [outbound(daysAgo(1)), outbound(daysAgo(15)), outbound(daysAgo(25))];
    expect(canSendMessage(messages, NOW).allowed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔒 Le cœur de PR-FILTRE-SOLLICITATION — seules les sollicitations comptent
// ─────────────────────────────────────────────────────────────────────────────

describe("canSendMessage — seules les sollicitations comptent", () => {
  it("🔒 6 réponses après un inbound → autorise (solicitationCount === 0)", () => {
    // Le scénario métier central : le PS a engagé l'échange, l'IA répond.
    // Aucun de ces sortants ne le "dérange" au sens L.34-5.
    const messages = Array.from({ length: 6 }, (_, i) => reply(daysAgo(i + 1)));
    const r = canSendMessage(messages, NOW);
    expect(r.allowed).toBe(true);
    expect(countSolicitationsInWindow(messages, NOW).solicitationCount).toBe(0);
  });

  it("🔒 une conversation à 10 réponses ne bloque JAMAIS", () => {
    const messages = Array.from({ length: 10 }, (_, i) => reply(daysAgo(i + 1)));
    expect(canSendMessage(messages, NOW).allowed).toBe(true);
  });

  it("🔒 MIX : 4 sollicitations + 10 réponses → REFUSE (les 4 suffisent)", () => {
    // Preuve que le filtre discrimine dans les deux sens : les réponses
    // n'atténuent pas le plafond, les sollicitations le saturent seules.
    const messages = [
      ...Array.from({ length: 4 }, (_, i) => outbound(daysAgo(i * 3 + 1))),
      ...Array.from({ length: 10 }, (_, i) => reply(daysAgo(i + 2))),
    ];
    const r = canSendMessage(messages, NOW);
    expect(r.allowed).toBe(false);

    const counts = countSolicitationsInWindow(messages, NOW);
    expect(counts.solicitationCount).toBe(4);
    expect(counts.totalOutboundCount).toBe(14);
  });

  it("🔒 MIX : 3 sollicitations + 10 réponses → AUTORISE", () => {
    const messages = [
      ...Array.from({ length: 3 }, (_, i) => outbound(daysAgo(i * 3 + 1))),
      ...Array.from({ length: 10 }, (_, i) => reply(daysAgo(i + 2))),
    ];
    expect(canSendMessage(messages, NOW).allowed).toBe(true);
  });

  it("🔒 FAIL-CLOSED : les sortants LEGACY (sans outboundKind) COMPTENT", () => {
    // Un doc antérieur à PR #42 n'a pas le champ. Il DOIT être compté
    // comme une sollicitation — l'exclure serait un sous-comptage du
    // plafond, donc une infraction. C'est `countsAgainstCap` qui applique
    // ce défaut, en un seul endroit.
    const messages = [
      legacy(daysAgo(1)),
      legacy(daysAgo(5)),
      legacy(daysAgo(10)),
      legacy(daysAgo(20)),
    ];
    const r = canSendMessage(messages, NOW);
    expect(r.allowed).toBe(false);
    expect(countSolicitationsInWindow(messages, NOW).solicitationCount).toBe(4);
  });

  it("MIX legacy + reply : seuls les legacy comptent", () => {
    const messages = [legacy(daysAgo(1)), legacy(daysAgo(2)), reply(daysAgo(3)), reply(daysAgo(4))];
    const counts = countSolicitationsInWindow(messages, NOW);
    expect(counts.solicitationCount).toBe(2);
    expect(counts.totalOutboundCount).toBe(4);
    expect(canSendMessage(messages, NOW).allowed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bornes de la fenêtre
// ─────────────────────────────────────────────────────────────────────────────

describe("canSendMessage — bornes fenêtre 30j", () => {
  it("4 sollicitations dont J-31 → autorise (J-31 hors fenêtre)", () => {
    const messages = [
      outbound(daysAgo(31)),
      outbound(daysAgo(15)),
      outbound(daysAgo(10)),
      outbound(daysAgo(5)),
    ];
    expect(canSendMessage(messages, NOW).allowed).toBe(true);
  });

  it("4 sollicitations PILE à J-30 → refuse (J-30 INCLUS, décision restrictive)", () => {
    const messages = Array.from({ length: 4 }, () => outbound(daysAgo(30)));
    expect(canSendMessage(messages, NOW).allowed).toBe(false);
  });

  it("4 sollicitations à J-30, J-31, J-32, J-33 (1 dans la fenêtre) → autorise", () => {
    const messages = [
      outbound(daysAgo(30)),
      outbound(daysAgo(31)),
      outbound(daysAgo(32)),
      outbound(daysAgo(33)),
    ];
    expect(canSendMessage(messages, NOW).allowed).toBe(true);
  });

  it("la fenêtre s'applique AUSSI au totalOutboundCount", () => {
    const messages = [outbound(daysAgo(5)), reply(daysAgo(10)), reply(daysAgo(31))];
    const counts = countSolicitationsInWindow(messages, NOW);
    expect(counts.solicitationCount).toBe(1);
    expect(counts.totalOutboundCount).toBe(2); // le J-31 est exclu
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sous le plafond
// ─────────────────────────────────────────────────────────────────────────────

describe("canSendMessage — sous le plafond", () => {
  it("liste vide → autorise", () => {
    expect(canSendMessage([], NOW).allowed).toBe(true);
  });

  it("1 sollicitation dans la fenêtre → autorise", () => {
    expect(canSendMessage([outbound(daysAgo(5))], NOW).allowed).toBe(true);
  });

  it("3 sollicitations dans la fenêtre → autorise (borne haute autorisée)", () => {
    const messages = [outbound(daysAgo(5)), outbound(daysAgo(20)), outbound(daysAgo(25))];
    expect(canSendMessage(messages, NOW).allowed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Au-dessus du plafond
// ─────────────────────────────────────────────────────────────────────────────

describe("canSendMessage — au-dessus du plafond", () => {
  it("exactement 4 dans la fenêtre → refuse", () => {
    const messages = [
      outbound(daysAgo(2)),
      outbound(daysAgo(10)),
      outbound(daysAgo(20)),
      outbound(daysAgo(25)),
    ];
    expect(canSendMessage(messages, NOW).allowed).toBe(false);
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
      { direction: "outbound", sentAt: fakeTimestamp, outboundKind: "solicitation" },
      outbound(daysAgo(10)),
      outbound(daysAgo(20)),
      outbound(daysAgo(25)),
    ];
    expect(canSendMessage(messages, NOW).allowed).toBe(false);
  });

  it("mix Timestamp + Date dans le même tableau → fonctionne", () => {
    const ts = { toDate: () => daysAgo(1) } as unknown as Timestamp;
    expect(
      canSendMessage(
        [
          { direction: "outbound", sentAt: ts, outboundKind: "solicitation" },
          outbound(daysAgo(10)),
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
  it("mentionne le plafond 4/30j, les sollicitations ET le total sortants", () => {
    const messages = [
      outbound(daysAgo(1)),
      outbound(daysAgo(10)),
      outbound(daysAgo(15)),
      outbound(daysAgo(25)),
      reply(daysAgo(2)),
    ];
    const r = canSendMessage(messages, NOW);
    expect(r.reason).toMatch(/4\/30j/);
    expect(r.reason).toMatch(/4 sollicitations/);
    expect(r.reason).toMatch(/5 envois/);
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
