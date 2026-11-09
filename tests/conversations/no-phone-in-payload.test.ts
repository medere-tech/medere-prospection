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
// PR2a — source unique de regex PII (partagée avec logger + routes
// `/api/admin/conversations*` + sanitize `lastMessagePreview.text`).
// Avant PR2a, ce fichier redéfinissait les 4 regexes inline → 2 nettoyeurs.
// Désormais un seul : `src/lib/utils/pii-scrubber.ts`.
import { containsEmail, containsFrenchPhoneNumber } from "@/lib/utils/pii-scrubber";
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
    actorTestAccount: false,
    action: "handoff",
    targetType: "conversation",
    targetId: "427963864300_test-camp",
    payload: { notesLength: 42 },
    timestamp: ts(1_700_000_300_000),
  };
}

function assertNoPhoneInJson(payload: unknown, label: string) {
  const json = JSON.stringify(payload);
  // PR2a — délègue à pii-scrubber (source unique). `containsFrenchPhoneNumber`
  // couvre E.164 (+33...), national (0X...) et format OVH (0033...) via
  // `normalizeInterDigitSeparators` + `FRENCH_PHONE_ANYWHERE_REGEX`.
  expect(containsFrenchPhoneNumber(json), `${label} ne doit pas contenir de numéro FR`).toBe(false);
  expect(containsEmail(json), `${label} ne doit pas contenir d'email`).toBe(false);
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

  it("sanitizeContactForHeader — phoneLast4 fait EXACTEMENT 4 chiffres, aucun autre champ ne contient de numéro", () => {
    // Le navigateur reçoit `phoneLast4` depuis PR3 tour 2b. On verrouille :
    //   1. phoneLast4 est présent, 4 caractères, 4 chiffres.
    //   2. AUCUN autre champ du header ne contient un pattern NUMÉRO FR —
    //      `containsFrenchPhoneNumber` (scrubber projet) attrape E.164,
    //      national FR, 0033 et les séparateurs variés. Le `contactId`
    //      HubSpot est un identifiant numérique opaque LEGITIME (12
    //      chiffres consécutifs) qui ne doit PAS déclencher la sentinelle :
    //      le scrubber ne matche pas car ça ne commence pas par un pattern
    //      téléphone valide.
    //   3. Les clefs `e164`, `raw`, `phone` ne sont PAS présentes
    //      (projection explicite, miroir de la sanitize serveur).
    const contact = makeContact();
    const header = sanitizeContactForHeader(contact);
    expect(header.phoneLast4).toHaveLength(4);
    expect(header.phoneLast4).toMatch(/^\d{4}$/);
    // Projection : les autres champs ne doivent PAS matcher un numéro FR.
    const otherFields = {
      contactId: header.contactId,
      civilite: header.civilite,
      firstName: header.firstName,
      lastName: header.lastName,
      speciality: header.speciality,
      city: header.city,
      optedOut: header.optedOut,
    };
    const otherJson = JSON.stringify(otherFields);
    expect(
      containsFrenchPhoneNumber(otherJson),
      "aucun champ de ContactHeaderProps hors phoneLast4 ne doit contenir un pattern FR",
    ).toBe(false);
    // Clefs interdites — l'objet header ne doit avoir QUE le flag + last4.
    expect(header).not.toHaveProperty("e164");
    expect(header).not.toHaveProperty("raw");
    expect(header).not.toHaveProperty("phone");
    // Preuve directe que les 4 chiffres sont bien les DERNIERS du e164
    // d'entrée (et PAS les premiers ni un slice arbitraire). `contact`
    // fixture a bien `phone.e164` → le fail-closed null ne s'applique pas ici.
    expect(header.phoneLast4).not.toBeNull();
    expect(header.phoneLast4).toBe(contact.phone.e164.slice(-4));
    // phoneLast4 isolé ne matche PAS la sentinelle téléphone FR
    // (puisque 4 chiffres seuls ne reconstituent pas un numéro).
    expect(containsFrenchPhoneNumber(header.phoneLast4 ?? "")).toBe(false);
  });

  it("sanitizeContactForHeader — contact SANS phone.e164 → phoneLast4=null (fail-closed PR3 tour 2b bis quinquies)", () => {
    // Doc corrompu (phone absent) : au lieu de poser un faux `"0000"`
    // qui tromperait l'UI et déclencherait un 500 côté serveur quand
    // l'admin cliquerait « Afficher », on retourne `null` et l'UI rend
    // « Numéro indisponible » sans bouton.
    const corrupted = { ...makeContact() } as unknown as Record<string, unknown>;
    delete corrupted.phone;
    const header = sanitizeContactForHeader(
      corrupted as unknown as Parameters<typeof sanitizeContactForHeader>[0],
    );
    expect(header.phoneLast4).toBeNull();
    // Les autres champs restent intacts.
    expect(header.firstName).toBe("Jean");
    expect(header.contactId).toBe("427963864300");
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
      campaignName: conv.campaignName ?? null,
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
      journal: sanitizeAuditEntriesForJournal(audits, {
        actorNameByUserId: new Map(),
        viewerIsTestAccount: false,
      }),
      viewerIsOwner: true,
      canMarkContacted: false,
      canUndoContact: false,
    };

    assertNoPhoneInJson(data, "ConversationDetailProps complète");
  });

  it("mutation testing — si on supprime le strip, le test fail", () => {
    // Simule une régression : on injecte sciemment le e164 dans la payload.
    const regressionPayload = {
      contact: { phone: { e164: E164_LEAK } },
    };
    const json = JSON.stringify(regressionPayload);
    // Via pii-scrubber (source unique) — prouve que la sentinelle attraperait
    // la régression. Avant PR2a : regex inline `/\+33\d{9}/`.
    expect(containsFrenchPhoneNumber(json)).toBe(true);
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
    // Via pii-scrubber (source unique) : `containsFrenchPhoneNumber` normalise
    // les séparateurs inter-chiffres puis cherche l'alternance `0033[1-9]\d{8}`.
    expect(containsFrenchPhoneNumber(json)).toBe(true);
  });
});
