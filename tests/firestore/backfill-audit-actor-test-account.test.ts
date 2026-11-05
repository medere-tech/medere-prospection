/**
 * Tests emulator — `backfill-actor-test-account-core` + stream unique
 * `fetchJournalEntriesRealOnly`.
 *
 * Invariants vérifiés :
 *   1. Scénario 200/5/3 (compat backward) :
 *      - AVANT rattrapage → les 3 anciennes sont INVISIBLES.
 *      - APRÈS rattrapage → les 3 + 5 = 8 réelles sont visibles.
 *   2. Idempotence : un 2e passage = 0 update.
 *   3. Aucun autre champ modifié : diff complet avant/après.
 *   4. PR3 tour 2b bis sexies — règle OR sur `actorId` :
 *      (a) ancienne entrée d'un compte de test SANS flag payload →
 *          marquée true via `testUserIds.has(actorId)` ;
 *      (b) ancienne entrée d'un compte réel → marquée false ;
 *      (c) `testUserIds` vide → `runBackfill` throw AVANT toute écriture ;
 *      (d) mutation : retire la règle `testUserIds.has(actorId)` → (a)
 *          repasserait à false (l'ancienne entrée test polluerait la vue).
 */
import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchJournalEntriesRealOnly } from "@/lib/conversations/load-conversation-detail";
import {
  __APP_NAME_FOR_TESTS,
  __getAppByName,
  __resetFirestoreAdminForTests,
  getAdminDb,
} from "@/lib/firestore/admin";
import {
  type ClerkUsersListPort,
  deriveActorTestAccount,
  EmptyTestUserSetError,
  fetchTestAccountUserIds,
  runBackfill,
} from "@/lib/firestore/backfill-actor-test-account-core";
import { __resetEnvCacheForTests } from "@/lib/security/env";

const PEPPER = "c".repeat(64);
const CONV_ID = "427963864300_hubspot-list-6081";
const CONTACT_ID = "427963864300";

/** Ensemble de users test SIMULÉ Clerk (injecté dans `runBackfill`). */
const TEST_USER_IDS: ReadonlySet<string> = new Set([
  "clerk_e2e_admin",
  "clerk_e2e_commercial_owner",
]);

async function fullReset() {
  vi.restoreAllMocks();
  __resetFirestoreAdminForTests();
  const app = __getAppByName(__APP_NAME_FOR_TESTS);
  if (app) await deleteApp(app);
  __resetEnvCacheForTests();
}

async function seedScenario200_5_3(): Promise<void> {
  const db = getAdminDb();
  const T_LEGACY = 1_800_000_000_000;
  const T_RECENT_REAL = 1_900_000_000_000;
  const T_RECENT_TEST = 1_950_000_000_000;

  // 3 anciennes réelles — PAS de champ top-level, pas de flag payload.
  for (let i = 0; i < 3; i++) {
    await db.collection("audit_log").add({
      actorId: `clerk_legacy_real_${i}`,
      actorType: "human",
      action: "contact_phone_accessed",
      targetType: "conversation",
      targetId: CONV_ID,
      payload: {
        method: "display",
        contactId: CONTACT_ID,
        conversationId: CONV_ID,
      },
      timestamp: Timestamp.fromMillis(T_LEGACY + i),
    });
  }

  // 5 nouvelles réelles — avec champ top-level `false`.
  for (let i = 0; i < 5; i++) {
    await db.collection("audit_log").add({
      actorId: `clerk_recent_real_${i}`,
      actorType: "human",
      actorTestAccount: false,
      action: "contact_phone_accessed",
      targetType: "conversation",
      targetId: CONV_ID,
      payload: {
        method: "display",
        contactId: CONTACT_ID,
        conversationId: CONV_ID,
        actorTestAccount: false,
      },
      timestamp: Timestamp.fromMillis(T_RECENT_REAL + i),
    });
  }

  // 200 nouvelles test — avec champ top-level `true` (plus récentes).
  for (let i = 0; i < 200; i++) {
    await db.collection("audit_log").add({
      actorId: `clerk_recent_test_${i}`,
      actorType: "human",
      actorTestAccount: true,
      action: "contact_phone_accessed",
      targetType: "conversation",
      targetId: CONV_ID,
      payload: {
        method: "copy",
        contactId: CONTACT_ID,
        conversationId: CONV_ID,
        actorTestAccount: true,
      },
      timestamp: Timestamp.fromMillis(T_RECENT_TEST + i),
    });
  }
}

