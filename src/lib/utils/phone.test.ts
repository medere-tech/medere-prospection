import { describe, expect, it } from "vitest";

import { inferPhoneType, isValidE164, maskPhone, parsePhone, toE164 } from "./phone";

describe("toE164", () => {
  it("normalise un mobile FR en format national vers E.164", () => {
    expect(toE164("06 12 34 56 78")).toBe("+33612345678");
    expect(toE164("0612345678")).toBe("+33612345678");
  });

  it("accepte un numéro déjà international", () => {
    expect(toE164("+33 6 12 34 56 78")).toBe("+33612345678");
    expect(toE164("+44 7400 123456")).toBe("+447400123456");
  });

  it("respecte le pays par défaut fourni", () => {
    expect(toE164("020 7946 0958", "GB")).toBe("+442079460958");
  });

  it("renvoie null pour une saisie non interprétable", () => {
    expect(toE164("blah")).toBeNull();
    expect(toE164("")).toBeNull();
  });

  it("renvoie null pour un numéro invalide (trop court)", () => {
    expect(toE164("+331")).toBeNull();
  });
});

describe("isValidE164", () => {
  it("vrai pour un E.164 valide", () => {
    expect(isValidE164("+33612345678")).toBe(true);
    expect(isValidE164("+447400123456")).toBe(true);
  });

  it("faux pour un numéro national (sans +) ou invalide", () => {
    expect(isValidE164("0612345678")).toBe(false);
    expect(isValidE164("+33612")).toBe(false);
    expect(isValidE164("not a phone")).toBe(false);
  });
});

describe("inferPhoneType", () => {
  it("distingue mobile / fixe / voip en France", () => {
    expect(inferPhoneType("06 12 34 56 78")).toBe("mobile");
    expect(inferPhoneType("07 55 66 77 88")).toBe("mobile");
    expect(inferPhoneType("01 42 68 53 00")).toBe("landline");
    expect(inferPhoneType("09 70 12 34 56")).toBe("voip");
  });

  it("renvoie unknown pour les numéros spéciaux et l'ambigu", () => {
    expect(inferPhoneType("08 92 70 12 39")).toBe("unknown"); // premium rate
    expect(inferPhoneType("blah")).toBe("unknown");
  });

  it("gère un mobile étranger", () => {
    expect(inferPhoneType("+44 7400 123456")).toBe("mobile");
  });
});

describe("parsePhone", () => {
  it("renvoie e164 + valid + type pour un numéro interprétable", () => {
    expect(parsePhone("06 12 34 56 78")).toEqual({
      e164: "+33612345678",
      valid: true,
      type: "mobile",
    });
  });

  it("renvoie null pour une saisie non interprétable", () => {
    expect(parsePhone("xxxxx")).toBeNull();
  });
});

describe("maskPhone", () => {
  it("conserve indicatif + 2 derniers chiffres, masque le reste", () => {
    expect(maskPhone("+33612345678")).toBe("+33*******78");
    expect(maskPhone("+447400123456")).toBe("+44********56");
  });

  it("masque entièrement une chaîne courte", () => {
    expect(maskPhone("")).toBe("");
    expect(maskPhone("12345")).toBe("*****");
  });

  it("ne révèle jamais le numéro complet", () => {
    const full = "+33612345678";
    expect(maskPhone(full)).not.toContain("612345");
  });
});
