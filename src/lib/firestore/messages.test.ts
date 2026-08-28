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
import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { countsAgainstCap, DEFAULT_OUTBOUND_KIND } from "@/lib/compliance/outbound-kind";
import { canSendMessage, countSolicitationsInWindow } from "@/lib/compliance/rate-limits";
import { __resetEnvCacheForTests } from "@/lib/security/env";
import { AuditPiiError, NotFoundError, ValidationError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";
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
import {
  __CONVERSATION_FANOUT_WARN_THRESHOLD_FOR_TESTS,
  __CONVERSATIONS_COLLECTION_FOR_TESTS,
  _parseConversationOrThrow,
  conversationDocId,
} from "./conversations";
import {
  __BODY_MAX_LENGTH_FOR_TESTS,
  __DEFAULT_HISTORY_LIMIT_FOR_TESTS,
  __DEFAULT_LIST_DAYS_FOR_TESTS,
  __MESSAGES_PARENT_COLLECTION_FOR_TESTS,
  __MESSAGES_SUBCOLLECTION_FOR_TESTS,
  __STALE_MESSAGES_DEFAULT_LIMIT_FOR_TESTS,
  _parseMessageOrThrow,
  addInbound,
  addOutbound,
  addOutboundDraft,
  addOutboundDraftInTx,
  addOutboundInTx,
  findInboundByExternalId,
  listRecentMessages,
  listRecentOutbound,
  listRecentOutboundByContact,
  listRecentOutboundByContactInTx,
  listRecentOutboundInTx,
  listStaleMessages,
  RATE_LIMIT_COUNTED_STATUSES,
  updateMessageStatus,
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

/**
 * Lit + parse la conversation DANS une tx. PR-OUTBOUNDKIND :
 * `addOutboundDraftInTx` exige désormais la conversation parente (pour la
 * garde `"reply"` ⇒ `inboundCount > 0`), au même titre qu'`addOutboundInTx`.
 */
async function readConvInTx(tx: Transaction, conversationId: string): Promise<Conversation> {
  const snap = await tx.get(
    getAdminDb().collection(__CONVERSATIONS_COLLECTION_FOR_TESTS).doc(conversationId),
  );
  return _parseConversationOrThrow(snap.data(), conversationId);
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
    outboundKind: "solicitation",
    createdAt: Timestamp.now(),
  };
  const docRef = await getAdminDb()
    .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
    .doc(conversationId)
    .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
    .add({ ...base, ...overrides });
  return docRef.id;
}

/** Relit un doc message brut depuis Firestore (typé `Message`). */
async function readMessageDoc(conversationId: string, messageId: string): Promise<Message> {
  const snap = await getAdminDb()
    .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
    .doc(conversationId)
    .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
    .doc(messageId)
    .get();
  return snap.data() as Message;
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
        outboundKind: "solicitation",
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
        outboundKind: "solicitation",
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
        outboundKind: "solicitation",
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
        generatedBy: "human",
        outboundKind: "solicitation", // commercial qui répond manuellement
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
        addOutbound("conv_out_4", {
          body: "",
          channel: "sms",
          generatedBy: "ai",
          outboundKind: "solicitation",
        }),
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
        addOutbound("conv_out_5", {
          body,
          channel: "sms",
          generatedBy: "ai",
          outboundKind: "solicitation",
        }),
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
        outboundKind: "solicitation",
      });
      expect(messageId).toMatch(FIRESTORE_AUTO_ID_PATTERN);
    });

    it("conversation inexistante → throw NotFoundError", async () => {
      await expect(
        addOutbound("conv_ghost", {
          body: "hello",
          channel: "sms",
          generatedBy: "ai",
          outboundKind: "solicitation",
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("conversation corrompue → throw ValidationError, aucun message créé", async () => {
      await getAdminDb()
        .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
        .doc("conv_broken")
        .set({ contactId: "x" }); // pas messageCount, etc.

      await expect(
        addOutbound("conv_broken", {
          body: "hello",
          channel: "sms",
          generatedBy: "ai",
          outboundKind: "solicitation",
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await countMessages("conv_broken")).toBe(0);
    });

    it("ATOMICITÉ : si appendAuditLogTx throw, message + compteurs rolled back", async () => {
      await seedConversation("conv_out_atomic");
      const spy = vi.spyOn(auditLogModule, "appendAuditLogTx").mockImplementation(() => {
        throw new AuditPiiError({ message: "simulated audit fail" });
      });

      await expect(
        addOutbound("conv_out_atomic", {
          body: "hello",
          channel: "sms",
          generatedBy: "ai",
          outboundKind: "solicitation",
        }),
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
        outboundKind: "solicitation",
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
  // addOutboundInTx (DEBT-001.2)
  // ───────────────────────────────────────────────────────────────────────

  describe("addOutboundInTx (DEBT-001.2)", () => {
    // ⚠️  `addOutboundInTx` reconstruit le convId via
    // `conversationDocId(conv.contactId, conv.campaignId)`. Le caller doit
    // donc seeder le doc conversation au convId DÉRIVÉ pour que les writes
    // tx (update conv counters, message subcollection) atterrissent
    // au bon endroit. Helper local pour garantir cet alignement.
    function seedConvDerived(contactId: string, campaignId: string) {
      const convId = conversationDocId(contactId, campaignId);
      return seedConversation(convId, { contactId, campaignId }).then(() => convId);
    }

    it("happy path dans une tx fournie : crée message + bump compteurs + audit sms_sent", async () => {
      // Prouve le bout-en-bout end-to-end via l'emulator : le caller
      // ouvre la tx, lit conv DANS la tx, puis appelle addOutboundInTx.
      // Représente le pattern qu'utilisera sendOutboundWithLock (DEBT-001.5).
      const convId = await seedConvDerived("contact_intx_1", "camp_intx_1");

      const messageId = await getAdminDb().runTransaction(async (tx) => {
        const convRef = getAdminDb().collection(__CONVERSATIONS_COLLECTION_FOR_TESTS).doc(convId);
        const doc = await tx.get(convRef);
        const conv = _parseConversationOrThrow(doc.data(), convId);
        return addOutboundInTx(tx, convId, conv, {
          body: "Bonjour, Léa de Médéré — STOP pour refuser.",
          channel: "sms",
          generatedBy: "ai",
          outboundKind: "solicitation",
          aiModel: "claude-sonnet-4-6",
        });
      });

      expect(messageId).toMatch(FIRESTORE_AUTO_ID_PATTERN);

      // Doc message créé
      const msgSnap = await getAdminDb()
        .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
        .doc(convId)
        .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
        .doc(messageId)
        .get();
      expect(msgSnap.exists).toBe(true);
      const msg = msgSnap.data() as Message;
      expect(msg.direction).toBe("outbound");
      expect(msg.status).toBe("queued");

      // Compteurs bumpés
      const convSnap = await getAdminDb()
        .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
        .doc(convId)
        .get();
      const conv = convSnap.data() as Conversation;
      expect(conv.outboundCount).toBe(1);
      expect(conv.messageCount).toBe(1);

      // Audit sms_sent posé
      const audits = await getAdminDb().collection(__AUDIT_COLLECTION_FOR_TESTS).get();
      expect(audits.size).toBe(1);
      const audit = audits.docs[0]?.data();
      expect(audit?.action).toBe("sms_sent");
      expect(audit?.payload).toEqual({ direction: "outbound", messageId });
    });

    it("retourne le messageId généré (Firestore auto-ID 20 chars)", async () => {
      const convId = await seedConvDerived("contact_intx_id", "camp_intx_id");

      const messageId = await getAdminDb().runTransaction(async (tx) => {
        const doc = await tx.get(
          getAdminDb().collection(__CONVERSATIONS_COLLECTION_FOR_TESTS).doc(convId),
        );
        const conv = _parseConversationOrThrow(doc.data(), convId);
        return addOutboundInTx(tx, convId, conv, {
          body: "Hello",
          channel: "sms",
          generatedBy: "ai",
          outboundKind: "solicitation",
        });
      });

      expect(messageId).toMatch(FIRESTORE_AUTO_ID_PATTERN);
      expect(messageId.length).toBe(20);
    });

    it("NE crée PAS sa propre tx (getAdminDb().runTransaction n'est PAS appelé par addOutboundInTx)", async () => {
      // Sentinelle anti-régression : si quelqu'un wrappe addOutboundInTx
      // dans son propre runTransaction (régression de design), ce test
      // casse. Le contrat est : LE CALLER fournit la tx, addOutboundInTx
      // opère dessus point.
      const convId = await seedConvDerived("contact_intx_notx", "camp_intx_notx");

      const db = getAdminDb();
      // Spy sur runTransaction avant l'appel. addOutboundInTx ne doit JAMAIS
      // l'appeler — c'est la tx fournie qui pose tous les writes.
      const runTxSpy = vi.spyOn(db, "runTransaction");

      // On ouvre NOUS la tx (le caller), addOutboundInTx la consomme.
      await db.runTransaction(async (tx) => {
        const doc = await tx.get(db.collection(__CONVERSATIONS_COLLECTION_FOR_TESTS).doc(convId));
        const conv = _parseConversationOrThrow(doc.data(), convId);
        return addOutboundInTx(tx, convId, conv, {
          body: "Hello",
          channel: "sms",
          generatedBy: "ai",
          outboundKind: "solicitation",
        });
      });

      // 1 SEUL appel à runTransaction : celui qu'on a ouvert nous-mêmes.
      // Si addOutboundInTx avait ouvert sa propre tx (régression), on en
      // verrait 2.
      expect(runTxSpy).toHaveBeenCalledTimes(1);

      runTxSpy.mockRestore();
    });

    it("body vide → throw ValidationError, tx rollback (aucune écriture)", async () => {
      const convId = await seedConvDerived("contact_intx_empty", "camp_intx_empty");
      const auditsBefore = await countAuditDocs();

      await expect(
        getAdminDb().runTransaction(async (tx) => {
          const doc = await tx.get(
            getAdminDb().collection(__CONVERSATIONS_COLLECTION_FOR_TESTS).doc(convId),
          );
          const conv = _parseConversationOrThrow(doc.data(), convId);
          return addOutboundInTx(tx, convId, conv, {
            body: "",
            channel: "sms",
            generatedBy: "ai",
            outboundKind: "solicitation",
          });
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      // Rollback total
      expect(await countMessages(convId)).toBe(0);
      expect(await countAuditDocs()).toBe(auditsBefore);
      const convSnap = await getAdminDb()
        .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
        .doc(convId)
        .get();
      expect((convSnap.data() as Conversation).outboundCount).toBe(0);
    });

    it("body > BODY_MAX_LENGTH → throw ValidationError (défense en profondeur)", async () => {
      // Re-validation DANS addOutboundInTx en plus de la pre-flight d'addOutbound.
      // Garantit que les callers directs (sendOutboundWithLock) sont aussi
      // protégés.
      const convId = await seedConvDerived("contact_intx_huge", "camp_intx_huge");

      const huge = "x".repeat(__BODY_MAX_LENGTH_FOR_TESTS + 1);
      await expect(
        getAdminDb().runTransaction(async (tx) => {
          const doc = await tx.get(
            getAdminDb().collection(__CONVERSATIONS_COLLECTION_FOR_TESTS).doc(convId),
          );
          const conv = _parseConversationOrThrow(doc.data(), convId);
          return addOutboundInTx(tx, convId, conv, {
            body: huge,
            channel: "sms",
            generatedBy: "ai",
            outboundKind: "solicitation",
          });
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("ATOMICITÉ : audit fail → rollback message + compteurs DANS la tx parente", async () => {
      const convId = await seedConvDerived("contact_intx_atomic", "camp_intx_atomic");
      const spy = vi.spyOn(auditLogModule, "appendAuditLogTx").mockImplementation(() => {
        throw new AuditPiiError({ message: "simulated audit fail in tx" });
      });

      await expect(
        getAdminDb().runTransaction(async (tx) => {
          const doc = await tx.get(
            getAdminDb().collection(__CONVERSATIONS_COLLECTION_FOR_TESTS).doc(convId),
          );
          const conv = _parseConversationOrThrow(doc.data(), convId);
          return addOutboundInTx(tx, convId, conv, {
            body: "Hello",
            channel: "sms",
            generatedBy: "ai",
            outboundKind: "solicitation",
          });
        }),
      ).rejects.toBeInstanceOf(AuditPiiError);

      // Rollback total : message ABSENT, compteur INCHANGÉ.
      expect(await countMessages(convId)).toBe(0);
      const convSnap = await getAdminDb()
        .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
        .doc(convId)
        .get();
      expect((convSnap.data() as Conversation).outboundCount).toBe(0);

      spy.mockRestore();
    });

    it("SENTINELLE — action audit = 'sms_sent' exactement (régression si renommée)", async () => {
      // Le mapping (direction outbound → action sms_sent) est verrouillé
      // par S6.5 et utilisé par les requêtes forensiques (`audit_log` où
      // action == "sms_sent" donne les envois). Si quelqu'un renomme
      // l'action côté addOutboundInTx, ce test casse.
      const convId = await seedConvDerived("contact_intx_action", "camp_intx_action");
      let capturedAction: string | undefined;
      const spy = vi.spyOn(auditLogModule, "appendAuditLogTx").mockImplementation((_tx, entry) => {
        capturedAction = entry.action;
        return "fake-audit-id";
      });

      await getAdminDb().runTransaction(async (tx) => {
        const doc = await tx.get(
          getAdminDb().collection(__CONVERSATIONS_COLLECTION_FOR_TESTS).doc(convId),
        );
        const conv = _parseConversationOrThrow(doc.data(), convId);
        return addOutboundInTx(tx, convId, conv, {
          body: "Hello",
          channel: "sms",
          generatedBy: "ai",
          outboundKind: "solicitation",
        });
      });

      expect(capturedAction).toBe("sms_sent");
      spy.mockRestore();
    });

    it("SENTINELLE — payload audit = { direction, messageId } UNIQUEMENT (pas de body, pas de body length)", async () => {
      const convId = await seedConvDerived("contact_intx_payload", "camp_intx_payload");
      let capturedPayload: Record<string, unknown> | undefined;
      const spy = vi.spyOn(auditLogModule, "appendAuditLogTx").mockImplementation((_tx, entry) => {
        capturedPayload = entry.payload;
        return "fake-audit-id";
      });

      const messageId = await getAdminDb().runTransaction(async (tx) => {
        const doc = await tx.get(
          getAdminDb().collection(__CONVERSATIONS_COLLECTION_FOR_TESTS).doc(convId),
        );
        const conv = _parseConversationOrThrow(doc.data(), convId);
        return addOutboundInTx(tx, convId, conv, {
          body: "PII risk: 0612345678 should not appear in audit",
          channel: "sms",
          generatedBy: "ai",
          outboundKind: "solicitation",
        });
      });

      expect(capturedPayload).toEqual({ direction: "outbound", messageId });
      // Sentinelle stricte : pas de clé en plus.
      expect(Object.keys(capturedPayload!).sort()).toEqual(["direction", "messageId"]);
      spy.mockRestore();
    });

    it("conversationId explicite est la source de vérité (PAS de dérivation depuis conv.contactId)", async () => {
      // Sentinelle anti-régression : `addOutboundInTx` opère sur le
      // conversationId EXPLICITE fourni par le caller, pas sur un convId
      // dérivé de `conv.contactId + conv.campaignId`. Si quelqu'un
      // refactore en dérivation (régression de design), ce test casse :
      // on seed à un convId arbitraire qui NE PEUT PAS être dérivé du
      // conv (contactId+campaignId ne forment pas le convId seedé).
      const arbitraryConvId = "arbitrary_legacy_convid_format";
      // conv contient un contactId/campaignId qui NE formeraient PAS
      // `arbitrary_legacy_convid_format` si on les concaténait.
      await seedConversation(arbitraryConvId, {
        contactId: "unrelated_contact",
        campaignId: "unrelated_camp",
      });

      const messageId = await getAdminDb().runTransaction(async (tx) => {
        const doc = await tx.get(
          getAdminDb().collection(__CONVERSATIONS_COLLECTION_FOR_TESTS).doc(arbitraryConvId),
        );
        const conv = _parseConversationOrThrow(doc.data(), arbitraryConvId);
        return addOutboundInTx(tx, arbitraryConvId, conv, {
          body: "Hello",
          channel: "sms",
          generatedBy: "ai",
          outboundKind: "solicitation",
        });
      });

      // Le doc message DOIT être dans la sous-collection du
      // arbitraryConvId fourni explicitement — PAS d'un convId dérivé.
      const msgSnap = await getAdminDb()
        .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
        .doc(arbitraryConvId)
        .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
        .doc(messageId)
        .get();
      expect(msgSnap.exists).toBe(true);

      // Le bump compteur DOIT être sur le doc arbitraryConvId.
      const convSnap = await getAdminDb()
        .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
        .doc(arbitraryConvId)
        .get();
      expect((convSnap.data() as Conversation).outboundCount).toBe(1);
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
  // findInboundByExternalId (S9.1)
  // ───────────────────────────────────────────────────────────────────────

  describe("findInboundByExternalId (S9.1)", () => {
    it("doublon webhook OVH → retourne { messageId, message } du doublon", async () => {
      await seedConversation("conv_dedup_1");
      const seededMessageId = await addInbound("conv_dedup_1", {
        body: "Oui ça m'intéresse",
        channel: "sms",
        externalId: "ovh-webhook-dedup-001",
        externalReceiver: "+33611112222",
      });

      const found = await findInboundByExternalId("conv_dedup_1", "ovh-webhook-dedup-001");
      expect(found).not.toBeNull();
      // Retour S9.2.1 : { messageId, message } pour permettre l'audit
      // reply_dropped duplicate avec duplicateOfMessageId.
      expect(found?.messageId).toBe(seededMessageId);
      expect(found?.messageId).toMatch(FIRESTORE_AUTO_ID_PATTERN);
      expect(found?.message.direction).toBe("inbound");
      expect(found?.message.externalId).toBe("ovh-webhook-dedup-001");
      expect(found?.message.body).toBe("Oui ça m'intéresse");
    });

    it("aucun doublon → retourne null (PAS NotFoundError, sémantique lecture tolérante)", async () => {
      await seedConversation("conv_dedup_2");
      // Aucun message créé. La query doit retourner null sans throw.
      const found = await findInboundByExternalId("conv_dedup_2", "ovh-webhook-never-seen");
      expect(found).toBeNull();
    });

    it("EXCLUT les messages OUTBOUND (filtre direction == inbound)", async () => {
      // Sentinelle anti-régression : si quelqu'un retire le filtre
      // `.where("direction", "==", "inbound")`, un message outbound qui
      // partagerait l'externalId (ex: ovhMessageId réutilisé) ferait
      // matcher la query → faux positif dédup → SMS inbound jamais traité.
      await seedConversation("conv_dedup_3");
      // Seed un outbound DIRECT avec externalId = celui qu'on va chercher.
      await seedMessage("conv_dedup_3", {
        direction: "outbound",
        externalId: "ovh-shared-id-001",
        status: "sent",
        body: "outbound msg",
      });

      const found = await findInboundByExternalId("conv_dedup_3", "ovh-shared-id-001");
      expect(found).toBeNull();
    });

    it("EXCLUT les inbound d'autres conversations (scope sous-collection)", async () => {
      // Sentinelle anti-régression : la query doit être scopée à la
      // sous-collection de la conversation cible, pas un collectionGroup.
      await seedConversation("conv_dedup_4a");
      await seedConversation("conv_dedup_4b");

      await addInbound("conv_dedup_4a", {
        body: "msg dans 4a",
        channel: "sms",
        externalId: "ovh-cross-conv-001",
        externalReceiver: "+33611112222",
      });

      // Recherche le même externalId mais dans la conversation 4b.
      const found = await findInboundByExternalId("conv_dedup_4b", "ovh-cross-conv-001");
      expect(found).toBeNull();
    });

    it("externalId vide → throw ValidationError AVANT query", async () => {
      // Defense-in-depth : signal d'un bug d'orchestration côté caller.
      // L'event Inngest valide déjà `min(1)` côté Zod, donc ce cas
      // n'arrive jamais en flow normal — mais on ne fait pas confiance.
      await expect(findInboundByExternalId("conv_x", "")).rejects.toBeInstanceOf(ValidationError);
    });

    it("conversation inexistante → null (lecture tolérante, PAS NotFoundError)", async () => {
      // Cohérent avec `listRecentOutbound` (l.612-618 : "conversation
      // absente → []"). La sémantique "y a-t-il un doublon ?" se traduit
      // logiquement en "non" quand la conversation n'existe pas — c'est
      // le caller process-reply qui décide quoi en faire en amont.
      const found = await findInboundByExternalId("conv_ghost", "ovh-1");
      expect(found).toBeNull();
    });

    it("doc trouvé mais corrompu → throw ValidationError au parse Zod", async () => {
      // Écrit un doc partiel direct dans la sous-collection avec
      // externalId qui matche la query. Doit fail au parse Zod (body
      // manquant, status manquant, etc.).
      await seedConversation("conv_dedup_corrupt");
      await getAdminDb()
        .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
        .doc("conv_dedup_corrupt")
        .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
        .add({
          direction: "inbound",
          externalId: "ovh-corrupt-001",
          createdAt: Timestamp.now(),
          // body / status / channel / generatedBy manquants → Zod fail.
        });

      await expect(
        findInboundByExternalId("conv_dedup_corrupt", "ovh-corrupt-001"),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // listRecentOutbound
  // ───────────────────────────────────────────────────────────────────────

  describe("listRecentOutbound", () => {
    it("3 outbound créés → 3 retournés, ordre DESC par createdAt", async () => {
      await seedConversation("conv_list_1");
      await addOutbound("conv_list_1", {
        body: "msg 1",
        channel: "sms",
        generatedBy: "ai",
        outboundKind: "solicitation",
      });
      await new Promise((r) => setTimeout(r, 10)); // garantir createdAt distinct
      await addOutbound("conv_list_1", {
        body: "msg 2",
        channel: "sms",
        generatedBy: "ai",
        outboundKind: "solicitation",
      });
      await new Promise((r) => setTimeout(r, 10));
      await addOutbound("conv_list_1", {
        body: "msg 3",
        channel: "sms",
        generatedBy: "ai",
        outboundKind: "solicitation",
      });

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
      await addOutbound("conv_list_2", {
        body: "out 1",
        channel: "sms",
        generatedBy: "ai",
        outboundKind: "solicitation",
      });
      await addInbound("conv_list_2", {
        body: "in 1",
        channel: "sms",
        externalId: "ovh-1",
        externalReceiver: "+33611111111",
      });
      await addOutbound("conv_list_2", {
        body: "out 2",
        channel: "sms",
        generatedBy: "ai",
        outboundKind: "solicitation",
      });

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
  // listRecentOutboundInTx (DEBT-001.2)
  // ───────────────────────────────────────────────────────────────────────

  describe("listRecentOutboundInTx (DEBT-001.2)", () => {
    it("retourne OutboundMessageRecord[] parsé identique à listRecentOutbound (sémantique préservée)", async () => {
      // Garantit que la version tx-aware retourne EXACTEMENT le même
      // résultat que la version HORS tx — seul le mode de lecture diffère
      // (tx.get vs .get). Comparaison ordre + sentAt mapping.
      const convId = "conv_listtx_1";
      await seedConversation(convId);
      const now = new Date("2026-05-17T12:00:00Z");
      const t1Created = Timestamp.fromDate(new Date("2026-05-15T10:00:00Z"));
      const t1Sent = Timestamp.fromDate(new Date("2026-05-15T10:05:00Z"));
      const t2Created = Timestamp.fromDate(new Date("2026-05-16T10:00:00Z"));

      await seedMessage(convId, { createdAt: t1Created, sentAt: t1Sent, status: "sent" });
      await seedMessage(convId, { createdAt: t2Created, status: "queued" });

      const txResult = await getAdminDb().runTransaction((tx) =>
        listRecentOutboundInTx(tx, convId, 30, now),
      );

      expect(txResult).toHaveLength(2);
      // Ordre DESC : t2 (16 mai) avant t1 (15 mai).
      expect((txResult[0]?.sentAt as Timestamp).toMillis()).toBe(t2Created.toMillis());
      // Mapping fallback préservé : t1 a sentAt → sentAt, t2 n'en a pas → createdAt.
      expect((txResult[1]?.sentAt as Timestamp).toMillis()).toBe(t1Sent.toMillis());

      // Cross-check : listRecentOutbound HORS tx donne le même résultat.
      const nonTxResult = await listRecentOutbound(convId, 30, now);
      expect(txResult).toEqual(nonTxResult);
    });

    it("respecte days param custom (7j → message à J-10 exclu, J-3 inclus)", async () => {
      const convId = "conv_listtx_days";
      await seedConversation(convId);
      const now = new Date("2026-05-17T12:00:00Z");
      const t10DaysAgo = Timestamp.fromDate(new Date(now.getTime() - 10 * 86400_000));
      const t3DaysAgo = Timestamp.fromDate(new Date(now.getTime() - 3 * 86400_000));

      await seedMessage(convId, { createdAt: t10DaysAgo, body: "old" });
      await seedMessage(convId, { createdAt: t3DaysAgo, body: "recent" });

      const result = await getAdminDb().runTransaction((tx) =>
        listRecentOutboundInTx(tx, convId, 7, now),
      );
      expect(result).toHaveLength(1);
      expect((result[0]?.sentAt as Timestamp).toMillis()).toBe(t3DaysAgo.toMillis());
    });

    it("default days === DEFAULT_LIST_DAYS (30) — sentinelle alignement S4", async () => {
      // Verrouille que listRecentOutboundInTx utilise le MÊME default que
      // listRecentOutbound. Si quelqu'un divergeait les defaults (ex: 60 jours
      // pour la version tx), le calcul rate-limit serait incohérent entre
      // les 2 paths.
      const convId = "conv_listtx_default";
      await seedConversation(convId);
      const now = new Date("2026-05-17T12:00:00Z");
      const t29DaysAgo = Timestamp.fromDate(new Date(now.getTime() - 29 * 86400_000));
      const t31DaysAgo = Timestamp.fromDate(new Date(now.getTime() - 31 * 86400_000));

      await seedMessage(convId, { createdAt: t29DaysAgo, body: "in_window" });
      await seedMessage(convId, { createdAt: t31DaysAgo, body: "out_of_window" });

      // Pas de `days` param → default 30j.
      const result = await getAdminDb().runTransaction((tx) =>
        listRecentOutboundInTx(tx, convId, undefined, now),
      );
      expect(result).toHaveLength(1);
      expect((result[0]?.sentAt as Timestamp).toMillis()).toBe(t29DaysAgo.toMillis());
      expect(__DEFAULT_LIST_DAYS_FOR_TESTS).toBe(30);
    });

    it("SENTINELLE — utilise tx.get(query), JAMAIS query.get() direct (anti-régression race rate-limit)", async () => {
      // Si quelqu'un remplace `tx.get(query)` par `query.get()` direct dans
      // listRecentOutboundInTx (régression accidentelle), la query lit
      // l'état Firestore HORS du contexte tx et la race DETTE-001 redevient
      // possible. Ce test mock un fake tx qui track tous les appels `tx.get`
      // et asserte que le résultat passe par lui — PAS par `.get()` direct.
      const convId = "conv_listtx_sentinel";
      await seedConversation(convId);
      const t1 = Timestamp.fromDate(new Date(Date.now() - 86400_000));
      await seedMessage(convId, { createdAt: t1, body: "m1", status: "sent" });

      // Compte les appels via spy sur le SDK Firestore réel : tx.get DOIT
      // être appelé au moins 1x avec une Query (notre query DESC). Si
      // listRecentOutboundInTx avait appelé `.get()` direct, tx.get ne serait
      // pas appelé sur la Query (uniquement éventuellement pour le contact
      // ailleurs).
      const txGetCalls: unknown[] = [];

      await getAdminDb().runTransaction(async (tx) => {
        const originalTxGet = tx.get.bind(tx);
        // Wrapper qui track les calls — exécute l'original derrière.
        tx.get = ((arg: unknown) => {
          txGetCalls.push(arg);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return originalTxGet(arg as any);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any;
        return listRecentOutboundInTx(tx, convId, 30);
      });

      // Au moins 1 appel à tx.get (notre Query).
      expect(txGetCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("conversation absente → [] (PAS NotFoundError, sémantique tolérante préservée)", async () => {
      const result = await getAdminDb().runTransaction((tx) =>
        listRecentOutboundInTx(tx, "conv_ghost_tx"),
      );
      expect(result).toEqual([]);
    });

    it("doc message corrompu → throw ValidationError au parse Zod (filet en lecture)", async () => {
      const convId = "conv_listtx_corrupt";
      await seedConversation(convId);
      const now = new Date("2026-05-01T12:00:00Z");
      const recent = Timestamp.fromDate(new Date(now.getTime() - 60_000));
      await getAdminDb()
        .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
        .doc(convId)
        .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
        .add({
          direction: "outbound",
          createdAt: recent,
          // body/status/channel/generatedBy manquants → Zod fail
        });

      await expect(
        getAdminDb().runTransaction((tx) => listRecentOutboundInTx(tx, convId, 30, now)),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("conversation vide → [] (consistent avec listRecentOutbound)", async () => {
      const convId = "conv_listtx_empty";
      await seedConversation(convId);
      const result = await getAdminDb().runTransaction((tx) => listRecentOutboundInTx(tx, convId));
      expect(result).toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // listRecentOutboundByContact{,InTx} (PR-PER-CONTACT) — fan-out
  // ───────────────────────────────────────────────────────────────────────

  describe("listRecentOutboundByContact{,InTx} (PR-PER-CONTACT)", () => {
    it("FAN-OUT : 1 contact, 3 conversations × 1 outbound → 3 records (somme des 3)", async () => {
      // Le cœur de la PR : le comptage agrège les conversations d'un même
      // PS. Scopé conversation, on aurait lu 1 seul message.
      const contactId = "hs_fanout";
      const now = new Date("2026-05-17T12:00:00Z");

      for (const camp of ["a", "b", "c"]) {
        const convId = `${contactId}_camp_${camp}`;
        await seedConversation(convId, { contactId, campaignId: `camp_${camp}` });
        await seedMessage(convId, {
          createdAt: Timestamp.fromDate(new Date("2026-05-15T10:00:00Z")),
          status: "sent",
          body: `msg_${camp}`,
        });
      }

      const result = await listRecentOutboundByContact(contactId, 30, now);

      expect(result).toHaveLength(3);
      // Comparaison de contrôle : la version scopée conversation n'en voit qu'1.
      expect(await listRecentOutbound(`${contactId}_camp_a`, 30, now)).toHaveLength(1);
    });

    it("🔒 conversation `closed` : ses outbounds comptent QUAND MÊME", async () => {
      // Une conv terminée porte des SMS réellement reçus par le PS — ils
      // dérangent au sens L.34-5 CPCE tant qu'ils sont dans la fenêtre 30j.
      const contactId = "hs_closed";
      const now = new Date("2026-05-17T12:00:00Z");
      const recent = Timestamp.fromDate(new Date("2026-05-15T10:00:00Z"));

      await seedConversation(`${contactId}_camp_closed`, { contactId, status: "closed" });
      await seedMessage(`${contactId}_camp_closed`, { createdAt: recent, status: "delivered" });

      await seedConversation(`${contactId}_camp_live`, { contactId, status: "in_dialogue" });
      await seedMessage(`${contactId}_camp_live`, { createdAt: recent, status: "sent" });

      const result = await listRecentOutboundByContact(contactId, 30, now);
      expect(result).toHaveLength(2);
    });

    it("les invariants de listRecentOutbound survivent au fan-out (fenêtre + status + inbound)", async () => {
      // Le fan-out RÉUTILISE listRecentOutbound : ses filtres doivent
      // continuer de s'appliquer conversation par conversation.
      const contactId = "hs_invariants";
      const now = new Date("2026-05-17T12:00:00Z");
      const inWindow = Timestamp.fromDate(new Date(now.getTime() - 5 * 86400_000));
      const outOfWindow = Timestamp.fromDate(new Date(now.getTime() - 31 * 86400_000));

      await seedConversation(`${contactId}_camp_a`, { contactId });
      await seedMessage(`${contactId}_camp_a`, { createdAt: inWindow, status: "sent" });
      await seedMessage(`${contactId}_camp_a`, { createdAt: outOfWindow, status: "sent" }); // hors 30j
      await seedMessage(`${contactId}_camp_a`, { createdAt: inWindow, status: "draft" }); // exclu
      await seedMessage(`${contactId}_camp_a`, { createdAt: inWindow, status: "failed" }); // exclu

      await seedConversation(`${contactId}_camp_b`, { contactId });
      await seedMessage(`${contactId}_camp_b`, { createdAt: inWindow, status: "queued" });
      await seedMessage(`${contactId}_camp_b`, {
        direction: "inbound",
        status: "received",
        createdAt: inWindow,
      }); // exclu

      const result = await listRecentOutboundByContact(contactId, 30, now);
      expect(result).toHaveLength(2); // 1 `sent` (conv a) + 1 `queued` (conv b)
    });

    it("ordre DESC par sentAt à l'échelle du CONTACT (fusion inter-conversations)", async () => {
      const contactId = "hs_merge_order";
      const now = new Date("2026-05-17T12:00:00Z");
      const t1 = Timestamp.fromDate(new Date("2026-05-10T10:00:00Z"));
      const t2 = Timestamp.fromDate(new Date("2026-05-14T10:00:00Z"));
      const t3 = Timestamp.fromDate(new Date("2026-05-16T10:00:00Z"));

      await seedConversation(`${contactId}_camp_a`, { contactId });
      await seedConversation(`${contactId}_camp_b`, { contactId });
      // Entrelacé volontairement : t1 et t3 dans A, t2 dans B.
      await seedMessage(`${contactId}_camp_a`, { createdAt: t1, status: "sent" });
      await seedMessage(`${contactId}_camp_a`, { createdAt: t3, status: "sent" });
      await seedMessage(`${contactId}_camp_b`, { createdAt: t2, status: "sent" });

      const result = await listRecentOutboundByContact(contactId, 30, now);

      const millis = result.map((r) => (r.sentAt as Timestamp).toMillis());
      expect(millis).toEqual([t3.toMillis(), t2.toMillis(), t1.toMillis()]);
    });

    it("contact sans conversation → []", async () => {
      expect(await listRecentOutboundByContact("hs_void", 30, new Date())).toEqual([]);
    });

    it("contactId vide → ValidationError (propagé par l'étage 1)", async () => {
      await expect(listRecentOutboundByContact("")).rejects.toBeInstanceOf(ValidationError);
    });

    it("SENTINELLE alignement : listRecentOutboundByContactInTx === listRecentOutboundByContact", async () => {
      // Extension au fan-out de la sentinelle historique
      // (`listRecentOutboundInTx` === `listRecentOutbound`). Si les 2
      // chemins divergent, le pré-check HORS tx et le re-check autoritaire
      // DANS la tx ne comptent plus la même chose.
      const contactId = "hs_align_fanout";
      const now = new Date("2026-05-17T12:00:00Z");
      const t1Created = Timestamp.fromDate(new Date("2026-05-15T10:00:00Z"));
      const t1Sent = Timestamp.fromDate(new Date("2026-05-15T10:05:00Z"));
      const t2Created = Timestamp.fromDate(new Date("2026-05-16T10:00:00Z"));

      await seedConversation(`${contactId}_camp_a`, { contactId });
      await seedConversation(`${contactId}_camp_b`, { contactId, status: "closed" });
      await seedMessage(`${contactId}_camp_a`, {
        createdAt: t1Created,
        sentAt: t1Sent,
        status: "sent",
      });
      await seedMessage(`${contactId}_camp_b`, { createdAt: t2Created, status: "queued" });

      const nonTx = await listRecentOutboundByContact(contactId, 30, now);
      const inTx = await getAdminDb().runTransaction((tx) =>
        listRecentOutboundByContactInTx(tx, contactId, 30, now),
      );

      expect(inTx).toEqual(nonTx);
      expect(inTx).toHaveLength(2);
      // Mapping fallback `sentAt ?? createdAt` préservé à travers le fan-out.
      expect((inTx[0]?.sentAt as Timestamp).toMillis()).toBe(t2Created.toMillis());
      expect((inTx[1]?.sentAt as Timestamp).toMillis()).toBe(t1Sent.toMillis());
    });

    it("🔒 ANTI-TRONCATURE : N > seuil de warn → les N conversations sont lues, aucun message perdu", async () => {
      // Miroir messages.ts du test conversations.ts : on vérifie ici que
      // le fan-out AGRÈGE bien les N conversations (1 outbound chacune).
      const contactId = "hs_many_msgs";
      const now = new Date("2026-05-17T12:00:00Z");
      const createdAt = Timestamp.fromDate(new Date("2026-05-15T10:00:00Z"));
      const count = __CONVERSATION_FANOUT_WARN_THRESHOLD_FOR_TESTS + 2;

      for (let i = 0; i < count; i++) {
        const convId = `${contactId}_camp_${String(i).padStart(2, "0")}`;
        await seedConversation(convId, { contactId });
        await seedMessage(convId, { createdAt, status: "sent", body: `m${i}` });
      }

      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
      const result = await listRecentOutboundByContact(contactId, 30, now);
      warnSpy.mockRestore();

      expect(result).toHaveLength(count);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Type-level (compile-time only, jamais exécuté)
  //
  // Ces tests vérifient que TypeScript refuse les inputs malformés. Pas
  // d'expect runtime — c'est `@ts-expect-error` qui assert. Si le compile
  // PASSE alors qu'il devrait FAIL, tsc throw "Unused @ts-expect-error".
  // ───────────────────────────────────────────────────────────────────────

  // ───────────────────────────────────────────────────────────────────────
  // outboundKind (PR-OUTBOUNDKIND) — estampillage à l'écriture
  // ───────────────────────────────────────────────────────────────────────

  describe("outboundKind (PR-OUTBOUNDKIND)", () => {
    it("addOutbound écrit la valeur tranchée par le caller ('solicitation')", async () => {
      const convId = "conv_kind_solicitation";
      await seedConversation(convId);

      const messageId = await addOutbound(convId, {
        body: "Bonjour Docteur, Léa de Médéré. STOP pour refuser.",
        channel: "sms",
        generatedBy: "ai",
        outboundKind: "solicitation",
      });

      const msg = await readMessageDoc(convId, messageId);
      expect(msg.outboundKind).toBe("solicitation");
    });

    it("addOutbound accepte aussi 'reply' quand la conv porte un inbound", async () => {
      // Cas d'usage futur : un commercial humain qui répond via le
      // dashboard. La garde ne se déclenche pas puisque le PS a écrit.
      const convId = "conv_kind_reply_ok";
      await seedConversation(convId, { inboundCount: 1, messageCount: 1 });

      const messageId = await addOutbound(convId, {
        body: "Bonjour Docteur, Léa de Médéré. STOP pour refuser.",
        channel: "sms",
        generatedBy: "human",
        outboundKind: "reply",
      });

      const msg = await readMessageDoc(convId, messageId);
      expect(msg.outboundKind).toBe("reply");
    });

    it("🔒 GARDE symétrique : addOutbound refuse 'reply' si inboundCount === 0", async () => {
      const convId = "conv_kind_reply_ko";
      await seedConversation(convId, { inboundCount: 0 });

      await expect(
        addOutbound(convId, {
          body: "Bonjour Docteur, Léa de Médéré. STOP pour refuser.",
          channel: "sms",
          generatedBy: "human",
          outboundKind: "reply",
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await countMessages(convId)).toBe(0);
    });

    it("🔒 FAIL-CLOSED : doc LEGACY sans outboundKind → parse OK, défaut 'solicitation'", async () => {
      // Les docs écrits avant cette PR n'ont pas le champ. Ils DOIVENT
      // rester lisibles (pas de ValidationError, sinon on bloque tous les
      // envois) ET compter comme sollicitations (au pire on sur-compte et
      // on bloque un envoi de trop — jamais l'inverse).
      //
      // C'est ce qui permet de se passer de backfill : la fenêtre
      // rate-limit étant glissante sur 30j, 30 jours après le déploiement
      // plus aucun doc comptabilisé n'est legacy.
      const convId = "conv_kind_legacy";
      await seedConversation(convId);

      // Écriture BRUTE sans outboundKind (simulation d'un doc pré-PR).
      const ref = await getAdminDb()
        .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
        .doc(convId)
        .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
        .add({
          direction: "outbound",
          body: "SMS legacy sans outboundKind",
          status: "sent",
          channel: "sms",
          generatedBy: "ai",
          createdAt: Timestamp.now(),
        });

      const snap = await getAdminDb()
        .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
        .doc(convId)
        .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
        .doc(ref.id)
        .get();

      // Le champ est bien ABSENT du doc Firestore…
      expect(snap.data()?.outboundKind).toBeUndefined();

      // …mais le parse le matérialise à "solicitation" (fail-closed).
      const parsed = _parseMessageOrThrow(snap.data(), convId, ref.id);
      expect(parsed.outboundKind).toBe("solicitation");

      // 🔒 SENTINELLE ANTI-DRIFT — le défaut appliqué par MessageSchema
      // DOIT être celui de `lib/compliance/outbound-kind.ts`, qui est la
      // source de vérité consommée à la lecture par `countsAgainstCap`.
      // Si les deux divergeaient, un doc legacy serait écrit/lu comme
      // sollicitation d'un côté et exclu du comptage de l'autre.
      expect(parsed.outboundKind).toBe(DEFAULT_OUTBOUND_KIND);
      expect(countsAgainstCap(parsed)).toBe(true);
    });

    it("SENTINELLE enum fermé : une valeur inconnue en base → ValidationError (fail-closed)", async () => {
      // Un doc portant une valeur hors enum n'est PAS silencieusement
      // ramené au défaut : il fait échouer le parse, donc l'envoi.
      const convId = "conv_kind_bogus";
      await seedConversation(convId);

      const ref = await getAdminDb()
        .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
        .doc(convId)
        .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
        .add({
          direction: "outbound",
          body: "SMS avec kind inconnu",
          status: "sent",
          channel: "sms",
          generatedBy: "ai",
          outboundKind: "followup",
          createdAt: Timestamp.now(),
        });

      const snap = await getAdminDb()
        .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
        .doc(convId)
        .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
        .doc(ref.id)
        .get();

      expect(() => _parseMessageOrThrow(snap.data(), convId, ref.id)).toThrow(ValidationError);
    });

    it("🔒 SENTINELLE `null` : outboundKind=null en base → ValidationError, PAS le défaut", async () => {
      // ─────────────────────────────────────────────────────────────────
      // POURQUOI CE TEST EXISTE
      //
      // `z.enum([...]).default(x)` ne se déclenche QUE sur `undefined`.
      // Une valeur `null` produit un `invalid_type`, donc un throw. C'est
      // le bon comportement (fail-closed : on bloque l'envoi plutôt que de
      // deviner la nature du message), MAIS c'est une subtilité de Zod que
      // rien ne garantit dans le temps :
      //
      //   - une future migration Zod pourrait aligner `null` sur
      //     `undefined` (comportement de `.nullish()`), ou
      //   - quelqu'un pourrait "corriger" le schéma en `.nullable()` ou
      //     `.catch(DEFAULT_OUTBOUND_KIND)` en croyant fiabiliser la
      //     lecture.
      //
      // Dans les deux cas, un doc à `null` deviendrait silencieusement une
      // "solicitation"… ou pire, si le `.catch()` était mal orienté, un
      // "reply" — donc exclu du comptage. Ce test verrouille le
      // comportement RÉEL observé, il ne le suppose pas.
      //
      // Firestore stocke `null` nativement (pas de coercition en
      // `undefined`), ce cas est donc atteignable en base : import
      // manuel, console Firebase, script de migration bâclé.
      // ─────────────────────────────────────────────────────────────────
      const convId = "conv_kind_null";
      await seedConversation(convId);

      const ref = await getAdminDb()
        .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
        .doc(convId)
        .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
        .add({
          direction: "outbound",
          body: "SMS avec outboundKind null",
          status: "sent",
          channel: "sms",
          generatedBy: "ai",
          outboundKind: null,
          createdAt: Timestamp.now(),
        });

      const snap = await getAdminDb()
        .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
        .doc(convId)
        .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
        .doc(ref.id)
        .get();

      // 1. Firestore a bien stocké `null` — et NON `undefined`. Sans cette
      //    assertion, le test pourrait passer pour la mauvaise raison (un
      //    champ absent, qui lui prend le défaut).
      expect(snap.data()?.outboundKind).toBeNull();

      // 2. Le parse REFUSE — il ne ramène PAS au défaut.
      expect(() => _parseMessageOrThrow(snap.data(), convId, ref.id)).toThrow(ValidationError);

      // 3. Contraste explicite : le MÊME doc sans le champ prend le défaut
      //    `"solicitation"`. C'est ce qui prouve que le refus de `null` est
      //    un comportement distinct et volontaire, pas un effet de bord du
      //    cas "champ absent".
      const { outboundKind: _dropped, ...sansLeChamp } = snap.data() as Record<string, unknown>;
      expect(_parseMessageOrThrow(sansLeChamp, convId, ref.id).outboundKind).toBe(
        DEFAULT_OUTBOUND_KIND,
      );

      // 4. 🔒 LE POINT QUI COMPTE — le refus se propage jusqu'au chemin de
      //    comptage. `listRecentOutbound` parse chaque doc : un `null` en
      //    base fait donc échouer le pré-check compliance, donc l'envoi.
      //    Fail-closed vérifié de bout en bout, pas seulement au parse.
      await expect(listRecentOutbound(convId)).rejects.toBeInstanceOf(ValidationError);
    });

    it("🔒 SÉPARATION DES RESPONSABILITÉS : le mapper TRANSPORTE, il ne filtre pas", async () => {
      // `listRecentOutbound` remonte TOUS les sortants comptables au sens
      // `RATE_LIMIT_COUNTED_STATUSES`, sollicitations ET réponses, en
      // propageant `outboundKind` verbatim. C'est `canSendMessage` (via
      // `countsAgainstCap`) qui décide ensuite ce qui compte.
      //
      // Si un jour ce mapper se mettait à filtrer lui-même, il y aurait
      // DEUX endroits où « ce qui compte » est décidé → drift garanti, et
      // le `totalOutboundCount` du contexte d'audit deviendrait faux.
      const convId = "conv_kind_mapper_transports";
      await seedConversation(convId, { inboundCount: 1, messageCount: 1 });
      const now = new Date();

      await addOutbound(convId, {
        body: "Sollicitation. STOP pour refuser. Médéré.",
        channel: "sms",
        generatedBy: "ai",
        outboundKind: "solicitation",
      });
      await addOutbound(convId, {
        body: "Réponse. STOP pour refuser. Médéré.",
        channel: "sms",
        generatedBy: "ai",
        outboundKind: "reply",
      });

      const records = await listRecentOutbound(convId, 30, now);
      // Le mapper remonte les 2…
      expect(records).toHaveLength(2);
      // …avec leur nature préservée (c'est ce transport qui permet à
      // `canSendMessage` de discriminer en aval).
      expect(records.map((r) => r.outboundKind).sort()).toEqual(["reply", "solicitation"]);
    });

    it("🔒 BOUT-EN-BOUT : 1 sollicitation + 10 réponses en base → canSendMessage AUTORISE", async () => {
      // Le scénario métier de PR-FILTRE-SOLLICITATION, vérifié sur la
      // vraie chaîne Firestore → mapper → compliance : une conversation
      // vivante ne sature jamais le plafond.
      const convId = "conv_kind_e2e_dialogue";
      await seedConversation(convId, { inboundCount: 1, messageCount: 1 });
      const now = new Date();

      await addOutbound(convId, {
        body: "1er SMS. STOP pour refuser. Médéré.",
        channel: "sms",
        generatedBy: "ai",
        outboundKind: "solicitation",
      });
      for (let i = 0; i < 10; i++) {
        await addOutbound(convId, {
          body: `Réponse ${i}. STOP pour refuser. Médéré.`,
          channel: "sms",
          generatedBy: "ai",
          outboundKind: "reply",
        });
      }

      const records = await listRecentOutbound(convId, 30, now);
      expect(records).toHaveLength(11);

      const counts = countSolicitationsInWindow(records, now);
      expect(counts.solicitationCount).toBe(1);
      expect(counts.totalOutboundCount).toBe(11);
      expect(canSendMessage(records, now).allowed).toBe(true);
    });

    it("🔒 BOUT-EN-BOUT : 4 sollicitations + 10 réponses en base → canSendMessage REFUSE", async () => {
      const convId = "conv_kind_e2e_cap";
      await seedConversation(convId, { inboundCount: 1, messageCount: 1 });
      const now = new Date();

      for (let i = 0; i < 4; i++) {
        await addOutbound(convId, {
          body: `Sollicitation ${i}. STOP pour refuser. Médéré.`,
          channel: "sms",
          generatedBy: "ai",
          outboundKind: "solicitation",
        });
      }
      for (let i = 0; i < 10; i++) {
        await addOutbound(convId, {
          body: `Réponse ${i}. STOP pour refuser. Médéré.`,
          channel: "sms",
          generatedBy: "ai",
          outboundKind: "reply",
        });
      }

      const records = await listRecentOutbound(convId, 30, now);
      const counts = countSolicitationsInWindow(records, now);
      expect(counts.solicitationCount).toBe(4);
      expect(counts.totalOutboundCount).toBe(14);
      expect(canSendMessage(records, now).allowed).toBe(false);
    });
  });

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
        outboundKind: "solicitation",
      });
      await addOutbound(convId, {
        // @ts-expect-error - status est FIGÉ par addOutbound (="queued")
        status: "sent",
        body: "x",
        channel: "sms",
        generatedBy: "ai",
        outboundKind: "solicitation",
      });
      await addOutbound(convId, {
        // @ts-expect-error - createdAt est FIGÉ (timestamp serveur)
        createdAt: new Date(),
        body: "x",
        channel: "sms",
        generatedBy: "ai",
        outboundKind: "solicitation",
      });
      await addOutbound(convId, {
        // @ts-expect-error - sentAt est posé par updateMessageStatus en S7
        sentAt: new Date(),
        body: "x",
        channel: "sms",
        generatedBy: "ai",
        outboundKind: "solicitation",
      });

      // 🔒 PR-OUTBOUNDKIND — `outboundKind` est REQUIS : le caller DOIT
      // trancher la nature de l'envoi au compile-time. L'omettre est une
      // erreur de compilation, pas un défaut silencieux.
      // @ts-expect-error - outboundKind manquant (champ REQUIS)
      await addOutbound(convId, {
        body: "x",
        channel: "sms",
        generatedBy: "ai",
      });

      // Et seules les 2 valeurs de l'enum fermé sont acceptées.
      await addOutbound(convId, {
        body: "x",
        channel: "sms",
        generatedBy: "ai",
        // @ts-expect-error - "followup" n'existe pas : une relance est une
        // sollicitation, pas une troisième catégorie.
        outboundKind: "followup",
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async function _typeCheckAddOutboundDraft(tx: Transaction, conv: Conversation, convId: string) {
      // 🔒 PR-OUTBOUNDKIND — `outboundKind` est FIGÉ à "reply" par
      // `addOutboundDraftInTx` (un draft naît toujours en réaction à un
      // inbound). Le caller ne peut PAS le fournir, au même titre que
      // `direction` / `status` / `generatedBy`.
      addOutboundDraftInTx(tx, conv, {
        // @ts-expect-error - outboundKind est FIGÉ par addOutboundDraftInTx (="reply")
        outboundKind: "solicitation",
        contactId: "contact_abc",
        conversationId: convId,
        body: "x",
        aiModel: "claude-sonnet-4-6",
        aiPromptVersion: "1.0.0",
        aiTemperature: 0.5,
        aiTokensInput: 1,
        aiTokensOutput: 1,
        aiGenerationDurationMs: 1,
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

  // ───────────────────────────────────────────────────────────────────────
  // S9.3.3a — Sentinelle RATE_LIMIT_COUNTED_STATUSES (whitelist explicite)
  // ───────────────────────────────────────────────────────────────────────

  describe("RATE_LIMIT_COUNTED_STATUSES (S9.3.3a-INVARIANT-RATE-LIMIT)", () => {
    it("contient EXACTEMENT ['queued', 'sending', 'sent', 'delivered']", () => {
      // 🔒 Sentinelle compliance — modification = re-validation
      // compliance-auditor + bump JSDoc + amender ces tests.
      // Cf. JSDoc RATE_LIMIT_COUNTED_STATUSES pour sémantique.
      expect([...RATE_LIMIT_COUNTED_STATUSES].sort()).toEqual([
        "delivered",
        "queued",
        "sending",
        "sent",
      ]);
    });

    it("EXCLUT 'draft' (S9.3 drafts non envoyés)", () => {
      expect((RATE_LIMIT_COUNTED_STATUSES as readonly string[]).includes("draft")).toBe(false);
    });

    it("EXCLUT 'failed' (sémantique S9.3.3a — un envoi qui n'a jamais atteint le PS)", () => {
      expect((RATE_LIMIT_COUNTED_STATUSES as readonly string[]).includes("failed")).toBe(false);
    });

    it("EXCLUT 'received' (déjà exclu par filtre direction='outbound', sentinelle redondante)", () => {
      expect((RATE_LIMIT_COUNTED_STATUSES as readonly string[]).includes("received")).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // S9.3.3a — listRecentOutbound : filtre status whitelist
  // ───────────────────────────────────────────────────────────────────────

  describe("listRecentOutbound — filtre status whitelist (S9.3.3a)", () => {
    it("EXCLUT les drafts du résultat (anti-pollution rate-limit)", async () => {
      // 🔒 Sentinelle critique — un draft S9.3 ne doit JAMAIS être compté
      // contre le plafond 3 SMS/30j. Si retiré, double-comptage en S9.4
      // quand `commitDraftToQueued` transitionnera le draft en queued.
      const convId = "conv_invariant_no_draft";
      await seedConversation(convId);

      const now = Timestamp.now();
      await seedMessage(convId, { status: "draft", createdAt: now, body: "draft body" });
      await seedMessage(convId, { status: "queued", createdAt: now, body: "queued body" });
      await seedMessage(convId, { status: "sent", createdAt: now, body: "sent body" });

      const result = await listRecentOutbound(convId);

      // Seuls queued + sent remontent (2 messages comptés).
      expect(result.length).toBe(2);
    });

    it("EXCLUT 'failed' du résultat (sémantique S9.3.3a)", async () => {
      // 🔒 Sentinelle — un envoi failed côté OVH n'a jamais atteint le PS,
      // donc ne compte pas comme une tentative de dérangement L.34-5 CPCE.
      // Changement de sémantique vs pré-S9.3.3a (où failed était compté
      // par effet de bord — absence de filtre status).
      const convId = "conv_invariant_no_failed";
      await seedConversation(convId);

      const now = Timestamp.now();
      await seedMessage(convId, { status: "failed", createdAt: now });
      await seedMessage(convId, { status: "queued", createdAt: now });

      const result = await listRecentOutbound(convId);

      // Seul queued remonte (failed exclu).
      expect(result.length).toBe(1);
    });

    it("INCLUT tous les statuts de la whitelist ['queued', 'sending', 'sent', 'delivered']", async () => {
      const convId = "conv_invariant_whitelist";
      await seedConversation(convId);

      const now = Timestamp.now();
      await seedMessage(convId, { status: "queued", createdAt: now });
      await seedMessage(convId, { status: "sending", createdAt: now });
      await seedMessage(convId, { status: "sent", createdAt: now });
      await seedMessage(convId, { status: "delivered", createdAt: now });

      const result = await listRecentOutbound(convId);

      expect(result.length).toBe(4);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // S9.3.3a — listRecentOutboundInTx : filtre status whitelist aligné
  // ───────────────────────────────────────────────────────────────────────

  describe("listRecentOutboundInTx — filtre status whitelist (S9.3.3a)", () => {
    it("EXCLUT les drafts (même sémantique que listRecentOutbound HORS tx)", async () => {
      // 🔒 Sentinelle anti-drift — la version tx-aware DOIT appliquer le
      // même filtre que la version HORS tx. Si drift, race rate-limit
      // possible en S9.4 (sendOutboundWithLock lit DANS tx, miss le draft
      // exclu HORS tx, et autorise un envoi qui aurait dû être bloqué).
      const convId = "conv_invarianttx_no_draft";
      await seedConversation(convId);

      const now = Timestamp.now();
      await seedMessage(convId, { status: "draft", createdAt: now });
      await seedMessage(convId, { status: "queued", createdAt: now });
      await seedMessage(convId, { status: "sent", createdAt: now });

      const result = await getAdminDb().runTransaction((tx) => listRecentOutboundInTx(tx, convId));

      expect(result.length).toBe(2);
    });

    it("EXCLUT 'failed' (sémantique alignée)", async () => {
      const convId = "conv_invarianttx_no_failed";
      await seedConversation(convId);

      const now = Timestamp.now();
      await seedMessage(convId, { status: "failed", createdAt: now });
      await seedMessage(convId, { status: "queued", createdAt: now });

      const result = await getAdminDb().runTransaction((tx) => listRecentOutboundInTx(tx, convId));

      expect(result.length).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // S9.3.3a — addOutboundDraftInTx
  // ───────────────────────────────────────────────────────────────────────

  describe("addOutboundDraftInTx (S9.3.3a)", () => {
    it("happy path : crée un doc Message status='draft' avec tous les champs IA", async () => {
      const convId = "conv_draft_happy";
      await seedConversation(convId, { inboundCount: 1, messageCount: 1 });

      const draftId = await getAdminDb().runTransaction(async (tx) =>
        addOutboundDraftInTx(tx, await readConvInTx(tx, convId), {
          contactId: "contact_abc",
          conversationId: convId,
          body: "Bonjour Docteur, quelle formation vous intéresse chez Médéré ?",
          aiModel: "claude-sonnet-4-6",
          aiPromptVersion: "1.0.0",
          aiTemperature: 0.5,
          aiTokensInput: 540,
          aiTokensOutput: 38,
          aiGenerationDurationMs: 1234,
        }),
      );

      expect(draftId).toMatch(FIRESTORE_AUTO_ID_PATTERN);

      const docSnap = await getAdminDb()
        .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
        .doc(convId)
        .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
        .doc(draftId)
        .get();
      expect(docSnap.exists).toBe(true);
      const msg = docSnap.data() as Message;
      expect(msg.direction).toBe("outbound");
      expect(msg.status).toBe("draft");
      expect(msg.channel).toBe("sms");
      expect(msg.generatedBy).toBe("ai");
      // 🔒 PR-OUTBOUNDKIND — figé à "reply" par la fonction.
      expect(msg.outboundKind).toBe("reply");
      expect(msg.aiModel).toBe("claude-sonnet-4-6");
      expect(msg.aiPromptVersion).toBe("1.0.0");
      expect(msg.aiTemperature).toBe(0.5);
      expect(msg.aiTokens).toEqual({ input: 540, output: 38 });
      expect(msg.createdAt).toBeInstanceOf(Timestamp);
      // Statuts post-envoi NON posés (laissés à S9.4 commitDraftToQueued).
      expect(msg.sentAt).toBeUndefined();
      expect(msg.deliveredAt).toBeUndefined();
    });

    it("🔒 GARDE : outboundKind='reply' sur une conv sans inbound → ValidationError, aucun doc créé", async () => {
      // Un draft affirme que le PS a écrit en premier. Si la conversation
      // ne porte AUCUN inbound, l'affirmation est fausse : soit le caller
      // s'est trompé, soit les compteurs sont désynchronisés. On refuse.
      //
      // C'est le SEUL mode de défaillance de `outboundKind` qui élargit le
      // quota (un sortant qui devait compter ne compterait plus) — donc le
      // seul qui produise une infraction L.34-5 CPCE.
      const convId = "conv_draft_no_inbound";
      await seedConversation(convId, { inboundCount: 0 });

      await expect(
        getAdminDb().runTransaction(async (tx) =>
          addOutboundDraftInTx(tx, await readConvInTx(tx, convId), {
            contactId: "contact_abc",
            conversationId: convId,
            body: "Bonjour Médéré, réponse sans question préalable.",
            aiModel: "claude-sonnet-4-6",
            aiPromptVersion: "1.0.0",
            aiTemperature: 0.5,
            aiTokensInput: 100,
            aiTokensOutput: 10,
            aiGenerationDurationMs: 500,
          }),
        ),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await countMessages(convId)).toBe(0);
    });

    it("🔒 GARDE : le wrapper addOutboundDraft applique la même garde (conv sans inbound)", async () => {
      const convId = "conv_draft_wrapper_no_inbound";
      await seedConversation(convId, { inboundCount: 0 });

      await expect(
        addOutboundDraft({
          contactId: "contact_abc",
          conversationId: convId,
          body: "Bonjour Médéré, réponse sans question préalable.",
          aiModel: "claude-sonnet-4-6",
          aiPromptVersion: "1.0.0",
          aiTemperature: 0.5,
          aiTokensInput: 100,
          aiTokensOutput: 10,
          aiGenerationDurationMs: 500,
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await countMessages(convId)).toBe(0);
    });

    it("le wrapper addOutboundDraft refuse une conversation inexistante → NotFoundError", async () => {
      // Effet de bord bienvenu de la lecture conv ajoutée en PR-OUTBOUNDKIND :
      // avant, un draft était créé sans broncher dans la sous-collection
      // d'une conversation supprimée (Firestore autorise les sous-collections
      // orphelines).
      await expect(
        addOutboundDraft({
          contactId: "contact_abc",
          conversationId: "conv_draft_ghost",
          body: "Bonjour Médéré.",
          aiModel: "claude-sonnet-4-6",
          aiPromptVersion: "1.0.0",
          aiTemperature: 0.5,
          aiTokensInput: 100,
          aiTokensOutput: 10,
          aiGenerationDurationMs: 500,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("🔒 NE BUMP PAS conversation.outboundCount / messageCount / lastOutboundAt", async () => {
      // Invariant critique S9.3.3a — un draft n'est pas un envoi tenté.
      // Si retiré, race en S9.4 quand commitDraftToQueued bumpera à son
      // tour → double-comptage côté analytics et rate-limit.
      const convId = "conv_draft_no_bump";
      await seedConversation(convId, { inboundCount: 1, messageCount: 1 });

      const before = await getAdminDb()
        .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
        .doc(convId)
        .get();
      const beforeConv = before.data() as Conversation;
      // La conv porte 1 inbound (pré-requis PR-OUTBOUNDKIND : un draft est
      // une réponse). Les compteurs OUTBOUND, eux, sont bien à zéro.
      expect(beforeConv.outboundCount).toBe(0);

      await getAdminDb().runTransaction(async (tx) =>
        addOutboundDraftInTx(tx, await readConvInTx(tx, convId), {
          contactId: "contact_abc",
          conversationId: convId,
          body: "Bonjour Docteur, Médéré propose des formations DPC. Une question ?",
          aiModel: "claude-sonnet-4-6",
          aiPromptVersion: "1.0.0",
          aiTemperature: 0.5,
          aiTokensInput: 500,
          aiTokensOutput: 30,
          aiGenerationDurationMs: 1000,
        }),
      );

      const after = await getAdminDb()
        .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
        .doc(convId)
        .get();
      const afterConv = after.data() as Conversation;
      // Assertion différentielle (plus robuste qu'une valeur absolue) :
      // AUCUN compteur n'a bougé.
      expect(afterConv.messageCount).toBe(beforeConv.messageCount);
      expect(afterConv.outboundCount).toBe(beforeConv.outboundCount);
      expect(afterConv.inboundCount).toBe(beforeConv.inboundCount);
      expect(afterConv.lastOutboundAt).toBeUndefined();
      expect(afterConv.firstMessageAt).toBeUndefined();
    });

    it("🔒 NE POSE PAS d'audit sms_sent (laissé à S9.4 commitDraftToQueued)", async () => {
      // Invariant — l'audit sms_sent doit être posé UNIQUEMENT quand
      // l'envoi OVH est acté (S9.4). Le caller (process-reply step 8
      // S9.3.3b) posera reply_generated à la place, distinct.
      const convId = "conv_draft_no_audit";
      await seedConversation(convId, { inboundCount: 1, messageCount: 1 });

      const beforeAudit = await countAuditDocs();

      await getAdminDb().runTransaction(async (tx) =>
        addOutboundDraftInTx(tx, await readConvInTx(tx, convId), {
          contactId: "contact_abc",
          conversationId: convId,
          body: "Bonjour Médéré, formations DPC.",
          aiModel: "claude-sonnet-4-6",
          aiPromptVersion: "1.0.0",
          aiTemperature: 0.5,
          aiTokensInput: 400,
          aiTokensOutput: 20,
          aiGenerationDurationMs: 800,
        }),
      );

      const afterAudit = await countAuditDocs();
      // Aucun audit posé par la fonction (caller pose reply_generated).
      expect(afterAudit).toBe(beforeAudit);
    });

    it("body vide → ValidationError (pas de doc créé)", async () => {
      const convId = "conv_draft_empty_body";
      await seedConversation(convId, { inboundCount: 1, messageCount: 1 });

      await expect(
        getAdminDb().runTransaction(async (tx) =>
          addOutboundDraftInTx(tx, await readConvInTx(tx, convId), {
            contactId: "contact_abc",
            conversationId: convId,
            body: "",
            aiModel: "claude-sonnet-4-6",
            aiPromptVersion: "1.0.0",
            aiTemperature: 0.5,
            aiTokensInput: 100,
            aiTokensOutput: 10,
            aiGenerationDurationMs: 500,
          }),
        ),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await countMessages(convId)).toBe(0);
    });

    it("body > BODY_MAX_LENGTH (1600) → ValidationError", async () => {
      const convId = "conv_draft_too_long";
      await seedConversation(convId, { inboundCount: 1, messageCount: 1 });

      const tooLong = "a".repeat(__BODY_MAX_LENGTH_FOR_TESTS + 1);
      await expect(
        getAdminDb().runTransaction(async (tx) =>
          addOutboundDraftInTx(tx, await readConvInTx(tx, convId), {
            contactId: "contact_abc",
            conversationId: convId,
            body: tooLong,
            aiModel: "claude-sonnet-4-6",
            aiPromptVersion: "1.0.0",
            aiTemperature: 0.5,
            aiTokensInput: 100,
            aiTokensOutput: 10,
            aiGenerationDurationMs: 500,
          }),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("le draft créé n'est PAS compté par listRecentOutbound (bout-en-bout)", async () => {
      // Sentinelle bout-en-bout — confirme que l'invariant rate-limit
      // tient ENSEMBLE pour les deux modules : addOutboundDraftInTx crée
      // un doc status='draft', listRecentOutbound le filtre.
      const convId = "conv_draft_e2e_rate_limit";
      await seedConversation(convId, { inboundCount: 1, messageCount: 1 });

      await getAdminDb().runTransaction(async (tx) =>
        addOutboundDraftInTx(tx, await readConvInTx(tx, convId), {
          contactId: "contact_abc",
          conversationId: convId,
          body: "Bonjour Médéré, draft test.",
          aiModel: "claude-sonnet-4-6",
          aiPromptVersion: "1.0.0",
          aiTemperature: 0.5,
          aiTokensInput: 300,
          aiTokensOutput: 15,
          aiGenerationDurationMs: 600,
        }),
      );

      // 1 doc total créé (vérifiable directement).
      expect(await countMessages(convId)).toBe(1);

      // Mais 0 message compté par listRecentOutbound (rate-limit safe).
      const recent = await listRecentOutbound(convId);
      expect(recent.length).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // S9.3.3b — listRecentMessages (historique passé à generateReply)
  // Fix MED-1 security-reviewer S9.3.3b : sentinelles runtime exclusion drafts
  // ───────────────────────────────────────────────────────────────────────

  describe("listRecentMessages (S9.3.3b)", () => {
    it("DEFAULT_HISTORY_LIMIT === 3 (décision Déthié S9.3.0)", () => {
      expect(__DEFAULT_HISTORY_LIMIT_FOR_TESTS).toBe(3);
    });

    it("🔒 EXCLUT les drafts de l'historique (anti-régression S9.3.3b MED-1)", async () => {
      // Sentinelle CRITIQUE — un draft n'a JAMAIS été envoyé au PS, l'inclure
      // dans le contexte Claude pour une nouvelle génération simulerait un
      // échange fictif. Si quelqu'un supprime le filtre `status !== "draft"`
      // dans listRecentMessages (messages.ts), ce test casse → forcera la
      // mise à jour explicite + revue compliance-auditor.
      const convId = "conv_history_no_draft";
      await seedConversation(convId);

      const now = Timestamp.now();
      // 1 doc draft (à EXCLURE)
      await seedMessage(convId, {
        direction: "outbound",
        status: "draft",
        body: "Draft body (NEVER seen by PS)",
        createdAt: now,
      });
      // 1 doc received inbound (à INCLURE)
      await seedMessage(convId, {
        direction: "inbound",
        status: "received",
        body: "Bonjour, ça m'intéresse",
        createdAt: now,
      });

      const history = await listRecentMessages(convId);

      // Seul le received remonte (draft exclu).
      expect(history.length).toBe(1);
      expect(history[0]).toEqual({
        direction: "inbound",
        body: "Bonjour, ça m'intéresse",
      });
    });

    it("INCLUT inbound (received) ET outbound NON-draft (queued/sending/sent/delivered/failed)", async () => {
      // Vérifie que le filtre exclu UNIQUEMENT "draft" — tous les autres
      // statuts (y compris failed, contrairement au rate-limit) sont
      // pertinents pour le contexte historique passé à Claude.
      const convId = "conv_history_all_statuses";
      await seedConversation(convId);

      const t0 = Timestamp.fromMillis(Date.now() - 1000 * 60 * 60 * 5);
      const t1 = Timestamp.fromMillis(Date.now() - 1000 * 60 * 60 * 4);
      const t2 = Timestamp.fromMillis(Date.now() - 1000 * 60 * 60 * 3);
      const t3 = Timestamp.fromMillis(Date.now() - 1000 * 60 * 60 * 2);

      // Volontairement varié et chronologique
      await seedMessage(convId, {
        direction: "outbound",
        status: "sent",
        body: "m1",
        createdAt: t0,
      });
      await seedMessage(convId, {
        direction: "inbound",
        status: "received",
        body: "m2",
        createdAt: t1,
      });
      await seedMessage(convId, {
        direction: "outbound",
        status: "queued",
        body: "m3",
        createdAt: t2,
      });
      // Limit défaut = 3 → on prend les 3 derniers (t1/t2/t3) → m2/m3/m4
      await seedMessage(convId, {
        direction: "outbound",
        status: "failed",
        body: "m4",
        createdAt: t3,
      });

      const history = await listRecentMessages(convId);

      // 3 dernières entries en ORDRE CHRONOLOGIQUE CROISSANT.
      expect(history.length).toBe(3);
      expect(history.map((h) => h.body)).toEqual(["m2", "m3", "m4"]);
    });

    it("retourne en ordre CHRONOLOGIQUE CROISSANT (anciens en premier)", async () => {
      // Sentinelle — le prompt LLM attend l'historique du plus ancien au
      // plus récent. Si l'ordre était DESC, Claude lirait à l'envers.
      const convId = "conv_history_order";
      await seedConversation(convId);

      const t1 = Timestamp.fromMillis(Date.now() - 1000 * 60 * 60 * 3);
      const t2 = Timestamp.fromMillis(Date.now() - 1000 * 60 * 60 * 2);
      const t3 = Timestamp.fromMillis(Date.now() - 1000 * 60 * 60 * 1);

      await seedMessage(convId, {
        direction: "outbound",
        status: "sent",
        body: "first",
        createdAt: t1,
      });
      await seedMessage(convId, {
        direction: "inbound",
        status: "received",
        body: "second",
        createdAt: t2,
      });
      await seedMessage(convId, {
        direction: "outbound",
        status: "sent",
        body: "third",
        createdAt: t3,
      });

      const history = await listRecentMessages(convId);

      expect(history.map((h) => h.body)).toEqual(["first", "second", "third"]);
    });

    it("conversation absente → [] (cohérent listRecentOutbound, pas NotFoundError)", async () => {
      const result = await listRecentMessages("conv_history_ghost");
      expect(result).toEqual([]);
    });

    it("limit custom (1) respecté + ordre chronologique", async () => {
      const convId = "conv_history_limit_1";
      await seedConversation(convId);

      const t1 = Timestamp.fromMillis(Date.now() - 1000 * 60 * 60 * 2);
      const t2 = Timestamp.fromMillis(Date.now() - 1000 * 60 * 60 * 1);

      await seedMessage(convId, {
        direction: "outbound",
        status: "sent",
        body: "old",
        createdAt: t1,
      });
      await seedMessage(convId, {
        direction: "inbound",
        status: "received",
        body: "new",
        createdAt: t2,
      });

      const history = await listRecentMessages(convId, 1);

      expect(history.length).toBe(1);
      // Limit=1 → on prend le PLUS RÉCENT (DESC) puis on inverse → "new" seul.
      expect(history[0]!.body).toBe("new");
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // updateMessageStatus (S9.4.2) — transitions + audit sms_failed
  // ───────────────────────────────────────────────────────────────────────

  describe("updateMessageStatus", () => {
    const CONV_ID = "conv_update_status";

    async function seedQueuedMessage(): Promise<string> {
      await seedConversation(CONV_ID);
      return seedMessage(CONV_ID, {
        direction: "outbound",
        status: "queued",
        body: "Bonjour, c'est Léa de Médéré. Test. STOP pour refuser.",
        generatedBy: "ai",
        outboundKind: "solicitation",
        createdAt: Timestamp.now(),
        queuedAt: Timestamp.now(),
      });
    }

    async function readMsg(messageId: string): Promise<Message | null> {
      const doc = await getAdminDb()
        .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
        .doc(CONV_ID)
        .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
        .doc(messageId)
        .get();
      return doc.exists ? (doc.data() as Message) : null;
    }

    async function countAuditByAction(action: string): Promise<number> {
      const snap = await getAdminDb()
        .collection(__AUDIT_COLLECTION_FOR_TESTS)
        .where("action", "==", action)
        .get();
      return snap.size;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Happy paths — transitions valides
    // ─────────────────────────────────────────────────────────────────────

    it("queued → sent : pose sentAt + externalId (si fourni), aucun audit sms_failed", async () => {
      const msgId = await seedQueuedMessage();

      await updateMessageStatus({
        conversationId: CONV_ID,
        messageId: msgId,
        status: "sent",
        ovhMessageId: "ovh-msg-abc-123",
      });

      const msg = await readMsg(msgId);
      expect(msg?.status).toBe("sent");
      expect(msg?.sentAt).toBeInstanceOf(Timestamp);
      expect(msg?.externalId).toBe("ovh-msg-abc-123");
      expect(msg?.error).toBeUndefined();

      expect(await countAuditByAction("sms_failed")).toBe(0);
    });

    it("queued → failed : pose error + audit sms_failed DANS la tx", async () => {
      const msgId = await seedQueuedMessage();

      await updateMessageStatus({
        conversationId: CONV_ID,
        messageId: msgId,
        status: "failed",
        failureReason: {
          code: "config_error",
          detail: "OVH 401 auth denied",
          retryCount: 0,
        },
      });

      const msg = await readMsg(msgId);
      expect(msg?.status).toBe("failed");
      expect(msg?.error).toEqual({
        code: "config_error",
        message: "OVH 401 auth denied",
        retryCount: 0,
      });
      expect(msg?.sentAt).toBeUndefined();

      // Audit sms_failed posé DANS la tx (atomicité avec UPDATE).
      expect(await countAuditByAction("sms_failed")).toBe(1);

      const snap = await getAdminDb()
        .collection(__AUDIT_COLLECTION_FOR_TESTS)
        .where("action", "==", "sms_failed")
        .get();
      const audit = snap.docs[0]!.data();
      expect(audit.targetType).toBe("message");
      expect(audit.targetId).toBe(msgId);
      // Payload anti-PII : code structuré + retryCount, PAS le detail brut.
      expect(audit.payload).toEqual({
        direction: "outbound",
        messageId: msgId,
        failureCode: "config_error",
        retryCount: 0,
      });
    });

    it("queued → failed avec detail absent : message default-fallback sur code", async () => {
      // Le schéma Zod Message exige `error.message: string.min(1)`. Si le
      // caller ne fournit pas `failureReason.detail`, on compose le message
      // depuis le `code` pour rester schema-valide.
      const msgId = await seedQueuedMessage();

      await updateMessageStatus({
        conversationId: CONV_ID,
        messageId: msgId,
        status: "failed",
        failureReason: { code: "validation_error", retryCount: 2 },
      });

      const msg = await readMsg(msgId);
      expect(msg?.error?.message).toBe("validation_error");
    });

    it("sent → delivered : pose deliveredAt, pas de audit sms_failed", async () => {
      await seedConversation(CONV_ID);
      const msgId = await seedMessage(CONV_ID, {
        direction: "outbound",
        status: "sent",
        body: "sent prior",
        generatedBy: "ai",
        outboundKind: "solicitation",
        createdAt: Timestamp.now(),
        sentAt: Timestamp.now(),
      });

      await updateMessageStatus({
        conversationId: CONV_ID,
        messageId: msgId,
        status: "delivered",
      });

      const msg = await readMsg(msgId);
      expect(msg?.status).toBe("delivered");
      expect(msg?.deliveredAt).toBeInstanceOf(Timestamp);
      expect(await countAuditByAction("sms_failed")).toBe(0);
    });

    it("sent → failed : pose error + audit sms_failed (DLR négatif)", async () => {
      await seedConversation(CONV_ID);
      const msgId = await seedMessage(CONV_ID, {
        direction: "outbound",
        status: "sent",
        body: "sent prior",
        generatedBy: "ai",
        outboundKind: "solicitation",
        createdAt: Timestamp.now(),
        sentAt: Timestamp.now(),
      });

      await updateMessageStatus({
        conversationId: CONV_ID,
        messageId: msgId,
        status: "failed",
        failureReason: {
          code: "external_service",
          detail: "DLR reported undeliverable",
          retryCount: 3,
        },
      });

      const msg = await readMsg(msgId);
      expect(msg?.status).toBe("failed");
      expect(await countAuditByAction("sms_failed")).toBe(1);
    });

    // ─────────────────────────────────────────────────────────────────────
    // Idempotence (no-op silencieux)
    // ─────────────────────────────────────────────────────────────────────

    it("status target === actuel : no-op silencieux, aucun audit double-posé", async () => {
      await seedConversation(CONV_ID);
      const msgId = await seedMessage(CONV_ID, {
        direction: "outbound",
        status: "failed",
        body: "already failed",
        generatedBy: "ai",
        outboundKind: "solicitation",
        createdAt: Timestamp.now(),
        error: { code: "config_error", message: "prior", retryCount: 1 },
      });

      // Tentative idempotente `failed → failed` (retry Inngest qui réappelle).
      await updateMessageStatus({
        conversationId: CONV_ID,
        messageId: msgId,
        status: "failed",
        failureReason: { code: "config_error", detail: "ignored", retryCount: 99 },
      });

      const msg = await readMsg(msgId);
      // Pas d'override de error.* (le doc reste tel quel, no-op silencieux).
      expect(msg?.error).toEqual({ code: "config_error", message: "prior", retryCount: 1 });

      // Aucun audit double-posé.
      expect(await countAuditByAction("sms_failed")).toBe(0);
    });

    it("sent → sent (no-op) : aucun update, aucun audit", async () => {
      await seedConversation(CONV_ID);
      const originalSentAt = Timestamp.fromMillis(Date.now() - 60_000);
      const msgId = await seedMessage(CONV_ID, {
        direction: "outbound",
        status: "sent",
        body: "sent prior",
        generatedBy: "ai",
        outboundKind: "solicitation",
        createdAt: Timestamp.fromMillis(Date.now() - 120_000),
        sentAt: originalSentAt,
      });

      await updateMessageStatus({
        conversationId: CONV_ID,
        messageId: msgId,
        status: "sent",
        ovhMessageId: "would-overwrite-but-noop",
      });

      const msg = await readMsg(msgId);
      // sentAt PAS overridden (no-op silencieux).
      expect(msg?.sentAt?.toMillis()).toBe(originalSentAt.toMillis());
      expect(msg?.externalId).toBeUndefined();
    });

    // ─────────────────────────────────────────────────────────────────────
    // Transitions invalides
    // ─────────────────────────────────────────────────────────────────────

    it("delivered → failed : refuse (terminal, Set vide dans table)", async () => {
      await seedConversation(CONV_ID);
      const msgId = await seedMessage(CONV_ID, {
        direction: "outbound",
        status: "delivered",
        body: "already delivered",
        generatedBy: "ai",
        outboundKind: "solicitation",
        createdAt: Timestamp.now(),
        deliveredAt: Timestamp.now(),
      });

      await expect(
        updateMessageStatus({
          conversationId: CONV_ID,
          messageId: msgId,
          status: "failed",
          failureReason: { code: "external_service", retryCount: 0 },
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("failed → sent : refuse (terminal, transition invalide)", async () => {
      await seedConversation(CONV_ID);
      const msgId = await seedMessage(CONV_ID, {
        direction: "outbound",
        status: "failed",
        body: "failed prior",
        generatedBy: "ai",
        outboundKind: "solicitation",
        createdAt: Timestamp.now(),
        error: { code: "config_error", message: "prior", retryCount: 0 },
      });

      await expect(
        updateMessageStatus({
          conversationId: CONV_ID,
          messageId: msgId,
          status: "sent",
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("draft → sent : refuse explicitement (utiliser commitDraftToQueued)", async () => {
      await seedConversation(CONV_ID);
      const msgId = await seedMessage(CONV_ID, {
        direction: "outbound",
        status: "draft",
        body: "Bonjour, c'est Léa de Médéré. STOP.",
        generatedBy: "ai",
        outboundKind: "solicitation",
        createdAt: Timestamp.now(),
      });

      await expect(
        updateMessageStatus({
          conversationId: CONV_ID,
          messageId: msgId,
          status: "sent",
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("received (inbound) → sent : refuse (status terminal inbound)", async () => {
      await seedConversation(CONV_ID);
      const msgId = await seedMessage(CONV_ID, {
        direction: "inbound",
        status: "received",
        body: "Inbound test",
        generatedBy: "human",
        outboundKind: "solicitation",
        externalId: "ovh-inbound-1",
        externalReceiver: "+33612345678",
        createdAt: Timestamp.now(),
        receivedAt: Timestamp.now(),
      });

      await expect(
        updateMessageStatus({
          conversationId: CONV_ID,
          messageId: msgId,
          status: "sent",
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    // ─────────────────────────────────────────────────────────────────────
    // Assertions structurelles failureReason ↔ status="failed"
    // ─────────────────────────────────────────────────────────────────────

    it("status='failed' SANS failureReason → ValidationError (fail-fast HORS tx)", async () => {
      const msgId = await seedQueuedMessage();

      await expect(
        updateMessageStatus({
          conversationId: CONV_ID,
          messageId: msgId,
          status: "failed",
          // failureReason MANQUANT
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      // Vérifie le fail-fast HORS tx : le message reste "queued" (pas de tx ouverte).
      const msg = await readMsg(msgId);
      expect(msg?.status).toBe("queued");
    });

    it("status='sent' AVEC failureReason → ValidationError", async () => {
      const msgId = await seedQueuedMessage();

      await expect(
        updateMessageStatus({
          conversationId: CONV_ID,
          messageId: msgId,
          status: "sent",
          failureReason: { code: "config_error", retryCount: 0 },
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      const msg = await readMsg(msgId);
      expect(msg?.status).toBe("queued");
    });

    // ─────────────────────────────────────────────────────────────────────
    // Cas d'erreur — doc absent / corrompu
    // ─────────────────────────────────────────────────────────────────────

    it("message inexistant → NotFoundError (tx ouverte mais rollback propre)", async () => {
      await seedConversation(CONV_ID);

      await expect(
        updateMessageStatus({
          conversationId: CONV_ID,
          messageId: "nonexistent_msg_id",
          status: "sent",
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // listStaleMessages (S9.4.4) — collection group query orphan monitoring
  // ───────────────────────────────────────────────────────────────────────

  describe("listStaleMessages", () => {
    const CONV_A = "hsa_camp_A";
    const CONV_B = "hsb_camp_B";
    const NOW = new Date("2026-06-17T12:00:00Z");
    const ONE_HOUR_MS = 60 * 60 * 1000;

    async function seedConv(convId: string): Promise<void> {
      await seedConversation(convId);
    }

    async function seedStaleMessage(convId: string, overrides: Partial<Message>): Promise<string> {
      const createdAt = (overrides.createdAt as Timestamp) ?? Timestamp.fromDate(NOW);
      const base: Message = {
        direction: "outbound",
        body: "Bonjour Léa de Médéré. STOP pour refuser.",
        status: "draft",
        channel: "sms",
        generatedBy: "ai",
        outboundKind: "solicitation",
        createdAt,
      };
      const ref = await getAdminDb()
        .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
        .doc(convId)
        .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
        .add({ ...base, ...overrides });
      return ref.id;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Happy paths
    // ─────────────────────────────────────────────────────────────────────

    it("retourne [] si aucun message stale", async () => {
      await seedConv(CONV_A);
      // Seed un draft RÉCENT (créé maintenant, pas stale)
      await seedStaleMessage(CONV_A, {
        status: "draft",
        createdAt: Timestamp.fromDate(NOW),
      });

      const result = await listStaleMessages({
        status: "draft",
        maxAgeMs: ONE_HOUR_MS,
        now: NOW,
      });

      expect(result).toEqual([]);
    });

    it("retourne les drafts stale cross-conversation (collection group)", async () => {
      // Seed 2 conversations différentes, 1 draft stale chacune
      await seedConv(CONV_A);
      await seedConv(CONV_B);

      const twoHoursAgo = Timestamp.fromDate(new Date(NOW.getTime() - 2 * ONE_HOUR_MS));
      const draftIdA = await seedStaleMessage(CONV_A, {
        status: "draft",
        createdAt: twoHoursAgo,
      });
      const draftIdB = await seedStaleMessage(CONV_B, {
        status: "draft",
        createdAt: twoHoursAgo,
      });

      const result = await listStaleMessages({
        status: "draft",
        maxAgeMs: ONE_HOUR_MS,
        now: NOW,
      });

      expect(result.length).toBe(2);
      const convIds = result.map((r) => r.conversationId).sort();
      expect(convIds).toEqual([CONV_A, CONV_B].sort());
      const msgIds = result.map((r) => r.messageId).sort();
      expect(msgIds).toEqual([draftIdA, draftIdB].sort());

      // Status correctement remonté
      expect(result.every((r) => r.status === "draft")).toBe(true);
    });

    it("ordre createdAt ASC (oldest first)", async () => {
      await seedConv(CONV_A);

      const oldest = Timestamp.fromDate(new Date(NOW.getTime() - 5 * ONE_HOUR_MS));
      const middle = Timestamp.fromDate(new Date(NOW.getTime() - 3 * ONE_HOUR_MS));
      const newer = Timestamp.fromDate(new Date(NOW.getTime() - 2 * ONE_HOUR_MS));

      const idMiddle = await seedStaleMessage(CONV_A, {
        status: "queued",
        createdAt: middle,
      });
      const idOldest = await seedStaleMessage(CONV_A, {
        status: "queued",
        createdAt: oldest,
      });
      const idNewer = await seedStaleMessage(CONV_A, {
        status: "queued",
        createdAt: newer,
      });

      const result = await listStaleMessages({
        status: "queued",
        maxAgeMs: ONE_HOUR_MS,
        now: NOW,
      });

      expect(result.length).toBe(3);
      // Oldest first (priorité monitoring)
      expect(result.map((r) => r.messageId)).toEqual([idOldest, idMiddle, idNewer]);
    });

    it("limit respecté (anti-DoS Firestore)", async () => {
      await seedConv(CONV_A);
      const twoHoursAgo = Timestamp.fromDate(new Date(NOW.getTime() - 2 * ONE_HOUR_MS));

      // Seed 5 drafts stale
      for (let i = 0; i < 5; i++) {
        await seedStaleMessage(CONV_A, {
          status: "draft",
          createdAt: Timestamp.fromMillis(twoHoursAgo.toMillis() + i * 1000),
        });
      }

      const result = await listStaleMessages({
        status: "draft",
        maxAgeMs: ONE_HOUR_MS,
        limit: 3,
        now: NOW,
      });

      expect(result.length).toBe(3);
    });

    it("filtre par status whitelist (drafts ≠ queued)", async () => {
      await seedConv(CONV_A);
      const twoHoursAgo = Timestamp.fromDate(new Date(NOW.getTime() - 2 * ONE_HOUR_MS));

      await seedStaleMessage(CONV_A, { status: "draft", createdAt: twoHoursAgo });
      await seedStaleMessage(CONV_A, { status: "queued", createdAt: twoHoursAgo });
      await seedStaleMessage(CONV_A, {
        status: "sent",
        createdAt: twoHoursAgo,
        sentAt: twoHoursAgo,
      });

      const drafts = await listStaleMessages({
        status: "draft",
        maxAgeMs: ONE_HOUR_MS,
        now: NOW,
      });
      const queued = await listStaleMessages({
        status: "queued",
        maxAgeMs: ONE_HOUR_MS,
        now: NOW,
      });

      expect(drafts.length).toBe(1);
      expect(drafts[0]?.status).toBe("draft");
      expect(queued.length).toBe(1);
      expect(queued[0]?.status).toBe("queued");
    });

    it("filtre direction outbound (ignore inbound)", async () => {
      await seedConv(CONV_A);
      const twoHoursAgo = Timestamp.fromDate(new Date(NOW.getTime() - 2 * ONE_HOUR_MS));

      // Un draft outbound (légitime) — devrait apparaître
      await seedStaleMessage(CONV_A, {
        status: "draft",
        direction: "outbound",
        createdAt: twoHoursAgo,
      });
      // Cas pathologique : inbound créé en "draft" status (ne devrait jamais
      // arriver en pratique mais defense-in-depth). Doit être filtré par
      // direction=outbound dans la query.
      await seedStaleMessage(CONV_A, {
        status: "draft",
        direction: "inbound",
        externalId: "ovh-test-inbound",
        externalReceiver: "+33612345678",
        createdAt: twoHoursAgo,
      } as Partial<Message>);

      const result = await listStaleMessages({
        status: "draft",
        maxAgeMs: ONE_HOUR_MS,
        now: NOW,
      });

      expect(result.length).toBe(1);
    });

    // ─────────────────────────────────────────────────────────────────────
    // Sentinelles anti-PII payload retour
    // ─────────────────────────────────────────────────────────────────────

    it("payload retour ne contient PAS body / phone / externalId (anti-PII)", async () => {
      await seedConv(CONV_A);
      const twoHoursAgo = Timestamp.fromDate(new Date(NOW.getTime() - 2 * ONE_HOUR_MS));

      await seedStaleMessage(CONV_A, {
        status: "queued",
        body: "Body SECRET avec phone +33612345678 dedans",
        externalReceiver: "+33612345678",
        externalId: "ovh-secret-id-XYZ",
        createdAt: twoHoursAgo,
      });

      const result = await listStaleMessages({
        status: "queued",
        maxAgeMs: ONE_HOUR_MS,
        now: NOW,
      });

      expect(result.length).toBe(1);
      const entry = result[0]!;

      // Champs exposés : 4 exactement (conversationId/messageId/createdAt/status)
      expect(Object.keys(entry).sort()).toEqual([
        "conversationId",
        "createdAt",
        "messageId",
        "status",
      ]);

      // Sentinelle defense-in-depth — pas de PII dans le serialized
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain("Body SECRET");
      expect(serialized).not.toContain("+33612345678");
      expect(serialized).not.toContain("ovh-secret-id-XYZ");
    });

    // ─────────────────────────────────────────────────────────────────────
    // Cas d'erreur
    // ─────────────────────────────────────────────────────────────────────

    it("maxAgeMs négatif → ValidationError", async () => {
      await expect(
        listStaleMessages({
          status: "draft",
          maxAgeMs: -1,
          now: NOW,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    // ─────────────────────────────────────────────────────────────────────
    // Sentinelle constante
    // ─────────────────────────────────────────────────────────────────────

    it("DEFAULT_LIMIT === 100 (anti-DoS borne défensive)", () => {
      expect(__STALE_MESSAGES_DEFAULT_LIMIT_FOR_TESTS).toBe(100);
    });
  });
});
