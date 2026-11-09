/**
 * Tests EMULATOR — `seed-reset-e2e-pr4-core.ts`.
 *
 * Couvre :
 *   - Refus de tout identifiant autre que E2E_CONV_ID_PR4 (whitelist).
 *   - Dry-run (`scanSeed`/`scanReset`) : zéro écriture.
 *   - `applySeed` : UNE seule écriture atomique (`tx.create`), pose
 *     `lastMessageAt` pour que la conv apparaisse dans la liste admin,
 *     passe `ConversationSchema`.
 *   - Visibilité : la conv seedée apparaît dans `listConversations`
 *     onglet `a_traiter` admin ET commercial `U05UVHGBURX`, puis dans
 *     `contactees` après `markHandoffContacted`.
 *   - Atomicité : un throw entre `tx.create` et le commit ne laisse
 *     AUCUN doc partiel (prouvé par le hook `__onBeforeCommit`).
 *   - Completeness : un doc existant mais incomplet (p.ex. sans
 *     `lastMessageAt`) → `already-incomplete` + issues explicites,
 *     JAMAIS « déjà existant » silencieux.
 *   - `applyReset` : efface contactedAt/contactedBy, pose
 *     `handoffContacted: false`, écrit l'audit système si marquage
 *     existait. Idempotent.
 */
import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { markHandoffContacted } from "@/lib/conversations/mark-handoff-contacted";
import { E2E_CONV_ID_PR4 } from "@/lib/conversations/testaccount-whitelist";
import {
  __APP_NAME_FOR_TESTS,
  __getAppByName,
  __resetFirestoreAdminForTests,
  getAdminDb,
} from "@/lib/firestore/admin";
import { __AUDIT_COLLECTION_FOR_TESTS } from "@/lib/firestore/audit-log";
import { filterForTab } from "@/lib/firestore/conversation-list-tabs";
import {
  ConversationSchema,
  listConversations,
  listConversationsByAssignee,
  type ListConversationsFilters,
} from "@/lib/firestore/conversations";
import {
  applyReset,
  applySeed,
  assertProjectIdMatches,
  assertTargetConversationIdAllowed,
  checkSeedCompleteness,
  E2E_PR4_CAMPAIGN_ID,
  E2E_PR4_CONTACT_ID,
  E2E_PR4_HANDOFF_ASSIGNED_TO,
  scanReset,
  scanSeed,
} from "@/lib/firestore/seed-reset-e2e-pr4-core";
import { __resetEnvCacheForTests } from "@/lib/security/env";
import { ForbiddenError, ValidationError } from "@/lib/utils/errors";

const PEPPER = "d".repeat(64);

async function fullReset() {
  vi.restoreAllMocks();
  __resetFirestoreAdminForTests();
  const app = __getAppByName(__APP_NAME_FOR_TESTS);
  if (app) await deleteApp(app);
  __resetEnvCacheForTests();
}

function tabFilters(tab: string): ListConversationsFilters {
  const { statuses, handoffContacted } = filterForTab(tab);
  return {
    ...(statuses && statuses.length > 0 && { statusIn: [...statuses] }),
    ...(handoffContacted !== undefined && { handoffContacted }),
  };
}

async function seedContactFixture(): Promise<void> {
  // Un contact fixture pour que la Phase 1 du seed trouve les champs de liste.
  await getAdminDb().collection("contacts").doc(E2E_PR4_CONTACT_ID).set({
    firstName: "Dethie",
    lastName: "Faye",
    civilite: "M.",
    speciality: "Dentiste",
    city: "Paris",
  });
}

