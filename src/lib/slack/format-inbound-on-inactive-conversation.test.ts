/**
 * Tests `buildInboundOnInactiveConversationBlocks` (PR-NO-DROPPED-SMS).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Scope — fonction PURE
 *
 *   - en-tetes conditionnels selon `reason` (table source de verite
 *     `HEADERS_BY_REASON`)
 *   - echappement mrkdwn sur TOUS les champs externes (defense anti-phishing)
 *   - troncature `lastInboundBody` a `LAST_INBOUND_MAX_CHARS`
 *   - absence de PII strictement verrouillee (lastName/phone/email/
 *     hubspotId/ovhMessageId)
 *   - mention `<!here>` optionnelle (canal uniquement)
 *   - fallback phoneLast4 quand pas de firstName/speciality/city
 */
import { describe, expect, it, vi } from "vitest";

import {
  buildInboundOnInactiveConversationBlocks,
  HEADERS_BY_REASON,
  LAST_INBOUND_MAX_CHARS,
} from "./format-inbound-on-inactive-conversation";

// ─────────────────────────────────────────────────────────────────────────────
// R4-Point1 PR-NO-DROPPED-SMS : sentinelles no-emoji + accents FR corrects
// ─────────────────────────────────────────────────────────────────────────────

const EMOJI_REGEX =
  // Détecte les emojis Unicode courants (symboles + visages + drapeaux).
  // Volontairement conservateur : couvre les plages U+1F300–U+1FAFF + sélection
  // de symboles divers souvent utilisés (⚠️ ❓ 🎯 📍 ✅ ❌ 🚨 🔒 💬 📞 📧).
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/u;

/**
 * Mapping explicite reason -> accents attendus. Si un header perd ses
 * accents (ex: "Desabonne" au lieu de "Désabonné"), ce test casse. C'est
 * la sentinelle anti-régression R4-Point1 décidée par Déthié.
 */
const EXPECTED_ACCENTED_SUBSTRINGS: Readonly<Record<string, readonly string[]>> = {
  opted_out: ["désabonné"],
  blocked: ["bloqué"],
  closed: ["clôturée", "réécrit"],
  conversation_became_terminal: ["Désabonnement", "reçu", "vérifier"],
  handed_off_no_assignee: ["attribué", "reçu"],
  no_conversation: ["reçu", "à rattacher"],
  unknown_contact: ["Numéro", "reçu", "référencé"],
  parse_failed: ["reçu"],
  enqueue_failed: ["échec", "reçu", "lancé"],
};

describe("Sentinelle R4-Point1 : HEADERS_BY_REASON sans emoji + accents corrects", () => {
  for (const [reason, expectedSubs] of Object.entries(EXPECTED_ACCENTED_SUBSTRINGS) as Array<
    [keyof typeof HEADERS_BY_REASON, readonly string[]]
  >) {
    it(`reason=${reason} : aucun emoji + accents présents`, () => {
      const header = HEADERS_BY_REASON[reason];
      expect(EMOJI_REGEX.test(header)).toBe(false);
      for (const sub of expectedSubs) {
        expect(header).toContain(sub);
      }
    });
  }

  it("textes de section 'Numéro inconnu' + 'Désabonnement détecté' sans emoji + accents OK", () => {
    const withOptOut = buildInboundOnInactiveConversationBlocks({
      reason: "closed",
      wasOptOut: true,
      lastInboundBody: "STOP",
      dashboardUrl: "https://d.test/x",
      firstName: "A",
      speciality: "B",
      city: "C",
    });
    const serializedWithOptOut = JSON.stringify(withOptOut);
    expect(serializedWithOptOut).toContain("Désabonnement détecté");
    expect(EMOJI_REGEX.test(serializedWithOptOut)).toBe(false);

    const unknownContact = buildInboundOnInactiveConversationBlocks({
      reason: "unknown_contact",
      wasOptOut: false,
      lastInboundBody: "coucou",
      dashboardUrl: "https://d.test/x",
      phoneLast4: "4567",
    });
    const serializedUnknown = JSON.stringify(unknownContact);
    expect(serializedUnknown).toContain("Numéro inconnu");
    expect(EMOJI_REGEX.test(serializedUnknown)).toBe(false);
  });
});

describe("buildInboundOnInactiveConversationBlocks — en-tetes conditionnels", () => {
  for (const [reason, expectedHeader] of Object.entries(HEADERS_BY_REASON) as Array<
    [keyof typeof HEADERS_BY_REASON, string]
  >) {
    it(`reason=${reason} -> en-tete "${expectedHeader}"`, () => {
      const blocks = buildInboundOnInactiveConversationBlocks({
        reason,
        wasOptOut: false,
        lastInboundBody: "test",
        dashboardUrl: "https://d.test/x",
      });
      const header = blocks[0] as { type: string; text: { text: string } };
      expect(header.type).toBe("header");
      expect(header.text.text).toBe(expectedHeader);
    });
  }
});

