import { describe, expect, it } from "vitest";

import {
  __BODY_MAX_LENGTH_FOR_TESTS,
  __EVENT_NAMES_FOR_TESTS,
  smsReplyReceived,
  SmsReplyReceivedDataSchema,
  smsSendFirstRequested,
  SmsSendFirstRequestedDataSchema,
} from "./events";

// ─────────────────────────────────────────────────────────────────────────────
// Sentinelles de noms d'events
// ─────────────────────────────────────────────────────────────────────────────

describe("EVENT_NAMES — sentinelles anti-régression", () => {
  it("SMS_SEND_FIRST_REQUESTED est figé à 'medere/sms.send-first.requested'", () => {
    // Modifier ce nom = casse les émetteurs (scripts, webhook futur).
    // Test sentinelle pour empêcher le drift silencieux.
    expect(__EVENT_NAMES_FOR_TESTS.SMS_SEND_FIRST_REQUESTED).toBe(
      "medere/sms.send-first.requested",
    );
  });

  it("SMS_REPLY_RECEIVED est figé à 'medere/sms.reply.received'", () => {
    expect(__EVENT_NAMES_FOR_TESTS.SMS_REPLY_RECEIVED).toBe("medere/sms.reply.received");
  });

  it("EventType `smsSendFirstRequested.name` correspond à la constante", () => {
    expect(smsSendFirstRequested.name).toBe(__EVENT_NAMES_FOR_TESTS.SMS_SEND_FIRST_REQUESTED);
  });

  it("EventType `smsReplyReceived.name` correspond à la constante", () => {
    expect(smsReplyReceived.name).toBe(__EVENT_NAMES_FOR_TESTS.SMS_REPLY_RECEIVED);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SmsSendFirstRequestedDataSchema — validation runtime
// ─────────────────────────────────────────────────────────────────────────────

describe("SmsSendFirstRequestedDataSchema", () => {
  const validData = {
    contactId: "contact-abc-123",
    campaignId: "campaign-q4-dental",
    body: "Bonjour, Léa, assistante IA de Médéré. Pour vous désinscrire : STOP.",
  };

  it("accepte un payload bien formé", () => {
    const result = SmsSendFirstRequestedDataSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  it("refuse contactId vide", () => {
    const result = SmsSendFirstRequestedDataSchema.safeParse({ ...validData, contactId: "" });
    expect(result.success).toBe(false);
  });

  it("refuse campaignId vide", () => {
    const result = SmsSendFirstRequestedDataSchema.safeParse({ ...validData, campaignId: "" });
    expect(result.success).toBe(false);
  });

  it("refuse body vide", () => {
    const result = SmsSendFirstRequestedDataSchema.safeParse({ ...validData, body: "" });
    expect(result.success).toBe(false);
  });

  it("refuse body > BODY_MAX_LENGTH (1600 chars)", () => {
    const overlong = "a".repeat(__BODY_MAX_LENGTH_FOR_TESTS + 1);
    const result = SmsSendFirstRequestedDataSchema.safeParse({ ...validData, body: overlong });
    expect(result.success).toBe(false);
  });

  it("accepte body exactement BODY_MAX_LENGTH (1600 chars)", () => {
    const max = "a".repeat(__BODY_MAX_LENGTH_FOR_TESTS);
    const result = SmsSendFirstRequestedDataSchema.safeParse({ ...validData, body: max });
    expect(result.success).toBe(true);
  });

  it("strictObject : refuse un champ inattendu (anti-bypass)", () => {
    // Sentinelle : si un caller injecte `dryRun: true` ou autre via cast TS
    // forcé, le schéma doit throw plutôt que stripper silencieusement.
    const sneaky = { ...validData, dryRun: true };
    const result = SmsSendFirstRequestedDataSchema.safeParse(sneaky);
    expect(result.success).toBe(false);
  });

  it("refuse les champs manquants", () => {
    const result = SmsSendFirstRequestedDataSchema.safeParse({
      contactId: "c",
      // campaignId missing
      body: "x",
    });
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SmsReplyReceivedDataSchema — validation runtime
// ─────────────────────────────────────────────────────────────────────────────

describe("SmsReplyReceivedDataSchema", () => {
  const validData = {
    phone: "+33775745453",
    body: "Bonjour, oui je suis intéressé.",
    ovhMessageId: "ovh-msg-12345",
  };

  it("accepte un payload bien formé", () => {
    const result = SmsReplyReceivedDataSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  it("refuse phone non-E.164 (pas de '+')", () => {
    const result = SmsReplyReceivedDataSchema.safeParse({ ...validData, phone: "33775745453" });
    expect(result.success).toBe(false);
  });

  it("refuse phone avec leading zero après '+'", () => {
    const result = SmsReplyReceivedDataSchema.safeParse({ ...validData, phone: "+03775745453" });
    expect(result.success).toBe(false);
  });

  it("refuse phone trop court (< 7 chiffres après '+1')", () => {
    const result = SmsReplyReceivedDataSchema.safeParse({ ...validData, phone: "+12345" });
    expect(result.success).toBe(false);
  });

  it("refuse phone trop long (> 15 chiffres totaux)", () => {
    const result = SmsReplyReceivedDataSchema.safeParse({
      ...validData,
      phone: "+1234567890123456",
    });
    expect(result.success).toBe(false);
  });

  it("accepte phone US +1XXXXXXXXXX (10 digits après +1)", () => {
    const result = SmsReplyReceivedDataSchema.safeParse({
      ...validData,
      phone: "+14155552671",
    });
    expect(result.success).toBe(true);
  });

  it("refuse body vide", () => {
    const result = SmsReplyReceivedDataSchema.safeParse({ ...validData, body: "" });
    expect(result.success).toBe(false);
  });

  it("refuse body > 1600 chars", () => {
    const overlong = "a".repeat(__BODY_MAX_LENGTH_FOR_TESTS + 1);
    const result = SmsReplyReceivedDataSchema.safeParse({ ...validData, body: overlong });
    expect(result.success).toBe(false);
  });

  it("refuse ovhMessageId vide", () => {
    const result = SmsReplyReceivedDataSchema.safeParse({ ...validData, ovhMessageId: "" });
    expect(result.success).toBe(false);
  });

  it("strictObject : refuse un champ inattendu (anti-bypass)", () => {
    const sneaky = { ...validData, autoReply: true };
    const result = SmsReplyReceivedDataSchema.safeParse(sneaky);
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EventType — contrat structurel
// ─────────────────────────────────────────────────────────────────────────────

describe("EventType — structure Inngest", () => {
  it("smsSendFirstRequested expose `.name`, `.schema` et `.create()`", () => {
    expect(typeof smsSendFirstRequested.name).toBe("string");
    expect(smsSendFirstRequested.schema).toBe(SmsSendFirstRequestedDataSchema);
    expect(typeof smsSendFirstRequested.create).toBe("function");
  });

  it("smsReplyReceived expose `.name`, `.schema` et `.create()`", () => {
    expect(typeof smsReplyReceived.name).toBe("string");
    expect(smsReplyReceived.schema).toBe(SmsReplyReceivedDataSchema);
    expect(typeof smsReplyReceived.create).toBe("function");
  });

  it("smsSendFirstRequested.create() produit un payload `{ name, data }`", () => {
    const payload = smsSendFirstRequested.create({
      contactId: "c1",
      campaignId: "k1",
      body: "Bonjour",
    });
    expect(payload.name).toBe("medere/sms.send-first.requested");
    expect(payload.data).toEqual({ contactId: "c1", campaignId: "k1", body: "Bonjour" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sentinelle BODY_MAX_LENGTH
// ─────────────────────────────────────────────────────────────────────────────

describe("BODY_MAX_LENGTH — cohérence cross-module", () => {
  it("est figé à 1600 (aligné firestore/messages.ts + ovh/send-sms.ts)", () => {
    // Cf. JSDoc events.ts en-tête : drift = events acceptés Inngest mais
    // refusés par les wrappers downstream. Sentinelle obligatoire.
    expect(__BODY_MAX_LENGTH_FOR_TESTS).toBe(1600);
  });
});
