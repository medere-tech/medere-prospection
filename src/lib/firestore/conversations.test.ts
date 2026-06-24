/**
 * Tests conversations.ts contre l'emulator. Couvre :
 *   - `conversationDocId` helper pur (2 tests)
 *   - `getConversation` : exist + valide / null / corrompu
 *   - `incrementMessageCount` : 1er outbound (firstMessageAt posé) / 2e outbound
 *                                (firstMessageAt inchangé) / inbound /
 *                                NotFoundError / ATOMICITÉ (audit fail → rollback)
 *   - `setHandoff` : 1er handoff OK / 2e → ConflictError (même OU autre
 *                    assignedTo) / notes trop courts → ValidationError /
 *                    audit log notesLength SANS notes brut / NotFoundError /
 *                    ATOMICITÉ (audit fail → rollback)
 */
import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetEnvCacheForTests } from "@/lib/security/env";
import {
  AuditPiiError,
  ConflictError,
  InternalError,
  NotFoundError,
  ValidationError,
} from "@/lib/utils/errors";
import type { Conversation } from "@/types/conversation";

import {
  __APP_NAME_FOR_TESTS,
  __getAppByName,
  __resetFirestoreAdminForTests,
  getAdminDb,
} from "./admin";
import * as auditLogModule from "./audit-log";
import { __AUDIT_COLLECTION_FOR_TESTS } from "./audit-log";
import {
  __ACTIVE_CONVERSATION_STATUSES_FOR_TESTS,
  __CONVERSATIONS_COLLECTION_FOR_TESTS,
  __HANDOFF_NOTES_MIN_LENGTH_FOR_TESTS,
  __NON_STOP_INTENTS_FOR_TESTS,
  __NON_TERMINAL_NEXT_STATUSES_FOR_TESTS,
  __TERMINAL_CONV_STATUSES_FOR_INTENT_CHANGE_FOR_TESTS,
  conversationDocId,
  getActiveConversationByContactId,
  getConversation,
  getOrCreateInitialConversation,
  incrementMessageCount,
  setConversationIntent,
  setHandoff,
} from "./conversations";

const PEPPER = "a".repeat(64);

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

