/**
 * Tests EMULATOR — PR4 core `markHandoffContacted` / `unmarkHandoffContacted`
 * (`src/lib/conversations/mark-handoff-contacted.ts`).
 *
 * Ce fichier est placé sous `tests/firestore/**` pour être piloté par le
 * project `firestore` (cf. vitest.config.firestore.ts:48). La variante
 * `src/lib/conversations/` n'est PAS matchée par ce include — un test là
 * tournerait sans l'emulator et taperait Firestore prod.
 *
 * Invariants couverts (chacun avec sa mutation réelle dans la PR) :
 *
 *   1. 404 si conversation inexistante.
 *   2. Droits marquage : admin OK, commercial titulaire OK, commercial
 *      non-titulaire 403.
 *   3. Droits annulation : admin OK, auteur OK, autre commercial 403.
 *   4. Ordre droits-AVANT-statut : non-titulaire sur conv `active` → 403
 *      (PAS 409).
 *   5. Statut ≠ handed_off → 409.
 *   6. Idempotence : 2ᵉ marquage → 409.
 *   7. Whitelist : testAccount sur conv non whitelistée → 403 avec
 *      ZÉRO lecture Firestore (prouvé par absence du doc, pas de
 *      tx.get émis).
 *   8. FieldValue.delete à l'annulation : `handoff.contactedAt` et
 *      `handoff.contactedBy` effacés, `handoffContacted: false`, bump
 *      `updatedAt`.
 *   9. Audit sans PII + `actorTestAccount` à la racine.
 *  10. Concurrence : deux marquages en Promise.allSettled → EXACTEMENT
 *      1 succès + 1 ConflictError + 1 seul audit `handoff_contacted`.
 *  11. Atomicité : si `appendAuditLogTx` throw, aucune écriture sur la
 *      conv (rollback tx).
 */
import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  canMarkHandoffContacted,
  canUnmarkHandoffContacted,
  type HandoffContactedActor,
  markHandoffContacted,
  unmarkHandoffContacted,
} from "@/lib/conversations/mark-handoff-contacted";
import { E2E_CONV_ID_PR4 } from "@/lib/conversations/testaccount-whitelist";
import {
  __APP_NAME_FOR_TESTS,
  __getAppByName,
  __resetFirestoreAdminForTests,
  getAdminDb,
} from "@/lib/firestore/admin";
import * as auditLogModule from "@/lib/firestore/audit-log";
import { __AUDIT_COLLECTION_FOR_TESTS } from "@/lib/firestore/audit-log";
import { __resetEnvCacheForTests } from "@/lib/security/env";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/utils/errors";
import type { Conversation, ConversationStatus } from "@/types/conversation";

const PEPPER = "c".repeat(64);
const COLLECTION = "conversations";

// ─────────────────────────────────────────────────────────────────────────
// Actors — admin, titulaire, autre commercial, test-account.
// ─────────────────────────────────────────────────────────────────────────

const ADMIN: HandoffContactedActor = {
  userId: "user_admin",
  role: "admin",
  slackUserId: "U05UVHGBURX",
  testAccount: false,
};
const TITULAIRE: HandoffContactedActor = {
  userId: "user_vanessa",
  role: "commercial",
  slackUserId: "U_VANESSA",
  testAccount: false,
};
const AUTRE_COMMERCIAL: HandoffContactedActor = {
  userId: "user_zacharie",
  role: "commercial",
  slackUserId: "U_ZACHARIE",
  testAccount: false,
};
const TEST_ACTOR: HandoffContactedActor = {
  userId: "user_e2e_commercial",
  role: "commercial",
  slackUserId: "U_VANESSA", // même slack que titulaire pour ne pas croiser la garde fine
  testAccount: true,
};

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

async function fullReset() {
  vi.restoreAllMocks();
  __resetFirestoreAdminForTests();
  const app = __getAppByName(__APP_NAME_FOR_TESTS);
  if (app) await deleteApp(app);
  __resetEnvCacheForTests();
}

