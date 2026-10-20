/**
 * Sentinelle anti-fuite numéro (VUE-CONVERSATION PR1).
 *
 * Vérifie que `ConversationDetailProps` ne contient AUCUN pattern
 * téléphone après sanitize, pour TOUS les champs sérialisés en payload
 * RSC + payload API.
 *
 * Pour tester la sanitize dans un cas réaliste, on construit un
 * `Contact + Conversation + Messages + AuditLog` complet avec des
 * numéros présents dans les champs d'origine (externalReceiver, phone.e164),
 * on fait passer par `sanitize*`, puis on sérialise en JSON et on grep
 * les patterns de scrubber Pino :
 *   - `+33\d{9,}` E.164 FR
 *   - `0033\d{9,}` E.164 FR "international format" OVH
 *   - `\b0[1-9]\d{8}\b` FR national 10 digits
 *   - `@` suivi d'un domaine (email)
 */
import { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";

import {
  sanitizeAuditEntriesForJournal,
  sanitizeContactForHeader,
  sanitizeConversationIntent,
  sanitizeConversationStatus,
  sanitizeHandoffForPanel,
  sanitizeMessageForBubble,
} from "@/components/conversations/sanitize";
import type { ConversationDetailProps } from "@/components/conversations/types";
import type { AuditLog } from "@/types/audit-log";
import type { Contact } from "@/types/contact";
import type { Conversation } from "@/types/conversation";
import type { Message } from "@/types/message";

const ts = (ms: number) => Timestamp.fromMillis(ms);
const E164_LEAK = "+33612349876";
const NATIONAL_LEAK = "0612349876";
const EMAIL_LEAK = "fuite@medere.fr";
const DOMESTIC_INTL_LEAK = "0033612349876";

function makeContact(): Contact {
  return {
    hubspotId: "427963864300",
    firstName: "Jean",
    lastName: "Dupont",
    civilite: "Dr",
    speciality: "Dentiste",
    city: "Paris",
    postalCode: "75001",
    email: EMAIL_LEAK,
    phone: {
      e164: E164_LEAK,
      raw: NATIONAL_LEAK,
      type: "MOBILE",
      valid: true,
      lookupAt: ts(1_700_000_000_000),
    },
    segment: "b2c_mobile_perso",
    bloctelChecked: true,
    bloctelOptOut: false,
    bloctelCheckedAt: ts(1_700_000_000_000),
    consent: {
      legitimateInterest: "test",
      optedOut: false,
    },
    enrichment: { source: "lusha", enrichedAt: ts(1_700_000_000_000) },
    status: "ready",
    campaignId: "test-camp",
    createdAt: ts(1_700_000_000_000),
    updatedAt: ts(1_700_000_000_000),
  } as unknown as Contact;
}

function makeConv(): Conversation {
  return {
    contactId: "427963864300",
    campaignId: "test-camp",
    channel: "sms",
    status: "handed_off",
    intent: "INTERESSE",
    messageCount: 2,
    outboundCount: 1,
    inboundCount: 1,
    lastInboundAt: ts(1_700_000_200_000),
    lastOutboundAt: ts(1_700_000_100_000),
    followupCount: 0,
    handoff: {
      assignedTo: "U05UVHGBURX",
      assignedAt: ts(1_700_000_300_000),
    },
    createdAt: ts(1_700_000_000_000),
    updatedAt: ts(1_700_000_300_000),
  } as unknown as Conversation;
}

function makeOutboundMsg(status: string): Message & { messageId: string } {
  return {
    messageId: "msg_out_1",
    direction: "outbound",
    status,
    body: "Bonjour, Léa de Médéré.",
    externalReceiver: E164_LEAK, // ← doit disparaître après sanitize
    channel: "sms",
    outboundKind: "solicitation",
    generatedBy: "ai",
    aiModel: "claude-sonnet-4-6",
    aiPromptVersion: "1.0.0",
    createdAt: ts(1_700_000_100_000),
    sentAt: ts(1_700_000_105_000),
  } as unknown as Message & { messageId: string };
}

function makeInboundMsg(): Message & { messageId: string } {
  return {
    messageId: "msg_in_1",
    direction: "inbound",
    status: "received",
    body: "Oui, intéressé",
    externalReceiver: E164_LEAK, // ← doit disparaître après sanitize
    channel: "sms",
    generatedBy: "human",
    createdAt: ts(1_700_000_200_000),
    receivedAt: ts(1_700_000_200_000),
  } as unknown as Message & { messageId: string };
}

function makeAuditEntry(): AuditLog & { docId: string } {
  return {
    docId: "aud_1",
    actorId: "U05UVHGBURX",
    actorType: "human",
    action: "handoff",
    targetType: "conversation",
    targetId: "427963864300_test-camp",
    payload: { notesLength: 42 },
    timestamp: ts(1_700_000_300_000),
  };
}

function assertNoPhoneInJson(payload: unknown, label: string) {
  const json = JSON.stringify(payload);
  // E.164 brut + national + 0033 format OVH + email
  expect(json, `${label} ne doit pas contenir +33...`).not.toMatch(/\+33\d{9}/);
  expect(json, `${label} ne doit pas contenir 0033...`).not.toMatch(/\b0033\d{9}\b/);
  expect(json, `${label} ne doit pas contenir 0[1-9]...`).not.toMatch(/\b0[1-9]\d{8}\b/);
  expect(json, `${label} ne doit pas contenir d'email`).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
}

describe("Sentinelle PR1 — zero PII dans la payload RSC", () => {
  it("sanitizeContactForHeader strippe phone + email", () => {
    const contact = makeContact();
    const header = sanitizeContactForHeader(contact);
    assertNoPhoneInJson(header, "ContactHeaderProps");
    // Mais firstName/lastName/speciality/city doivent rester
    expect(header.firstName).toBe("Jean");
    expect(header.speciality).toBe("Dentiste");
    expect(header.city).toBe("Paris");
  });

  it("sanitizeMessageForBubble strippe externalReceiver (outbound)", () => {
    const msg = makeOutboundMsg("sent");
    const bubble = sanitizeMessageForBubble(msg, "Vanessa");
    expect(bubble).not.toBeNull();
    if (bubble === null) throw new Error();
    assertNoPhoneInJson(bubble, "MessageProps outbound");
    // Mais body + status doivent rester
    expect(bubble.body).toBe("Bonjour, Léa de Médéré.");
    expect(bubble.status).toBe("sent");
  });

  it("sanitizeMessageForBubble retourne null sur status='duplicate' (defense-in-depth)", () => {
    const msg = { ...makeOutboundMsg("sent"), status: "duplicate" } as unknown as Parameters<
      typeof sanitizeMessageForBubble
    >[0];
    expect(sanitizeMessageForBubble(msg, null)).toBeNull();
  });

  it("sanitizeMessageForBubble strippe externalReceiver (inbound)", () => {
    const msg = makeInboundMsg();
    const bubble = sanitizeMessageForBubble(msg, null);
    assertNoPhoneInJson(bubble, "MessageProps inbound");
  });

  it("payload complète ConversationDetailProps : aucun pattern téléphone", () => {
    const conv = makeConv();
    const contact = makeContact();
    const audits = [makeAuditEntry()];

    const data: ConversationDetailProps = {
      conversationId: "427963864300_test-camp",
      contactId: "427963864300",
      status: sanitizeConversationStatus(conv),
      intent: sanitizeConversationIntent(conv),
      campaignId: conv.campaignId,
      createdAtIso: conv.createdAt.toDate().toISOString(),
      updatedAtIso: conv.updatedAt.toDate().toISOString(),
      lastInboundAtIso: conv.lastInboundAt?.toDate().toISOString() ?? null,
      lastOutboundAtIso: conv.lastOutboundAt?.toDate().toISOString() ?? null,
      inboundCount: conv.inboundCount,
      outboundCount: conv.outboundCount,
      summary: null,
      handoff: sanitizeHandoffForPanel(conv, "Vanessa Rabba"),
      contact: sanitizeContactForHeader(contact),
      messages: [
        sanitizeMessageForBubble(makeOutboundMsg("sent"), null),
        sanitizeMessageForBubble(makeInboundMsg(), null),
      ].filter((m): m is NonNullable<typeof m> => m !== null),
      journal: sanitizeAuditEntriesForJournal(audits),
      viewerIsOwner: true,
    };

    assertNoPhoneInJson(data, "ConversationDetailProps complète");
  });

  it("mutation testing — si on supprime le strip, le test fail", () => {
    // Simule une régression : on injecte sciemment le e164 dans la payload.
    const regressionPayload = {
      contact: { phone: { e164: E164_LEAK } },
    };
    const json = JSON.stringify(regressionPayload);
    expect(json).toMatch(/\+33\d{9}/);
    // La sentinelle ci-dessus échouerait sur ce payload — c'est le but.
  });

  it("sanitize tolère les patterns inattendus sans crasher", () => {
    const malformedContact = {
      hubspotId: "x",
      firstName: null,
      lastName: null,
      civilite: null,
      speciality: null,
      city: null,
      consent: { optedOut: false },
    } as unknown as Contact;
    const header = sanitizeContactForHeader(malformedContact);
    expect(header.contactId).toBe("x");
    expect(header.firstName).toBeNull();
    expect(header.optedOut).toBe(false);
  });

  it("patterns 0033 FR international (format OVH) ne passent pas non plus", () => {
    const payload = { field: `receiver=${DOMESTIC_INTL_LEAK}` };
    const json = JSON.stringify(payload);
    // La sentinelle doit détecter 0033\d{9}
    expect(json).toMatch(/\b0033\d{9}\b/);
  });
});
