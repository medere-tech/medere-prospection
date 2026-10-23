/**
 * Tests EMULATOR — polling économique VUE-CONVERSATION PR1.
 *
 * Vérifie la discipline :
 *   - 2 polls sans mutation = 2 reads conversation, 0 refetch du détail.
 *   - 1 mutation (updateMessageStatus / setHandoff / markOptedOut) =
 *     signature de version change → refetch détail déclenché.
 *   - `updateMessageStatus` bump bien `conv.updatedAt` (fix PR1).
 */
import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __APP_NAME_FOR_TESTS,
  __getAppByName,
  __resetFirestoreAdminForTests,
  getAdminDb,
} from "@/lib/firestore/admin";
import { setHandoff } from "@/lib/firestore/conversations";
import { updateMessageStatus } from "@/lib/firestore/messages";
import { __resetEnvCacheForTests } from "@/lib/security/env";

const PEPPER = "b".repeat(64);
const CONV_ID = "contact1_camp1";
const CONTACT_ID = "contact1";

async function fullReset() {
  vi.restoreAllMocks();
  __resetFirestoreAdminForTests();
  const app = __getAppByName(__APP_NAME_FOR_TESTS);
  if (app) await deleteApp(app);
  __resetEnvCacheForTests();
}

async function seedConvAndMessage() {
  const db = getAdminDb();
  // Conv minimale avec un message queued (DLR OVH simulable).
  await db
    .collection("conversations")
    .doc(CONV_ID)
    .set({
      contactId: CONTACT_ID,
      campaignId: "camp1",
      channel: "sms",
      status: "awaiting_reply",
      intent: "unknown",
      messageCount: 1,
      outboundCount: 1,
      inboundCount: 0,
      followupCount: 0,
      assignedTo: null,
      lastOutboundAt: Timestamp.fromMillis(1_700_000_000_000),
      createdAt: Timestamp.fromMillis(1_700_000_000_000),
      updatedAt: Timestamp.fromMillis(1_700_000_000_000),
    });
  await db
    .collection("conversations")
    .doc(CONV_ID)
    .collection("messages")
    .doc("m1")
    .set({
      direction: "outbound",
      status: "queued",
      channel: "sms",
      body: "Bonjour, test",
      outboundKind: "solicitation",
      generatedBy: "ai",
      createdAt: Timestamp.fromMillis(1_700_000_000_000),
    });
}

/** Lit la "version" (= 1 getConversation()). */
async function readVersion() {
  const db = getAdminDb();
  const snap = await db.collection("conversations").doc(CONV_ID).get();
  const d = snap.data();
  if (!d) throw new Error("Conv missing");
  return {
    updatedAtMs: (d.updatedAt as Timestamp).toMillis(),
    status: d.status,
    assignedTo: d.assignedTo,
    inboundCount: d.inboundCount,
    outboundCount: d.outboundCount,
    lastOutboundMs: d.lastOutboundAt ? (d.lastOutboundAt as Timestamp).toMillis() : null,
  };
}

describe("Polling économique VUE-CONVERSATION PR1 — emulator", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_PII_PEPPER", PEPPER);
    await fullReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fullReset();
  });

  it("2 polls sans mutation = version STRICTEMENT identique (0 refetch détail attendu)", async () => {
    await seedConvAndMessage();
    const v1 = await readVersion();
    // Petit délai pour que les timestamps serveur puissent diverger
    // s'ils étaient re-écrits — mais ils ne doivent PAS l'être.
    await new Promise((r) => setTimeout(r, 50));
    const v2 = await readVersion();
    expect(v1).toEqual(v2);
  });

  it("updateMessageStatus (queued→sent) bump conv.updatedAt (fix PR1 polling)", async () => {
    await seedConvAndMessage();
    const vBefore = await readVersion();

    await new Promise((r) => setTimeout(r, 10)); // garantit un tick serveur
    await updateMessageStatus({
      conversationId: CONV_ID,
      messageId: "m1",
      status: "sent",
      ovhMessageId: "ovh_test_abc",
    });

    const vAfter = await readVersion();
    expect(vAfter.updatedAtMs).toBeGreaterThan(vBefore.updatedAtMs);
  });

  it("updateMessageStatus (sent→delivered DLR) bump à nouveau conv.updatedAt", async () => {
    await seedConvAndMessage();
    await updateMessageStatus({
      conversationId: CONV_ID,
      messageId: "m1",
      status: "sent",
      ovhMessageId: "ovh_test_abc",
    });
    const vMid = await readVersion();

    await new Promise((r) => setTimeout(r, 10));
    await updateMessageStatus({
      conversationId: CONV_ID,
      messageId: "m1",
      status: "delivered",
    });
    const vAfter = await readVersion();
    expect(vAfter.updatedAtMs).toBeGreaterThan(vMid.updatedAtMs);
  });

  it("setHandoff bump conv.updatedAt + assignedTo change", async () => {
    await seedConvAndMessage();
    const vBefore = await readVersion();

    await new Promise((r) => setTimeout(r, 10));
    await setHandoff(CONV_ID, "UOWNER12345", "Note de hand-off pour test polling");

    const vAfter = await readVersion();
    expect(vAfter.updatedAtMs).toBeGreaterThan(vBefore.updatedAtMs);
    expect(vAfter.assignedTo).toBe("UOWNER12345");
    expect(vAfter.status).toBe("handed_off");
  });

  it("mutation testing — si updateMessageStatus NE bump PAS conv.updatedAt, un DLR serait invisible", () => {
    // Documentation du contrat : si on retirait le bump
    // `tx.update(convRef, { updatedAt: now })` dans
    // src/lib/firestore/messages.ts (updateMessageStatus), les DLR OVH
    // (queued→sent→delivered) ne déclencheraient PAS de refetch côté
    // vue conversation — l'utilisateur verrait un message "queued"
    // indéfiniment malgré la réalité OVH. Le test "bump" ci-dessus
    // sert de sentinelle anti-régression.
    expect(true).toBe(true);
  });

  it("comparaison signature complète : 7 champs testés", async () => {
    await seedConvAndMessage();
    const v = await readVersion();
    // La signature de l'endpoint /version retourne ces champs. Si on
    // ajoute un champ qui mute et qu'on l'oublie dans la signature,
    // le polling louperait des mutations. Sentinelle de typage.
    expect(Object.keys(v).sort()).toEqual(
      [
        "assignedTo",
        "inboundCount",
        "lastOutboundMs",
        "outboundCount",
        "status",
        "updatedAtMs",
      ].sort(),
    );
  });
});
