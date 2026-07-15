/**
 * Tests parseIncomingOvhSms (S9.6, INFRA-SMS-001).
 *
 * Scope : parser pur (Zod + validation E.164). Vérifie :
 *   - happy path sur le payload OVH réel capturé (S9.6-EXPLORE)
 *   - conversion id NUMBER → ovhMessageId STRING
 *   - validation stricte E.164 du sender
 *   - throw ValidationError sur toutes les shapes invalides
 *   - tolérance aux champs optionnels absents (payload callback minimaliste)
 *   - strip des champs surnuméraires (compat future OVH)
 */
import { describe, expect, it } from "vitest";

import { ValidationError } from "@/lib/utils/errors";

import { parseIncomingOvhSms } from "./parse-incoming";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture — payload OVH réel capturé S9.6-EXPLORE sur sms-ng66707-1
// ─────────────────────────────────────────────────────────────────────────────

const REAL_OVH_INBOUND = {
  credits: 0,
  creationDatetime: "2026-07-15T12:24:10+02:00",
  id: 118791103,
  sender: "+33775745453",
  message: "Test réception Medere 1",
  tag: "",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("parseIncomingOvhSms — happy path", () => {
  it("mappe le payload OVH réel vers {phone, body, ovhMessageId}", () => {
    const result = parseIncomingOvhSms(REAL_OVH_INBOUND);
    expect(result).toEqual({
      phone: "+33775745453",
      body: "Test réception Medere 1",
      ovhMessageId: "118791103",
    });
  });

  it("convertit id NUMBER en ovhMessageId STRING (contrat SmsReplyReceivedDataSchema)", () => {
    const result = parseIncomingOvhSms({ ...REAL_OVH_INBOUND, id: 42 });
    expect(result.ovhMessageId).toBe("42");
    expect(typeof result.ovhMessageId).toBe("string");
  });

  it("préserve le sender E.164 tel quel, sans re-normalisation", () => {
    const result = parseIncomingOvhSms({ ...REAL_OVH_INBOUND, sender: "+33612345678" });
    expect(result.phone).toBe("+33612345678");
  });

  it("préserve le message tel quel, sans trim ni normalisation", () => {
    const withSpaces = "  Bonjour Léa, oui je suis intéressé  ";
    const result = parseIncomingOvhSms({ ...REAL_OVH_INBOUND, message: withSpaces });
    expect(result.body).toBe(withSpaces);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tolérance aux champs optionnels
// ─────────────────────────────────────────────────────────────────────────────

describe("parseIncomingOvhSms — payload minimaliste (compat callback OVH)", () => {
  it("accepte un payload avec uniquement id/sender/message (creationDatetime absent)", () => {
    const result = parseIncomingOvhSms({
      id: 42,
      sender: "+33775745453",
      message: "OK",
    });
    expect(result).toEqual({
      phone: "+33775745453",
      body: "OK",
      ovhMessageId: "42",
    });
  });

  it("strip les champs surnuméraires sans throw (compat future OVH)", () => {
    const result = parseIncomingOvhSms({
      ...REAL_OVH_INBOUND,
      // Simulation d'un nouveau champ OVH ajouté dans le futur.
      newFieldAddedByOvh: "some_value",
      anotherOne: 123,
    });
    expect(result).toEqual({
      phone: "+33775745453",
      body: "Test réception Medere 1",
      ovhMessageId: "118791103",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Erreurs de shape (Zod)
// ─────────────────────────────────────────────────────────────────────────────

describe("parseIncomingOvhSms — throw ValidationError sur shape invalide", () => {
  it("throw si raw n'est pas un objet (null)", () => {
    expect(() => parseIncomingOvhSms(null)).toThrow(ValidationError);
  });

  it("throw si raw n'est pas un objet (string)", () => {
    expect(() => parseIncomingOvhSms("not an object")).toThrow(ValidationError);
  });

  it("throw si id absent", () => {
    expect(() => parseIncomingOvhSms({ sender: "+33775745453", message: "test" })).toThrow(
      ValidationError,
    );
  });

  it("throw si id est une string (contrat NUMBER strict)", () => {
    expect(() => parseIncomingOvhSms({ ...REAL_OVH_INBOUND, id: "118791103" })).toThrow(
      ValidationError,
    );
  });

  it("throw si id n'est pas un entier (float)", () => {
    expect(() => parseIncomingOvhSms({ ...REAL_OVH_INBOUND, id: 42.5 })).toThrow(ValidationError);
  });

  it("throw si sender absent", () => {
    const withoutSender: Record<string, unknown> = { ...REAL_OVH_INBOUND };
    delete withoutSender.sender;
    expect(() => parseIncomingOvhSms(withoutSender)).toThrow(ValidationError);
  });

  it("throw si sender vide", () => {
    expect(() => parseIncomingOvhSms({ ...REAL_OVH_INBOUND, sender: "" })).toThrow(ValidationError);
  });

  it("throw si message absent", () => {
    const withoutMessage: Record<string, unknown> = { ...REAL_OVH_INBOUND };
    delete withoutMessage.message;
    expect(() => parseIncomingOvhSms(withoutMessage)).toThrow(ValidationError);
  });

  it("throw si message vide", () => {
    expect(() => parseIncomingOvhSms({ ...REAL_OVH_INBOUND, message: "" })).toThrow(
      ValidationError,
    );
  });

  it("throw si message > 1600 chars (borne GSM-7 x10 segments)", () => {
    expect(() => parseIncomingOvhSms({ ...REAL_OVH_INBOUND, message: "x".repeat(1601) })).toThrow(
      ValidationError,
    );
  });

  it("accepte un message pile 1600 chars (borne inclusive)", () => {
    const result = parseIncomingOvhSms({ ...REAL_OVH_INBOUND, message: "x".repeat(1600) });
    expect(result.body.length).toBe(1600);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation E.164 stricte du sender
// ─────────────────────────────────────────────────────────────────────────────

describe("parseIncomingOvhSms — validation E.164 stricte du sender", () => {
  it("throw si sender au format national FR sans +33 (0775...)", () => {
    expect(() => parseIncomingOvhSms({ ...REAL_OVH_INBOUND, sender: "0775745453" })).toThrow(
      ValidationError,
    );
  });

  it("throw si sender au format +33 avec leading zero (regex E164 refuse)", () => {
    expect(() => parseIncomingOvhSms({ ...REAL_OVH_INBOUND, sender: "+0612345678" })).toThrow(
      ValidationError,
    );
  });

  it("throw si sender contient un espace", () => {
    expect(() => parseIncomingOvhSms({ ...REAL_OVH_INBOUND, sender: "+33 6 12 34 56 78" })).toThrow(
      ValidationError,
    );
  });

  it("throw si sender contient des lettres", () => {
    expect(() => parseIncomingOvhSms({ ...REAL_OVH_INBOUND, sender: "+33abc" })).toThrow(
      ValidationError,
    );
  });

  it("le message d'erreur ne fuit PAS le sender complet (anti-PII)", () => {
    try {
      parseIncomingOvhSms({ ...REAL_OVH_INBOUND, sender: "0775745453" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      if (err instanceof ValidationError) {
        expect(err.message).not.toContain("0775745453");
        expect(JSON.stringify(err.context)).not.toContain("0775745453");
        // Seul senderLength doit apparaître pour observabilité.
        expect(err.context).toMatchObject({ senderLength: 10 });
      }
    }
  });
});
