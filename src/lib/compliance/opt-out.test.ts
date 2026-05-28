import { describe, expect, it } from "vitest";

import { hasOptOut, isOptOut } from "./opt-out";

// ─────────────────────────────────────────────────────────────────────────────
// hasOptOut — validation message SORTANT
// ─────────────────────────────────────────────────────────────────────────────

describe("hasOptOut (message sortant)", () => {
  it("'... STOP au 38080' → true", () => {
    expect(hasOptOut("Bonjour Dr X. STOP au 38080.")).toBe(true);
  });

  it("minuscule 'stop' → true (insensible casse)", () => {
    expect(hasOptOut("Bonjour. stop pour ne plus recevoir.")).toBe(true);
  });

  it("'STOP' en début de chaîne → true", () => {
    expect(hasOptOut("STOP. Pour vous désinscrire.")).toBe(true);
  });

  it("'STOP' en fin de chaîne → true", () => {
    expect(hasOptOut("Formation DPC gratuite — STOP")).toBe(true);
  });

  it("'STOPPER' (mot piège, pas de word boundary) → false", () => {
    expect(hasOptOut("Pour STOPPER votre abonnement.")).toBe(false);
  });

  it("'STOPPAGE' → false (word boundary)", () => {
    expect(hasOptOut("STOPPAGE de la campagne.")).toBe(false);
  });

  it("sans aucun 'STOP' → false", () => {
    expect(hasOptOut("Bonjour Dr X, formation DPC.")).toBe(false);
  });

  it("chaîne vide → false", () => {
    expect(hasOptOut("")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isOptOut — détection message ENTRANT
// ─────────────────────────────────────────────────────────────────────────────

describe("isOptOut (message entrant) — mots-clés directs", () => {
  it("'STOP' seul → true", () => {
    expect(isOptOut("STOP")).toBe(true);
  });

  it("'stop' minuscule → true", () => {
    expect(isOptOut("stop")).toBe(true);
  });

  it("'Stop merci' (< 50) → true", () => {
    expect(isOptOut("Stop merci")).toBe(true);
  });

  it("'STOPP' variante → true", () => {
    expect(isOptOut("STOPP")).toBe(true);
  });

  it("'unsub' → true", () => {
    expect(isOptOut("unsub")).toBe(true);
  });

  it("'UNSUB' caps → true", () => {
    expect(isOptOut("UNSUB")).toBe(true);
  });

  it("'DESINSCRIPTION' tout caps → true", () => {
    expect(isOptOut("DESINSCRIPTION")).toBe(true);
  });
});

describe("isOptOut — accents (normalisation NFD + strip diacritiques)", () => {
  it("'ARRET' (sans accent) → true", () => {
    expect(isOptOut("ARRET")).toBe(true);
  });

  it("'ARRÊT' (caps + accent circonflexe) → true", () => {
    expect(isOptOut("ARRÊT")).toBe(true);
  });

  it("'Arrêt' (lowercase + accent) → true", () => {
    expect(isOptOut("Arrêt")).toBe(true);
  });

  it("'Désinscription svp' → true (é → e)", () => {
    expect(isOptOut("Désinscription svp")).toBe(true);
  });

  it("'désabonner' → false (mot pas dans la liste)", () => {
    // « désabonner » a été écarté de OPT_OUT_KEYWORDS pour S4 (décision
    // explicite : pas d'ajout sans validation juridique). Le classifieur
    // Claude (S7) traitera ce cas via intent classification.
    expect(isOptOut("désabonner")).toBe(false);
  });
});

describe("isOptOut — espaces et trim", () => {
  it("'  STOP  ' avec espaces → true (trim)", () => {
    expect(isOptOut("  STOP  ")).toBe(true);
  });

  it("'\\nSTOP\\n' avec sauts de ligne → true (trim)", () => {
    expect(isOptOut("\nSTOP\n")).toBe(true);
  });

  it("uniquement espaces → false", () => {
    expect(isOptOut("   ")).toBe(false);
  });
});

describe("isOptOut — comportement volontaire (précaution juridique)", () => {
  it("'STOPPER' contient STOP → true (faux positif assumé, précaution)", () => {
    expect(isOptOut("STOPPER")).toBe(true);
  });

  it("'arrete moi de me contacter' (< 50) → true (contient ARRET)", () => {
    // 26 chars, après norm → "ARRETE MOI DE ME CONTACTER", contient "ARRET".
    expect(isOptOut("arrete moi de me contacter")).toBe(true);
  });
});

describe("isOptOut — faux positifs à éviter", () => {
  it("'DÉCONFINEMENT' (ne contient aucun mot-clé) → false", () => {
    expect(isOptOut("DÉCONFINEMENT")).toBe(false);
  });

  it("'Non merci, je vais voir' (< 50, sans mot-clé) → false", () => {
    expect(isOptOut("Non merci, je vais voir")).toBe(false);
  });

  it("'Bonjour' → false", () => {
    expect(isOptOut("Bonjour")).toBe(false);
  });
});

describe("isOptOut — threshold 50 chars (probable conversation)", () => {
  it("> 50 chars avec STOP dedans → false (probable conversation)", () => {
    const long = "Bonjour je voudrais comprendre votre demarche merci STOP svp.";
    expect(long.length).toBeGreaterThan(50);
    expect(isOptOut(long)).toBe(false);
  });

  it("EXACTEMENT 50 chars → analyse normale", () => {
    // 50 chars pile : on est encore dans le seuil (max INCLUS).
    const exactly50 = "STOP " + "x".repeat(45); // 50 chars exactement
    expect(exactly50.length).toBe(50);
    expect(isOptOut(exactly50)).toBe(true); // contient STOP
  });

  it("51 chars avec STOP dedans → false (au-delà du seuil)", () => {
    const fiftyOne = "STOP " + "x".repeat(46);
    expect(fiftyOne.length).toBe(51);
    expect(isOptOut(fiftyOne)).toBe(false);
  });
});

describe("isOptOut — bord", () => {
  it("chaîne vide → false", () => {
    expect(isOptOut("")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Anti-évasion Unicode invisible (security-reviewer S4 — M1)
// Un PS qui glisse un caractère invisible au milieu d'un mot-clé pour
// échapper à `isOptOut` est techniquement possible. Le normalizer retire
// désormais les `\p{Cf}` et `\p{Cc}` en plus des diacritiques.
// ─────────────────────────────────────────────────────────────────────────────

describe("isOptOut — anti-évasion Unicode invisible", () => {
  it("'S\\u200BTOP' (Zero-Width Space) → true (ZWSP retiré)", () => {
    expect(isOptOut("S​TOP")).toBe(true);
  });

  it("'\\uFEFFSTOP' (BOM en préfixe) → true (BOM retiré)", () => {
    expect(isOptOut("﻿STOP")).toBe(true);
  });

  it("'S\\u00ADTOP' (Soft Hyphen) → true", () => {
    expect(isOptOut("S­TOP")).toBe(true);
  });

  it("'S\\u2060TOP' (Word Joiner) → true", () => {
    expect(isOptOut("S⁠TOP")).toBe(true);
  });

  it("ZWSP entre chaque lettre 'S\\u200BT\\u200BO\\u200BP' → true", () => {
    expect(isOptOut("S​T​O​P")).toBe(true);
  });

  it("ARRET avec diacritique combinant explicite 'A\\u0301RRET' → true", () => {
    // U+0301 Combining Acute Accent : décomposé puis retiré comme un accent.
    expect(isOptOut("ÁRRET")).toBe(true);
  });

  it("anti-régression : 'DÉCONFINEMENT' toujours false", () => {
    // S'assure qu'on n'introduit pas de faux positif via NFKD.
    expect(isOptOut("DÉCONFINEMENT")).toBe(false);
  });
});
