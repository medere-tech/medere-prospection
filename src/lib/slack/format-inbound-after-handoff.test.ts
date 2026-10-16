import { describe, expect, it } from "vitest";

import {
  buildInboundAfterHandoffBlocks,
  type InboundAfterHandoffInput,
  LAST_INBOUND_MAX_CHARS,
} from "./format-inbound-after-handoff";

const BASE_INPUT: InboundAfterHandoffInput = {
  firstName: "Pierre",
  speciality: "Dentiste",
  city: "Paris",
  lastInboundBody: "Je ne suis pas disponible cette semaine, on peut en reparler lundi ?",
  conversationId: "conv-abc-123",
  isOptOut: false,
  dashboardUrl: "https://dashboard.medere.fr/conversations/conv-abc-123",
};

describe("buildInboundAfterHandoffBlocks — variante normale (isOptOut=false)", () => {
  it("header lisible et sans emoji", () => {
    const blocks = buildInboundAfterHandoffBlocks(BASE_INPUT);
    const header = blocks[0] as { type: string; text: { text: string; emoji: boolean } };
    expect(header.type).toBe("header");
    expect(header.text.text).toBe("Nouveau message d'un lead que vous suivez");
    expect(header.text.emoji).toBe(false);
  });

  it("identite PS : firstName + speciality + city", () => {
    const blocks = buildInboundAfterHandoffBlocks(BASE_INPUT);
    const section = blocks[1] as { type: string; text: { text: string } };
    expect(section.type).toBe("section");
    expect(section.text.text).toContain("*Pierre*");
    expect(section.text.text).toContain("Dentiste");
    expect(section.text.text).toContain("Paris");
  });

  it("blockquote du body entier (non tronque)", () => {
    const blocks = buildInboundAfterHandoffBlocks(BASE_INPUT);
    const quote = blocks[2] as { text: { text: string } };
    expect(quote.text.text).toContain(
      "> Je ne suis pas disponible cette semaine, on peut en reparler lundi ?",
    );
  });

  it("PAS de bloc 'Ne plus recontacter.' (variante normale)", () => {
    const blocks = buildInboundAfterHandoffBlocks(BASE_INPUT);
    const serialized = JSON.stringify(blocks);
    expect(serialized).not.toContain("Ne plus recontacter");
  });

  it("lien dashboard + footer conv id", () => {
    const blocks = buildInboundAfterHandoffBlocks(BASE_INPUT);
    const link = blocks[3] as { text: { text: string } };
    expect(link.text.text).toBe(
      "<https://dashboard.medere.fr/conversations/conv-abc-123|Voir la conversation>",
    );
    const footer = blocks[4] as { type: string; elements: { text: string }[] };
    expect(footer.type).toBe("context");
    expect(footer.elements[0]!.text).toBe("conv `conv-abc-123`");
  });

  it("blockquote multi-lignes : chaque ligne est prefixee par `> `", () => {
    const multi = buildInboundAfterHandoffBlocks({
      ...BASE_INPUT,
      lastInboundBody: "Ligne 1\nLigne 2\nLigne 3",
    });
    const quote = multi[2] as { text: { text: string } };
    expect(quote.text.text).toBe("> Ligne 1\n> Ligne 2\n> Ligne 3");
  });
});

describe("buildInboundAfterHandoffBlocks — variante STOP (isOptOut=true)", () => {
  const STOP_INPUT: InboundAfterHandoffInput = { ...BASE_INPUT, isOptOut: true };

  it("header distinct", () => {
    const blocks = buildInboundAfterHandoffBlocks(STOP_INPUT);
    const header = blocks[0] as { text: { text: string } };
    expect(header.text.text).toBe("Demande d'arret (STOP) sur un lead que vous suivez");
  });

  it("bloc d'action explicite 'Ne plus recontacter.'", () => {
    const blocks = buildInboundAfterHandoffBlocks(STOP_INPUT);
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain("Ne plus recontacter");
    expect(serialized).toContain("Le consentement a ete retire (STOP).");
  });

  it("variante STOP : structure (header + identite + body + action + lien + footer = 6 blocks)", () => {
    const blocks = buildInboundAfterHandoffBlocks(STOP_INPUT);
    expect(blocks).toHaveLength(6);
  });

  it("variante normale : 5 blocks (pas de bloc action)", () => {
    const blocks = buildInboundAfterHandoffBlocks(BASE_INPUT);
    expect(blocks).toHaveLength(5);
  });
});

