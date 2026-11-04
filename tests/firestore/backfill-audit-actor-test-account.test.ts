/**
 * Tests emulator — `backfill-actor-test-account-core` + stream unique
 * `fetchJournalEntriesRealOnly` (PR3 tour 2b bis quater).
 *
 * Invariants vérifiés (brief Déthié) :
 *   1. Scénario 200 test + 5 nouvelles réelles + 3 anciennes réelles :
 *      - AVANT rattrapage → les 3 anciennes sont INVISIBLES du journal
 *        d'un compte réel (preuve que le rattrapage est nécessaire).
 *      - APRÈS rattrapage → les 3 + 5 = 8 réelles sont visibles.
 *   2. Idempotence : un 2e passage = 0 update.
 *   3. Aucun autre champ modifié : comparaison complète avant/après,
 *      hors `actorTestAccount`.
 *   4. Mutation : si le backfill posait toujours `false`, une ancienne
 *      entrée test redeviendrait visible — les tests l'attrapent.
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
  deriveActorTestAccount,
  runBackfill,
} from "@/lib/firestore/backfill-actor-test-account-core";
import { __resetEnvCacheForTests } from "@/lib/security/env";

const PEPPER = "c".repeat(64);
const CONV_ID = "427963864300_hubspot-list-6081";
const CONTACT_ID = "427963864300";

async function fullReset() {
  vi.restoreAllMocks();
  __resetFirestoreAdminForTests();
  const app = __getAppByName(__APP_NAME_FOR_TESTS);
  if (app) await deleteApp(app);
  __resetEnvCacheForTests();
}

async function seedScenario200_5_3(): Promise<void> {
  const db = getAdminDb();
  const T_LEGACY = 1_800_000_000_000; // 3 anciennes réelles sans champ
  const T_RECENT_REAL = 1_900_000_000_000; // 5 nouvelles réelles
  const T_RECENT_TEST = 1_950_000_000_000; // 200 nouvelles test (timestamp max)

  // 3 anciennes réelles — PAS de champ top-level, pas de champ payload
  // (représente un doc écrit par le code historique avant l'introduction
  // du flag dans revealContactPhone).
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
    // Preuve que le rattrapage est NÉCESSAIRE : seules les 5 nouvelles
    // réelles sont visibles. Les 3 anciennes sans champ top-level sont
    // écartées par `where("actorTestAccount", "==", false)` (Firestore
    // ne matche pas un champ absent à `false`).
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
    const stats = await runBackfill(getAdminDb(), { apply: true });
    // Les 3 anciennes sont les seules sans champ → 3 needsUpdate.
    expect(stats.needsUpdate).toBe(3);
    expect(stats.updated).toBe(3);
    expect(stats.testCount).toBe(0); // payload.actorTestAccount absent → false

    const direct = await fetchJournalEntriesRealOnly({
      targetType: "conversation",
      targetId: CONV_ID,
      viewerIsTestAccount: false,
    });
    expect(direct).toHaveLength(8);
    expect(direct.map((e) => e.actorId)).toEqual([
      "clerk_recent_real_4",
      "clerk_recent_real_3",
      "clerk_recent_real_2",
      "clerk_recent_real_1",
      "clerk_recent_real_0",
      "clerk_legacy_real_2",
      "clerk_legacy_real_1",
      "clerk_legacy_real_0",
    ]);
  });

  it("DRY-RUN → stats scannés/needsUpdate corrects, 0 update écrit", async () => {
    await seedScenario200_5_3();
    const stats = await runBackfill(getAdminDb(), { apply: false });
    expect(stats.scanned).toBe(208); // 3 + 5 + 200
    expect(stats.needsUpdate).toBe(3);
    expect(stats.updated).toBe(0);
    // Aucun doc modifié : la vue journal ne change pas (5 réelles).
    const direct = await fetchJournalEntriesRealOnly({
      targetType: "conversation",
      targetId: CONV_ID,
      viewerIsTestAccount: false,
    });
    expect(direct).toHaveLength(5);
  });

  it("idempotence : un 2e passage apply = 0 update", async () => {
    await seedScenario200_5_3();
    const first = await runBackfill(getAdminDb(), { apply: true });
    expect(first.updated).toBe(3);

    const second = await runBackfill(getAdminDb(), { apply: true });
    expect(second.needsUpdate).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.scanned).toBe(208); // Toujours lu, c'est normal.
  });

  it("aucun autre champ modifié : diff complet avant/après sauf actorTestAccount", async () => {
    await seedScenario200_5_3();
    const db = getAdminDb();

    // Snapshot AVANT backfill des 3 anciennes (identifiées par actorId).
    const beforeSnap = await db
      .collection("audit_log")
      .where("actorId", "in", ["clerk_legacy_real_0", "clerk_legacy_real_1", "clerk_legacy_real_2"])
      .get();
    const before = new Map<string, Record<string, unknown>>();
    for (const doc of beforeSnap.docs) {
      before.set(doc.id, doc.data());
    }

    await runBackfill(db, { apply: true });

    // Snapshot APRÈS backfill.
    const afterSnap = await db
      .collection("audit_log")
      .where("actorId", "in", ["clerk_legacy_real_0", "clerk_legacy_real_1", "clerk_legacy_real_2"])
      .get();
    const after = new Map<string, Record<string, unknown>>();
    for (const doc of afterSnap.docs) {
      after.set(doc.id, doc.data());
    }

    // Même docIds, même nombre.
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());

    for (const [docId, dataAfter] of after) {
      const dataBefore = before.get(docId)!;
      // Le seul champ qui change est actorTestAccount, qui passe de
      // `undefined` (absent) à `false`.
      expect(dataAfter.actorTestAccount).toBe(false);
      expect(dataBefore.actorTestAccount).toBeUndefined();

      // Tous les autres champs sont strictement identiques.
      const beforeWithoutFlag = { ...dataBefore };
      const afterWithoutFlag = { ...dataAfter };
      delete afterWithoutFlag.actorTestAccount;
      expect(afterWithoutFlag).toEqual(beforeWithoutFlag);
    }
  });

  it("dérivation : docs avec `payload.actorTestAccount: true` sont rattrapés à true", async () => {
    const db = getAdminDb();
    // Seed : un doc LEGACY avec payload.actorTestAccount: true (cas réel
    // que `revealContactPhone` posait avant PR3 tour 2b bis ter).
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
        actorTestAccount: true, // ← payload porte déjà le flag
      },
      timestamp: Timestamp.fromMillis(1_700_000_000_000),
    });

    const stats = await runBackfill(db, { apply: true });
    expect(stats.needsUpdate).toBe(1);
    expect(stats.updated).toBe(1);
    expect(stats.testCount).toBe(1); // le payload a tranché : true

    const after = await ref.get();
    expect(after.data()?.actorTestAccount).toBe(true);

    // Et l'entrée n'apparaît PAS dans le journal d'un compte réel.
    const direct = await fetchJournalEntriesRealOnly({
      targetType: "conversation",
      targetId: CONV_ID,
      viewerIsTestAccount: false,
    });
    expect(direct.map((e) => e.actorId)).not.toContain("clerk_legacy_e2e");
  });

  it("deriveActorTestAccount — unité pure (sentinelle de la règle)", () => {
    // Prouve la règle que la mutation ci-dessous cassera.
    expect(deriveActorTestAccount({ actorTestAccount: true })).toBe(true);
    expect(deriveActorTestAccount({ actorTestAccount: false })).toBe(false);
    expect(deriveActorTestAccount({})).toBe(false);
    expect(deriveActorTestAccount(undefined)).toBe(false);
    // Strict equality : "true" string ou 1 number NE comptent pas.
    expect(deriveActorTestAccount({ actorTestAccount: "true" as never })).toBe(false);
    expect(deriveActorTestAccount({ actorTestAccount: 1 as never })).toBe(false);
  });

  it("mutation : si le backfill posait toujours `false`, une ancienne entrée test deviendrait visible", async () => {
    // On reproduit DIRECTEMENT le comportement muté — c'est la preuve que
    // la règle `derivedValue = payload.actorTestAccount === true` est
    // active. Si on remplaçait cette dérivation par `false` constant, le
    // doc ci-dessous (payload true, test harness) finirait avec
    // actorTestAccount=false top-level et apparaîtrait dans la vue réelle.
    const db = getAdminDb();
    const ref = await db.collection("audit_log").add({
      actorId: "clerk_legacy_e2e_test",
      actorType: "human",
      action: "contact_phone_accessed",
      targetType: "conversation",
      targetId: CONV_ID,
      payload: {
        method: "display",
        contactId: CONTACT_ID,
        conversationId: CONV_ID,
        actorTestAccount: true, // → doit être rattrapé à true
      },
      timestamp: Timestamp.fromMillis(1_700_000_000_000),
    });

    // Simulation de la MUTATION : on force le champ à `false` comme si
    // le backfill avait une dérivation buggée. On compare le résultat UI.
    await ref.update({ actorTestAccount: false });
    const resWithMutation = await fetchJournalEntriesRealOnly({
      targetType: "conversation",
      targetId: CONV_ID,
      viewerIsTestAccount: false,
    });
    expect(resWithMutation.map((e) => e.actorId)).toContain("clerk_legacy_e2e_test");

    // RESTAURATION de la bonne valeur via runBackfill : mais comme le
    // champ est déjà posé, `needsBackfill` retourne false → runBackfill
    // ne touche RIEN. On doit donc rejouer explicitement la dérivation
    // via `deriveActorTestAccount(payload)` pour prouver l'invariant du
    // CORE (c'est exactement ce que fait le vrai backfill).
    const data = (await ref.get()).data()!;
    const correct = deriveActorTestAccount(data.payload as Record<string, unknown>);
    await ref.update({ actorTestAccount: correct });
    const resCorrected = await fetchJournalEntriesRealOnly({
      targetType: "conversation",
      targetId: CONV_ID,
      viewerIsTestAccount: false,
    });
    expect(resCorrected.map((e) => e.actorId)).not.toContain("clerk_legacy_e2e_test");
  });
});
