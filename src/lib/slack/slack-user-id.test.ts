import { describe, expect, it } from "vitest";

import { ValidationError } from "@/lib/utils/errors";

import { assertSlackUserId, SLACK_USER_ID_REGEX } from "./slack-user-id";

describe("SLACK_USER_ID_REGEX — sentinelle de format", () => {
  it("accepte un U-id standard moderne (11 chars)", () => {
    expect(SLACK_USER_ID_REGEX.test("U05UVHGBURX")).toBe(true);
  });

  it("accepte un U-id prod reel confirme (U06Q0ECSG91)", () => {
    // Reference brief Dethie : conv de test porte cet ID — doit matcher
    // sans quoi la PR casserait la prod.
    expect(SLACK_USER_ID_REGEX.test("U06Q0ECSG91")).toBe(true);
  });

  it("accepte un W-id (Enterprise Grid)", () => {
    expect(SLACK_USER_ID_REGEX.test("WABCDEFGHIJ")).toBe(true);
  });

  it("rejette un U-id trop court (U + 7 = 8 chars)", () => {
    // Minimum applique = 9 chars (U + 8) pour matcher les IDs les plus anciens.
    expect(SLACK_USER_ID_REGEX.test("UABCDEFG")).toBe(false);
  });

  it("rejette un prefixe autre que U/W", () => {
    expect(SLACK_USER_ID_REGEX.test("C05UVHGBURX")).toBe(false); // channel ID
    expect(SLACK_USER_ID_REGEX.test("D05UVHGBURX")).toBe(false); // DM channel ID
    expect(SLACK_USER_ID_REGEX.test("B05UVHGBURX")).toBe(false); // bot ID
  });

  it("rejette minuscules", () => {
    expect(SLACK_USER_ID_REGEX.test("u05uvhgburx")).toBe(false);
  });

  it("rejette un wrapping mention `<@U...>`", () => {
    expect(SLACK_USER_ID_REGEX.test("<@U05UVHGBURX>")).toBe(false);
  });

  it("rejette un email", () => {
    expect(SLACK_USER_ID_REGEX.test("vanessa@medere.fr")).toBe(false);
  });

  it("rejette un nom humain", () => {
    expect(SLACK_USER_ID_REGEX.test("Vanessa Rabba")).toBe(false);
    expect(SLACK_USER_ID_REGEX.test("VanessaRabba")).toBe(false);
  });

  it("rejette chaine vide", () => {
    expect(SLACK_USER_ID_REGEX.test("")).toBe(false);
  });
});

describe("assertSlackUserId", () => {
  it("ne throw rien sur un ID valide", () => {
    expect(() => assertSlackUserId("U05UVHGBURX", "setHandoff")).not.toThrow();
  });

  it("throw ValidationError sur un ID invalide", () => {
    expect(() => assertSlackUserId("not-a-slack-id", "setHandoff")).toThrow(ValidationError);
  });

  it("le context de l'erreur ne contient PAS la valeur brute (anti-PII)", () => {
    // Un humain pourrait avoir tape son nom au lieu d'un ID. On ne doit
    // pas leaker ce nom dans les logs d'erreur.
    try {
      assertSlackUserId("Vanessa Rabba", "sendHandoff");
      expect.fail("should have thrown");
    } catch (e) {
      const err = e as ValidationError;
      const ctx = err.context as Record<string, unknown>;
      expect(ctx.operation).toBe("sendHandoff");
      expect(ctx.inputLength).toBe(13);
      const serialized = JSON.stringify(ctx);
      expect(serialized).not.toContain("Vanessa");
      expect(serialized).not.toContain("Rabba");
    }
  });
});
