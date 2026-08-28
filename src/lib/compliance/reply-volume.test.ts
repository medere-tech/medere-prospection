/**
 * Tests de `lib/compliance/reply-volume.ts` (PR-BARRIERE-2).
 *
 * Couverture exigée : 100 % (CLAUDE.md — `lib/compliance/`).
 *
 * Ces tests verrouillent DEUX propriétés distinctes :
 *   1. le disjoncteur fonctionne (10 réponses/24h → la 11e est refusée) ;
 *   2. il ne déborde JAMAIS sur le plafond légal (les sollicitations ne
 *      sont pas comptées, et la fenêtre reste bien de 24 h et non 48).
 */
import { describe, expect, it } from "vitest";

import type { OutboundMessageRecord } from "./rate-limits";
import {
  canSendReplyVolume,
  countReplyVolumeInWindow,
  REPLY_VOLUME_MAX,
  REPLY_VOLUME_WINDOW_HOURS,
} from "./reply-volume";

const NOW = new Date("2026-05-28T12:00:00Z");

function hoursAgo(n: number, ref: Date = NOW): Date {
  return new Date(ref.getTime() - n * 3600 * 1000);
}

/** Réponse — compte contre le plafond de VOLUME. */
function reply(sentAt: Date): OutboundMessageRecord {
  return { direction: "outbound", sentAt, outboundKind: "reply" };
}

/** Sollicitation — compte contre le plafond LÉGAL, jamais celui-ci. */
function solicitation(sentAt: Date): OutboundMessageRecord {
  return { direction: "outbound", sentAt, outboundKind: "solicitation" };
}