describe("conversations.ts", () => {
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
  // conversationDocId helper
  // ───────────────────────────────────────────────────────────────────────

  describe("conversationDocId", () => {
    it("construit l'ID composite ${contactId}_${campaignId}", () => {
      expect(conversationDocId("contact_abc", "campaign_xyz")).toBe("contact_abc_campaign_xyz");
    });

    it("préserve les caractères spéciaux (hubspotId numérique pur)", () => {
      expect(conversationDocId("123456", "dentistes-idf-mai-2026")).toBe(
        "123456_dentistes-idf-mai-2026",
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // getConversation
  // ───────────────────────────────────────────────────────────────────────

  describe("getConversation", () => {
    it("doc présent + Zod valide → renvoie une Conversation typée", async () => {
      await seedConversation("conv_1");
      const got = await getConversation("conv_1");
      expect(got).not.toBeNull();
      expect(got?.status).toBe("active");
      expect(got?.messageCount).toBe(0);
    });

    it("doc inexistant → renvoie null (absence légitime)", async () => {
      const got = await getConversation("conv_ghost");
      expect(got).toBeNull();
    });

    it("doc présent mais corrompu (messageCount manquant) → throw ValidationError", async () => {
      await getAdminDb()
        .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
        .doc("conv_broken")
        .set({ contactId: "x", campaignId: "y" });
      await expect(getConversation("conv_broken")).rejects.toBeInstanceOf(ValidationError);
    });

    it("doc présent mais messageCount NÉGATIF → throw ValidationError (Zod nonneg)", async () => {
      const broken = buildValidConversation({ messageCount: -1 });
      await getAdminDb()
        .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
        .doc("conv_negative")
        .set(broken);
      await expect(getConversation("conv_negative")).rejects.toBeInstanceOf(ValidationError);
    });

    it("ValidationError porte un context.conversationId pour le forensic", async () => {
      await getAdminDb()
        .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
        .doc("conv_X")
        .set({ contactId: "x" });
      try {
        await getConversation("conv_X");
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationError);
        const ctx = (e as ValidationError).context as {
          conversationId: string;
        };
        expect(ctx.conversationId).toBe("conv_X");
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // getActiveConversationByContactId (S9.2.1)
  // ───────────────────────────────────────────────────────────────────────

  describe("getActiveConversationByContactId (S9.2.1)", () => {
    it("SENTINELLE — ACTIVE_CONVERSATION_STATUSES verrouillé à [active, awaiting_reply, in_dialogue, qualified]", () => {
      // 🔒 Q1 brief Déthié S9.2.0 : modifier ce set = arbitrage compliance
      // direct (quelles convs reçoivent un traitement IA vs sont droppées).
      // Le test casse si quelqu'un retire `active` (race condition
      // send-first-sms → inbound rapide redeviendrait possible).
      expect([...__ACTIVE_CONVERSATION_STATUSES_FOR_TESTS].sort()).toEqual([
        "active",
        "awaiting_reply",
        "in_dialogue",
        "qualified",
      ]);
    });

    it("happy path : 1 conv `awaiting_reply` → retourne { conversationId, conversation }", async () => {
      const convId = conversationDocId("contact_active_1", "camp_a");
      await seedConversation(convId, {
        contactId: "contact_active_1",
        campaignId: "camp_a",
        status: "awaiting_reply",
      });
      const got = await getActiveConversationByContactId("contact_active_1");
      expect(got).not.toBeNull();
      expect(got?.conversationId).toBe(convId);
      expect(got?.conversation.status).toBe("awaiting_reply");
      expect(got?.conversation.contactId).toBe("contact_active_1");
    });

    it("conv `active` (1er SMS pas encore envoyé) → trouvée aussi (anti-race Q1)", async () => {
      // Sentinelle race condition : un inbound qui arriverait JUSTE après
      // que send-first-sms ait envoyé le SMS mais AVANT que le status
      // ait été mis à jour à awaiting_reply doit quand même trouver la conv.
      const convId = conversationDocId("contact_active_2", "camp_b");
      await seedConversation(convId, {
        contactId: "contact_active_2",
        campaignId: "camp_b",
        status: "active",
      });
      const got = await getActiveConversationByContactId("contact_active_2");
      expect(got?.conversation.status).toBe("active");
    });

    it("conv `in_dialogue` → trouvée (cas n-ième message PS)", async () => {
      await seedConversation(conversationDocId("contact_active_3", "camp_c"), {
        contactId: "contact_active_3",
        campaignId: "camp_c",
        status: "in_dialogue",
      });
      const got = await getActiveConversationByContactId("contact_active_3");
      expect(got?.conversation.status).toBe("in_dialogue");
    });

    it("conv `qualified` → trouvée (avant transition handoff)", async () => {
      await seedConversation(conversationDocId("contact_active_4", "camp_d"), {
        contactId: "contact_active_4",
        campaignId: "camp_d",
        status: "qualified",
      });
      const got = await getActiveConversationByContactId("contact_active_4");
      expect(got?.conversation.status).toBe("qualified");
    });

    it("conv `closed` → null (PAS active, exclue)", async () => {
      await seedConversation(conversationDocId("contact_inactive_1", "camp_e"), {
        contactId: "contact_inactive_1",
        campaignId: "camp_e",
        status: "closed",
      });
      const got = await getActiveConversationByContactId("contact_inactive_1");
      expect(got).toBeNull();
    });

    it("conv `opted_out` → null (exclue, anti-re-process opt-out)", async () => {
      await seedConversation(conversationDocId("contact_inactive_2", "camp_f"), {
        contactId: "contact_inactive_2",
        campaignId: "camp_f",
        status: "opted_out",
      });
      const got = await getActiveConversationByContactId("contact_inactive_2");
      expect(got).toBeNull();
    });

    it("conv `handed_off` → null (sous responsabilité commercial humain)", async () => {
      await seedConversation(conversationDocId("contact_inactive_3", "camp_g"), {
        contactId: "contact_inactive_3",
        campaignId: "camp_g",
        status: "handed_off",
      });
      const got = await getActiveConversationByContactId("contact_inactive_3");
      expect(got).toBeNull();
    });

    it("conv `blocked` → null (filtrée par compliance)", async () => {
      await seedConversation(conversationDocId("contact_inactive_4", "camp_h"), {
        contactId: "contact_inactive_4",
        campaignId: "camp_h",
        status: "blocked",
      });
      const got = await getActiveConversationByContactId("contact_inactive_4");
      expect(got).toBeNull();
    });

    it("aucune conv pour ce contact → null", async () => {
      const got = await getActiveConversationByContactId("contact_nonexistent");
      expect(got).toBeNull();
    });

    it("contactId vide → throw ValidationError sans PII (inputLength only)", async () => {
      try {
        await getActiveConversationByContactId("");
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationError);
        const ctx = (e as ValidationError).context as { op: string; inputLength: number };
        expect(ctx.op).toBe("getActiveConversationByContactId");
        expect(ctx.inputLength).toBe(0);
      }
    });

    it("invariant cassé (>1 conv active même contact) → throw InternalError", async () => {
      // Drift d'invariant business : un contact qui se retrouve dans
      // 2 conversations actives simultanément (bug d'orchestration
      // campagne). Le pipeline DOIT arrêter — pas choisir arbitrairement.
      await seedConversation(conversationDocId("contact_dup", "camp_p"), {
        contactId: "contact_dup",
        campaignId: "camp_p",
        status: "awaiting_reply",
      });
      await seedConversation(conversationDocId("contact_dup", "camp_q"), {
        contactId: "contact_dup",
        campaignId: "camp_q",
        status: "in_dialogue",
      });

      try {
        await getActiveConversationByContactId("contact_dup");
        expect.fail("should have thrown InternalError");
      } catch (e) {
        expect(e).toBeInstanceOf(InternalError);
        const ctx = (e as InternalError).context as {
          op: string;
          contactId: string;
          count: number;
        };
        expect(ctx.op).toBe("getActiveConversationByContactId");
        expect(ctx.contactId).toBe("contact_dup");
        expect(ctx.count).toBeGreaterThanOrEqual(2);
      }
    });

    it("doc trouvé mais corrompu → throw ValidationError au parse Zod", async () => {
      await getAdminDb()
        .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
        .doc("conv_active_corrupt")
        .set({
          contactId: "contact_corrupt",
          campaignId: "camp_corrupt",
          status: "awaiting_reply",
          // messageCount manquant → Zod fail
        });
      await expect(getActiveConversationByContactId("contact_corrupt")).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // incrementMessageCount
  // ───────────────────────────────────────────────────────────────────────

  describe("incrementMessageCount", () => {
    it("1er outbound → messageCount=1, outboundCount=1, firstMessageAt + lastOutboundAt posés, 1 audit sms_sent", async () => {
      await seedConversation("conv_inc_1");
      await incrementMessageCount("conv_inc_1", "outbound");

      const conv = await getConversation("conv_inc_1");
      expect(conv?.messageCount).toBe(1);
      expect(conv?.outboundCount).toBe(1);
      expect(conv?.inboundCount).toBe(0);
      expect(conv?.firstMessageAt).toBeInstanceOf(Timestamp);
      expect(conv?.lastMessageAt).toBeInstanceOf(Timestamp);
      expect(conv?.lastOutboundAt).toBeInstanceOf(Timestamp);
      expect(conv?.lastInboundAt).toBeUndefined();

      const audits = await getAdminDb().collection(__AUDIT_COLLECTION_FOR_TESTS).get();
      expect(audits.size).toBe(1);
      const audit = audits.docs[0]?.data();
      expect(audit?.action).toBe("sms_sent");
      expect(audit?.payload).toEqual({ direction: "outbound" });
    });

    it("2e outbound → compteurs +1, firstMessageAt INCHANGÉ", async () => {
      const earlyTs = Timestamp.fromDate(new Date("2026-01-01T00:00:00Z"));
      await seedConversation("conv_inc_2", {
        messageCount: 1,
        outboundCount: 1,
        firstMessageAt: earlyTs,
        lastMessageAt: earlyTs,
        lastOutboundAt: earlyTs,
      });
      await incrementMessageCount("conv_inc_2", "outbound");

      const conv = await getConversation("conv_inc_2");
      expect(conv?.messageCount).toBe(2);
      expect(conv?.outboundCount).toBe(2);
      // firstMessageAt inchangé (1er message posé en seed).
      expect((conv?.firstMessageAt as Timestamp).toMillis()).toBe(earlyTs.toMillis());
      // lastMessageAt bumpé (nouveau timestamp).
      expect((conv?.lastMessageAt as Timestamp).toMillis()).toBeGreaterThan(earlyTs.toMillis());
    });

    it("1er inbound → inboundCount=1, lastInboundAt posé, audit sms_received", async () => {
      await seedConversation("conv_inc_3");
      await incrementMessageCount("conv_inc_3", "inbound");

      const conv = await getConversation("conv_inc_3");
      expect(conv?.inboundCount).toBe(1);
      expect(conv?.outboundCount).toBe(0);
      expect(conv?.lastInboundAt).toBeInstanceOf(Timestamp);
      expect(conv?.lastOutboundAt).toBeUndefined();

      const audits = await getAdminDb().collection(__AUDIT_COLLECTION_FOR_TESTS).get();
      expect(audits.docs[0]?.data().action).toBe("sms_received");
    });

    it("mix outbound puis inbound → compteurs séparés cohérents", async () => {
      await seedConversation("conv_inc_4");
      await incrementMessageCount("conv_inc_4", "outbound");
      await incrementMessageCount("conv_inc_4", "inbound");
      await incrementMessageCount("conv_inc_4", "outbound");

      const conv = await getConversation("conv_inc_4");
      expect(conv?.messageCount).toBe(3);
      expect(conv?.outboundCount).toBe(2);
      expect(conv?.inboundCount).toBe(1);
      expect(await countAuditDocs()).toBe(3);
    });

    it("conversation inexistante → throw NotFoundError", async () => {
      await expect(incrementMessageCount("conv_ghost", "outbound")).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it("ATOMICITÉ : si appendAuditLogTx throw, l'update conversation est rolled back", async () => {
      await seedConversation("conv_inc_atomic");
      // On force appendAuditLogTx à throw AuditPiiError pour simuler une
      // anomalie. Le runTransaction DOIT rollback l'update conversation.
      const spy = vi.spyOn(auditLogModule, "appendAuditLogTx").mockImplementation(() => {
        throw new AuditPiiError({ message: "simulated audit fail" });
      });

      await expect(incrementMessageCount("conv_inc_atomic", "outbound")).rejects.toBeInstanceOf(
        AuditPiiError,
      );

      const conv = await getConversation("conv_inc_atomic");
      // Compteurs et timestamps inchangés — preuve de l'atomicité.
      expect(conv?.messageCount).toBe(0);
      expect(conv?.outboundCount).toBe(0);
      expect(conv?.firstMessageAt).toBeUndefined();

      spy.mockRestore();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // setHandoff
  // ───────────────────────────────────────────────────────────────────────

  describe("setHandoff", () => {
    const VALID_NOTES = "INTERESSE: prend RDV"; // 21 chars

    it("1er handoff → status=handed_off, handoff sous-objet rempli, 1 audit handoff", async () => {
      await seedConversation("conv_hand_1");
      await incrementMessageCount("conv_hand_1", "inbound"); // 1 audit pré-existant

      await setHandoff("conv_hand_1", "U05UVHGBURX", VALID_NOTES);

      const conv = await getConversation("conv_hand_1");
      expect(conv?.status).toBe("handed_off");
      expect(conv?.handoff?.assignedTo).toBe("U05UVHGBURX");
      expect(conv?.handoff?.assignedAt).toBeInstanceOf(Timestamp);
      expect(conv?.handoff?.notes).toBe(VALID_NOTES);

      const audits = await getAdminDb().collection(__AUDIT_COLLECTION_FOR_TESTS).get();
      expect(audits.size).toBe(2); // 1 increment + 1 handoff
      const handoffAudit = audits.docs.find((d) => d.data().action === "handoff");
      expect(handoffAudit?.data().actorId).toBe("U05UVHGBURX");
      expect(handoffAudit?.data().actorType).toBe("human");
    });

    it("audit payload contient notesLength UNIQUEMENT, JAMAIS notes brut", async () => {
      await seedConversation("conv_hand_2");
      const notesWithPotentialPii = "Dr Dupont a accepté le RDV"; // 27 chars, contient "Dr Dupont"
      await setHandoff("conv_hand_2", "U05UVHGBURX", notesWithPotentialPii);

      const audits = await getAdminDb().collection(__AUDIT_COLLECTION_FOR_TESTS).get();
      const handoffAudit = audits.docs.find((d) => d.data().action === "handoff");
      const payload = handoffAudit?.data().payload as { notesLength: number };
      expect(payload.notesLength).toBe(notesWithPotentialPii.length);
      // Pas la valeur brute :
      const serialized = JSON.stringify(handoffAudit?.data().payload);
      expect(serialized).not.toContain("Dupont");
      expect(serialized).not.toContain("Dr");
    });

    it("2e handoff (autre assignedTo) → throw ConflictError, conv NON modifiée", async () => {
      await seedConversation("conv_hand_3");
      await setHandoff("conv_hand_3", "U05UVHGBURX", VALID_NOTES);

      await expect(setHandoff("conv_hand_3", "U01DPF08TQV", VALID_NOTES)).rejects.toBeInstanceOf(
        ConflictError,
      );

      // Conversation reste assignée au 1er commercial.
      const conv = await getConversation("conv_hand_3");
      expect(conv?.handoff?.assignedTo).toBe("U05UVHGBURX");
    });

    it("2e handoff (MÊME assignedTo) → throw ConflictError aussi (strict, KISS Inngest)", async () => {
      await seedConversation("conv_hand_4");
      await setHandoff("conv_hand_4", "U05UVHGBURX", VALID_NOTES);

      await expect(setHandoff("conv_hand_4", "U05UVHGBURX", VALID_NOTES)).rejects.toBeInstanceOf(
        ConflictError,
      );
    });

    it("notes < 10 chars → throw ValidationError AVANT runTransaction (aucune écriture)", async () => {
      await seedConversation("conv_hand_5");
      const auditsBefore = await countAuditDocs();

      await expect(setHandoff("conv_hand_5", "U05UVHGBURX", "court")).rejects.toBeInstanceOf(
        ValidationError,
      );

      // Aucune écriture : ni nouveau audit, ni conversation modifiée.
      expect(await countAuditDocs()).toBe(auditsBefore);
      const conv = await getConversation("conv_hand_5");
      expect(conv?.status).toBe("active");
      expect(conv?.handoff).toBeUndefined();
    });

    it("notes pile à HANDOFF_NOTES_MIN_LENGTH → accepté (limite inclusive)", async () => {
      await seedConversation("conv_hand_6");
      const exactMinNotes = "x".repeat(__HANDOFF_NOTES_MIN_LENGTH_FOR_TESTS);
      await expect(
        setHandoff("conv_hand_6", "U05UVHGBURX", exactMinNotes),
      ).resolves.toBeUndefined();
    });

    it("conversation inexistante → throw NotFoundError", async () => {
      await expect(setHandoff("conv_ghost", "U05UVHGBURX", VALID_NOTES)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it("ATOMICITÉ : si appendAuditLogTx throw, l'update conversation est rolled back", async () => {
      await seedConversation("conv_hand_atomic");
      const spy = vi.spyOn(auditLogModule, "appendAuditLogTx").mockImplementation(() => {
        throw new AuditPiiError({ message: "simulated audit fail" });
      });

      await expect(
        setHandoff("conv_hand_atomic", "U05UVHGBURX", VALID_NOTES),
      ).rejects.toBeInstanceOf(AuditPiiError);

      const conv = await getConversation("conv_hand_atomic");
      expect(conv?.status).toBe("active"); // PAS modifié
      expect(conv?.handoff).toBeUndefined();

      spy.mockRestore();
    });

    it("fallback 'unknown' si état inconsistant (status=handed_off sans sous-objet handoff)", async () => {
      // État théoriquement inatteignable via setHandoff (qui écrit les
      // deux ensemble) mais possible via migration ou corruption. On
      // teste le fallback `?? "unknown"` du context ConflictError.
      await seedConversation("conv_inconsistent", { status: "handed_off" });
      try {
        await setHandoff("conv_inconsistent", "U05UVHGBURX", VALID_NOTES);
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ConflictError);
        const ctx = (e as ConflictError).context as {
          currentAssignedTo: string;
        };
        expect(ctx.currentAssignedTo).toBe("unknown");
      }
    });

    it("ConflictError porte context.currentAssignedTo pour debug forensic", async () => {
      await seedConversation("conv_hand_ctx");
      await setHandoff("conv_hand_ctx", "U05UVHGBURX", VALID_NOTES);

      try {
        await setHandoff("conv_hand_ctx", "U01DPF08TQV", VALID_NOTES);
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ConflictError);
        const ctx = (e as ConflictError).context as {
          conversationId: string;
          currentAssignedTo: string;
        };
        expect(ctx.conversationId).toBe("conv_hand_ctx");
        expect(ctx.currentAssignedTo).toBe("U05UVHGBURX");
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // setConversationIntent (S9.2.2.1) — branches INTERESSE/OBJECTION/NEUTRE
  // ───────────────────────────────────────────────────────────────────────

  describe("setConversationIntent (S9.2.2.1)", () => {
    it("INTERESSE + nextStatus=in_dialogue → update les 2 champs + lastIntentChangeAt + updatedAt", async () => {
      await seedConversation("conv_intent_1", {
        status: "awaiting_reply",
        intent: "unknown",
      });

      await setConversationIntent("conv_intent_1", "INTERESSE", {
        nextStatus: "in_dialogue",
      });

      const conv = await getConversation("conv_intent_1");
      expect(conv?.intent).toBe("INTERESSE");
      expect(conv?.status).toBe("in_dialogue");
      expect(conv?.lastIntentChangeAt).toBeInstanceOf(Timestamp);
    });

    it("OBJECTION + nextStatus=in_dialogue → update les 2 champs", async () => {
      await seedConversation("conv_intent_2", {
        status: "awaiting_reply",
        intent: "unknown",
      });

      await setConversationIntent("conv_intent_2", "OBJECTION", {
        nextStatus: "in_dialogue",
      });

      const conv = await getConversation("conv_intent_2");
      expect(conv?.intent).toBe("OBJECTION");
      expect(conv?.status).toBe("in_dialogue");
    });

    it("NEUTRE + nextStatus=in_dialogue → update les 2 champs", async () => {
      await seedConversation("conv_intent_3", {
        status: "awaiting_reply",
        intent: "unknown",
      });

      await setConversationIntent("conv_intent_3", "NEUTRE", {
        nextStatus: "in_dialogue",
      });

      const conv = await getConversation("conv_intent_3");
      expect(conv?.intent).toBe("NEUTRE");
      expect(conv?.status).toBe("in_dialogue");
    });

    it("sans nextStatus → update intent uniquement, status préservé", async () => {
      await seedConversation("conv_intent_4", {
        status: "in_dialogue",
        intent: "NEUTRE",
      });

      await setConversationIntent("conv_intent_4", "INTERESSE");

      const conv = await getConversation("conv_intent_4");
      expect(conv?.intent).toBe("INTERESSE");
      expect(conv?.status).toBe("in_dialogue"); // ← status inchangé
    });

    it("conv en status terminal (closed) → throw ValidationError, pas d'update", async () => {
      await seedConversation("conv_intent_5", {
        status: "closed",
        intent: "NEUTRE",
      });

      await expect(
        setConversationIntent("conv_intent_5", "INTERESSE", {
          nextStatus: "in_dialogue",
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      const conv = await getConversation("conv_intent_5");
      expect(conv?.intent).toBe("NEUTRE"); // ← inchangé
      expect(conv?.status).toBe("closed");
    });

    it("conv en status opted_out → throw ValidationError (intent figé à STOP)", async () => {
      await seedConversation("conv_intent_6", {
        status: "opted_out",
        intent: "STOP",
      });

      await expect(setConversationIntent("conv_intent_6", "INTERESSE")).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it("conv inexistante → throw NotFoundError", async () => {
      await expect(setConversationIntent("conv_ghost_intent", "INTERESSE")).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it("nextStatus terminal (handed_off) → throw ValidationError AVANT la tx", async () => {
      await seedConversation("conv_intent_7", {
        status: "awaiting_reply",
        intent: "unknown",
      });

      // Sentinelle : un nextStatus terminal doit passer par la fonction
      // dédiée (setHandoff / markOptedOut). setConversationIntent refuse
      // au runtime (le typage TS accepte `ConversationStatus` entier, c'est
      // le runtime guard qui filtre — defense-in-depth pragmatique).
      await expect(
        setConversationIntent("conv_intent_7", "INTERESSE", {
          nextStatus: "handed_off",
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      // L'état n'a pas bougé.
      const conv = await getConversation("conv_intent_7");
      expect(conv?.intent).toBe("unknown");
      expect(conv?.status).toBe("awaiting_reply");
    });

    it("aucun audit log posé (l'audit est orchestré par le pipeline)", async () => {
      await seedConversation("conv_intent_8", {
        status: "awaiting_reply",
        intent: "unknown",
      });

      const auditsBefore = await countAuditDocs();
      await setConversationIntent("conv_intent_8", "INTERESSE", {
        nextStatus: "in_dialogue",
      });
      const auditsAfter = await countAuditDocs();

      // Sentinelle critique : setConversationIntent NE pose PAS d'audit
      // (cf. JSDoc — c'est le pipeline qui orchestre `intent_classified`).
      expect(auditsAfter).toBe(auditsBefore);
    });

    it("date custom via options.now → lastIntentChangeAt = date custom", async () => {
      await seedConversation("conv_intent_9");
      const customDate = new Date("2026-06-15T14:30:00.000Z");

      await setConversationIntent("conv_intent_9", "INTERESSE", {
        nextStatus: "in_dialogue",
        now: customDate,
      });

      const conv = await getConversation("conv_intent_9");
      expect(conv?.lastIntentChangeAt).toBeInstanceOf(Timestamp);
      expect((conv?.lastIntentChangeAt as Timestamp).toMillis()).toBe(customDate.getTime());
    });

    // ─── Defense-in-depth : runtime guard contre STOP / unknown via cast ───

    it("runtime guard : intent='STOP' via cast as Intent → throw ValidationError", async () => {
      await seedConversation("conv_intent_stop_bypass", {
        status: "awaiting_reply",
        intent: "unknown",
      });

      // Bypass typage TS pour simuler un caller JS / runtime non-typé.
      // Le runtime guard DOIT refuser pour préserver l'invariant
      // "STOP passe par markOptedOut, pas par setConversationIntent".
      await expect(
        setConversationIntent(
          "conv_intent_stop_bypass",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          "STOP" as any,
        ),
      ).rejects.toBeInstanceOf(ValidationError);

      const conv = await getConversation("conv_intent_stop_bypass");
      expect(conv?.intent).toBe("unknown"); // ← rien n'a bougé
    });

    it("runtime guard : intent='unknown' via cast as Intent → throw ValidationError", async () => {
      await seedConversation("conv_intent_unknown_bypass", {
        status: "awaiting_reply",
        intent: "INTERESSE",
      });

      await expect(
        setConversationIntent(
          "conv_intent_unknown_bypass",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          "unknown" as any,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    // ─── Tests TYPE-LEVEL (compile-time defense via @ts-expect-error) ───

    it("type-level : intent='STOP' refusé au compile-time", () => {
      const exercise = async () => {
        // @ts-expect-error — `"STOP"` n'est pas dans NonStopIntent
        await setConversationIntent("conv_x", "STOP");
      };
      expect(exercise).toBeDefined();
    });

    it("type-level : intent='unknown' refusé au compile-time", () => {
      const exercise = async () => {
        // @ts-expect-error — `"unknown"` n'est pas dans NonStopIntent
        await setConversationIntent("conv_x", "unknown");
      };
      expect(exercise).toBeDefined();
    });

    // ─── Sentinelles structurelles sur les constantes exposées ───

    it("sentinelle : __NON_STOP_INTENTS verrouillé à ['INTERESSE','OBJECTION','NEUTRE']", () => {
      expect([...__NON_STOP_INTENTS_FOR_TESTS].sort()).toEqual([
        "INTERESSE",
        "NEUTRE",
        "OBJECTION",
      ]);
    });

    it("sentinelle : __TERMINAL_CONV_STATUSES_FOR_INTENT_CHANGE inclut opted_out + handed_off + closed + blocked", () => {
      expect([...__TERMINAL_CONV_STATUSES_FOR_INTENT_CHANGE_FOR_TESTS].sort()).toEqual([
        "blocked",
        "closed",
        "handed_off",
        "opted_out",
      ]);
    });

    it("sentinelle : __NON_TERMINAL_NEXT_STATUSES exclut tous les terminaux", () => {
      expect([...__NON_TERMINAL_NEXT_STATUSES_FOR_TESTS].sort()).toEqual([
        "active",
        "awaiting_reply",
        "in_dialogue",
        "qualified",
      ]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // getOrCreateInitialConversation (S10.1.4.c)
  // ─────────────────────────────────────────────────────────────────────

  describe("getOrCreateInitialConversation (S10.1.4.c)", () => {
    it("première création → renvoie { conversationId composite, created: true }", async () => {
      const { conversationId, created } = await getOrCreateInitialConversation(
        "hs_abc",
        "hubspot-list-200",
      );

      expect(conversationId).toBe("hs_abc_hubspot-list-200");
      expect(created).toBe(true);

      // Doc écrit avec les valeurs init attendues
      const got = await getConversation(conversationId);
      expect(got).not.toBeNull();
      expect(got?.contactId).toBe("hs_abc");
      expect(got?.campaignId).toBe("hubspot-list-200");
      expect(got?.channel).toBe("sms");
      expect(got?.status).toBe("active");
      expect(got?.intent).toBe("unknown");
      expect(got?.messageCount).toBe(0);
      expect(got?.outboundCount).toBe(0);
      expect(got?.inboundCount).toBe(0);
      expect(got?.followupCount).toBe(0);
    });

    it("idempotence : 2e appel mêmes (contactId, campaignId) → created: false, MÊME conversationId", async () => {
      const first = await getOrCreateInitialConversation("hs_abc", "hubspot-list-200");
      expect(first.created).toBe(true);

      const second = await getOrCreateInitialConversation("hs_abc", "hubspot-list-200");
      expect(second.conversationId).toBe(first.conversationId);
      expect(second.created).toBe(false);
    });

    it("idempotence : doc existant N'EST PAS écrasé (valeurs préservées)", async () => {
      // 1er appel crée la conv
      await getOrCreateInitialConversation("hs_abc", "hubspot-list-200");

      // Simulation : un autre flow a entre-temps incrémenté la conv
      await incrementMessageCount("hs_abc_hubspot-list-200", "outbound");

      // 2ᵉ appel doit NE PAS reset les compteurs (idempotent read-only sur conv existante)
      const { created } = await getOrCreateInitialConversation("hs_abc", "hubspot-list-200");
      expect(created).toBe(false);

      const got = await getConversation("hs_abc_hubspot-list-200");
      expect(got?.messageCount).toBe(1); // pas remis à 0
      expect(got?.outboundCount).toBe(1);
    });

    it("sentinelle composite : 2 contacts différents + même campaignId → 2 conversationIds distincts", async () => {
      const a = await getOrCreateInitialConversation("hs_alice", "hubspot-list-200");
      const b = await getOrCreateInitialConversation("hs_bob", "hubspot-list-200");

      expect(a.conversationId).toBe("hs_alice_hubspot-list-200");
      expect(b.conversationId).toBe("hs_bob_hubspot-list-200");
      expect(a.conversationId).not.toBe(b.conversationId);
      expect(a.created).toBe(true);
      expect(b.created).toBe(true);
    });

    it("sentinelle composite : 1 contact + 2 campaignIds → 2 conversationIds distincts", async () => {
      const c1 = await getOrCreateInitialConversation("hs_alice", "hubspot-list-200");
      const c2 = await getOrCreateInitialConversation("hs_alice", "hubspot-list-300");

      expect(c1.conversationId).toBe("hs_alice_hubspot-list-200");
      expect(c2.conversationId).toBe("hs_alice_hubspot-list-300");
      expect(c1.conversationId).not.toBe(c2.conversationId);
      expect(c1.created).toBe(true);
      expect(c2.created).toBe(true);
    });

    it("contactId vide → ValidationError sans I/O Firestore", async () => {
      await expect(getOrCreateInitialConversation("", "hubspot-list-200")).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it("campaignId vide → ValidationError sans I/O Firestore", async () => {
      await expect(getOrCreateInitialConversation("hs_abc", "")).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it("audit_log non touché (le helper ne pose AUCUN audit lui-même)", async () => {
      expect(await countAuditDocs()).toBe(0);

      await getOrCreateInitialConversation("hs_abc", "hubspot-list-200");
      expect(await countAuditDocs()).toBe(0);

      // 2ᵉ appel idempotent — toujours pas d'audit
      await getOrCreateInitialConversation("hs_abc", "hubspot-list-200");
      expect(await countAuditDocs()).toBe(0);
    });
  });
});