describe("buildInboundAfterHandoffBlocks — bornes et PII", () => {
  it(`respecte le cap de ${LAST_INBOUND_MAX_CHARS} chars`, () => {
    const long = "A".repeat(LAST_INBOUND_MAX_CHARS + 50);
    const blocks = buildInboundAfterHandoffBlocks({ ...BASE_INPUT, lastInboundBody: long });
    const quote = blocks[2] as { text: { text: string } };
    // '> ' prefixe + 300 chars + '...'
    expect(quote.text.text.endsWith("...")).toBe(true);
    const bodyPortion = quote.text.text.replace(/^>\s/, "").replace(/\.\.\.$/, "");
    expect(bodyPortion.length).toBe(LAST_INBOUND_MAX_CHARS);
  });

  it("body exactement a la borne : pas tronque", () => {
    const exact = "B".repeat(LAST_INBOUND_MAX_CHARS);
    const blocks = buildInboundAfterHandoffBlocks({ ...BASE_INPUT, lastInboundBody: exact });
    const quote = blocks[2] as { text: { text: string } };
    expect(quote.text.text.endsWith("...")).toBe(false);
    expect(quote.text.text.endsWith("B")).toBe(true);
  });

  it("sentinelle anti-PII : lastName / phone / email / hubspotId / ovhMessageId JAMAIS presents meme en cas de smuggling", () => {
    // On force les champs interdits via cast — le typage les rejette au
    // compile-time mais un dev pourrait tenter via `as any`. Le test prouve
    // que la sortie ne les mentionne JAMAIS, quelle que soit la variante.
    const smuggle = {
      ...BASE_INPUT,
      lastName: "Dupont",
      phone: "+33612345678",
      email: "pierre.dupont@example.fr",
      hubspotId: "hs-contact-123",
      ovhMessageId: "ovh-msg-xyz",
    } as unknown as InboundAfterHandoffInput;

    for (const variant of [false, true]) {
      const blocks = buildInboundAfterHandoffBlocks({ ...smuggle, isOptOut: variant });
      const serialized = JSON.stringify(blocks);
      expect(serialized).not.toContain("Dupont");
      expect(serialized).not.toContain("+33612345678");
      expect(serialized).not.toContain("pierre.dupont@example.fr");
      expect(serialized).not.toContain("hs-contact-123");
      expect(serialized).not.toContain("ovh-msg-xyz");
    }
  });

  describe("sentinelles anti-phishing mrkdwn (fix HIGH security-reviewer)", () => {
    const HOSTILES: Array<{ input: string; label: string }> = [
      { input: "<https://phishing.site|URGENT: Valider Medere>", label: "lien masque" },
      { input: "<!here>", label: "mention here" },
      { input: "<!channel>", label: "mention channel" },
      { input: "<@U12345678>", label: "mention user" },
      { input: "a & b < c > d", label: "mix special chars" },
    ];

    for (const { input, label } of HOSTILES) {
      it(`entree hostile dans lastInboundBody (${label}) : aucune syntaxe active residuelle`, () => {
        const blocks = buildInboundAfterHandoffBlocks({
          ...BASE_INPUT,
          lastInboundBody: input,
        });
        const serialized = JSON.stringify(blocks);
        // Verifs ciblees sur l'entree brute : si on la retrouve TELLE
        // QUELLE, l'echappement a fuite. Si on retrouve l'entite &lt;
        // / &gt; / &amp; a la place, l'echappement a fait son job.
        expect(serialized).not.toContain(input);
      });

      it(`entree hostile dans firstName (${label}) : aucune syntaxe active residuelle`, () => {
        const blocks = buildInboundAfterHandoffBlocks({
          ...BASE_INPUT,
          firstName: input,
        });
        const serialized = JSON.stringify(blocks);
        expect(serialized).not.toContain(input);
      });

      it(`entree hostile dans city (${label}) : aucune syntaxe active residuelle`, () => {
        const blocks = buildInboundAfterHandoffBlocks({
          ...BASE_INPUT,
          city: input,
        });
        const serialized = JSON.stringify(blocks);
        expect(serialized).not.toContain(input);
      });
    }

    it("lien phishing specifiquement : plus aucun `<https://` ni `|URGENT` connectables", () => {
      const blocks = buildInboundAfterHandoffBlocks({
        ...BASE_INPUT,
        lastInboundBody: "<https://phishing.site|URGENT: Valider Medere>",
      });
      const serialized = JSON.stringify(blocks);
      // Un lien Slack mrkdwn exige `<URL|text>` AVEC le `<` ouvrant.
      // Echappement de `<` suffit a casser le parse Slack.
      expect(serialized).not.toContain("<https://phishing.site|");
      // Les entites doivent apparaitre a la place.
      expect(serialized).toContain("&lt;https://phishing.site|URGENT: Valider Medere&gt;");
    });

    it("mention `<@U12345678>` specifiquement : plus aucun ping actif", () => {
      const blocks = buildInboundAfterHandoffBlocks({
        ...BASE_INPUT,
        firstName: "<@U12345678>",
      });
      const serialized = JSON.stringify(blocks);
      expect(serialized).not.toContain("<@U12345678>");
      expect(serialized).toContain("&lt;@U12345678&gt;");
    });
  });

  it("sentinelle zero emoji sur l'ensemble des blocks (regex large plan 1 Unicode emoji)", () => {
    // Pas d'emoji dans les 2 variantes (contrainte brief PR-A).
    for (const variant of [false, true]) {
      const blocks = buildInboundAfterHandoffBlocks({ ...BASE_INPUT, isOptOut: variant });
      const serialized = JSON.stringify(blocks);
      // Regex plan unicode large couvrant les plages emoji usuelles.
      // Si quelqu'un ajoute un emoji au builder, ce test casse.
      expect(serialized).not.toMatch(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]/u);
    }
  });
});