describe("seed-reset-e2e-pr4 (PR4 — point 8)", () => {
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
  // Gardes pures
  // ───────────────────────────────────────────────────────────────────────

  describe("gardes pures", () => {
    it("assertTargetConversationIdAllowed — passe pour E2E_CONV_ID_PR4", () => {
      expect(() => assertTargetConversationIdAllowed(E2E_CONV_ID_PR4)).not.toThrow();
    });

    it("assertTargetConversationIdAllowed — throw pour tout autre identifiant", () => {
      expect(() => assertTargetConversationIdAllowed("conv_autre")).toThrow(ForbiddenError);
      expect(() => assertTargetConversationIdAllowed("427963864300_hubspot-list-6081")).toThrow(
        ForbiddenError,
      );
      expect(() => assertTargetConversationIdAllowed("")).toThrow(ForbiddenError);
    });

    it("assertProjectIdMatches — passe quand égalité stricte", () => {
      expect(() => assertProjectIdMatches("medere-test", "medere-test")).not.toThrow();
    });

    it("assertProjectIdMatches — throw sur mismatch", () => {
      expect(() => assertProjectIdMatches("medere-test", "medere-prod")).toThrow(ValidationError);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // SEED — atomicité, visibilité, ConversationSchema
  // ───────────────────────────────────────────────────────────────────────

  describe("seed — atomicité & shape du doc", () => {
    it("scanSeed sur base vide → will-create, ZÉRO écriture", async () => {
      const dec = await scanSeed(getAdminDb());
      expect(dec.kind).toBe("will-create");
      const snap = await getAdminDb().collection("conversations").doc(E2E_CONV_ID_PR4).get();
      expect(snap.exists).toBe(false);
    });

    it("scanSeed refuse un identifiant hors whitelist", async () => {
      await expect(scanSeed(getAdminDb(), "autre_id")).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("applySeed crée la conv avec status=handed_off + handoffContacted=false + lastMessageAt", async () => {
      await seedContactFixture();
      const result = await applySeed(getAdminDb());
      expect(result.kind).toBe("created");
      const snap = await getAdminDb().collection("conversations").doc(E2E_CONV_ID_PR4).get();
      const data = snap.data()!;
      expect(data.status).toBe("handed_off");
      expect(data.handoffContacted).toBe(false);
      expect(data.contactId).toBe(E2E_PR4_CONTACT_ID);
      expect(data.campaignId).toBe(E2E_PR4_CAMPAIGN_ID);
      expect(data.assignedTo).toBe(E2E_PR4_HANDOFF_ASSIGNED_TO);
      expect(data.handoff.assignedTo).toBe(E2E_PR4_HANDOFF_ASSIGNED_TO);
      // Invariant visibilité : `lastMessageAt` posé = `createdAt`.
      expect(data.lastMessageAt).toBeInstanceOf(Timestamp);
      expect((data.lastMessageAt as Timestamp).toMillis()).toBe(
        (data.createdAt as Timestamp).toMillis(),
      );
    });

    it("🔒 ConversationSchema parse le doc seedé sans erreur", async () => {
      await seedContactFixture();
      await applySeed(getAdminDb());
      const snap = await getAdminDb().collection("conversations").doc(E2E_CONV_ID_PR4).get();
      const parsed = ConversationSchema.safeParse(snap.data());
      expect(parsed.success, !parsed.success ? JSON.stringify(parsed.error.issues) : "OK").toBe(
        true,
      );
    });

    it("applySeed recopie les champs de liste depuis le contact (contactDisplayName etc.)", async () => {
      await seedContactFixture();
      await applySeed(getAdminDb());
      const snap = await getAdminDb().collection("conversations").doc(E2E_CONV_ID_PR4).get();
      const data = snap.data()!;
      expect(data.contactDisplayName).toBeTruthy();
      expect(data.contactNameSearch).toBeTruthy();
      expect(data.contactSpecialty).toBe("Dentiste");
      expect(data.contactCity).toBe("Paris");
    });

    it("🔒 atomicité : throw entre tx.create et commit NE LAISSE PAS de doc partiel", async () => {
      await seedContactFixture();
      await expect(
        applySeed(getAdminDb(), E2E_CONV_ID_PR4, {
          __onBeforeCommit: async () => {
            throw new Error("[test] simulated failure between writes");
          },
        }),
      ).rejects.toThrow(/simulated failure/);

      // Preuve : aucun doc n'a été écrit — la tx a roll-back tx.create.
      const snap = await getAdminDb().collection("conversations").doc(E2E_CONV_ID_PR4).get();
      expect(snap.exists).toBe(false);
    });

    it("applySeed est idempotent : 2 appels → already-complete le 2e, createdAt inchangé", async () => {
      await seedContactFixture();
      const r1 = await applySeed(getAdminDb());
      expect(r1.kind).toBe("created");
      const snap1 = await getAdminDb().collection("conversations").doc(E2E_CONV_ID_PR4).get();
      const created1 = (snap1.data()!.createdAt as Timestamp).toMillis();

      await new Promise((r) => setTimeout(r, 15));

      const r2 = await applySeed(getAdminDb());
      expect(r2.kind).toBe("already-complete");
      const snap2 = await getAdminDb().collection("conversations").doc(E2E_CONV_ID_PR4).get();
      const created2 = (snap2.data()!.createdAt as Timestamp).toMillis();
      expect(created2).toBe(created1);
    });

    it("🔒 completeness : un doc existant SANS lastMessageAt → already-incomplete + issues explicites", async () => {
      // Simule un doc seedé par un ancien seed cassé (sans lastMessageAt).
      const now = Timestamp.now();
      await getAdminDb()
        .collection("conversations")
        .doc(E2E_CONV_ID_PR4)
        .set({
          contactId: E2E_PR4_CONTACT_ID,
          campaignId: E2E_PR4_CAMPAIGN_ID,
          channel: "sms",
          status: "handed_off",
          intent: "INTERESSE",
          messageCount: 0,
          outboundCount: 0,
          inboundCount: 0,
          followupCount: 0,
          handoffContacted: false,
          assignedTo: E2E_PR4_HANDOFF_ASSIGNED_TO,
          handoff: { assignedTo: E2E_PR4_HANDOFF_ASSIGNED_TO, assignedAt: now },
          createdAt: now,
          updatedAt: now,
          // ← PAS de lastMessageAt
        });

      const result = await applySeed(getAdminDb());
      expect(result.kind).toBe("already-incomplete");
      if (result.kind === "already-incomplete") {
        expect(result.issues.join("|")).toMatch(/lastMessageAt/);
      }

      // Et `scanSeed` doit refléter l'état incomplet (pas « déjà existant » silencieux).
      const dec = await scanSeed(getAdminDb());
      expect(dec.kind).toBe("already-exists");
      if (dec.kind === "already-exists") {
        expect(dec.completeness.complete).toBe(false);
        expect(dec.completeness.issues.join("|")).toMatch(/lastMessageAt/);
      }
    });

    it("checkSeedCompleteness — doc parfait → complete: true", async () => {
      await seedContactFixture();
      await applySeed(getAdminDb());
      const snap = await getAdminDb().collection("conversations").doc(E2E_CONV_ID_PR4).get();
      const res = checkSeedCompleteness(snap.data());
      expect(res.complete).toBe(true);
      expect(res.issues).toEqual([]);
    });

    it("applySeed refuse un identifiant hors whitelist (0 écriture)", async () => {
      await expect(applySeed(getAdminDb(), "autre_id")).rejects.toBeInstanceOf(ForbiddenError);
      const all = await getAdminDb().collection("conversations").get();
      expect(all.size).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // VISIBILITÉ dans la liste admin/commercial
  // ───────────────────────────────────────────────────────────────────────

  describe("visibilité — listConversations onglets a_traiter / contactees", () => {
    it("🔒 admin — a_traiter inclut la conv seedée", async () => {
      await seedContactFixture();
      await applySeed(getAdminDb());
      const res = await listConversations({
        limit: 100,
        filters: tabFilters("a_traiter"),
      });
      const ids = res.conversations.map((c) => c.conversationId);
      expect(ids).toContain(E2E_CONV_ID_PR4);
    });

    it("🔒 commercial U05UVHGBURX — a_traiter inclut la conv seedée", async () => {
      await seedContactFixture();
      await applySeed(getAdminDb());
      const res = await listConversationsByAssignee(E2E_PR4_HANDOFF_ASSIGNED_TO, {
        limit: 100,
        filters: tabFilters("a_traiter"),
      });
      const ids = res.conversations.map((c) => c.conversationId);
      expect(ids).toContain(E2E_CONV_ID_PR4);
    });

    it("🔒 après markHandoffContacted — contactees inclut la conv seedée (et a_traiter ne l'inclut plus)", async () => {
      await seedContactFixture();
      await applySeed(getAdminDb());
      await markHandoffContacted({
        actor: {
          userId: "clerk_dethie",
          role: "admin",
          slackUserId: E2E_PR4_HANDOFF_ASSIGNED_TO,
          testAccount: false,
        },
        conversationId: E2E_CONV_ID_PR4,
      });
      const contactees = await listConversations({
        limit: 100,
        filters: tabFilters("contactees"),
      });
      const aTraiter = await listConversations({
        limit: 100,
        filters: tabFilters("a_traiter"),
      });
      expect(contactees.conversations.map((c) => c.conversationId)).toContain(E2E_CONV_ID_PR4);
      expect(aTraiter.conversations.map((c) => c.conversationId)).not.toContain(E2E_CONV_ID_PR4);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // RESET
  // ───────────────────────────────────────────────────────────────────────

  describe("reset", () => {
    async function seedWithMarking(): Promise<void> {
      await seedContactFixture();
      await applySeed(getAdminDb());
      await getAdminDb().collection("conversations").doc(E2E_CONV_ID_PR4).update({
        handoffContacted: true,
        "handoff.contactedAt": Timestamp.now(),
        "handoff.contactedBy": "user_vanessa",
      });
    }

    it("scanReset sur base vide → absent, ZÉRO écriture", async () => {
      const dec = await scanReset(getAdminDb());
      expect(dec.kind).toBe("absent");
    });

    it("scanReset sur conv sans marquage → no-marking", async () => {
      await seedContactFixture();
      await applySeed(getAdminDb());
      const dec = await scanReset(getAdminDb());
      expect(dec.kind).toBe("no-marking");
    });

    it("scanReset sur conv marquée → has-marking + payload", async () => {
      await seedWithMarking();
      const dec = await scanReset(getAdminDb());
      expect(dec.kind).toBe("has-marking");
      if (dec.kind === "has-marking") {
        expect(dec.contactedBy).toBe("user_vanessa");
        expect(typeof dec.contactedAtMs).toBe("number");
      }
    });

    it("applyReset efface contactedAt/contactedBy + remet handoffContacted=false + 1 audit", async () => {
      await seedWithMarking();
      const result = await applyReset(getAdminDb());
      expect(result.cleared).toBe(true);
      expect(result.wroteAudit).toBe(true);

      const snap = await getAdminDb().collection("conversations").doc(E2E_CONV_ID_PR4).get();
      const data = snap.data()!;
      expect(data.handoffContacted).toBe(false);
      expect(data.handoff.contactedAt).toBeUndefined();
      expect(data.handoff.contactedBy).toBeUndefined();
      expect(data.handoff.assignedTo).toBe(E2E_PR4_HANDOFF_ASSIGNED_TO);

      const audits = await getAdminDb()
        .collection(__AUDIT_COLLECTION_FOR_TESTS)
        .where("action", "==", "handoff_contact_undone")
        .get();
      expect(audits.size).toBe(1);
      const audit = audits.docs[0]!.data();
      expect(audit.actorType).toBe("system");
      expect(audit.actorId).toBe("seed-reset-pr4");
      expect((audit.payload as { originalContactedBy: string }).originalContactedBy).toBe(
        "user_vanessa",
      );
    });

    it("applyReset sur conv SANS marquage : cleared=true mais wroteAudit=false", async () => {
      await seedContactFixture();
      await applySeed(getAdminDb());
      const result = await applyReset(getAdminDb());
      expect(result.cleared).toBe(true);
      expect(result.wroteAudit).toBe(false);
      const audits = await getAdminDb()
        .collection(__AUDIT_COLLECTION_FOR_TESTS)
        .where("action", "==", "handoff_contact_undone")
        .get();
      expect(audits.size).toBe(0);
    });

    it("applyReset est idempotent : 2 appels consécutifs → 1 seul audit", async () => {
      await seedWithMarking();
      await applyReset(getAdminDb());
      const second = await applyReset(getAdminDb());
      expect(second.wroteAudit).toBe(false);
      const audits = await getAdminDb()
        .collection(__AUDIT_COLLECTION_FOR_TESTS)
        .where("action", "==", "handoff_contact_undone")
        .get();
      expect(audits.size).toBe(1);
    });

    it("applyReset refuse un identifiant hors whitelist", async () => {
      await expect(applyReset(getAdminDb(), "autre_id")).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});
