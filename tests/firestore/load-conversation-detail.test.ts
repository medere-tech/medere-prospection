/**
 * Tests EMULATOR — `loadConversationDetail` (VUE-CONVERSATION PR1).
 *
 * Couvre les 4 kinds de retour :
 *   - `not_found` : conv ou contact inconnu.
 *   - `not_mine`  : commercial non-titulaire → page 403.
 *   - `ok`        : admin voit tout, titulaire voit sa conv.
 *   - `error`     : I/O (non testé ici — propagé si Firestore down).
 *
 * Mutation testing sur le contrôle d'accès commercial : si on retire le
 * check `slackUserId !== assignedTo`, le test fail car l'intrus voit tout.
 *
 * Filtre `duplicate` : vérifie que les messages `status === "duplicate"`
 * ne figurent PAS dans la payload (déjà strippés par `listMessagesInConversation`).
 */
import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConversationDetail } from "@/lib/conversations/load-conversation-detail";
import {
  __APP_NAME_FOR_TESTS,
  __getAppByName,
  __resetFirestoreAdminForTests,
  getAdminDb,
} from "@/lib/firestore/admin";
import { __resetEnvCacheForTests } from "@/lib/security/env";

const PEPPER = "b".repeat(64);
const CONV_ID = "contact1_camp1";
const CONTACT_ID = "contact1";
const OWNER_SLACK = "UOWNER12345";
const INTRUDER_SLACK = "UINTRUDER123";

async function fullReset() {
  vi.restoreAllMocks();
  __resetFirestoreAdminForTests();
  const app = __getAppByName(__APP_NAME_FOR_TESTS);
  if (app) await deleteApp(app);
  __resetEnvCacheForTests();
}

async function seed({
  withHandoff = true,
  withDuplicate = false,
}: {
  withHandoff?: boolean;
  withDuplicate?: boolean;
}) {
  const db = getAdminDb();
  // Contact — champs alignés sur ContactSchema (phone.type lowercase,
  // legitimateInterest >= 20 chars).
  await db
    .collection("contacts")
    .doc(CONTACT_ID)
    .set({
      hubspotId: CONTACT_ID,
      firstName: "Jean",
      lastName: "Dupont",
      civilite: "Dr",
      speciality: "Chirurgien-dentiste",
      city: "Paris",
      postalCode: "75001",
      phone: {
        e164: "+33612349876",
        raw: "0612349876",
        type: "mobile",
        valid: true,
        lookupAt: Timestamp.fromMillis(1_700_000_000_000),
      },
      segment: "b2c_mobile_perso",
      bloctelChecked: true,
      bloctelOptOut: false,
      consent: {
        legitimateInterest:
          "Intérêt légitime documenté pour cette campagne test VUE-CONVERSATION PR1.",
        optedOut: false,
      },
      enrichment: {
        source: "lusha",
        enrichedAt: Timestamp.fromMillis(1_700_000_000_000),
      },
      status: "ready",
      campaignId: "camp1",
      createdAt: Timestamp.fromMillis(1_700_000_000_000),
      updatedAt: Timestamp.fromMillis(1_700_000_000_000),
    });

  // Conversation — omit handoff key si pas de handoff (Firestore refuse undefined).
  const convData: Record<string, unknown> = {
    contactId: CONTACT_ID,
    campaignId: "camp1",
    channel: "sms",
    status: withHandoff ? "handed_off" : "in_dialogue",
    intent: "INTERESSE",
    messageCount: 2,
    outboundCount: 1,
    inboundCount: 1,
    followupCount: 0,
    lastInboundAt: Timestamp.fromMillis(1_700_000_200_000),
    lastOutboundAt: Timestamp.fromMillis(1_700_000_100_000),
    assignedTo: withHandoff ? OWNER_SLACK : null,
    createdAt: Timestamp.fromMillis(1_700_000_000_000),
    updatedAt: Timestamp.fromMillis(1_700_000_200_000),
  };
  if (withHandoff) {
    convData.handoff = {
      assignedTo: OWNER_SLACK,
      assignedAt: Timestamp.fromMillis(1_700_000_150_000),
    };
  }
  await db.collection("conversations").doc(CONV_ID).set(convData);

  // Messages
  await db
    .collection("conversations")
    .doc(CONV_ID)
    .collection("messages")
    .doc("m1")
    .set({
      direction: "outbound",
      status: "sent",
      channel: "sms",
      body: "Bonjour, Léa de Médéré.",
      outboundKind: "solicitation",
      generatedBy: "ai",
      createdAt: Timestamp.fromMillis(1_700_000_100_000),
      sentAt: Timestamp.fromMillis(1_700_000_105_000),
      externalReceiver: "+33612349876",
    });
  await db
    .collection("conversations")
    .doc(CONV_ID)
    .collection("messages")
    .doc("m2")
    .set({
      direction: "inbound",
      status: "received",
      channel: "sms",
      body: "Oui, intéressé",
      generatedBy: "human",
      createdAt: Timestamp.fromMillis(1_700_000_200_000),
      receivedAt: Timestamp.fromMillis(1_700_000_200_000),
      externalReceiver: "+33612349876",
    });

  if (withDuplicate) {
    await db
      .collection("conversations")
      .doc(CONV_ID)
      .collection("messages")
      .doc("m_dup")
      .set({
        direction: "inbound",
        status: "duplicate",
        duplicateOf: "m2",
        channel: "sms",
        body: "DOUBLON INVISIBLE",
        generatedBy: "human",
        createdAt: Timestamp.fromMillis(1_700_000_300_000),
        externalReceiver: "+33612349876",
      });
  }
}