/** Doc LEGACY (antérieur à #42, sans `outboundKind`). */
function legacy(sentAt: Date): OutboundMessageRecord {
  return { direction: "outbound", sentAt };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sentinelles de constantes
// ─────────────────────────────────────────────────────────────────────────────

describe("reply-volume — sentinelles", () => {
  it("🔒 plafond = 10 réponses, fenêtre = 24 heures", () => {
    expect(REPLY_VOLUME_MAX).toBe(10);
    expect(REPLY_VOLUME_WINDOW_HOURS).toBe(24);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Le disjoncteur
// ─────────────────────────────────────────────────────────────────────────────

describe("canSendReplyVolume — le disjoncteur", () => {
  it("🔒 10 réponses en 24h → la 11e est REFUSÉE", () => {
    const messages = Array.from({ length: 10 }, (_, i) => reply(hoursAgo(i + 1)));
    const r = canSendReplyVolume(messages, NOW);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("10 réponses");
  });

  it("9 réponses en 24h → autorisé (borne haute sous le plafond)", () => {
    const messages = Array.from({ length: 9 }, (_, i) => reply(hoursAgo(i + 1)));
    expect(canSendReplyVolume(messages, NOW).allowed).toBe(true);
  });

  it("liste vide → autorisé", () => {
    expect(canSendReplyVolume([], NOW).allowed).toBe(true);
  });

  it("🔒 10 réponses réparties sur 25h → AUTORISÉ (la plus ancienne sort)", () => {
    // Le test qui prouve que la fenêtre est bien GLISSANTE et de 24 h.
    // Réponses à h-1 .. h-9 (9 dans la fenêtre) + une à h-25 (exclue).
    const messages = [
      ...Array.from({ length: 9 }, (_, i) => reply(hoursAgo(i + 1))),
      reply(hoursAgo(25)),
    ];
    const r = canSendReplyVolume(messages, NOW);
    expect(r.allowed).toBe(true);
    expect(countReplyVolumeInWindow(messages, NOW).replyCount).toBe(9);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Étanchéité vs le plafond légal
// ─────────────────────────────────────────────────────────────────────────────

describe("canSendReplyVolume — n'empiète PAS sur le plafond légal", () => {
  it("🔒 50 SOLLICITATIONS en 24h → le plafond de volume ne bronche pas", () => {
    // Les sollicitations relèvent de `rate-limits.ts`, pas d'ici. Même en
    // nombre absurde, elles ne déclenchent jamais ce disjoncteur.
    const messages = Array.from({ length: 50 }, (_, i) => solicitation(hoursAgo((i % 23) + 1)));
    const r = canSendReplyVolume(messages, NOW);
    expect(r.allowed).toBe(true);
    expect(countReplyVolumeInWindow(messages, NOW).replyCount).toBe(0);
  });

  it("🔒 MIX compté séparément : 4 sollicitations + 10 réponses", () => {
    const messages = [
      ...Array.from({ length: 4 }, (_, i) => solicitation(hoursAgo(i + 1))),
      ...Array.from({ length: 10 }, (_, i) => reply(hoursAgo(i + 1))),
    ];
    const counts = countReplyVolumeInWindow(messages, NOW);
    expect(counts.replyCount).toBe(10); // seules les réponses comptent
    expect(counts.totalOutboundCount).toBe(14); // mais le total documente l'ampleur
    expect(canSendReplyVolume(messages, NOW).allowed).toBe(false);
  });

  it("🔒 LEGACY (sans outboundKind) N'EST PAS une réponse → ne compte pas", () => {
    // Polarité INVERSÉE vs le plafond légal, et c'est délibéré : ici
    // sur-bloquer ferait taire un PS en conversation réelle. Cf. JSDoc
    // `countsAsReply`. En pratique un legacy ne peut pas être dans une
    // fenêtre de 24 h (ils datent d'avant #42).
    const messages = Array.from({ length: 20 }, (_, i) => legacy(hoursAgo((i % 23) + 1)));
    expect(canSendReplyVolume(messages, NOW).allowed).toBe(true);
    expect(countReplyVolumeInWindow(messages, NOW).replyCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bornes de la fenêtre — le piège differenceInDays
// ─────────────────────────────────────────────────────────────────────────────

describe("countReplyVolumeInWindow — bornes de la fenêtre 24h", () => {
  it("🔒 EXACTEMENT 24h00 → COMPTÉ (borne inclusive, convention J-30)", () => {
    const messages = Array.from({ length: 10 }, () => reply(hoursAgo(24)));
    expect(countReplyVolumeInWindow(messages, NOW).replyCount).toBe(10);
    expect(canSendReplyVolume(messages, NOW).allowed).toBe(false);
  });

  it("🔒 25h00 → EXCLU", () => {
    const messages = Array.from({ length: 10 }, () => reply(hoursAgo(25)));
    expect(countReplyVolumeInWindow(messages, NOW).replyCount).toBe(0);
    expect(canSendReplyVolume(messages, NOW).allowed).toBe(true);
  });

  it("🔒 PIÈGE differenceInDays : 30h N'EST PAS dans la fenêtre 24h", () => {
    // `differenceInDays(now, 30h)` vaut 1, donc `1 <= 1` serait vrai — la
    // fenêtre ferait en réalité ~48h. C'est pour ça que le module utilise
    // `differenceInHours`. Ce test tombe si quelqu'un rebascule sur des
    // jours (sentinelle de mutation).
    const messages = Array.from({ length: 10 }, () => reply(hoursAgo(30)));
    expect(countReplyVolumeInWindow(messages, NOW).replyCount).toBe(0);
    expect(canSendReplyVolume(messages, NOW).allowed).toBe(true);
  });

  it("24h59 → compté (differenceInHours tronque dans le bon sens)", () => {
    const messages = Array.from({ length: 10 }, () =>
      reply(new Date(NOW.getTime() - (24 * 60 + 59) * 60 * 1000)),
    );
    expect(countReplyVolumeInWindow(messages, NOW).replyCount).toBe(10);
  });

  it("totalOutboundCount respecte aussi la fenêtre", () => {
    const messages = [reply(hoursAgo(1)), solicitation(hoursAgo(2)), reply(hoursAgo(30))];
    const counts = countReplyVolumeInWindow(messages, NOW);
    expect(counts.replyCount).toBe(1);
    expect(counts.totalOutboundCount).toBe(2); // le h-30 est exclu
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Format du reason + support Timestamp
// ─────────────────────────────────────────────────────────────────────────────

describe("canSendReplyVolume — reason et types", () => {
  it("le reason mentionne le plafond, la fenêtre, et distingue réponses/total", () => {
    const messages = [
      ...Array.from({ length: 10 }, (_, i) => reply(hoursAgo(i + 1))),
      solicitation(hoursAgo(2)),
    ];
    const r = canSendReplyVolume(messages, NOW);
    expect(r.reason).toContain("10 réponses/24h");
    expect(r.reason).toContain("11 envois");
  });

  it("autorisé → pas de reason", () => {
    const r = canSendReplyVolume([], NOW);
    expect(r.allowed).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it("supporte les Timestamp Firestore (.toDate())", () => {
    const ts = { toDate: () => hoursAgo(1) } as unknown as OutboundMessageRecord["sentAt"];
    const messages: OutboundMessageRecord[] = Array.from({ length: 10 }, () => ({
      direction: "outbound",
      sentAt: ts,
      outboundKind: "reply",
    }));
    expect(canSendReplyVolume(messages, NOW).allowed).toBe(false);
  });
});
