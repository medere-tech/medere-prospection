/**
 * Tests d'intégration Firestore emulator pour `commitDraftToQueued`
 * (S9.4.1 send-reply.ts).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * COUVERTURE (S9.4.1)
 *
 *   1. **Happy path** — draft → queued :
 *        - message.status muté à "queued" + queuedAt setté
 *        - conversation.outboundCount += 1 + lastOutboundAt setté
 *        - audit `sms_sent` posé (1 doc)
 *        - audit `compliance_check (allowed)` posé DANS tx (1 doc)
 *        - audit `reply_draft_dropped` PAS posé (0 doc)
 *        - retour `{ ok: true, messageId === draftMessageId, ... }`
 *
 *   2. **Branches blocked × 4 rules représentatives** :
 *        - opt_out (opted_out): contact.consent.optedOut=true
 *        - rate_limit (rate_limit_exceeded): 3 outbound récents
 *        - hours (sunday): now = dimanche
 *        - phone_validity (phone_invalid): contact.phone.valid=false
 *      Pour chaque : assertions tx rollback + 2 audits best-effort posés
 *      + retour `{ ok: false, failure }`.
 *
 *   3. **Cas d'erreur (throw, pas blocked)** :
 *        - draft inexistant → NotFoundError
 *        - conv inexistante (pré-flight) → NotFoundError
 *        - draft avec status !== "draft" (déjà queued) → ValidationError
 *        - draft avec direction !== "outbound" → ValidationError (cas
 *          pathologique seed inbound — defense-in-depth)
 *        - draft avec generatedBy !== "ai" → ValidationError
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * SETUP — pattern miroir `concurrency.test.ts`
 *
 * Pas de mock — toute l'interaction Firestore passe par l'emulator vrai
 * (port 8085). Wipe entre chaque test via `tests/firestore/setup.ts`
 * `afterEach` (REST DELETE emulator).
 *
 * Le `AUDIT_PII_PEPPER` est stubbé via `vi.stubEnv` (requis par
 * `detectPiiInPayload` → `hashPii`). Aucun appel `hashPii` direct ici
 * mais le scrubber peut être appelé indirectement par les audits posés.
 */
import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetEnvCacheForTests } from "@/lib/security/env";
import { NotFoundError, ValidationError } from "@/lib/utils/errors";
import type { Contact } from "@/types/contact";
import type { Conversation } from "@/types/conversation";
import type { Message } from "@/types/message";

import {
  __APP_NAME_FOR_TESTS,
  __getAppByName,
  __resetFirestoreAdminForTests,
  getAdminDb,
} from "./admin";
import { __AUDIT_COLLECTION_FOR_TESTS } from "./audit-log";
import { __CONTACTS_COLLECTION_FOR_TESTS } from "./contacts";
import { __CONVERSATIONS_COLLECTION_FOR_TESTS } from "./conversations";
import {
  __MESSAGES_PARENT_COLLECTION_FOR_TESTS,
  __MESSAGES_SUBCOLLECTION_FOR_TESTS,
} from "./messages";
import {
  __SEND_REPLY_CONVERSATIONS_COLLECTION_FOR_TESTS,
  __SEND_REPLY_MESSAGES_SUBCOLLECTION_FOR_TESTS,
  __SEND_REPLY_RATE_LIMIT_WINDOW_DAYS_FOR_TESTS,
  commitDraftToQueued,
} from "./send-reply";

const PEPPER = "a".repeat(64);

// Mardi 12 mai 2026, 12h Paris (UTC+2 été) → 10h UTC. Plein dans plage 10-13h
// (éviter 13h Paris qui est limite haute, et 14h pour pause déjeuner).
const FIXED_NOW = new Date("2026-05-12T10:00:00Z");

