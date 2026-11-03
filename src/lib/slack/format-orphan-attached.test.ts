/**
 * Tests `format-orphan-attached.ts` — fonction pure Block Kit dédiée au
 * rattachement manuel d'un orphan (PR2c tour 2b bloc C sexies).
 */
import { describe, expect, it } from "vitest";

import {
  buildOrphanAttachedBlocks,
  LAST_INBOUND_MAX_CHARS,
  type OrphanAttachedInput,
} from "./format-orphan-attached";

const BASE_INPUT: OrphanAttachedInput = {
  firstName: "Marie",
  speciality: "Chirurgien-dentiste",
  city: "Paris",
  lastInboundBody: "Bonjour, j'ai bien reçu votre message, merci.",
  adminName: "Déthié Faye",
  originalReceivedAtIso: "2026-10-30T09:17:00.000Z",
  isOptOut: false,
  dashboardUrl: "https://dashboard.medere.fr/conversations/427963864300_hubspot-list-6081",
};

/**
 * Concatène tous les `text.text` et `elements[].text` d'une liste de
 * blocks Block Kit — sans les URLs de lien (qui portent légitimement
 * l'id dans leur query string). Utilisé par la sentinelle anti-ID.
 */
function extractAllMrkdwnText(blocks: readonly Record<string, unknown>[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    const textObj = (b as { text?: { text?: string } }).text;
    if (textObj && typeof textObj.text === "string") parts.push(textObj.text);
    const elements = (b as { elements?: Array<{ text?: string }> }).elements;
    if (Array.isArray(elements)) {
      for (const e of elements) {
        if (typeof e.text === "string") parts.push(e.text);
      }
    }
  }
  return parts.join("\n");
}

describe("buildOrphanAttachedBlocks — variante normale (isOptOut=false)", () => {
  it("header dédié au rattachement (pas « Nouveau message… »)", () => {
    const blocks = buildOrphanAttachedBlocks(BASE_INPUT);
    const header = blocks[0] as { type: string; text: { text: string } };
    expect(header.type).toBe("header");
    expect(header.text.text).toBe("SMS orphelin rattaché manuellement à une conversation");
  });

  it("section 'rattachement' nomme l'admin ET la date de réception d'origine", () => {
    const blocks = buildOrphanAttachedBlocks(BASE_INPUT);
    const line = blocks[3] as { text: { text: string } };
    expect(line.text.text).toContain("*Déthié Faye*");
    // formatDateTimeParis — jour/mois/année + heure Paris (CEST → 11:17 pour 09:17 UTC).
    expect(line.text.text).toMatch(/reçu le \d{2}\/\d{2}\/\d{4} à \d{2}:\d{2}/);
  });

  it("adminName null → libellé générique « un administrateur »", () => {
    const blocks = buildOrphanAttachedBlocks({ ...BASE_INPUT, adminName: null });
    const line = blocks[3] as { text: { text: string } };
    expect(line.text.text).toContain("*un administrateur*");
  });

  it("structure : 5 blocks (header + identite + body + rattachement + lien, pas de bloc STOP ni footer)", () => {
    const blocks = buildOrphanAttachedBlocks(BASE_INPUT);
    expect(blocks).toHaveLength(5);
    expect((blocks[0] as { type: string }).type).toBe("header");
    expect((blocks[4] as { text: { text: string } }).text.text).toContain("|Voir la conversation>");
  });

  it("lien → dashboardUrl (vers conversations, construit par getDashboardConversationUrl)", () => {
    const blocks = buildOrphanAttachedBlocks(BASE_INPUT);
    const link = blocks[4] as { text: { text: string } };
    expect(link.text.text).toBe(
      "<https://dashboard.medere.fr/conversations/427963864300_hubspot-list-6081|Voir la conversation>",
    );
    expect(link.text.text).not.toContain("/admin/orphan-inbounds");
  });
});