describe("buildInboundOnInactiveConversationBlocks — echappement mrkdwn", () => {
  it("firstName malveillant (<url|texte>) echappe en entites HTML", () => {
    const blocks = buildInboundOnInactiveConversationBlocks({
      reason: "closed",
      wasOptOut: false,
      lastInboundBody: "innocuous body",
      dashboardUrl: "https://d.test/x",
      firstName: "<https://evil.com|Clique ici>",
      speciality: "Dentiste",
      city: "Paris",
    });
    const serialized = JSON.stringify(blocks);
    // Caractere `<` echappe en `&lt;` dans les blocks mrkdwn — jamais de
    // lien phishing cliquable (fix HIGH security-reviewer PR-A, applique
    // par symetrie ici).
    expect(serialized).not.toContain("<https://evil.com|");
    expect(serialized).toContain("&lt;https://evil.com");
  });

  it("body malveillant (<@UFOO>) echappe la mention", () => {
    const blocks = buildInboundOnInactiveConversationBlocks({
      reason: "opted_out",
      wasOptOut: false,
      lastInboundBody: "<@UFOO> Bonjour",
      dashboardUrl: "https://d.test/x",
      firstName: "A",
      speciality: "B",
      city: "C",
    });
    const serialized = JSON.stringify(blocks);
    expect(serialized).not.toContain("<@UFOO>");
    expect(serialized).toContain("&lt;@UFOO&gt;");
  });
});

describe("buildInboundOnInactiveConversationBlocks — troncature body", () => {
  it("body > 300 chars tronque + suffixe `...`", () => {
    const longBody = "x".repeat(400);
    const blocks = buildInboundOnInactiveConversationBlocks({
      reason: "unknown_contact",
      wasOptOut: false,
      lastInboundBody: longBody,
      dashboardUrl: "https://d.test/x",
      phoneLast4: "4567",
    });
    const serialized = JSON.stringify(blocks);
    // La version tronquee contient `...` apres les 300 premiers chars.
    expect(serialized).toContain("...");
    // Pas 400 x d'affilee (prouve la troncature).
    expect(serialized).not.toContain("x".repeat(400));
  });

  it("cap verrouille a 300 (sentinelle)", () => {
    expect(LAST_INBOUND_MAX_CHARS).toBe(300);
  });
});

describe("buildInboundOnInactiveConversationBlocks — anti-PII sentinelle", () => {
  it("un input hostile avec lastName/phone/email/hubspotId/ovhMessageId ne les expose PAS", () => {
    // Cast as any pour contourner le type (sentinelle runtime).
    const blocks = buildInboundOnInactiveConversationBlocks({
      reason: "handed_off_no_assignee",
      wasOptOut: false,
      lastInboundBody: "innocent",
      dashboardUrl: "https://d.test/x",
      firstName: "John",
      speciality: "Dentiste",
      city: "Paris",
      // Champs non-declares, cast delibere pour prouver qu'ils sont ignores.
      lastName: "LEAK_LASTNAME",
      phone: "+33612345678",
      email: "leak@example.com",
      hubspotId: "hs-12345",
      ovhMessageId: "118791103",
    } as unknown as Parameters<typeof buildInboundOnInactiveConversationBlocks>[0]);
    const serialized = JSON.stringify(blocks);
    expect(serialized).not.toContain("LEAK_LASTNAME");
    expect(serialized).not.toContain("+33612345678");
    expect(serialized).not.toContain("33612345678");
    expect(serialized).not.toContain("leak@example.com");
    expect(serialized).not.toContain("hs-12345");
    expect(serialized).not.toContain("118791103");
  });
});

describe("buildInboundOnInactiveConversationBlocks — opt-out mention + here", () => {
  it("wasOptOut=true -> section 'Désabonnement détecté'", () => {
    const blocks = buildInboundOnInactiveConversationBlocks({
      reason: "closed",
      wasOptOut: true,
      lastInboundBody: "STOP",
      dashboardUrl: "https://d.test/x",
      firstName: "A",
      speciality: "B",
      city: "C",
    });
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain("Désabonnement détecté");
  });

  it("includeHereMention=true -> section <!here>", () => {
    const blocks = buildInboundOnInactiveConversationBlocks({
      reason: "handed_off_no_assignee",
      wasOptOut: false,
      lastInboundBody: "test",
      dashboardUrl: "https://d.test/x",
      includeHereMention: true,
      firstName: "A",
      speciality: "B",
      city: "C",
    });
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain("<!here>");
  });

  it("includeHereMention default false -> pas de <!here>", () => {
    const blocks = buildInboundOnInactiveConversationBlocks({
      reason: "closed",
      wasOptOut: false,
      lastInboundBody: "test",
      dashboardUrl: "https://d.test/x",
      firstName: "A",
      speciality: "B",
      city: "C",
    });
    const serialized = JSON.stringify(blocks);
    expect(serialized).not.toContain("<!here>");
  });
});