// Test contact + conv IDs constants (cohérent + isolé wipe Firestore)
const CONTACT_ID = "hs_test_dent_01";
const CONV_ID = "hs_test_dent_01_camp_test";
const CAMPAIGN_ID = "camp_test";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de seed
// ─────────────────────────────────────────────────────────────────────────────

function buildValidContact(overrides: Partial<Contact> = {}): Contact {
  const now = Timestamp.fromDate(FIXED_NOW);
  return {
    hubspotId: CONTACT_ID,
    firstName: "Jean",
    lastName: "Dupont",
    civilite: "Dr",
    speciality: "dentiste",
    city: "Paris",
    postalCode: "75001",
    phone: {
      e164: "+33612345678",
      raw: "06 12 34 56 78",
      type: "mobile",
      valid: true,
      lookupAt: now,
    },
    segment: "b2b_cabinet",
    bloctelChecked: true,
    bloctelOptOut: false,
    bloctelCheckedAt: now,
    consent: {
      legitimateInterest: "Contact HubSpot Médéré importé le 2026-05-29, dentiste IDF, opt-in B2B.",
      optedOut: false,
    },
    enrichment: {
      source: "hubspot",
      enrichedAt: now,
    },
    status: "ready",
    campaignId: CAMPAIGN_ID,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildValidConversation(overrides: Partial<Conversation> = {}): Conversation {
  const now = Timestamp.fromDate(FIXED_NOW);
  return {
    contactId: CONTACT_ID,
    campaignId: CAMPAIGN_ID,
    channel: "sms",
    status: "in_dialogue",
    intent: "INTERESSE",
    messageCount: 2,
    outboundCount: 1,
    inboundCount: 1,
    followupCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Body valide qui passe les 3 rules content (ai_disclosure pas vérifié car
 * messageCount > 0, stop_present "STOP" ✓, advertiser_identification "Médéré" ✓).
 */
const VALID_DRAFT_BODY =
  "Bonjour Dr Dupont, Léa de Médéré. Voici les infos demandées. Répondez STOP pour ne plus être contacté.";

function buildValidDraftMessage(overrides: Partial<Message> = {}): Message {
  return {
    direction: "outbound",
    body: VALID_DRAFT_BODY,
    status: "draft",
    channel: "sms",
    generatedBy: "ai",
    aiModel: "claude-sonnet-4-6",
    aiPromptVersion: "1.0.0",
    aiTemperature: 0.5,
    aiTokens: { input: 540, output: 38 },
    createdAt: Timestamp.fromDate(FIXED_NOW),
    ...overrides,
  };
}

async function seedContact(overrides: Partial<Contact> = {}): Promise<void> {
  await getAdminDb()
    .collection(__CONTACTS_COLLECTION_FOR_TESTS)
    .doc(CONTACT_ID)
    .set(buildValidContact(overrides));
}

async function seedConversation(overrides: Partial<Conversation> = {}): Promise<void> {
  await getAdminDb()
    .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
    .doc(CONV_ID)
    .set(buildValidConversation(overrides));
}

async function seedDraft(overrides: Partial<Message> = {}): Promise<string> {
  const ref = await getAdminDb()
    .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
    .doc(CONV_ID)
    .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
    .add(buildValidDraftMessage(overrides));
  return ref.id;
}

async function seedOutboundMessage(daysAgo: number, bodyTag: string): Promise<void> {
  const createdAt = Timestamp.fromDate(new Date(FIXED_NOW.getTime() - daysAgo * 86400_000));
  const message: Message = {
    direction: "outbound",
    body: `seed_${bodyTag}`,
    status: "sent",
    channel: "sms",
    generatedBy: "ai",
    createdAt,
    sentAt: createdAt,
  };
  await getAdminDb()
    .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
    .doc(CONV_ID)
    .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
    .add(message);
}

async function readMessage(messageId: string): Promise<Message | null> {
  const doc = await getAdminDb()
    .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
    .doc(CONV_ID)
    .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
    .doc(messageId)
    .get();
  return doc.exists ? (doc.data() as Message) : null;
}

async function readConversation(): Promise<Conversation | null> {
  const doc = await getAdminDb()
    .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
    .doc(CONV_ID)
    .get();
  return doc.exists ? (doc.data() as Conversation) : null;
}

async function countAuditByAction(action: string): Promise<number> {
  const snap = await getAdminDb()
    .collection(__AUDIT_COLLECTION_FOR_TESTS)
    .where("action", "==", action)
    .get();
  return snap.size;
}

async function findAuditByAction(action: string): Promise<Record<string, unknown> | null> {
  const snap = await getAdminDb()
    .collection(__AUDIT_COLLECTION_FOR_TESTS)
    .where("action", "==", action)
    .limit(1)
    .get();
  return snap.empty ? null : (snap.docs[0]!.data() as Record<string, unknown>);
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

describe("commitDraftToQueued — S9.4.1", () => {
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
  // Sentinelles constantes — anti-drift collections
  // ───────────────────────────────────────────────────────────────────────

  describe("sentinelles constantes (anti-drift)", () => {
    it("CONVERSATIONS_COLLECTION matche conversations.ts", () => {
      expect(__SEND_REPLY_CONVERSATIONS_COLLECTION_FOR_TESTS).toBe(
        __CONVERSATIONS_COLLECTION_FOR_TESTS,
      );
    });

    it("MESSAGES_SUBCOLLECTION matche messages.ts", () => {
      expect(__SEND_REPLY_MESSAGES_SUBCOLLECTION_FOR_TESTS).toBe(
        __MESSAGES_SUBCOLLECTION_FOR_TESTS,
      );
    });

    it("RATE_LIMIT_WINDOW_DAYS = 30 (aligné S4)", () => {
      expect(__SEND_REPLY_RATE_LIMIT_WINDOW_DAYS_FOR_TESTS).toBe(30);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Happy path — draft → queued + bump + audit sms_sent
  // ───────────────────────────────────────────────────────────────────────

  describe("happy path — draft → queued", () => {
    it("status passe à 'queued' + queuedAt setté + ID inchangé", async () => {
      await seedContact();
      await seedConversation();
      const draftId = await seedDraft();

      const result = await commitDraftToQueued({
        conversationId: CONV_ID,
        draftMessageId: draftId,
        now: FIXED_NOW,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");

      expect(result.messageId).toBe(draftId);
      expect(result.conversationId).toBe(CONV_ID);
      expect(result.contactId).toBe(CONTACT_ID);
      expect(typeof result.auditId).toBe("string");
      expect(result.auditId.length).toBeGreaterThan(0);

      const updated = await readMessage(draftId);
      expect(updated?.status).toBe("queued");
      expect(updated?.queuedAt).toBeInstanceOf(Timestamp);
      // Body inchangé (la transition mute UNIQUEMENT status + queuedAt).
      expect(updated?.body).toBe(VALID_DRAFT_BODY);
      expect(updated?.direction).toBe("outbound");
      expect(updated?.generatedBy).toBe("ai");
    });

    it("conversation.outboundCount += 1 + lastOutboundAt + lastMessageAt", async () => {
      await seedContact();
      await seedConversation({ messageCount: 2, outboundCount: 1 });
      const draftId = await seedDraft();

      await commitDraftToQueued({
        conversationId: CONV_ID,
        draftMessageId: draftId,
        now: FIXED_NOW,
      });

      const conv = await readConversation();
      expect(conv?.outboundCount).toBe(2);
      expect(conv?.messageCount).toBe(3);
      expect(conv?.lastOutboundAt).toBeInstanceOf(Timestamp);
      expect(conv?.lastMessageAt).toBeInstanceOf(Timestamp);
    });

    it("audit sms_sent posé (1 doc) — payload { direction, messageId }", async () => {
      await seedContact();
      await seedConversation();
      const draftId = await seedDraft();

      await commitDraftToQueued({
        conversationId: CONV_ID,
        draftMessageId: draftId,
        now: FIXED_NOW,
      });

      expect(await countAuditByAction("sms_sent")).toBe(1);

      const audit = await findAuditByAction("sms_sent");
      expect(audit?.actorId).toBe("system");
      expect(audit?.actorType).toBe("system");
      expect(audit?.targetType).toBe("message");
      expect(audit?.targetId).toBe(draftId);
      expect(audit?.payload).toEqual({ direction: "outbound", messageId: draftId });
    });

    it("audit compliance_check (allowed) posé DANS tx (1 doc)", async () => {
      await seedContact();
      await seedConversation();
      const draftId = await seedDraft();

      await commitDraftToQueued({
        conversationId: CONV_ID,
        draftMessageId: draftId,
        now: FIXED_NOW,
      });

      expect(await countAuditByAction("compliance_check")).toBe(1);

      const audit = await findAuditByAction("compliance_check");
      expect(audit?.targetType).toBe("contact");
      expect(audit?.targetId).toBe(CONTACT_ID);
      expect(audit?.payload).toEqual({ result: "allowed" });
    });

    it("audit reply_draft_dropped PAS posé en allowed (0 doc)", async () => {
      await seedContact();
      await seedConversation();
      const draftId = await seedDraft();

      await commitDraftToQueued({
        conversationId: CONV_ID,
        draftMessageId: draftId,
        now: FIXED_NOW,
      });

      expect(await countAuditByAction("reply_draft_dropped")).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Branches blocked × rules représentatives
  // ───────────────────────────────────────────────────────────────────────

  describe("branche blocked — opt_out (consent drift entre génération et envoi)", () => {
    it("contact.consent.optedOut=true → blocked + 2 audits HORS tx + draft reste draft", async () => {
      await seedContact({
        consent: {
          legitimateInterest:
            "Contact HubSpot Médéré importé le 2026-05-29, dentiste IDF, opt-in B2B.",
          optedOut: true,
          optedOutAt: Timestamp.fromDate(FIXED_NOW),
          optedOutChannel: "sms",
        },
      });
      await seedConversation();
      const draftId = await seedDraft();

      const result = await commitDraftToQueued({
        conversationId: CONV_ID,
        draftMessageId: draftId,
        now: FIXED_NOW,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.failure.rule).toBe("opt_out");
      expect(result.failure.code).toBe("opted_out");
      expect(result.failure.context).toEqual({});

      // Draft reste status="draft" (tx rollback).
      const draftAfter = await readMessage(draftId);
      expect(draftAfter?.status).toBe("draft");

      // Conversation NON bumpée.
      const conv = await readConversation();
      expect(conv?.outboundCount).toBe(1); // valeur initiale
      expect(conv?.messageCount).toBe(2);

      // Pas d'audit sms_sent.
      expect(await countAuditByAction("sms_sent")).toBe(0);

      // 2 audits best-effort HORS tx posés.
      expect(await countAuditByAction("compliance_check")).toBe(1);
      expect(await countAuditByAction("reply_draft_dropped")).toBe(1);

      // Vérifier le payload reply_draft_dropped.
      const auditDropped = await findAuditByAction("reply_draft_dropped");
      expect(auditDropped?.targetType).toBe("message");
      expect(auditDropped?.targetId).toBe(draftId);
      const payload = auditDropped?.payload as {
        contactId: string;
        conversationId: string;
        draftMessageId: string;
        blockedRule: string;
        blockedCode: string;
      };
      expect(payload.contactId).toBe(CONTACT_ID);
      expect(payload.conversationId).toBe(CONV_ID);
      expect(payload.draftMessageId).toBe(draftId);
      expect(payload.blockedRule).toBe("opt_out");
      expect(payload.blockedCode).toBe("opted_out");

      // Vérifier le payload compliance_check (blocked).
      const auditCompliance = await findAuditByAction("compliance_check");
      const cPayload = auditCompliance?.payload as { result: string; rule: string; code: string };
      expect(cPayload.result).toBe("blocked");
      expect(cPayload.rule).toBe("opt_out");
      expect(cPayload.code).toBe("opted_out");
    });
  });

  describe("branche blocked — rate_limit (3 outbound récents)", () => {
    it("3 outbound dans la fenêtre 30j → blocked rate_limit + audits HORS tx", async () => {
      await seedContact();
      await seedConversation();
      // Seed 3 outbound dans la fenêtre rate-limit
      await seedOutboundMessage(1, "rl1");
      await seedOutboundMessage(2, "rl2");
      await seedOutboundMessage(3, "rl3");
      const draftId = await seedDraft();

      const result = await commitDraftToQueued({
        conversationId: CONV_ID,
        draftMessageId: draftId,
        now: FIXED_NOW,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.failure.rule).toBe("rate_limit");
      expect(result.failure.code).toBe("rate_limit_exceeded");
      const ctx = result.failure.context as {
        count: number;
        maxAllowed: number;
        windowDays: number;
      };
      expect(ctx.count).toBe(3);
      expect(ctx.maxAllowed).toBe(3);
      expect(ctx.windowDays).toBe(30);

      // Draft reste draft.
      const draftAfter = await readMessage(draftId);
      expect(draftAfter?.status).toBe("draft");

      // 2 audits posés.
      expect(await countAuditByAction("compliance_check")).toBe(1);
      expect(await countAuditByAction("reply_draft_dropped")).toBe(1);
      expect(await countAuditByAction("sms_sent")).toBe(0);
    });
  });

  describe("branche blocked — hours (dimanche)", () => {
    it("now = dimanche → blocked rule=hours + audits posés", async () => {
      await seedContact();
      await seedConversation();
      const draftId = await seedDraft();

      // Dimanche 10 mai 2026, 14h Paris (UTC+2 été) → 12h UTC.
      const sunday = new Date("2026-05-10T12:00:00Z");

      const result = await commitDraftToQueued({
        conversationId: CONV_ID,
        draftMessageId: draftId,
        now: sunday,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.failure.rule).toBe("hours");
      expect(result.failure.code).toBe("sunday");

      const draftAfter = await readMessage(draftId);
      expect(draftAfter?.status).toBe("draft");

      expect(await countAuditByAction("compliance_check")).toBe(1);
      expect(await countAuditByAction("reply_draft_dropped")).toBe(1);
      expect(await countAuditByAction("sms_sent")).toBe(0);
    });
  });

  describe("branche blocked — phone_validity (phone_invalid)", () => {
    it("contact.phone.valid=false → blocked rule=phone_validity", async () => {
      await seedContact({
        phone: {
          e164: "+33612345678",
          raw: "06 12 34 56 78",
          type: "mobile",
          valid: false, // ← phone invalid
          lookupAt: Timestamp.fromDate(FIXED_NOW),
        },
      });
      await seedConversation();
      const draftId = await seedDraft();

      const result = await commitDraftToQueued({
        conversationId: CONV_ID,
        draftMessageId: draftId,
        now: FIXED_NOW,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.failure.rule).toBe("phone_validity");
      expect(result.failure.code).toBe("phone_invalid");

      expect(await countAuditByAction("compliance_check")).toBe(1);
      expect(await countAuditByAction("reply_draft_dropped")).toBe(1);
      expect(await countAuditByAction("sms_sent")).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Cas d'erreur (throw, pas blocked) — bug caller / état pathologique
  // ───────────────────────────────────────────────────────────────────────

  describe("cas d'erreur (throw, pas blocked)", () => {
    it("conversation inexistante (pré-flight) → NotFoundError", async () => {
      // Pas de seedConversation.
      await expect(
        commitDraftToQueued({
          conversationId: "conv_nonexistent",
          draftMessageId: "msg_nonexistent",
          now: FIXED_NOW,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("draft inexistant DANS tx → NotFoundError", async () => {
      await seedContact();
      await seedConversation();
      // Pas de seedDraft.

      await expect(
        commitDraftToQueued({
          conversationId: CONV_ID,
          draftMessageId: "msg_nonexistent",
          now: FIXED_NOW,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("draft avec status='queued' (idempotence broken) → ValidationError", async () => {
      await seedContact();
      await seedConversation();
      const queuedMsgId = await seedDraft({ status: "queued" });

      await expect(
        commitDraftToQueued({
          conversationId: CONV_ID,
          draftMessageId: queuedMsgId,
          now: FIXED_NOW,
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      // Le message reste tel quel (pas d'effet de bord).
      const msg = await readMessage(queuedMsgId);
      expect(msg?.status).toBe("queued");
    });

    it("draft avec direction='inbound' (defense-in-depth) → ValidationError", async () => {
      await seedContact();
      await seedConversation();
      const inboundMsgId = await seedDraft({
        direction: "inbound",
        status: "draft", // forcer un cas anormal (inbound ne peut pas être draft en pratique)
        externalId: "ovh_test_inbound",
      } as Partial<Message>);

      await expect(
        commitDraftToQueued({
          conversationId: CONV_ID,
          draftMessageId: inboundMsgId,
          now: FIXED_NOW,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("draft avec generatedBy='human' (hors scope MVP S9.4) → ValidationError", async () => {
      await seedContact();
      await seedConversation();
      const humanMsgId = await seedDraft({ generatedBy: "human" });

      await expect(
        commitDraftToQueued({
          conversationId: CONV_ID,
          draftMessageId: humanMsgId,
          now: FIXED_NOW,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("contact inexistant (mismatch conv.contactId) → NotFoundError (withContactLock)", async () => {
      // Conv seedée mais contact pas seeded → withContactLock throw
      // NotFoundError au tx.get(contactRef).
      await seedConversation();
      const draftId = await seedDraft();
      // PAS de seedContact.

      await expect(
        commitDraftToQueued({
          conversationId: CONV_ID,
          draftMessageId: draftId,
          now: FIXED_NOW,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Atomicité tx — rollback vérifié
  // ───────────────────────────────────────────────────────────────────────

  describe("atomicité tx — assertions rollback", () => {
    it("opt_out blocked → AUCUN audit `compliance_check (allowed)` posé DANS tx (rollback complet)", async () => {
      // Sentinelle critique : le pré-flight HORS tx N'A PAS posé d'audit
      // `compliance_check (allowed)` même si preSendCheck a couru. C'est
      // `preSendCheckWithAuditTx` qui throw AVANT d'écrire l'audit allowed
      // dans la tx.
      //
      // Au final : 1 audit `compliance_check (blocked)` posé HORS tx
      // (best-effort), 0 audit `compliance_check (allowed)`.
      await seedContact({
        consent: {
          legitimateInterest: "ok ok ok ok ok ok ok ok ok ok ok ok ok ok ok ok ok ok ok ok",
          optedOut: true,
        },
      });
      await seedConversation();
      const draftId = await seedDraft();

      await commitDraftToQueued({
        conversationId: CONV_ID,
        draftMessageId: draftId,
        now: FIXED_NOW,
      });

      // Lire TOUS les audits compliance_check pour vérifier qu'il n'y en a
      // qu'1 (blocked, HORS tx) — PAS 2 (allowed DANS tx + blocked HORS tx).
      const allCompliance = await getAdminDb()
        .collection(__AUDIT_COLLECTION_FOR_TESTS)
        .where("action", "==", "compliance_check")
        .get();
      expect(allCompliance.size).toBe(1);

      const payload = allCompliance.docs[0]!.data().payload as { result: string };
      expect(payload.result).toBe("blocked");
    });
  });
});