async function seedConv(id: string, overrides: Partial<Conversation> = {}): Promise<void> {
  const now = Timestamp.now();
  const doc: Conversation = {
    contactId: "contact_abc",
    campaignId: "hubspot-list-42",
    channel: "sms",
    status: "handed_off",
    intent: "INTERESSE",
    messageCount: 3,
    outboundCount: 2,
    inboundCount: 1,
    followupCount: 0,
    handoffContacted: false,
    assignedTo: "U_VANESSA",
    handoff: {
      assignedTo: "U_VANESSA",
      assignedAt: now,
      notes: "Médecin intéressé, rappeler semaine prochaine.",
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  // Strip explicit `undefined` — Firestore Admin SDK refuse les undefined ;
  // les overrides `{ handoff: undefined }` servent à simuler une conv sans
  // sous-objet handoff (NE PAS écrire la clé à la place).
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (v !== undefined) clean[k] = v;
  }
  await getAdminDb().collection(COLLECTION).doc(id).set(clean);
}

async function readConv(id: string): Promise<Conversation | null> {
  const snap = await getAdminDb().collection(COLLECTION).doc(id).get();
  return snap.exists ? (snap.data() as Conversation) : null;
}

async function countAuditOfAction(action: string): Promise<number> {
  const snap = await getAdminDb()
    .collection(__AUDIT_COLLECTION_FOR_TESTS)
    .where("action", "==", action)
    .get();
  return snap.size;
}

async function firstAuditOfAction(action: string): Promise<Record<string, unknown> | undefined> {
  const snap = await getAdminDb()
    .collection(__AUDIT_COLLECTION_FOR_TESTS)
    .where("action", "==", action)
    .get();
  return snap.docs[0]?.data();
}

describe("markHandoffContacted / unmarkHandoffContacted (PR4)", () => {
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
  // Prédicats purs (hors Firestore)
  // ───────────────────────────────────────────────────────────────────────

  describe("prédicats purs", () => {
    it("canMarkHandoffContacted — admin OK partout", () => {
      expect(canMarkHandoffContacted(ADMIN, "U_WHOEVER")).toBe(true);
      expect(canMarkHandoffContacted(ADMIN, undefined)).toBe(true);
    });
    it("canMarkHandoffContacted — commercial titulaire OK", () => {
      expect(canMarkHandoffContacted(TITULAIRE, "U_VANESSA")).toBe(true);
    });
    it("canMarkHandoffContacted — commercial non-titulaire 403", () => {
      expect(canMarkHandoffContacted(AUTRE_COMMERCIAL, "U_VANESSA")).toBe(false);
    });
    it("canMarkHandoffContacted — deux chaînes vides ne matchent PAS", () => {
      const empty: HandoffContactedActor = { ...TITULAIRE, slackUserId: "" };
      expect(canMarkHandoffContacted(empty, "")).toBe(false);
    });
    it("canUnmarkHandoffContacted — admin OK, auteur OK, autre 403", () => {
      expect(canUnmarkHandoffContacted(ADMIN, "user_other")).toBe(true);
      expect(canUnmarkHandoffContacted(TITULAIRE, "user_vanessa")).toBe(true);
      expect(canUnmarkHandoffContacted(AUTRE_COMMERCIAL, "user_vanessa")).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Marquage (POST)
  // ───────────────────────────────────────────────────────────────────────

  describe("markHandoffContacted", () => {
    it("404 si conv inexistante", async () => {
      await expect(
        markHandoffContacted({ actor: ADMIN, conversationId: "conv_ghost" }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("admin → succès, handoffContacted=true, audit handoff_contacted", async () => {
      await seedConv("conv_mark_admin");
      const res = await markHandoffContacted({
        actor: ADMIN,
        conversationId: "conv_mark_admin",
      });
      expect(res.contactedAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      const conv = await readConv("conv_mark_admin");
      expect(conv?.handoffContacted).toBe(true);
      expect(conv?.handoff?.contactedBy).toBe(ADMIN.userId);
      expect(conv?.handoff?.contactedAt).toBeInstanceOf(Timestamp);
      expect(await countAuditOfAction("handoff_contacted")).toBe(1);
      const audit = (await firstAuditOfAction("handoff_contacted"))!;
      expect(audit.actorId).toBe(ADMIN.userId);
      expect(audit.actorType).toBe("human");
      expect(audit.actorTestAccount).toBe(false);
      expect(audit.targetType).toBe("conversation");
      expect(audit.targetId).toBe("conv_mark_admin");
    });

    it("commercial titulaire → succès", async () => {
      await seedConv("conv_mark_titulaire");
      await markHandoffContacted({
        actor: TITULAIRE,
        conversationId: "conv_mark_titulaire",
      });
      const conv = await readConv("conv_mark_titulaire");
      expect(conv?.handoffContacted).toBe(true);
      expect(conv?.handoff?.contactedBy).toBe(TITULAIRE.userId);
    });

    it("commercial non-titulaire → 403 ForbiddenError, conv NON modifiée", async () => {
      await seedConv("conv_mark_autre");
      await expect(
        markHandoffContacted({
          actor: AUTRE_COMMERCIAL,
          conversationId: "conv_mark_autre",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      const conv = await readConv("conv_mark_autre");
      expect(conv?.handoffContacted).toBe(false);
      expect(await countAuditOfAction("handoff_contacted")).toBe(0);
    });

    it("ordre DROITS avant STATUT : non-titulaire sur conv `active` → 403 (PAS 409)", async () => {
      await seedConv("conv_mark_order", {
        status: "active" as ConversationStatus,
        handoff: undefined,
        assignedTo: undefined,
      });
      // AUTRE_COMMERCIAL n'est pas titulaire (handoff.assignedTo undefined
      // → `canMark` renvoie false avant même qu'on ne regarde le statut).
      // Le test prouve que l'erreur est ForbiddenError, pas ConflictError.
      await expect(
        markHandoffContacted({
          actor: AUTRE_COMMERCIAL,
          conversationId: "conv_mark_order",
        }),
      ).rejects.toSatisfy((err) => err instanceof ForbiddenError);
      await expect(
        markHandoffContacted({
          actor: AUTRE_COMMERCIAL,
          conversationId: "conv_mark_order",
        }),
      ).rejects.not.toSatisfy((err) => err instanceof ConflictError);
    });

    it("statut ≠ handed_off → 409 ConflictError", async () => {
      await seedConv("conv_mark_active", {
        status: "active" as ConversationStatus,
        handoff: undefined,
      });
      await expect(
        markHandoffContacted({ actor: ADMIN, conversationId: "conv_mark_active" }),
      ).rejects.toBeInstanceOf(ConflictError);
      const conv = await readConv("conv_mark_active");
      expect(conv?.handoffContacted).toBe(false);
    });

    it("idempotence : 2ᵉ marquage → 409 ConflictError", async () => {
      await seedConv("conv_mark_idem");
      await markHandoffContacted({ actor: ADMIN, conversationId: "conv_mark_idem" });
      await expect(
        markHandoffContacted({ actor: ADMIN, conversationId: "conv_mark_idem" }),
      ).rejects.toBeInstanceOf(ConflictError);
      // Toujours un seul audit.
      expect(await countAuditOfAction("handoff_contacted")).toBe(1);
    });

    it("whitelist : testAccount hors liste → 403 AVANT toute lecture Firestore", async () => {
      // Pas de seed : la conv n'existe pas. Un code qui lirait Firestore
      // avant la garde whitelist renverrait NotFoundError ; la garde
      // elle-même renvoie ForbiddenError. On discrimine par le TYPE.
      await expect(
        markHandoffContacted({
          actor: TEST_ACTOR,
          conversationId: "conv_pas_dans_whitelist",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("whitelist : testAccount sur E2E_CONV_ID_PR4 → passe la garde (atteint le core)", async () => {
      // Preuve directe que la whitelist ne bloque pas les 2 IDs connus :
      // sans seed, on attend NotFoundError (la garde est franchie, le
      // tx.get a bien eu lieu). Un ForbiddenError ici signerait la garde
      // qui refuse E2E_CONV_ID_PR4.
      await expect(
        markHandoffContacted({
          actor: TEST_ACTOR,
          conversationId: E2E_CONV_ID_PR4,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("atomicité : si appendAuditLogTx throw, conv NON modifiée", async () => {
      await seedConv("conv_mark_atomic");
      const spy = vi.spyOn(auditLogModule, "appendAuditLogTx").mockImplementation(() => {
        throw new Error("[audit boom]");
      });
      await expect(
        markHandoffContacted({ actor: ADMIN, conversationId: "conv_mark_atomic" }),
      ).rejects.toThrow(/audit boom/);
      const conv = await readConv("conv_mark_atomic");
      expect(conv?.handoffContacted).toBe(false);
      expect(conv?.handoff?.contactedAt).toBeUndefined();
      expect(conv?.handoff?.contactedBy).toBeUndefined();
      expect(await countAuditOfAction("handoff_contacted")).toBe(0);
      spy.mockRestore();
    });

    it("concurrence : 2 marquages parallèles → EXACTEMENT 1 succès + 1 ConflictError + 1 seul audit", async () => {
      await seedConv("conv_mark_conc");
      const results = await Promise.allSettled([
        markHandoffContacted({ actor: ADMIN, conversationId: "conv_mark_conc" }),
        markHandoffContacted({ actor: ADMIN, conversationId: "conv_mark_conc" }),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toBeInstanceOf(ConflictError);
      expect(await countAuditOfAction("handoff_contacted")).toBe(1);
      const conv = await readConv("conv_mark_conc");
      expect(conv?.handoffContacted).toBe(true);
    });

    it("audit handoff_contacted — payload sans PII, contactedBy présent", async () => {
      await seedConv("conv_mark_pii", {
        // On seed avec un `notes` qui serait sensible si copié :
        handoff: {
          assignedTo: "U_VANESSA",
          assignedAt: Timestamp.now(),
          notes: "Dr Dupont — 06 12 34 56 78 — revoir",
        },
      });
      await markHandoffContacted({
        actor: TITULAIRE,
        conversationId: "conv_mark_pii",
      });
      const audit = (await firstAuditOfAction("handoff_contacted"))!;
      const serialized = JSON.stringify(audit);
      expect(serialized).not.toContain("Dupont");
      expect(serialized).not.toMatch(/\+?33\d|0[1-9]\d{8}/);
      const payload = audit.payload as { contactedBy: string };
      expect(payload.contactedBy).toBe(TITULAIRE.userId);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Annulation (DELETE)
  // ───────────────────────────────────────────────────────────────────────

  describe("unmarkHandoffContacted", () => {
    it("404 si conv inexistante", async () => {
      await expect(
        unmarkHandoffContacted({ actor: ADMIN, conversationId: "conv_ghost" }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("admin → succès, FieldValue.delete sur contactedAt/contactedBy, handoffContacted=false", async () => {
      await seedConv("conv_unmark_admin");
      await markHandoffContacted({
        actor: TITULAIRE,
        conversationId: "conv_unmark_admin",
      });

      await unmarkHandoffContacted({
        actor: ADMIN, // admin ≠ auteur TITULAIRE — prouve E5.
        conversationId: "conv_unmark_admin",
      });
      const conv = await readConv("conv_unmark_admin");
      expect(conv?.handoffContacted).toBe(false);
      expect(conv?.handoff?.contactedAt).toBeUndefined();
      expect(conv?.handoff?.contactedBy).toBeUndefined();
      // handoff.assignedTo PRÉSERVÉ (on n'écrase pas l'objet handoff
      // entier).
      expect(conv?.handoff?.assignedTo).toBe("U_VANESSA");

      // Audit annulation posé, avec actorId=ADMIN et
      // originalContactedBy=TITULAIRE dans le payload.
      const audit = (await firstAuditOfAction("handoff_contact_undone"))!;
      expect(audit.actorId).toBe(ADMIN.userId);
      const payload = audit.payload as {
        originalContactedBy: string;
        originalContactedAtMs: number;
      };
      expect(payload.originalContactedBy).toBe(TITULAIRE.userId);
      expect(typeof payload.originalContactedAtMs).toBe("number");
    });

    it("auteur du marquage → succès", async () => {
      await seedConv("conv_unmark_auteur");
      await markHandoffContacted({
        actor: TITULAIRE,
        conversationId: "conv_unmark_auteur",
      });
      await unmarkHandoffContacted({
        actor: TITULAIRE,
        conversationId: "conv_unmark_auteur",
      });
      const conv = await readConv("conv_unmark_auteur");
      expect(conv?.handoffContacted).toBe(false);
    });

    it("autre commercial (ni admin ni auteur) → 403 ForbiddenError, conv NON modifiée", async () => {
      await seedConv("conv_unmark_autre");
      await markHandoffContacted({
        actor: TITULAIRE,
        conversationId: "conv_unmark_autre",
      });
      await expect(
        unmarkHandoffContacted({
          actor: AUTRE_COMMERCIAL,
          conversationId: "conv_unmark_autre",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      const conv = await readConv("conv_unmark_autre");
      expect(conv?.handoffContacted).toBe(true);
    });

    it("idempotence : rien à annuler → 409 ConflictError", async () => {
      await seedConv("conv_unmark_idem");
      await expect(
        unmarkHandoffContacted({ actor: ADMIN, conversationId: "conv_unmark_idem" }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("whitelist : testAccount hors liste → 403 AVANT toute lecture Firestore", async () => {
      await expect(
        unmarkHandoffContacted({
          actor: TEST_ACTOR,
          conversationId: "conv_unmark_pas_whitelistee",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});
