import { describe, expect, it } from "vitest";

import { hasAIDisclosure } from "./ai-disclosure";

// ─────────────────────────────────────────────────────────────────────────────
// Patterns valides (4 patterns de la skill medere-sms-compliance)
// ─────────────────────────────────────────────────────────────────────────────

describe("hasAIDisclosure — patterns valides", () => {
  it("'assistante IA' (pattern #1 — féminin + IA)", () => {
    expect(hasAIDisclosure("Bonjour Léa, assistante IA de Médéré.")).toBe(true);
  });

  it("'assistant virtuel' (pattern #1 — masculin + virtuel)", () => {
    expect(hasAIDisclosure("Je suis un assistant virtuel de Médéré.")).toBe(true);
  });

  it("'assistante intelligence artificielle' (pattern #1)", () => {
    expect(
      hasAIDisclosure(
        "Cette communication est gérée par notre assistante intelligence artificielle Léa.",
      ),
    ).toBe(true);
  });

  it("'je suis Léa' (pattern #2)", () => {
    expect(hasAIDisclosure("Bonjour, je suis Léa, ravie de vous écrire.")).toBe(true);
  });

  it('"c\'est Léa" (pattern #2 — apostrophe)', () => {
    expect(hasAIDisclosure("Bonjour, c'est Léa de Médéré.")).toBe(true);
  });

  it("'assistante automatisée' (pattern #3 — féminin)", () => {
    expect(hasAIDisclosure("Je suis votre assistante automatisée.")).toBe(true);
  });

  it("'assistant automatisé' (pattern #3 — masculin)", () => {
    expect(hasAIDisclosure("Bonjour, assistant automatisé Médéré.")).toBe(true);
  });

  it("'agent virtuel' (pattern #4)", () => {
    expect(hasAIDisclosure("Je suis un agent virtuel.")).toBe(true);
  });

  it("'agent IA' (pattern #4)", () => {
    expect(hasAIDisclosure("Bonjour, agent IA Médéré ici.")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Casse mixte (flag /i)
// ─────────────────────────────────────────────────────────────────────────────

describe("hasAIDisclosure — casse mixte", () => {
  it("MAJUSCULES — 'JE SUIS LÉA' → true", () => {
    expect(hasAIDisclosure("BONJOUR, JE SUIS LÉA")).toBe(true);
  });

  it("camelcase — 'AssIsTaNtE iA' → true", () => {
    expect(hasAIDisclosure("AssIsTaNtE iA Médéré")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Position dans le message (pas obligé d'être en début)
// ─────────────────────────────────────────────────────────────────────────────

describe("hasAIDisclosure — position dans le message", () => {
  it("mention en milieu de message → true", () => {
    expect(
      hasAIDisclosure("Bonjour Dr X. Notre assistante IA Léa propose des formations DPC. STOP"),
    ).toBe(true);
  });

  it("mention en fin de message → true", () => {
    expect(hasAIDisclosure("Médéré formations DPC. Je suis Léa.")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Négatifs (anti-régression)
// ─────────────────────────────────────────────────────────────────────────────

describe("hasAIDisclosure — sans annonce IA → false", () => {
  it("message commercial sans mention IA → false", () => {
    expect(hasAIDisclosure("Bonjour Dr X, formation DPC gratuite. STOP.")).toBe(false);
  });

  it("chaîne vide → false", () => {
    expect(hasAIDisclosure("")).toBe(false);
  });

  it("'Bonjour Léa' SEUL (sans 'je suis' ni \"c'est\") → false", () => {
    // Léa peut être un prénom de destinataire — il faut bien le contexte
    // « je suis » ou « c'est » pour que ça compte comme annonce IA.
    expect(hasAIDisclosure("Bonjour Léa, comment ça va ?")).toBe(false);
  });

  it("'IA' seul sans 'assistant' ni 'agent' → false (mot isolé non suffisant)", () => {
    expect(hasAIDisclosure("L'IA est partout aujourd'hui.")).toBe(false);
  });

  it("'agent' sans 'virtuel/IA' → false", () => {
    expect(hasAIDisclosure("Notre agent commercial vous rappelle.")).toBe(false);
  });
});