describe("buildInboundOnInactiveConversationBlocks — fallback sans contact", () => {
  it("pas de firstName/speciality/city mais phoneLast4 -> section 'Numéro inconnu' avec last4", () => {
    const blocks = buildInboundOnInactiveConversationBlocks({
      reason: "unknown_contact",
      wasOptOut: false,
      lastInboundBody: "test",
      dashboardUrl: "https://d.test/x",
      phoneLast4: "4567",
    });
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain("Numéro inconnu");
    expect(serialized).toContain("4567");
  });

  it("ni contact ni phoneLast4 -> section 'Contact non identifie'", () => {
    const blocks = buildInboundOnInactiveConversationBlocks({
      reason: "parse_failed",
      wasOptOut: false,
      lastInboundBody: "unparseable",
      dashboardUrl: "https://d.test/x",
    });
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain("Contact non identifié");
  });
});

describe("buildInboundOnInactiveConversationBlocks — footer", () => {
  it("conversationId + orphanDocId -> footer `conv X / orphan Y`", () => {
    const blocks = buildInboundOnInactiveConversationBlocks({
      reason: "closed",
      wasOptOut: false,
      lastInboundBody: "test",
      dashboardUrl: "https://d.test/x",
      firstName: "A",
      speciality: "B",
      city: "C",
      conversationId: "hs-123_camp-a",
      orphanDocId: "oih_abc123",
    });
    const context = blocks[blocks.length - 1] as {
      type: string;
      elements: Array<{ text: string }>;
    };
    expect(context.type).toBe("context");
    expect(context.elements[0]!.text).toContain("conv `hs-123_camp-a`");
    expect(context.elements[0]!.text).toContain("orphan `oih_abc123`");
  });

  it("aucun id -> pas de footer context", () => {
    const blocks = buildInboundOnInactiveConversationBlocks({
      reason: "parse_failed",
      wasOptOut: false,
      lastInboundBody: "test",
      dashboardUrl: "https://d.test/x",
    });
    expect(blocks.some((b) => (b as { type: string }).type === "context")).toBe(false);
  });

  it("LOW-1 : conversationId avec backtick -> omis du footer + callback onInvalidFooterId", () => {
    const onInvalid = (invalidFields: readonly string[]): void => {
      capturedInvalid = [...invalidFields];
    };
    let capturedInvalid: string[] = [];
    const blocks = buildInboundOnInactiveConversationBlocks({
      reason: "closed",
      wasOptOut: false,
      lastInboundBody: "test",
      dashboardUrl: "https://d.test/x",
      firstName: "A",
      speciality: "B",
      city: "C",
      conversationId: "hs-123`injection|hostile",
      orphanDocId: "oih_valid_only",
      onInvalidFooterId: onInvalid,
    });
    const serialized = JSON.stringify(blocks);
    // conversationId hostile OMIT du footer.
    expect(serialized).not.toContain("hs-123`injection");
    expect(serialized).not.toContain("hs-123`");
    // orphanDocId valide reste.
    expect(serialized).toContain("orphan `oih_valid_only`");
    // Callback invoque avec le nom du champ invalide.
    expect(capturedInvalid).toEqual(["conversationId"]);
  });

  it("LOW-1 : orphanDocId avec pipe -> omis du footer + callback invoque", () => {
    let capturedInvalid: string[] = [];
    const blocks = buildInboundOnInactiveConversationBlocks({
      reason: "closed",
      wasOptOut: false,
      lastInboundBody: "test",
      dashboardUrl: "https://d.test/x",
      firstName: "A",
      speciality: "B",
      city: "C",
      conversationId: "hs-valid_123",
      orphanDocId: "oih_<bad>|here",
      onInvalidFooterId: (f) => (capturedInvalid = [...f]),
    });
    const serialized = JSON.stringify(blocks);
    expect(serialized).not.toContain("oih_<bad>");
    expect(serialized).toContain("conv `hs-valid_123`");
    expect(capturedInvalid).toEqual(["orphanDocId"]);
  });

  it("LOW-1 : IDs valides -> callback NON invoque", () => {
    const onInvalid = vi.fn();
    buildInboundOnInactiveConversationBlocks({
      reason: "closed",
      wasOptOut: false,
      lastInboundBody: "test",
      dashboardUrl: "https://d.test/x",
      firstName: "A",
      speciality: "B",
      city: "C",
      conversationId: "hs-123_camp-a",
      orphanDocId: "oih_abc123",
      onInvalidFooterId: onInvalid,
    });
    expect(onInvalid).not.toHaveBeenCalled();
  });
});
