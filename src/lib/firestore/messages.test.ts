/**
 * Tests messages.ts contre l'emulator. Couvre :
 *
 *   - Sentinels :
 *       * alignement CONVERSATIONS_COLLECTION entre messages.ts et
 *         conversations.ts (1 test)
 *       * pattern Firestore auto-ID `/^[A-Za-z0-9]{20}$/` sur les
 *         messageId retournés par addOutbound / addInbound
 *
 *   - addOutbound : happy path 1er / 2e (firstMessageAt inchangé) /
 *                   spread champs optionnels (aiModel, externalReceiver…) /
 *                   body vide → ValidationError avant tx /
 *                   body > 1600 chars → ValidationError avant tx /
 *                   body pile 1600 → accepté /
 *                   conversation absente → NotFoundError /
 *                   conversation corrompue → ValidationError /
 *                   ATOMICITÉ (audit fail → rollback message + compteurs) /
 *                   audit payload SANS body brut
 *
 *   - addInbound  : happy path (direction/status/generatedBy/createdAt/
 *                   receivedAt figés) / body vide/trop long /
 *                   NotFoundError / ValidationError /
 *                   ATOMICITÉ / audit payload SANS body brut
 *
 *   - listRecentOutbound :
 *                   ordre DESC par createdAt /
 *                   exclu inbound /
 *                   exclu hors fenêtre 30j (J-31) /
 *                   fenêtre custom (ex: 7j) /
 *                   MAPPING FALLBACK : sentAt = msg.sentAt ?? msg.createdAt
 *                   (1 message avec sentAt fourni, 1 sans → 2 résultats
 *                    distincts) /
 *                   conversation absente → [] (pas NotFoundError) /
 *                   conversation vide → []
 *
 *   - Type-level (@ts-expect-error, compile-time, jamais exécuté) :
 *       * addOutbound refuse `direction`, `status`, `createdAt`, `sentAt`
 *       * addInbound  refuse `direction`, `status`, `generatedBy`,
 *                            `receivedAt`
 */
import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetEnvCacheForTests } from "@/lib/security/env";
import { AuditPiiError, NotFoundError, ValidationError } from "@/lib/utils/errors";
import type { Conversation } from "@/types/conversation";
import type { Message } from "@/types/message";

import {
  __APP_NAME_FOR_TESTS,
  __getAppByName,
  __resetFirestoreAdminForTests,
  getAdminDb,
} from "./admin";
import * as auditLogModule from "./audit-log";
import { __AUDIT_COLLECTION_FOR_TESTS } from "./audit-log";
import { __CONVERSATIONS_COLLECTION_FOR_TESTS } from "./conversations";
import {
  __BODY_MAX_LENGTH_FOR_TESTS,
  __DEFAULT_LIST_DAYS_FOR_TESTS,
  __MESSAGES_PARENT_COLLECTION_FOR_TESTS,
  __MESSAGES_SUBCOLLECTION_FOR_TESTS,
  addInbound,
  addOutbound,
  listRecentOutbound,
} from "./messages";

const PEPPER = "a".repeat(64);

// Pattern Firestore auto-ID (20 caractères alphanumériques mixed case).
const FIRESTORE_AUTO_ID_PATTERN = /^[A-Za-z0-9]{20}$/;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de seed
// ─────────────────────────────────────────────────────────────────────────────