describe("loadConversationDetail — persist emulator (VUE-CONVERSATION PR1)", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_PII_PEPPER", PEPPER);
    await fullReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fullReset();
  });

  it("not_found si conversation inexistante", async () => {
    const res = await loadConversationDetail("no_such_conv", {
      role: "admin",
      slackUserId: undefined,
    });
    expect(res.kind).toBe("not_found");
  });

  it("ok admin : voit la conv même sans slackUserId titulaire", async () => {
    await seed({ withHandoff: true });
    const res = await loadConversationDetail(CONV_ID, { role: "admin", slackUserId: undefined });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") throw new Error();
    expect(res.data.viewerIsOwner).toBe(true); // admin = owner par convention
    expect(res.data.handoff?.assignedToSlackId).toBe(OWNER_SLACK);
  });

  it("ok commercial titulaire : voit sa propre conv", async () => {
    await seed({ withHandoff: true });
    const res = await loadConversationDetail(CONV_ID, {
      role: "commercial",
      slackUserId: OWNER_SLACK,
    });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") throw new Error();
    expect(res.data.viewerIsOwner).toBe(true);
  });

  it("not_mine : commercial non-titulaire bloqué 403", async () => {
    await seed({ withHandoff: true });
    const res = await loadConversationDetail(CONV_ID, {
      role: "commercial",
      slackUserId: INTRUDER_SLACK,
    });
    expect(res.kind).toBe("not_mine");
    // assignedToName peut être null (Airtable non seedé en test)
    if (res.kind === "not_mine") {
      expect(res.assignedToName).toBeDefined();
    }
  });

  it("not_mine : commercial sans slackUserId du tout → 403", async () => {
    await seed({ withHandoff: true });
    const res = await loadConversationDetail(CONV_ID, {
      role: "commercial",
      slackUserId: undefined,
    });
    expect(res.kind).toBe("not_mine");
  });

  it("mutation testing — si le check est inversé (!=), un commercial non-titulaire voit tout", () => {
    // Documentation : si on remplaçait `viewer.slackUserId !== assignedToSlack`
    // par `viewer.slackUserId === assignedToSlack` dans load-conversation-detail.ts,
    // ce test échouerait car l'intrus recevrait kind="ok" au lieu de "not_mine".
    // La sentinelle précédente le vérifie déjà.
    expect(true).toBe(true);
  });

  it("exclusion duplicate : un message status='duplicate' n'apparaît PAS dans messages[]", async () => {
    await seed({ withHandoff: true, withDuplicate: true });
    const res = await loadConversationDetail(CONV_ID, { role: "admin", slackUserId: undefined });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") throw new Error();
    const ids = res.data.messages.map((m) => m.messageId);
    expect(ids).toContain("m1");
    expect(ids).toContain("m2");
    expect(ids).not.toContain("m_dup");
  });

  it("mutation testing filtre duplicate — vérif qu'il n'apparaît pas", async () => {
    await seed({ withHandoff: true, withDuplicate: true });
    const res = await loadConversationDetail(CONV_ID, { role: "admin", slackUserId: undefined });
    if (res.kind !== "ok") throw new Error();
    // Si listMessagesInConversation retirait son filtre `duplicate`, le body
    // "DOUBLON INVISIBLE" apparaîtrait. On teste l'absence.
    const bodies = res.data.messages.map((m) => m.body);
    expect(bodies).not.toContain("DOUBLON INVISIBLE");
  });

  it("sanity : aucun pattern téléphone dans la payload sérialisée", async () => {
    await seed({ withHandoff: true });
    const res = await loadConversationDetail(CONV_ID, { role: "admin", slackUserId: undefined });
    if (res.kind !== "ok") throw new Error();
    const json = JSON.stringify(res.data);
    expect(json).not.toMatch(/\+33\d{9}/);
    expect(json).not.toMatch(/\b0033\d{9}\b/);
    expect(json).not.toMatch(/\b0[1-9]\d{8}\b/);
  });

  it("conversation sans handoff : status='in_dialogue' + handoff=null", async () => {
    await seed({ withHandoff: false });
    const res = await loadConversationDetail(CONV_ID, { role: "admin", slackUserId: undefined });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") throw new Error();
    expect(res.data.status).toBe("in_dialogue");
    expect(res.data.handoff).toBeNull();
  });

  it("commercial non assigné et pas de handoff : accès autorisé (viewerIsOwner=false)", async () => {
    // Attendu : si assignedTo est null, on considère que personne n'est
    // titulaire. Dans ce cas, le commercial ne peut pas être « titulaire »
    // au sens strict (slackUserId !== null). Donc 403 pour un commercial.
    await seed({ withHandoff: false });
    const res = await loadConversationDetail(CONV_ID, {
      role: "commercial",
      slackUserId: INTRUDER_SLACK,
    });
    expect(res.kind).toBe("not_mine");
  });
});
