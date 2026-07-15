/**
 * Tests parseIncomingOvhSms — CALLBACK PUSH (S9.6-FIX2, INFRA-SMS-001).
 *
 * Scope : parser pur (Zod + normalisation E.164). Vérifie :
 *   - happy path sur le format callback push RÉEL (senderid, id number, etc.)
 *   - conversion id NUMBER → ovhMessageId STRING
 *   - normalisation E.164 du senderid (0033XXX, 33XXX, +33XXX, 06XX)
 *   - throw ValidationError sur toutes les shapes invalides
 *   - tolérance aux champs OVH optionnels (keyword, shortcode, tag, token)
 *   - strip des champs surnuméraires (compat future OVH)
 *   - anti-PII : le sender complet ne fuit jamais dans err.context
 */
import { describe, expect, it } from "vitest";

import { ValidationError } from "@/lib/utils/errors";

import { parseIncomingOvhSms } from "./parse-incoming";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture — payload callback push RÉEL (capturé prod S9.6-FIX diag)
// ─────────────────────────────────────────────────────────────────────────────

const REAL_OVH_CALLBACK = {
  id: 118791103,
  senderid: "+33775745453",
  message: "Test réception Medere 1",
  keyword: "",
  shortcode: "+33939070545",
  tag: "",
  token: "shared-secret-value",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("parseIncomingOvhSms — happy path (callback push format)", () => {
  it("mappe le payload OVH callback réel vers {phone, body, ovhMessageId}", () => {
    const result = parseIncomingOvhSms(REAL_OVH_CALLBACK);
    expect(result).toEqual({
      phone: "+33775745453",
      body: "Test réception Medere 1",
      ovhMessageId: "118791103",
    });
  });

  it("convertit id NUMBER en ovhMessageId STRING (contrat SmsReplyReceivedDataSchema)", () => {
    const result = parseIncomingOvhSms({ ...REAL_OVH_CALLBACK, id: 42 });
    expect(result.ovhMessageId).toBe("42");
    expect(typeof result.ovhMessageId).toBe("string");
  });

  it("préserve le message tel quel, sans trim ni normalisation", () => {
    const withSpaces = "  Bonjour Léa, oui je suis intéressé  ";
    const result = parseIncomingOvhSms({ ...REAL_OVH_CALLBACK, message: withSpaces });
    expect(result.body).toBe(withSpaces);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation E.164 via toE164('FR')
// ─────────────────────────────────────────────────────────────────────────────

describe("parseIncomingOvhSms — normalisation E.164 du senderid", () => {
  it("accepte senderid déjà E.164 canonique (+33775745453)", () => {
    const result = parseIncomingOvhSms({ ...REAL_OVH_CALLBACK, senderid: "+33612345678" });
    expect(result.phone).toBe("+33612345678");
  });

  it("normalise senderid national FR sans + (0612345678 → +33612345678)", () => {
    const result = parseIncomingOvhSms({ ...REAL_OVH_CALLBACK, senderid: "0612345678" });
    expect(result.phone).toBe("+33612345678");
  });

  it("normalise senderid préfixe international 00 (0033612345678 → +33612345678)", () => {
    const result = parseIncomingOvhSms({ ...REAL_OVH_CALLBACK, senderid: "0033612345678" });
    expect(result.phone).toBe("+33612345678");
  });

  it("normalise senderid E.164 sans + (33612345678 → +33612345678)", () => {
    const result = parseIncomingOvhSms({ ...REAL_OVH_CALLBACK, senderid: "33612345678" });
    expect(result.phone).toBe("+33612345678");
  });

  it("throw si senderid non-numérique (contient lettres)", () => {
    expect(() => parseIncomingOvhSms({ ...REAL_OVH_CALLBACK, senderid: "notaphone" })).toThrow(
      ValidationError,
    );
  });

  it("throw si senderid trop court pour être un vrai numéro FR", () => {
    expect(() => parseIncomingOvhSms({ ...REAL_OVH_CALLBACK, senderid: "123" })).toThrow(
      ValidationError,
    );
  });

  it("le message d'erreur ne fuit PAS le senderid complet (anti-PII)", () => {
    try {
      parseIncomingOvhSms({ ...REAL_OVH_CALLBACK, senderid: "notaphonenumber123" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      if (err instanceof ValidationError) {
        expect(err.message).not.toContain("notaphonenumber123");
        expect(JSON.stringify(err.context)).not.toContain("notaphonenumber123");
        // Seul senderidLength doit apparaître pour observabilité.
        expect(err.context).toMatchObject({ senderidLength: 18 });
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tolérance aux champs OVH optionnels + strip surnuméraires
// ─────────────────────────────────────────────────────────────────────────────

describe("parseIncomingOvhSms — champs optionnels + surnuméraires", () => {
  it("accepte un payload minimal (id/senderid/message uniquement)", () => {
    const result = parseIncomingOvhSms({
      id: 42,
      senderid: "+33612345678",
      message: "OK",
    });
    expect(result).toEqual({
      phone: "+33612345678",
      body: "OK",
      ovhMessageId: "42",
    });
  });

  it("accepte keyword/shortcode/tag/token présents sans les rejeter", () => {
    const result = parseIncomingOvhSms(REAL_OVH_CALLBACK);
    // Le résultat downstream ne contient QUE les 3 champs event, pas les extras.
    expect(Object.keys(result).sort()).toEqual(["body", "ovhMessageId", "phone"]);
  });

  it("strip les champs surnuméraires OVH sans throw (compat future)", () => {
    const result = parseIncomingOvhSms({
      ...REAL_OVH_CALLBACK,
      newFieldAddedByOvh: "some_value",
      anotherOne: 123,
    });
    expect(result).toEqual({
      phone: "+33775745453",
      body: "Test réception Medere 1",
      ovhMessageId: "118791103",
    });
  });

  it("IGNORE le token du body (l'auth vit dans le query param côté route)", () => {
    const result = parseIncomingOvhSms({ ...REAL_OVH_CALLBACK, token: "any-value-here" });
    // Aucune assertion sur token → pas exposé côté event. Ce test verrouille
    // qu'on ne s'appuie PAS sur token pour la logique métier downstream.
    expect(result).not.toHaveProperty("token");
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
    expect(() => parseIncomingOvhSms({ senderid: "+33612345678", message: "test" })).toThrow(
      ValidationError,
    );
  });

  it("throw si id est une string (contrat NUMBER strict côté route)", () => {
    expect(() => parseIncomingOvhSms({ ...REAL_OVH_CALLBACK, id: "118791103" })).toThrow(
      ValidationError,
    );
  });

  it("throw si id n'est pas un entier (float)", () => {
    expect(() => parseIncomingOvhSms({ ...REAL_OVH_CALLBACK, id: 42.5 })).toThrow(ValidationError);
  });

  it("throw si senderid absent", () => {
    const withoutSenderid: Record<string, unknown> = { ...REAL_OVH_CALLBACK };
    delete withoutSenderid.senderid;
    expect(() => parseIncomingOvhSms(withoutSenderid)).toThrow(ValidationError);
  });

  it("throw si senderid vide", () => {
    expect(() => parseIncomingOvhSms({ ...REAL_OVH_CALLBACK, senderid: "" })).toThrow(
      ValidationError,
    );
  });

  it("throw si message absent", () => {
    const withoutMessage: Record<string, unknown> = { ...REAL_OVH_CALLBACK };
    delete withoutMessage.message;
    expect(() => parseIncomingOvhSms(withoutMessage)).toThrow(ValidationError);
  });

  it("throw si message vide", () => {
    expect(() => parseIncomingOvhSms({ ...REAL_OVH_CALLBACK, message: "" })).toThrow(
      ValidationError,
    );
  });

  it("throw si message > 1600 chars (borne GSM-7 x10 segments)", () => {
    expect(() => parseIncomingOvhSms({ ...REAL_OVH_CALLBACK, message: "x".repeat(1601) })).toThrow(
      ValidationError,
    );
  });

  it("accepte un message pile 1600 chars (borne inclusive)", () => {
    const result = parseIncomingOvhSms({ ...REAL_OVH_CALLBACK, message: "x".repeat(1600) });
    expect(result.body.length).toBe(1600);
  });

  it("throw si le NOM d'ancien champ 'sender' est fourni au lieu de 'senderid' (anti-régression S9.6-FIX2)", () => {
    // Sentinelle : vérifie qu'un payload GET /incoming (qui a `sender`) est
    // bien rejeté par ce parser (dédié au callback push, format `senderid`).
    // Si demain quelqu'un remet accidentellement `sender` dans le schema, ce
    // test casse.
    const legacyGetIncomingShape: Record<string, unknown> = {
      id: 118791103,
      sender: "+33775745453", // ← ancien nom de champ
      message: "test",
    };
    expect(() => parseIncomingOvhSms(legacyGetIncomingShape)).toThrow(ValidationError);
  });
});