function buildValidConversation(overrides: Partial<Conversation> = {}): Conversation {
  const now = Timestamp.now();
  return {
    contactId: "contact_abc",
    campaignId: "dentistes-idf-mai-2026",
    channel: "sms",
    status: "active",
    intent: "unknown",
    messageCount: 0,
    outboundCount: 0,
    inboundCount: 0,
    followupCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function seedConversation(
  id: string,
  overrides: Partial<Conversation> = {},
): Promise<Conversation> {
  const conv = buildValidConversation(overrides);
  await getAdminDb().collection(__CONVERSATIONS_COLLECTION_FOR_TESTS).doc(id).set(conv);
  return conv;
}

/** Écrit un doc message DIRECTEMENT dans la sous-collection, sans passer
 *  par addOutbound/addInbound. Utilisé pour les tests `listRecentOutbound`
 *  qui ont besoin de poser un `sentAt` distinct du `createdAt` (impossible
 *  via addOutbound qui fige `createdAt = now` et n'expose pas `sentAt`). */
async function seedMessage(conversationId: string, overrides: Partial<Message>): Promise<string> {
  const base: Message = {
    direction: "outbound",
    body: "seed",
    status: "sent",
    channel: "sms",
    generatedBy: "ai",
    createdAt: Timestamp.now(),
  };
  const docRef = await getAdminDb()
    .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
    .doc(conversationId)
    .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
    .add({ ...base, ...overrides });
  return docRef.id;
}

async function countMessages(conversationId: string): Promise<number> {
  const snap = await getAdminDb()
    .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
    .doc(conversationId)
    .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
    .get();
  return snap.size;
}

async function countAuditDocs(): Promise<number> {
  const snap = await getAdminDb().collection(__AUDIT_COLLECTION_FOR_TESTS).get();
  return snap.size;
}

async function fullReset() {
  vi.restoreAllMocks();
  __resetFirestoreAdminForTests();
  const app = __getAppByName(__APP_NAME_FOR_TESTS);
  if (app) {
    await deleteApp(app);
  }
  __resetEnvCacheForTests();
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe("messages.ts", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_PII_PEPPER", PEPPER);
    await fullReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fullReset();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Sentinels & invariants structurels
  // ───────────────────────────────────────────────────────────────────────

  describe("sentinels", () => {
    it("CONVERSATIONS_COLLECTION reste aligné entre messages.ts et conversations.ts", () => {
      // Si quelqu'un renomme la collection côté conversations.ts, ce test
      // casse — empêche une divergence silencieuse qui briserait
      // addOutbound/addInbound qui pointent vers la sous-collection.
      expect(__MESSAGES_PARENT_COLLECTION_FOR_TESTS).toBe(__CONVERSATIONS_COLLECTION_FOR_TESTS);
    });

    it("MESSAGES_SUBCOLLECTION === 'messages' (alignement skill firestore-schema)", () => {
      expect(__MESSAGES_SUBCOLLECTION_FOR_TESTS).toBe("messages");
    });

    it("BODY_MAX_LENGTH === 1600 (marge sécurité SMS multipart 10 segments)", () => {
      expect(__BODY_MAX_LENGTH_FOR_TESTS).toBe(1600);
    });

    it("DEFAULT_LIST_DAYS === 30 (alignement S4 rate-limits)", () => {
      expect(__DEFAULT_LIST_DAYS_FOR_TESTS).toBe(30);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // addOutbound
  // ───────────────────────────────────────────────────────────────────────

  describe("addOutbound", () => {
    it("happy path 1er message → doc créé, compteurs bumpés, 1 audit sms_sent", async () => {
      await seedConversation("conv_out_1");
      const messageId = await addOutbound("conv_out_1", {
        body: "Bonjour, Léa de Médéré. Une question rapide à vous poser. STOP pour refuser.",
        channel: "sms",
        generatedBy: "ai",
        aiModel: "claude-sonnet-4-6",
        aiPromptVersion: "first-sms-v1.0.0",
      });

      // messageId = Firestore auto-ID (sentinel pattern)
      expect(messageId).toMatch(FIRESTORE_AUTO_ID_PATTERN);

      // Doc message créé avec champs figés.
      const msgSnap = await getAdminDb()
        .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
        .doc("conv_out_1")
        .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
        .doc(messageId)
        .get();
      expect(msgSnap.exists).toBe(true);
      const msg = msgSnap.data() as Message;
      expect(msg.direction).toBe("outbound");
      expect(msg.status).toBe("queued");
      expect(msg.channel).toBe("sms");
      expect(msg.generatedBy).toBe("ai");
      expect(msg.aiModel).toBe("claude-sonnet-4-6");
      expect(msg.aiPromptVersion).toBe("first-sms-v1.0.0");
      expect(msg.createdAt).toBeInstanceOf(Timestamp);
      // sentAt/deliveredAt/error NON posés (S7).
      expect(msg.sentAt).toBeUndefined();
      expect(msg.deliveredAt).toBeUndefined();
      expect(msg.error).toBeUndefined();

      // Compteurs conversation bumpés.
      const convSnap = await getAdminDb()
        .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
        .doc("conv_out_1")
        .get();
      const conv = convSnap.data() as Conversation;
      expect(conv.messageCount).toBe(1);
      expect(conv.outboundCount).toBe(1);
      expect(conv.inboundCount).toBe(0);
      expect(conv.firstMessageAt).toBeInstanceOf(Timestamp);
      expect(conv.lastOutboundAt).toBeInstanceOf(Timestamp);

      // 1 seul audit sms_sent avec payload enrichi {direction, messageId}.
      const audits = await getAdminDb().collection(__AUDIT_COLLECTION_FOR_TESTS).get();
      expect(audits.size).toBe(1);
      const audit = audits.docs[0]?.data();
      expect(audit?.action).toBe("sms_sent");
      expect(audit?.targetType).toBe("message");
      expect(audit?.targetId).toBe(messageId);
      expect(audit?.payload).toEqual({ direction: "outbound", messageId });
    });

    it("2e outbound → messageCount=2, firstMessageAt INCHANGÉ (cadence stable)", async () => {
      const earlyTs = Timestamp.fromDate(new Date("2026-01-01T00:00:00Z"));
      await seedConversation("conv_out_2", {
        messageCount: 1,
        outboundCount: 1,
        firstMessageAt: earlyTs,
        lastMessageAt: earlyTs,
        lastOutboundAt: earlyTs,
      });
      await addOutbound("conv_out_2", {
        body: "Suite à mon dernier message...",
        channel: "sms",
        generatedBy: "ai",
      });

      const convSnap = await getAdminDb()
        .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
        .doc("conv_out_2")
        .get();
      const conv = convSnap.data() as Conversation;
      expect(conv.messageCount).toBe(2);
      expect(conv.outboundCount).toBe(2);
      expect((conv.firstMessageAt as Timestamp).toMillis()).toBe(earlyTs.toMillis());
      expect((conv.lastMessageAt as Timestamp).toMillis()).toBeGreaterThan(earlyTs.toMillis());
    });

    it("happy path AVEC tous les champs optionnels (externalReceiver, aiTemperature, aiTokens)", async () => {
      // Couvre les branches conditionnelles des spreads `... && {...}`.
      // Sans ce test, externalReceiver/aiTemperature/aiTokens sont
      // ignorés en branch coverage (cf. test précédent qui n'en fournit
      // aucun, et le test happy path 1er qui n'en fournit qu'une partie).
      await seedConversation("conv_out_full");
      const messageId = await addOutbound("conv_out_full", {
        body: "Bonjour, Léa de Médéré.",
        channel: "sms",
        generatedBy: "ai",
        externalReceiver: "+33612345678",
        aiModel: "claude-sonnet-4-6",
        aiPromptVersion: "first-sms-v1.0.0",
        aiTemperature: 0.7,
        aiTokens: { input: 120, output: 45 },
      });

      const msgSnap = await getAdminDb()
        .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
        .doc("conv_out_full")
        .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
        .doc(messageId)
        .get();
      const msg = msgSnap.data() as Message;
      expect(msg.externalReceiver).toBe("+33612345678");
      expect(msg.aiTemperature).toBe(0.7);
      expect(msg.aiTokens).toEqual({ input: 120, output: 45 });
    });

    it("champs optionnels absents → aucun undefined sérialisé dans le doc", async () => {
      // Firestore Admin SDK n'a PAS ignoreUndefinedProperties activé.
      // L'objet messageDoc doit OMETTRE les optionnels non fournis, sinon
      // tx.create throw. Ce test est le filet de sécurité.
      await seedConversation("conv_out_3");
      const messageId = await addOutbound("conv_out_3", {
        body: "Message minimal",
        channel: "sms",
        generatedBy: "human", // commercial qui répond manuellement
      });

      const msgSnap = await getAdminDb()
        .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
        .doc("conv_out_3")
        .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
        .doc(messageId)
        .get();
      const raw = msgSnap.data();
      expect(raw).not.toBeUndefined();
      // Aucun des optionnels n'est posé (pas même en clé:undefined).
      expect("aiModel" in raw!).toBe(false);
      expect("aiPromptVersion" in raw!).toBe(false);
      expect("aiTemperature" in raw!).toBe(false);
      expect("aiTokens" in raw!).toBe(false);
      expect("externalReceiver" in raw!).toBe(false);
    });

    it("body vide → throw ValidationError AVANT runTransaction (aucune écriture)", async () => {
      await seedConversation("conv_out_4");
      const auditsBefore = await countAuditDocs();
      const messagesBefore = await countMessages("conv_out_4");

      await expect(
        addOutbound("conv_out_4", { body: "", channel: "sms", generatedBy: "ai" }),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await countAuditDocs()).toBe(auditsBefore);
      expect(await countMessages("conv_out_4")).toBe(messagesBefore);
      const convSnap = await getAdminDb()
        .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
        .doc("conv_out_4")
        .get();
      expect((convSnap.data() as Conversation).messageCount).toBe(0);
    });

    it("body > BODY_MAX_LENGTH (1601 chars) → throw ValidationError AVANT runTransaction", async () => {
      await seedConversation("conv_out_5");
      const body = "x".repeat(__BODY_MAX_LENGTH_FOR_TESTS + 1);

      await expect(
        addOutbound("conv_out_5", { body, channel: "sms", generatedBy: "ai" }),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await countMessages("conv_out_5")).toBe(0);
      expect(await countAuditDocs()).toBe(0);
    });

    it("body pile à BODY_MAX_LENGTH → accepté (limite inclusive)", async () => {
      await seedConversation("conv_out_6");
      const body = "x".repeat(__BODY_MAX_LENGTH_FOR_TESTS);

      const messageId = await addOutbound("conv_out_6", {
        body,
        channel: "sms",
        generatedBy: "ai",
      });
      expect(messageId).toMatch(FIRESTORE_AUTO_ID_PATTERN);
    });

    it("conversation inexistante → throw NotFoundError", async () => {
      await expect(
        addOutbound("conv_ghost", { body: "hello", channel: "sms", generatedBy: "ai" }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("conversation corrompue → throw ValidationError, aucun message créé", async () => {
      await getAdminDb()
        .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
        .doc("conv_broken")
        .set({ contactId: "x" }); // pas messageCount, etc.

      await expect(
        addOutbound("conv_broken", { body: "hello", channel: "sms", generatedBy: "ai" }),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await countMessages("conv_broken")).toBe(0);
    });

    it("ATOMICITÉ : si appendAuditLogTx throw, message + compteurs rolled back", async () => {
      await seedConversation("conv_out_atomic");
      const spy = vi.spyOn(auditLogModule, "appendAuditLogTx").mockImplementation(() => {
        throw new AuditPiiError({ message: "simulated audit fail" });
      });

      await expect(
        addOutbound("conv_out_atomic", { body: "hello", channel: "sms", generatedBy: "ai" }),
      ).rejects.toBeInstanceOf(AuditPiiError);

      // Rollback total : pas de message, pas de compteur bumpé, pas d'audit.
      expect(await countMessages("conv_out_atomic")).toBe(0);
      expect(await countAuditDocs()).toBe(0);
      const convSnap = await getAdminDb()
        .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
        .doc("conv_out_atomic")
        .get();
      const conv = convSnap.data() as Conversation;
      expect(conv.messageCount).toBe(0);
      expect(conv.outboundCount).toBe(0);
      expect(conv.firstMessageAt).toBeUndefined();

      spy.mockRestore();
    });

    it("audit payload NE CONTIENT PAS le body (filet PII même si body 'safe' ici)", async () => {
      await seedConversation("conv_out_audit_pii");
      const bodyWithFakePii = "Mon RDV est le 06 mai à 14h"; // pas un E.164 valide donc passerait le scrubber, mais on prouve qu'il n'arrive même PAS dans le payload
      await addOutbound("conv_out_audit_pii", {
        body: bodyWithFakePii,
        channel: "sms",
        generatedBy: "ai",
      });

      const audits = await getAdminDb().collection(__AUDIT_COLLECTION_FOR_TESTS).get();
      expect(audits.size).toBe(1);
      const audit = audits.docs[0]?.data();
      const serialized = JSON.stringify(audit?.payload);
      expect(serialized).not.toContain("RDV");
      expect(serialized).not.toContain("mai");
      // Le payload ne contient QUE direction + messageId.
      expect(Object.keys(audit?.payload as object).sort()).toEqual(["direction", "messageId"]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // addInbound
  // ───────────────────────────────────────────────────────────────────────

  describe("addInbound", () => {
    it("happy path → doc créé, direction/status/generatedBy/receivedAt figés", async () => {
      await seedConversation("conv_in_1");
      const messageId = await addInbound("conv_in_1", {
        body: "Oui, ça m'intéresse",
        channel: "sms",
        externalId: "ovh-webhook-xyz-001",
        externalReceiver: "+33612345678",
      });

      expect(messageId).toMatch(FIRESTORE_AUTO_ID_PATTERN);

      const msgSnap = await getAdminDb()
        .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
        .doc("conv_in_1")
        .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
        .doc(messageId)
        .get();
      const msg = msgSnap.data() as Message;
      expect(msg.direction).toBe("inbound");
      expect(msg.status).toBe("received");
      expect(msg.generatedBy).toBe("human");
      expect(msg.channel).toBe("sms");
      expect(msg.externalId).toBe("ovh-webhook-xyz-001");
      expect(msg.externalReceiver).toBe("+33612345678");
      expect(msg.body).toBe("Oui, ça m'intéresse");
      expect(msg.createdAt).toBeInstanceOf(Timestamp);
      expect(msg.receivedAt).toBeInstanceOf(Timestamp);
      // intent NON posé (classify-intent S7).
      expect(msg.intent).toBeUndefined();
      expect(msg.intentConfidence).toBeUndefined();

      // Compteurs : inboundCount=1, outboundCount=0.
      const convSnap = await getAdminDb()
        .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
        .doc("conv_in_1")
        .get();
      const conv = convSnap.data() as Conversation;
      expect(conv.inboundCount).toBe(1);
      expect(conv.outboundCount).toBe(0);
      expect(conv.lastInboundAt).toBeInstanceOf(Timestamp);

      // Audit sms_received avec payload enrichi.
      const audits = await getAdminDb().collection(__AUDIT_COLLECTION_FOR_TESTS).get();
      const audit = audits.docs[0]?.data();
      expect(audit?.action).toBe("sms_received");
      expect(audit?.payload).toEqual({ direction: "inbound", messageId });
    });

    it("body vide → throw ValidationError AVANT runTransaction", async () => {
      await seedConversation("conv_in_2");
      await expect(
        addInbound("conv_in_2", {
          body: "",
          channel: "sms",
          externalId: "ovh-1",
          externalReceiver: "+33611111111",
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await countMessages("conv_in_2")).toBe(0);
      expect(await countAuditDocs()).toBe(0);
    });

    it("body > BODY_MAX_LENGTH → throw ValidationError, aucune écriture", async () => {
      await seedConversation("conv_in_3");
      const body = "y".repeat(__BODY_MAX_LENGTH_FOR_TESTS + 1);
      await expect(
        addInbound("conv_in_3", {
          body,
          channel: "sms",
          externalId: "ovh-2",
          externalReceiver: "+33611111111",
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await countMessages("conv_in_3")).toBe(0);
    });

    it("conversation inexistante → throw NotFoundError", async () => {
      await expect(
        addInbound("conv_ghost", {
          body: "hello",
          channel: "sms",
          externalId: "ovh-x",
          externalReceiver: "+33611111111",
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("conversation corrompue → throw ValidationError", async () => {
      await getAdminDb()
        .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
        .doc("conv_in_broken")
        .set({ contactId: "x" });

      await expect(
        addInbound("conv_in_broken", {
          body: "hello",
          channel: "sms",
          externalId: "ovh-y",
          externalReceiver: "+33611111111",
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("ATOMICITÉ : si appendAuditLogTx throw, message + compteurs rolled back", async () => {
      await seedConversation("conv_in_atomic");
      const spy = vi.spyOn(auditLogModule, "appendAuditLogTx").mockImplementation(() => {
        throw new AuditPiiError({ message: "simulated audit fail" });
      });

      await expect(
        addInbound("conv_in_atomic", {
          body: "hello",
          channel: "sms",
          externalId: "ovh-atomic",
          externalReceiver: "+33611111111",
        }),
      ).rejects.toBeInstanceOf(AuditPiiError);

      expect(await countMessages("conv_in_atomic")).toBe(0);
      expect(await countAuditDocs()).toBe(0);
      const convSnap = await getAdminDb()
        .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
        .doc("conv_in_atomic")
        .get();
      const conv = convSnap.data() as Conversation;
      expect(conv.inboundCount).toBe(0);
      expect(conv.lastInboundAt).toBeUndefined();

      spy.mockRestore();
    });

    it("audit payload NE CONTIENT PAS le body (cas critique : PS répond avec PII)", async () => {
      await seedConversation("conv_in_audit_pii");
      // Un PS peut écrire "Mon numéro perso est 06 12 34 56 78". Le body
      // DOIT être stocké brut dans le doc message (forensic + classify
      // S7) mais JAMAIS apparaître dans l'audit.
      const bodyWithPii = "Mon numéro perso est 0612345678";
      await addInbound("conv_in_audit_pii", {
        body: bodyWithPii,
        channel: "sms",
        externalId: "ovh-pii",
        externalReceiver: "+33611111111",
      });

      const audits = await getAdminDb().collection(__AUDIT_COLLECTION_FOR_TESTS).get();
      const audit = audits.docs[0]?.data();
      const serialized = JSON.stringify(audit?.payload);
      expect(serialized).not.toContain("0612345678");
      expect(serialized).not.toContain("numéro");
      expect(Object.keys(audit?.payload as object).sort()).toEqual(["direction", "messageId"]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // listRecentOutbound
  // ───────────────────────────────────────────────────────────────────────

  describe("listRecentOutbound", () => {
    it("3 outbound créés → 3 retournés, ordre DESC par createdAt", async () => {
      await seedConversation("conv_list_1");
      await addOutbound("conv_list_1", { body: "msg 1", channel: "sms", generatedBy: "ai" });
      await new Promise((r) => setTimeout(r, 10)); // garantir createdAt distinct
      await addOutbound("conv_list_1", { body: "msg 2", channel: "sms", generatedBy: "ai" });
      await new Promise((r) => setTimeout(r, 10));
      await addOutbound("conv_list_1", { body: "msg 3", channel: "sms", generatedBy: "ai" });

      const result = await listRecentOutbound("conv_list_1");
      expect(result).toHaveLength(3);
      // Ordre DESC : msg 3 (le plus récent) en premier.
      const t0 = (result[0]?.sentAt as Timestamp).toMillis();
      const t1 = (result[1]?.sentAt as Timestamp).toMillis();
      const t2 = (result[2]?.sentAt as Timestamp).toMillis();
      expect(t0).toBeGreaterThanOrEqual(t1);
      expect(t1).toBeGreaterThanOrEqual(t2);
      // Tous direction = outbound (sanity).
      expect(result.every((r) => r.direction === "outbound")).toBe(true);
    });

    it("mix outbound + inbound → ne retourne QUE les outbound", async () => {
      await seedConversation("conv_list_2");
      await addOutbound("conv_list_2", { body: "out 1", channel: "sms", generatedBy: "ai" });
      await addInbound("conv_list_2", {
        body: "in 1",
        channel: "sms",
        externalId: "ovh-1",
        externalReceiver: "+33611111111",
      });
      await addOutbound("conv_list_2", { body: "out 2", channel: "sms", generatedBy: "ai" });

      const result = await listRecentOutbound("conv_list_2");
      expect(result).toHaveLength(2);
      expect(result.every((r) => r.direction === "outbound")).toBe(true);
    });

    it("message à J-31 → EXCLU de la fenêtre 30j par défaut", async () => {
      await seedConversation("conv_list_3");
      const now = new Date("2026-05-01T12:00:00Z");
      const t31DaysAgo = Timestamp.fromDate(new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000));
      const t1DayAgo = Timestamp.fromDate(new Date(now.getTime() - 24 * 60 * 60 * 1000));

      await seedMessage("conv_list_3", { createdAt: t31DaysAgo, body: "old" });
      await seedMessage("conv_list_3", { createdAt: t1DayAgo, body: "recent" });

      const result = await listRecentOutbound("conv_list_3", 30, now);
      expect(result).toHaveLength(1);
      expect((result[0]?.sentAt as Timestamp).toMillis()).toBe(t1DayAgo.toMillis());
    });

    it("fenêtre custom 7j → message à J-10 exclu, message à J-3 inclus", async () => {
      await seedConversation("conv_list_4");
      const now = new Date("2026-05-01T12:00:00Z");
      const t10DaysAgo = Timestamp.fromDate(new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000));
      const t3DaysAgo = Timestamp.fromDate(new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000));

      await seedMessage("conv_list_4", { createdAt: t10DaysAgo });
      await seedMessage("conv_list_4", { createdAt: t3DaysAgo });

      const result = await listRecentOutbound("conv_list_4", 7, now);
      expect(result).toHaveLength(1);
      expect((result[0]?.sentAt as Timestamp).toMillis()).toBe(t3DaysAgo.toMillis());
    });

    it("MAPPING FALLBACK : sentAt = msg.sentAt si fourni, sinon msg.createdAt", async () => {
      // Cas critique. Précision [D] du brief Déthié S6.5.
      await seedConversation("conv_list_mapping");
      const now = new Date("2026-05-17T12:00:00Z");

      // msg 1 : status "sent", sentAt fourni 5 min après createdAt.
      const t1Created = Timestamp.fromDate(new Date("2026-05-15T10:00:00Z"));
      const t1Sent = Timestamp.fromDate(new Date("2026-05-15T10:05:00Z"));
      await seedMessage("conv_list_mapping", {
        createdAt: t1Created,
        sentAt: t1Sent,
        status: "sent",
        body: "msg1 sent",
      });

      // msg 2 : status "queued", PAS de sentAt (cas où le doc est créé
      // mais OVH n'a pas encore confirmé l'envoi).
      const t2Created = Timestamp.fromDate(new Date("2026-05-16T10:00:00Z"));
      await seedMessage("conv_list_mapping", {
        createdAt: t2Created,
        status: "queued",
        body: "msg2 queued",
      });

      const result = await listRecentOutbound("conv_list_mapping", 30, now);
      expect(result).toHaveLength(2);

      // Ordre DESC sur createdAt : msg2 (16 mai) avant msg1 (15 mai).
      // msg2 : sentAt absent → fallback createdAt.
      expect((result[0]?.sentAt as Timestamp).toMillis()).toBe(t2Created.toMillis());
      // msg1 : sentAt fourni → sentAt (PAS createdAt).
      expect((result[1]?.sentAt as Timestamp).toMillis()).toBe(t1Sent.toMillis());
      // Sanity : t1Sent != t1Created (sinon le test ne prouverait rien).
      expect(t1Sent.toMillis()).not.toBe(t1Created.toMillis());
    });

    it("conversation absente → retourne [] (PAS NotFoundError, lecture tolérante)", async () => {
      const result = await listRecentOutbound("conv_ghost_list");
      expect(result).toEqual([]);
    });

    it("conversation existante mais aucun message → retourne []", async () => {
      await seedConversation("conv_list_empty");
      const result = await listRecentOutbound("conv_list_empty");
      expect(result).toEqual([]);
    });

    it("doc message corrompu dans la sous-collection → throw ValidationError au parse", async () => {
      // Si quelqu'un (migration foireuse, écriture hors API) pose un doc
      // partiel, on doit fail-fast plutôt que de retourner un résultat
      // incomplet qui fausserait le calcul rate-limit. Filet en lecture.
      await seedConversation("conv_list_corrupt");
      const now = new Date("2026-05-01T12:00:00Z");
      const recent = Timestamp.fromDate(new Date(now.getTime() - 60 * 1000));
      await getAdminDb()
        .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
        .doc("conv_list_corrupt")
        .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
        .add({
          direction: "outbound",
          createdAt: recent,
          // body/status/channel/generatedBy MANQUANTS → Zod fail
        });

      await expect(listRecentOutbound("conv_list_corrupt", 30, now)).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Type-level (compile-time only, jamais exécuté)
  //
  // Ces tests vérifient que TypeScript refuse les inputs malformés. Pas
  // d'expect runtime — c'est `@ts-expect-error` qui assert. Si le compile
  // PASSE alors qu'il devrait FAIL, tsc throw "Unused @ts-expect-error".
  // ───────────────────────────────────────────────────────────────────────

  describe("type-level (compile-time)", () => {
    it("placeholder runtime : les vrais checks sont les @ts-expect-error ci-dessous", () => {
      expect(true).toBe(true);
    });

    // Wrapper non-exécuté. Présent uniquement pour la compilation TS.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async function _typeCheckAddOutbound(convId: string) {
      await addOutbound(convId, {
        // @ts-expect-error - direction est FIGÉ par addOutbound (="outbound")
        direction: "inbound",
        body: "x",
        channel: "sms",
        generatedBy: "ai",
      });
      await addOutbound(convId, {
        // @ts-expect-error - status est FIGÉ par addOutbound (="queued")
        status: "sent",
        body: "x",
        channel: "sms",
        generatedBy: "ai",
      });
      await addOutbound(convId, {
        // @ts-expect-error - createdAt est FIGÉ (timestamp serveur)
        createdAt: new Date(),
        body: "x",
        channel: "sms",
        generatedBy: "ai",
      });
      await addOutbound(convId, {
        // @ts-expect-error - sentAt est posé par updateMessageStatus en S7
        sentAt: new Date(),
        body: "x",
        channel: "sms",
        generatedBy: "ai",
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async function _typeCheckAddInbound(convId: string) {
      await addInbound(convId, {
        // @ts-expect-error - direction est FIGÉ par addInbound (="inbound")
        direction: "outbound",
        body: "x",
        channel: "sms",
        externalId: "ovh",
        externalReceiver: "+33611111111",
      });
      await addInbound(convId, {
        // @ts-expect-error - status est FIGÉ par addInbound (="received")
        status: "queued",
        body: "x",
        channel: "sms",
        externalId: "ovh",
        externalReceiver: "+33611111111",
      });
      await addInbound(convId, {
        // @ts-expect-error - generatedBy est FIGÉ (="human", PS = humain)
        generatedBy: "ai",
        body: "x",
        channel: "sms",
        externalId: "ovh",
        externalReceiver: "+33611111111",
      });
      await addInbound(convId, {
        // @ts-expect-error - receivedAt est FIGÉ (timestamp serveur)
        receivedAt: new Date(),
        body: "x",
        channel: "sms",
        externalId: "ovh",
        externalReceiver: "+33611111111",
      });
    }
  });
});
