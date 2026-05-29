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
import { AuditPiiError, ConflictError, NotFoundError, ValidationError } from "@/lib/utils/errors";
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
  __CONVERSATIONS_COLLECTION_FOR_TESTS,
  __HANDOFF_NOTES_MIN_LENGTH_FOR_TESTS,
  conversationDocId,
  getConversation,
  incrementMessageCount,
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
});