describe("backfill-audit-actor-test-account — scénario 200/5/3", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_PII_PEPPER", PEPPER);
    await fullReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fullReset();
  });

  it("AVANT rattrapage → viewer réel voit 5 réelles (les 3 anciennes sont invisibles)", async () => {
    await seedScenario200_5_3();
    const direct = await fetchJournalEntriesRealOnly({
      targetType: "conversation",
      targetId: CONV_ID,
      viewerIsTestAccount: false,
    });
    expect(direct).toHaveLength(5);
    expect(direct.map((e) => e.actorId)).toEqual([
      "clerk_recent_real_4",
      "clerk_recent_real_3",
      "clerk_recent_real_2",
      "clerk_recent_real_1",
      "clerk_recent_real_0",
    ]);
  });

  it("APRÈS rattrapage → viewer réel voit les 8 réelles (5 + 3), ordre DESC", async () => {
    await seedScenario200_5_3();
    const stats = await runBackfill(getAdminDb(), {
      apply: true,
      testUserIds: TEST_USER_IDS,
    });
    // Les 3 anciennes sont les seules sans champ → 3 needsUpdate.
    expect(stats.needsUpdate).toBe(3);
    expect(stats.updated).toBe(3);
    expect(stats.testCount).toBe(0); // aucun des 3 legacy n'est un actorId test

    const direct = await fetchJournalEntriesRealOnly({
      targetType: "conversation",
      targetId: CONV_ID,
      viewerIsTestAccount: false,
    });
    expect(direct).toHaveLength(8);
  });

  it("DRY-RUN → stats correctes, 0 update écrit", async () => {
    await seedScenario200_5_3();
    const stats = await runBackfill(getAdminDb(), {
      apply: false,
      testUserIds: TEST_USER_IDS,
    });
    expect(stats.scanned).toBe(208);
    expect(stats.needsUpdate).toBe(3);
    expect(stats.updated).toBe(0);
    const direct = await fetchJournalEntriesRealOnly({
      targetType: "conversation",
      targetId: CONV_ID,
      viewerIsTestAccount: false,
    });
    expect(direct).toHaveLength(5);
  });

  it("idempotence : un 2e passage apply = 0 update", async () => {
    await seedScenario200_5_3();
    const first = await runBackfill(getAdminDb(), {
      apply: true,
      testUserIds: TEST_USER_IDS,
    });
    expect(first.updated).toBe(3);

    const second = await runBackfill(getAdminDb(), {
      apply: true,
      testUserIds: TEST_USER_IDS,
    });
    expect(second.needsUpdate).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.scanned).toBe(208);
  });

  it("aucun autre champ modifié : diff complet avant/après sauf actorTestAccount", async () => {
    await seedScenario200_5_3();
    const db = getAdminDb();

    const beforeSnap = await db
      .collection("audit_log")
      .where("actorId", "in", ["clerk_legacy_real_0", "clerk_legacy_real_1", "clerk_legacy_real_2"])
      .get();
    const before = new Map<string, Record<string, unknown>>();
    for (const doc of beforeSnap.docs) before.set(doc.id, doc.data());

    await runBackfill(db, { apply: true, testUserIds: TEST_USER_IDS });

    const afterSnap = await db
      .collection("audit_log")
      .where("actorId", "in", ["clerk_legacy_real_0", "clerk_legacy_real_1", "clerk_legacy_real_2"])
      .get();
    const after = new Map<string, Record<string, unknown>>();
    for (const doc of afterSnap.docs) after.set(doc.id, doc.data());

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [docId, dataAfter] of after) {
      const dataBefore = before.get(docId)!;
      expect(dataAfter.actorTestAccount).toBe(false);
      expect(dataBefore.actorTestAccount).toBeUndefined();
      const beforeWithoutFlag = { ...dataBefore };
      const afterWithoutFlag = { ...dataAfter };
      delete afterWithoutFlag.actorTestAccount;
      expect(afterWithoutFlag).toEqual(beforeWithoutFlag);
    }
  });

  it("dérivation : docs avec `payload.actorTestAccount: true` sont rattrapés à true", async () => {
    const db = getAdminDb();
    const ref = await db.collection("audit_log").add({
      actorId: "clerk_legacy_e2e",
      actorType: "human",
      action: "contact_phone_accessed",
      targetType: "conversation",
      targetId: CONV_ID,
      payload: {
        method: "display",
        contactId: CONTACT_ID,
        conversationId: CONV_ID,
        actorTestAccount: true,
      },
      timestamp: Timestamp.fromMillis(1_700_000_000_000),
    });

    const stats = await runBackfill(db, { apply: true, testUserIds: TEST_USER_IDS });
    expect(stats.needsUpdate).toBe(1);
    expect(stats.updated).toBe(1);
    expect(stats.testCount).toBe(1);
    expect(stats.testCountByAction).toEqual({ contact_phone_accessed: 1 });

    const after = await ref.get();
    expect(after.data()?.actorTestAccount).toBe(true);

    const direct = await fetchJournalEntriesRealOnly({
      targetType: "conversation",
      targetId: CONV_ID,
      viewerIsTestAccount: false,
    });
    expect(direct.map((e) => e.actorId)).not.toContain("clerk_legacy_e2e");
  });

  // ─────────────────────────────────────────────────────────────────────
  // PR3 tour 2b bis sexies — règle OR sur actorId
  // ─────────────────────────────────────────────────────────────────────

  it("ancienne entrée d'un COMPTE TEST SANS flag payload → marquée true via actorId", async () => {
    // Reproduit exactement l'anomalie du brief : `e2e-admin` a attaché /
    // classé / remis à traiter des orphelins pendant PR2c. Les audits
    // posés par `attachOrphanToConversation`, `dismissOrphan`,
    // `reopenOrphan` à l'époque N'AVAIENT PAS de `payload.actorTestAccount`
    // (ce chemin ne porte pas le flag — seul `revealContactPhone` le pose).
    //
    // Sans la règle `actorId ∈ testUserIds`, le backfill les marquerait
    // false → polluait le journal de Déthié sur les vraies conversations.
    const db = getAdminDb();
    const ref = await db.collection("audit_log").add({
      actorId: "clerk_e2e_admin", // ← est dans TEST_USER_IDS
      actorType: "human",
      action: "orphan_attached_to_conversation",
      targetType: "conversation",
      targetId: CONV_ID,
      payload: {
        orphanDocId: "oih_fixture_e2e",
        contactId: CONTACT_ID,
        conversationId: CONV_ID,
        reason: "no_conversation",
        phoneMatch: "match",
        wasOptOut: false,
        optOutDecision: "admin_no",
        // PAS DE actorTestAccount dans le payload — c'est le cas réel.
      },
      timestamp: Timestamp.fromMillis(1_700_000_000_000),
    });

    const stats = await runBackfill(db, { apply: true, testUserIds: TEST_USER_IDS });
    expect(stats.testCount).toBe(1);
    expect(stats.testCountByAction).toEqual({ orphan_attached_to_conversation: 1 });

    const after = await ref.get();
    expect(after.data()?.actorTestAccount).toBe(true);

    // Et l'entrée est bien invisible pour un viewer réel.
    const direct = await fetchJournalEntriesRealOnly({
      targetType: "conversation",
      targetId: CONV_ID,
      viewerIsTestAccount: false,
    });
    expect(direct.map((e) => e.actorId)).not.toContain("clerk_e2e_admin");
  });

  it("entrée d'un COMPTE RÉEL → marquée false (actorId pas dans testUserIds, pas de flag payload)", async () => {
    const db = getAdminDb();
    const ref = await db.collection("audit_log").add({
      actorId: "clerk_dethie", // ← PAS dans TEST_USER_IDS
      actorType: "human",
      action: "orphan_attached_to_conversation",
      targetType: "conversation",
      targetId: CONV_ID,
      payload: {
        orphanDocId: "oih_real_prod",
        contactId: CONTACT_ID,
        conversationId: CONV_ID,
        reason: "no_conversation",
        phoneMatch: "match",
        wasOptOut: false,
        optOutDecision: "admin_no",
      },
      timestamp: Timestamp.fromMillis(1_700_000_000_000),
    });

    const stats = await runBackfill(db, { apply: true, testUserIds: TEST_USER_IDS });
    expect(stats.testCount).toBe(0);
    expect(stats.testCountByAction).toEqual({});

    const after = await ref.get();
    expect(after.data()?.actorTestAccount).toBe(false);

    const direct = await fetchJournalEntriesRealOnly({
      targetType: "conversation",
      targetId: CONV_ID,
      viewerIsTestAccount: false,
    });
    expect(direct.map((e) => e.actorId)).toContain("clerk_dethie");
  });

  it("testUserIds vide → runBackfill throw EmptyTestUserSetError SANS écriture", async () => {
    const db = getAdminDb();
    // Seed une entrée qui aurait besoin du backfill.
    await db.collection("audit_log").add({
      actorId: "clerk_e2e_admin",
      actorType: "human",
      action: "orphan_attached_to_conversation",
      targetType: "conversation",
      targetId: CONV_ID,
      payload: { orphanDocId: "x" },
      timestamp: Timestamp.fromMillis(1_700_000_000_000),
    });

    // Lookup Clerk a renvoyé zéro → set vide.
    await expect(runBackfill(db, { apply: true, testUserIds: new Set() })).rejects.toBeInstanceOf(
      EmptyTestUserSetError,
    );

    // Preuve qu'AUCUNE écriture n'a eu lieu : le doc est toujours sans
    // champ top-level.
    const snap = await db.collection("audit_log").where("actorId", "==", "clerk_e2e_admin").get();
    expect(snap.docs.length).toBe(1);
    expect(snap.docs[0]?.data().actorTestAccount).toBeUndefined();
  });

  it("fetchTestAccountUserIds — pagination 3 pages, comptes test sur 2e et 3e page", async () => {
    // Prouve que la pagination `data` + `totalCount` fonctionne au-delà
    // d'une seule page. On construit un faux Clerk qui :
    //   - page offset=0  : 100 users réels (aucun testAccount)
    //   - page offset=100: 100 users dont 2 testAccount
    //   - page offset=200: 50 users dont 3 testAccount (dernière page)
    // Total = 250 users, 5 testAccount.
    const PAGE1: Array<{ id: string; publicMetadata: Record<string, unknown> }> = [];
    for (let i = 0; i < 100; i++) {
      PAGE1.push({ id: `clerk_real_p1_${i}`, publicMetadata: { role: "commercial" } });
    }
    const PAGE2: Array<{ id: string; publicMetadata: Record<string, unknown> }> = [];
    for (let i = 0; i < 100; i++) {
      // 2 test accounts sur la page 2 : i=42 et i=77.
      PAGE2.push({
        id: `clerk_${i === 42 || i === 77 ? "test" : "real"}_p2_${i}`,
        publicMetadata: i === 42 || i === 77 ? { testAccount: true } : { role: "commercial" },
      });
    }
    const PAGE3: Array<{ id: string; publicMetadata: Record<string, unknown> }> = [];
    for (let i = 0; i < 50; i++) {
      // 3 test accounts sur la page 3 : i=5, i=10, i=25.
      const isTest = i === 5 || i === 10 || i === 25;
      PAGE3.push({
        id: `clerk_${isTest ? "test" : "real"}_p3_${i}`,
        publicMetadata: isTest ? { testAccount: true } : { role: "commercial" },
      });
    }

    const TOTAL = 250;
    const calls: Array<{ limit: number; offset: number }> = [];
    const fakeClerk: ClerkUsersListPort = {
      getUserList: async (params) => {
        const limit = params?.limit ?? 100;
        const offset = params?.offset ?? 0;
        calls.push({ limit, offset });
        let data: Array<{ id: string; publicMetadata: Record<string, unknown> }>;
        if (offset === 0) data = PAGE1;
        else if (offset === 100) data = PAGE2;
        else if (offset === 200) data = PAGE3;
        else data = [];
        // Cast conforme au vrai shape Clerk `PaginatedResourceResponse<User[]>`.
        return { data, totalCount: TOTAL } as unknown as Awaited<
          ReturnType<ClerkUsersListPort["getUserList"]>
        >;
      },
    };

    const ids = await fetchTestAccountUserIds(fakeClerk);
    // 5 testAccount au total (2 page 2 + 3 page 3).
    expect(ids.size).toBe(5);
    expect(ids.has("clerk_test_p2_42")).toBe(true);
    expect(ids.has("clerk_test_p2_77")).toBe(true);
    expect(ids.has("clerk_test_p3_5")).toBe(true);
    expect(ids.has("clerk_test_p3_10")).toBe(true);
    expect(ids.has("clerk_test_p3_25")).toBe(true);
    // 3 pages demandées, dans l'ordre.
    expect(calls).toEqual([
      { limit: 100, offset: 0 },
      { limit: 100, offset: 100 },
      { limit: 100, offset: 200 },
    ]);
  });

  it("fetchTestAccountUserIds — Clerk vide (totalCount=0) → Set vide, une seule requête", async () => {
    const calls: Array<{ limit: number; offset: number }> = [];
    const emptyClerk: ClerkUsersListPort = {
      getUserList: async (params) => {
        calls.push({ limit: params?.limit ?? 100, offset: params?.offset ?? 0 });
        return { data: [], totalCount: 0 } as unknown as Awaited<
          ReturnType<ClerkUsersListPort["getUserList"]>
        >;
      },
    };
    const ids = await fetchTestAccountUserIds(emptyClerk);
    expect(ids.size).toBe(0);
    expect(calls).toEqual([{ limit: 100, offset: 0 }]);
  });

  it("deriveActorTestAccount — unité pure (sentinelle de la règle OR)", () => {
    const testIds: ReadonlySet<string> = new Set(["clerk_e2e_admin"]);
    // (1) Payload flag true → true (quelle que soit l'actorId).
    expect(deriveActorTestAccount({ actorTestAccount: true }, "clerk_real", testIds)).toBe(true);
    expect(deriveActorTestAccount({ actorTestAccount: true }, "clerk_e2e_admin", testIds)).toBe(
      true,
    );
    // (2) Payload sans flag + actorId dans set → true.
    expect(deriveActorTestAccount({}, "clerk_e2e_admin", testIds)).toBe(true);
    expect(deriveActorTestAccount(undefined, "clerk_e2e_admin", testIds)).toBe(true);
    // (3) Payload sans flag + actorId hors set → false.
    expect(deriveActorTestAccount({}, "clerk_dethie", testIds)).toBe(false);
    expect(deriveActorTestAccount(undefined, "clerk_dethie", testIds)).toBe(false);
    // (4) Strict equality : "true" string ou 1 number NE comptent pas
    //     côté payload (seul `=== true` passe).
    expect(deriveActorTestAccount({ actorTestAccount: "true" as never }, "x", testIds)).toBe(false);
    expect(deriveActorTestAccount({ actorTestAccount: 1 as never }, "x", testIds)).toBe(false);
    // (5) actorId vide → pas de match (garde anti string vide).
    expect(deriveActorTestAccount({}, "", testIds)).toBe(false);
  });
});
