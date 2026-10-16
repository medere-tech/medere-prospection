import { describe, expect, it } from "vitest";

import { escapeSlackMrkdwn } from "./escape-mrkdwn";

describe("escapeSlackMrkdwn", () => {
  describe("fondations", () => {
    it("neutralise `<` et `>` isoles", () => {
      expect(escapeSlackMrkdwn("<")).toBe("&lt;");
      expect(escapeSlackMrkdwn(">")).toBe("&gt;");
    });

    it("neutralise `&` SEUL (prerequis pour l'ordre)", () => {
      expect(escapeSlackMrkdwn("&")).toBe("&amp;");
    });

    it("chaine vide inchangee", () => {
      expect(escapeSlackMrkdwn("")).toBe("");
    });

    it("texte neutre inchange (pas de sur-echappement)", () => {
      expect(escapeSlackMrkdwn("Bonjour, je rappelle lundi.")).toBe("Bonjour, je rappelle lundi.");
    });
  });

  describe("ordre critique (& avant < et >)", () => {
    it("`<` seul donne EXACTEMENT `&lt;` (prouve que & est echappe AVANT <)", () => {
      // 🔒 Test discriminant d'ordre — remplace l'ancien test tautologique.
      //
      // Si on inversait l'ordre dans le helper (`<` d'abord, puis `&`) :
      //   1. "<"  -> "&lt;"       (apres replace de `<`)
      //   2. "&lt;" -> "&amp;lt;" (le `&` du `&lt;` est a son tour echappe)
      //   -> Resultat KO : "<" devient "&amp;lt;".
      //
      // Avec l'ordre correct (& EN PREMIER) :
      //   1. "<"  -> "<"          (aucun `&` a echapper)
      //   2. "<"  -> "&lt;"       (apres replace de `<`)
      //   -> Resultat OK : "<" devient "&lt;".
      //
      // Ce test tombe SI on inverse l'ordre dans escape-mrkdwn.ts.
      // Verrouille l'invariant "& EN PREMIER" de facon non-tautologique.
      expect(escapeSlackMrkdwn("<")).toBe("&lt;");
    });

    it("`a & b < c > d` donne exactement `a &amp; b &lt; c &gt; d`", () => {
      expect(escapeSlackMrkdwn("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
    });
  });

  describe("sentinelles anti-phishing (entrees hostiles)", () => {
    it("lien masque `<https://phishing.site|URGENT: Valider Medere>` est desarmorce", () => {
      const hostile = "<https://phishing.site|URGENT: Valider Medere>";
      const safe = escapeSlackMrkdwn(hostile);
      // Le `<` ouvrant est transforme : Slack ne detecte plus un lien.
      expect(safe).toBe("&lt;https://phishing.site|URGENT: Valider Medere&gt;");
      // Verif defensive : plus aucun `<` en toute lettre qui pourrait
      // amorcer un `<url|text>` parse par Slack.
      expect(safe).not.toContain("<https://");
      expect(safe).not.toContain("<");
      // Le pipe `|` et le texte "URGENT" restent en toute lettre dans
      // l'output — c'est OK et volontaire : sans le `<...>` englobant,
      // Slack ne cree pas de lien, le `|` est juste un caractere.
    });

    it("mention broadcast `<!here>` est desarmorce", () => {
      expect(escapeSlackMrkdwn("<!here>")).toBe("&lt;!here&gt;");
      expect(escapeSlackMrkdwn("<!here>")).not.toContain("<!here>");
    });

    it("mention broadcast `<!channel>` est desarmorce", () => {
      expect(escapeSlackMrkdwn("<!channel>")).toBe("&lt;!channel&gt;");
    });

    it("mention user `<@U12345678>` est desarmorcee", () => {
      expect(escapeSlackMrkdwn("<@U12345678>")).toBe("&lt;@U12345678&gt;");
    });

    it("mention subteam `<!subteam^S012345>` est desarmorcee", () => {
      expect(escapeSlackMrkdwn("<!subteam^S012345>")).toBe("&lt;!subteam^S012345&gt;");
    });

    it("mention channel `<#C012345>` est desarmorcee", () => {
      expect(escapeSlackMrkdwn("<#C012345>")).toBe("&lt;#C012345&gt;");
    });
  });

  describe("perimetre explicite (ce qui N'EST PAS echappe)", () => {
    it("`*gras*` et `_italique_` et `~barre~` restent — ne pas sur-echapper", () => {
      // Un SMS humain qui contient `*un mot important*` doit rester lisible.
      // Ces caracteres ne sont pas un vecteur de phishing (pas de lien
      // masque ni de mention active).
      expect(escapeSlackMrkdwn("*gras*")).toBe("*gras*");
      expect(escapeSlackMrkdwn("_italique_")).toBe("_italique_");
      expect(escapeSlackMrkdwn("~barre~")).toBe("~barre~");
    });

    it("backticks restent", () => {
      expect(escapeSlackMrkdwn("`code`")).toBe("`code`");
    });
  });
});
