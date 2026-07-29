/**
 * Tests `format-handoff.ts` — fonction pure Block Kit.
 *
 * Couverture : structure DM vs orphelin, troncature 300 chars, présence
 * `<!here>` orphelin + absence DM, lien dashboard, sentinelle anti-PII
 * (lastName / phone / email / hubspotId ne fuient jamais).
 */
import { describe, expect, it } from "vitest";

import { buildHandoffBlocks, type HandoffInput, LAST_INBOUND_MAX_CHARS } from "./format-handoff";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture minimale — jamais réutiliser un vrai PS/commercial
// ─────────────────────────────────────────────────────────────────────────────

const BASE_INPUT: HandoffInput = {
  firstName: "Marie",
  speciality: "Chirurgien-dentiste",
  city: "Paris",
  lastInboundBody: "Bonjour, votre offre m'intéresse. Rappelez-moi.",
  conversationId: "conv-abc-123",
  isOrphan: false,
  dashboardUrl: "https://dashboard.medere.fr/conversations/conv-abc-123",
};

// ─────────────────────────────────────────────────────────────────────────────
// Structure de sortie — DM (isOrphan=false)
// ─────────────────────────────────────────────────────────────────────────────

describe("buildHandoffBlocks — DM (isOrphan=false)", () => {
  it("génère 5 blocks : header + section contexte + section blockquote + section lien + context footer", () => {
    const blocks = buildHandoffBlocks(BASE_INPUT);
    expect(blocks).toHaveLength(5);
    expect(blocks[0]).toMatchObject({ type: "header" });
    expect(blocks[1]).toMatchObject({ type: "section" });
    expect(blocks[2]).toMatchObject({ type: "section" });
    expect(blocks[3]).toMatchObject({ type: "section" });
    expect(blocks[4]).toMatchObject({ type: "context" });
  });

  it("header : titre '🎯 Lead intéressé'", () => {
    const blocks = buildHandoffBlocks(BASE_INPUT);
    expect(blocks[0]).toMatchObject({
      type: "header",
      text: { type: "plain_text", text: "🎯 Lead intéressé", emoji: true },
    });
  });

  it("section contexte : prénom en gras + spécialité + ville, PAS de <!here>", () => {
    const blocks = buildHandoffBlocks(BASE_INPUT);
    const text = (blocks[1] as { text: { text: string } }).text.text;
    expect(text).toBe("*Marie* — Chirurgien-dentiste\n📍 Paris");
    expect(text).not.toContain("<!here>");
    expect(text).not.toContain("<!channel>");
  });

  it("section blockquote : dernier message inbound préfixé de '> '", () => {
    const blocks = buildHandoffBlocks(BASE_INPUT);
    expect(blocks[2]).toMatchObject({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "> Bonjour, votre offre m'intéresse. Rappelez-moi.",
      },
    });
  });

  it("section lien : format mrkdwn <url|label>", () => {
    const blocks = buildHandoffBlocks(BASE_INPUT);
    expect(blocks[3]).toMatchObject({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "<https://dashboard.medere.fr/conversations/conv-abc-123|Voir la conversation>",
      },
    });
  });

  it("context footer : conversationId opaque pour correlation debug", () => {
    const blocks = buildHandoffBlocks(BASE_INPUT);
    expect(blocks[4]).toMatchObject({
      type: "context",
      elements: [{ type: "mrkdwn", text: "conv `conv-abc-123`" }],
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Structure de sortie — orphelin (isOrphan=true)
// ─────────────────────────────────────────────────────────────────────────────

describe("buildHandoffBlocks — orphelin (isOrphan=true)", () => {
  const ORPHAN_INPUT: HandoffInput = { ...BASE_INPUT, isOrphan: true };

  it("header : titre '❓ Lead non attribué à traiter'", () => {
    const blocks = buildHandoffBlocks(ORPHAN_INPUT);
    expect(blocks[0]).toMatchObject({
      type: "header",
      text: { type: "plain_text", text: "❓ Lead non attribué à traiter", emoji: true },
    });
  });

  it("section contexte contient <!here> (décision D8)", () => {
    const blocks = buildHandoffBlocks(ORPHAN_INPUT);
    const text = (blocks[1] as { text: { text: string } }).text.text;
    expect(text).toContain("<!here>");
    expect(text).toContain("*Marie* — Chirurgien-dentiste");
    expect(text).toContain("📍 Paris");
  });

  it("PAS de <!channel> ni de mention @user (D8 — ping large uniquement)", () => {
    const blocks = buildHandoffBlocks(ORPHAN_INPUT);
    const json = JSON.stringify(blocks);
    expect(json).not.toContain("<!channel>");
    expect(json).not.toMatch(/<@U[A-Z0-9]+>/);
  });

  it("reste 5 blocks au total (structure identique DM sauf header + <!here>)", () => {
    const blocks = buildHandoffBlocks(ORPHAN_INPUT);
    expect(blocks).toHaveLength(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Troncature du dernier message inbound
// ─────────────────────────────────────────────────────────────────────────────

describe("buildHandoffBlocks — troncature lastInboundBody", () => {
  it("respecte le cap de 300 chars (sentinelle)", () => {
    expect(LAST_INBOUND_MAX_CHARS).toBe(300);
  });

  it("body <= 300 chars : passe tel quel sans '…'", () => {
    const body = "a".repeat(300);
    const blocks = buildHandoffBlocks({ ...BASE_INPUT, lastInboundBody: body });
    const text = (blocks[2] as { text: { text: string } }).text.text;
    expect(text).toBe(`> ${body}`);
    expect(text).not.toContain("…");
  });

  it("body > 300 chars : tronqué à 300 chars + '…'", () => {
    const body = "x".repeat(500);
    const blocks = buildHandoffBlocks({ ...BASE_INPUT, lastInboundBody: body });
    const text = (blocks[2] as { text: { text: string } }).text.text;
    // Sans le préfixe '> ', le contenu tronqué doit faire 301 chars (300 + '…')
    const content = text.slice(2); // strip '> '
    expect(content).toHaveLength(301);
    expect(content.endsWith("…")).toBe(true);
    expect(content.slice(0, 300)).toBe("x".repeat(300));
  });

  it("body multi-lignes : chaque ligne préfixée '> '", () => {
    const body = "Ligne 1\nLigne 2\nLigne 3";
    const blocks = buildHandoffBlocks({ ...BASE_INPUT, lastInboundBody: body });
    const text = (blocks[2] as { text: { text: string } }).text.text;
    expect(text).toBe("> Ligne 1\n> Ligne 2\n> Ligne 3");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SENTINELLE ANTI-PII — cœur de la décision D2
// ─────────────────────────────────────────────────────────────────────────────

describe("buildHandoffBlocks — SENTINELLE anti-PII", () => {
  /**
   * Régression critique : si un jour un caller passe des champs PII
   * additionnels (lastName, phone, email, hubspotId) via un cast `as any`,
   * ces valeurs NE DOIVENT PAS apparaître dans la sortie. Ça garantit
   * qu'aucun ajout futur ne coule silencieusement une PII dans le block.
   */
  it("lastName / phone / email / hubspotId passés via cast → n'apparaissent PAS dans les blocks", () => {
    const MARKER_LASTNAME = "SENTINEL_LASTNAME_MUST_NOT_APPEAR_XYZ";
    const MARKER_PHONE = "+33612345678";
    const MARKER_EMAIL = "sentinel@must.not.appear";
    const MARKER_HUBSPOT_ID = "SENTINEL_HUBSPOT_ID_00000";

    const blocks = buildHandoffBlocks({
      ...BASE_INPUT,
      // Cast volontaire pour simuler un caller qui contourne le typage strict.
      lastName: MARKER_LASTNAME,
      phone: MARKER_PHONE,
      email: MARKER_EMAIL,
      hubspotId: MARKER_HUBSPOT_ID,
    } as unknown as HandoffInput);

    const json = JSON.stringify(blocks);
    expect(json).not.toContain(MARKER_LASTNAME);
    expect(json).not.toContain(MARKER_PHONE);
    expect(json).not.toContain(MARKER_EMAIL);
    expect(json).not.toContain(MARKER_HUBSPOT_ID);
  });

  it("lastInboundBody peut contenir un téléphone/email fournis par le PS → passe (contenu utilisateur légitime)", () => {
    // Distinction importante : le CONTENU du dernier message PS peut
    // contenir un téléphone (le PS a écrit "rappelez-moi au 06…") — c'est
    // exactement ce que le commercial doit voir pour hand-off. La
    // sentinelle ne s'applique PAS à `lastInboundBody`, elle s'applique
    // aux champs STRUCTURÉS additionnels (lastName/phone/email/hubspotId).
    const bodyWithPhone = "Rappelez-moi au 06 12 34 56 78 ou marie@example.com";
    const blocks = buildHandoffBlocks({ ...BASE_INPUT, lastInboundBody: bodyWithPhone });
    const json = JSON.stringify(blocks);
    expect(json).toContain("06 12 34 56 78");
    expect(json).toContain("marie@example.com");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lien dashboard — toujours présent, jamais unfurled par mrkdwn
// ─────────────────────────────────────────────────────────────────────────────

describe("buildHandoffBlocks — dashboardUrl", () => {
  it("URL présente exactement 1 fois dans les blocks (format mrkdwn)", () => {
    const blocks = buildHandoffBlocks(BASE_INPUT);
    const json = JSON.stringify(blocks);
    // Comptage naïf de l'URL — 1 seule occurrence attendue (section lien).
    const url = BASE_INPUT.dashboardUrl;
    const count = json.split(url).length - 1;
    expect(count).toBe(1);
  });

  it("format lien mrkdwn `<url|label>` respecté", () => {
    const blocks = buildHandoffBlocks(BASE_INPUT);
    const text = (blocks[3] as { text: { text: string } }).text.text;
    expect(text).toMatch(/^<https:\/\/[^|]+\|Voir la conversation>$/);
  });
});