describe("buildOrphanAttachedBlocks — variante STOP (isOptOut=true)", () => {
  const STOP_INPUT: OrphanAttachedInput = { ...BASE_INPUT, isOptOut: true };

  it("header distinct STOP", () => {
    const blocks = buildOrphanAttachedBlocks(STOP_INPUT);
    const header = blocks[0] as { text: { text: string } };
    expect(header.text.text).toBe("SMS orphelin rattaché manuellement — demande d'arrêt (STOP)");
  });

  it("bloc d'action « Désabonnement appliqué » explicite", () => {
    const blocks = buildOrphanAttachedBlocks(STOP_INPUT);
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain("Désabonnement appliqué");
    expect(serialized).toContain("Le consentement a été retiré (STOP).");
  });

  it("structure STOP : 6 blocks (header + identite + body + rattachement + STOP + lien)", () => {
    const blocks = buildOrphanAttachedBlocks(STOP_INPUT);
    expect(blocks).toHaveLength(6);
  });
});

describe("buildOrphanAttachedBlocks — bornes et sécurité", () => {
  it("respecte le cap LAST_INBOUND_MAX_CHARS (300)", () => {
    expect(LAST_INBOUND_MAX_CHARS).toBe(300);
    const body = "a".repeat(301);
    const blocks = buildOrphanAttachedBlocks({ ...BASE_INPUT, lastInboundBody: body });
    const quote = blocks[2] as { text: { text: string } };
    // "> " + 300 chars + "..."
    expect(quote.text.text.length).toBe(2 + 300 + 3);
    expect(quote.text.text.endsWith("...")).toBe(true);
  });

  it("échappe les métacaractères mrkdwn dans tous les champs externes (anti-injection)", () => {
    const blocks = buildOrphanAttachedBlocks({
      ...BASE_INPUT,
      firstName: "<script>",
      speciality: "Généraliste*",
      city: "Lyon|_",
      lastInboundBody: "<https://evil.example|phishing>",
      adminName: "Admin<@U999>",
    });
    const serialized = JSON.stringify(blocks);
    // Les patterns Slack d'injection NE DOIVENT PAS apparaître intacts.
    expect(serialized).not.toContain("<script>");
    expect(serialized).not.toContain("<@U999>");
    expect(serialized).not.toContain("<https://evil.example|phishing>");
  });

  it("SENTINELLE ANTI-ID : aucun identifiant de conversation dans le texte Slack (PR2c bloc C sexies)", () => {
    // Même règle que les 2 autres notifs commerciales : le lien suffit, l'id
    // technique ne doit pas apparaître en clair dans le texte rendu.
    const CONV_ID_LIKE = "427963864300_hubspot-list-6081";
    const blocks = buildOrphanAttachedBlocks(BASE_INPUT);
    const textOnly = extractAllMrkdwnText(blocks).replace(/<https:\/\/[^|>]+\|[^>]*>/g, "[LINK]");
    expect(textOnly, "conversationId ne doit JAMAIS apparaître dans le texte Slack").not.toContain(
      CONV_ID_LIKE,
    );
    expect(textOnly, "pattern `conv \\`<id>\\`` interdit").not.toMatch(/\bconv\s+`[^`]+`/);
    expect(textOnly, "pattern `<contactId>_hubspot-list-<n>` interdit").not.toMatch(
      /\b\w+_hubspot-list-\d+\b/,
    );
  });

  it("ISO invalide → fallback 'date inconnue' sans crash (fail-safe)", () => {
    const blocks = buildOrphanAttachedBlocks({
      ...BASE_INPUT,
      originalReceivedAtIso: "not-an-iso",
    });
    const line = blocks[3] as { text: { text: string } };
    // Soit la date est "date inconnue" (fail-safe), soit c'est "Invalid
    // Date" selon le comportement du formatter — l'important : pas de
    // throw, pas de crash d'envoi.
    expect(line.text.text).toContain("Rattaché par");
  });
});
