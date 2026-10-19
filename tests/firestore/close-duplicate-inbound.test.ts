/**
 * Tests EMULATOR Firestore pour `scripts/close-duplicate-inbound.mjs`
 * (R5-Point5). Prouve :
 *   - Dry-run n'ecrit RIEN : `loadState` seul laisse conv + 2 msgs intacts.
 *   - --apply ecrit exactement ce qui est prevu : doublon marque "duplicate"
 *     + duplicateOf, conv.inboundCount -1, lastInboundAt corrige, 1 audit
 *     log, le tout en 1 tx.
 *   - L'ORIGINAL n'est JAMAIS touche (status="received" preserve).
 *   - Refus race : si doublon.status change entre pre-flight et apply, throw
 *     et rollback complet.
 *   - Verification des compteurs denormalises avant/apres.
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
import { appendAuditLogTx } from "@/lib/firestore/audit-log";
import { __resetEnvCacheForTests } from "@/lib/security/env";

import {
  applyMutation,
  computeConversationCorrections,
  CONVERSATION_ID,
  DUPLICATE_ID,
  EXPECTED_EXTERNAL_ID,
  loadState,
  NEW_STATUS,
  ORIGINAL_ID,
} from "../../scripts/_lib/close-duplicate-inbound-core.mjs";

const PEPPER = "b".repeat(64);
const ORIG_MS = 1_729_000_000_000;
const DUP_MS = 1_729_000_010_000;

async function fullReset() {
  vi.restoreAllMocks();
  __resetFirestoreAdminForTests();
  const app = __getAppByName(__APP_NAME_FOR_TESTS);
  if (app) await deleteApp(app);
  __resetEnvCacheForTests();
}

/**
 * Seed l'etat pre-mutation : la conv (compteurs) + les 2 messages
 * (original + doublon) avec le MEME externalId.
 */
async function seedState() {
  const db = getAdminDb();
  await db
    .collection("conversations")
    .doc(CONVERSATION_ID)
    .set({
      contactId: "427963864300",
      status: "active",
      inboundCount: 5,
      outboundCount: 7,
      lastInboundAt: Timestamp.fromMillis(DUP_MS),
    });
  await db
    .collection("conversations")
    .doc(CONVERSATION_ID)
    .collection("messages")
    .doc(ORIGINAL_ID)
    .set({
      direction: "inbound",
      status: "received",
      externalId: EXPECTED_EXTERNAL_ID,
      createdAt: Timestamp.fromMillis(ORIG_MS),
      body: "Bonjour, interesse",
    });
  await db
    .collection("conversations")
    .doc(CONVERSATION_ID)
    .collection("messages")
    .doc(DUPLICATE_ID)
    .set({
      direction: "inbound",
      status: "received",
      externalId: EXPECTED_EXTERNAL_ID,
      createdAt: Timestamp.fromMillis(DUP_MS),
      body: "Bonjour, interesse",
    });
}

describe("close-duplicate-inbound — persist emulator (R5-Point5)", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_PII_PEPPER", PEPPER);
    await fullReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fullReset();
  });

  it("DRY-RUN : loadState seul N'ECRIT RIEN (conv + 2 msgs inchanges, 0 audit)", async () => {
    await seedState();
    const db = getAdminDb();

    const state = await loadState(db);
    expect(state.conv.inboundCount).toBe(5);
    expect(state.original.status).toBe("received");
    expect(state.duplicate.status).toBe("received");
    expect(state.inboundCandidates).toHaveLength(2);

    // Verifier qu'AUCUN doc n'a bouge
    const convAfter = await db.collection("conversations").doc(CONVERSATION_ID).get();
    expect(convAfter.data()?.inboundCount).toBe(5);
    const dupAfter = await db
      .collection("conversations")
      .doc(CONVERSATION_ID)
      .collection("messages")
      .doc(DUPLICATE_ID)
      .get();
    expect(dupAfter.data()?.status).toBe("received");
    expect(dupAfter.data()?.duplicateOf).toBeUndefined();

    // Aucun audit
    const auditSnap = await db.collection("audit_log").get();
    expect(auditSnap.size).toBe(0);
  });

  it("APPLY : doublon marque 'duplicate' + duplicateOf, compteurs corriges, 1 audit", async () => {
    await seedState();
    const db = getAdminDb();

    const state = await loadState(db);
    const corrections = computeConversationCorrections(state);
    await applyMutation(db, corrections, {
      Timestamp,
      appendAuditLogTxFn: appendAuditLogTx,
    });

    // Doublon : status="duplicate", duplicateOf=ORIGINAL_ID
    const dupSnap = await db
      .collection("conversations")
      .doc(CONVERSATION_ID)
      .collection("messages")
      .doc(DUPLICATE_ID)
      .get();
    const dupData = dupSnap.data();
    expect(dupData?.status).toBe(NEW_STATUS);
    expect(dupData?.duplicateOf).toBe(ORIGINAL_ID);
    expect(dupData?.updatedAt).toBeInstanceOf(Timestamp);
    // externalId et body preserves (append-only — pas d'overwrite)
    expect(dupData?.externalId).toBe(EXPECTED_EXTERNAL_ID);

    // Conv : inboundCount -1, lastInboundAt rebase sur l'original
    const convSnap = await db.collection("conversations").doc(CONVERSATION_ID).get();
    const convData = convSnap.data();
    expect(convData?.inboundCount).toBe(4);
    expect(convData?.lastInboundAt).toBeInstanceOf(Timestamp);
    expect((convData?.lastInboundAt as Timestamp).toMillis()).toBe(ORIG_MS);
    // outboundCount non touche
    expect(convData?.outboundCount).toBe(7);

    // Audit log : 1 entry, action="manual_override", payload avec counter correction
    const auditSnap = await db
      .collection("audit_log")
      .where("action", "==", "manual_override")
      .get();
    expect(auditSnap.size).toBe(1);
    const firstDoc = auditSnap.docs[0];
    if (!firstDoc) throw new Error("audit log attendu");
    const audit = firstDoc.data();
    expect(audit.actorType).toBe("human");
    expect(audit.targetType).toBe("message");
    expect(audit.targetId).toBe(DUPLICATE_ID);
    expect(audit.payload.duplicateOf).toBe(ORIGINAL_ID);
    expect(audit.payload.counterCorrection.inboundCount.before).toBe(5);
    expect(audit.payload.counterCorrection.inboundCount.after).toBe(4);
    expect(audit.payload.counterCorrection.lastInboundAt.changed).toBe(true);
    expect(audit.payload.counterCorrection.lastInboundAt.source).toBe(`message/${ORIGINAL_ID}`);
  });

  it("APPLY : l'ORIGINAL reste INTACT (status=received, externalId, body)", async () => {
    await seedState();
    const db = getAdminDb();

    const state = await loadState(db);
    const corrections = computeConversationCorrections(state);
    await applyMutation(db, corrections, {
      Timestamp,
      appendAuditLogTxFn: appendAuditLogTx,
    });

    const origSnap = await db
      .collection("conversations")
      .doc(CONVERSATION_ID)
      .collection("messages")
      .doc(ORIGINAL_ID)
      .get();
    const origData = origSnap.data();
    expect(origData?.status).toBe("received");
    expect(origData?.direction).toBe("inbound");
    expect(origData?.externalId).toBe(EXPECTED_EXTERNAL_ID);
    expect(origData?.duplicateOf).toBeUndefined();
    expect(origData?.body).toBe("Bonjour, interesse");
    expect((origData?.createdAt as Timestamp).toMillis()).toBe(ORIG_MS);
  });

  it("REFUS RACE : si statut doublon change entre pre-flight et apply → throw + rollback", async () => {
    await seedState();
    const db = getAdminDb();
    const state = await loadState(db);
    const corrections = computeConversationCorrections(state);

    // Race : un autre writer passe le doublon en "duplicate" avant notre apply
    await db
      .collection("conversations")
      .doc(CONVERSATION_ID)
      .collection("messages")
      .doc(DUPLICATE_ID)
      .update({ status: "duplicate" });

    await expect(
      applyMutation(db, corrections, {
        Timestamp,
        appendAuditLogTxFn: appendAuditLogTx,
      }),
    ).rejects.toThrow(/Race detectee.*attendu "received"/);

    // La conv doit garder inboundCount=5 (aucune ecriture conv)
    const convSnap = await db.collection("conversations").doc(CONVERSATION_ID).get();
    expect(convSnap.data()?.inboundCount).toBe(5);
    // Audit log vide
    const auditSnap = await db.collection("audit_log").get();
    expect(auditSnap.size).toBe(0);
  });

  it("REFUS RACE : inboundCount change entre pre-flight et apply → throw", async () => {
    await seedState();
    const db = getAdminDb();
    const state = await loadState(db);
    const corrections = computeConversationCorrections(state);

    // Race : inboundCount passe de 5 a 6 avant notre apply
    await db.collection("conversations").doc(CONVERSATION_ID).update({ inboundCount: 6 });

    await expect(
      applyMutation(db, corrections, {
        Timestamp,
        appendAuditLogTxFn: appendAuditLogTx,
      }),
    ).rejects.toThrow(/Race detectee.*inboundCount in-tx=6/);

    // Doublon reste "received"
    const dupSnap = await db
      .collection("conversations")
      .doc(CONVERSATION_ID)
      .collection("messages")
      .doc(DUPLICATE_ID)
      .get();
    expect(dupSnap.data()?.status).toBe("received");
    const auditSnap = await db.collection("audit_log").get();
    expect(auditSnap.size).toBe(0);
  });

  it("APPLY idempotence : rejoue apres succes → throw car doublon est deja 'duplicate'", async () => {
    await seedState();
    const db = getAdminDb();

    const state1 = await loadState(db);
    const corrections1 = computeConversationCorrections(state1);
    await applyMutation(db, corrections1, {
      Timestamp,
      appendAuditLogTxFn: appendAuditLogTx,
    });

    // 2eme apply : loadState voit duplicate.status=duplicate, computeCorrections
    // retourne inboundCount=4 avec `before=4`. Mais le re-check `inboundCount
    // in-tx` passe (4==4) → le refus vient de doublon.status != "received".
    const state2 = await loadState(db);
    const corrections2 = computeConversationCorrections(state2);
    await expect(
      applyMutation(db, corrections2, {
        Timestamp,
        appendAuditLogTxFn: appendAuditLogTx,
      }),
    ).rejects.toThrow(/Race detectee.*attendu "received"/);

    // L'etat reste tel qu'apres le 1er apply
    const convSnap = await db.collection("conversations").doc(CONVERSATION_ID).get();
    expect(convSnap.data()?.inboundCount).toBe(4);
    const auditSnap = await db.collection("audit_log").get();
    expect(auditSnap.size).toBe(1);
  });

  it("APPLY : lastInboundAt inchange si pointait deja sur l'original (pas sur doublon)", async () => {
    // Variante : lastInboundAt == original.createdAt des le depart.
    const db = getAdminDb();
    await db
      .collection("conversations")
      .doc(CONVERSATION_ID)
      .set({
        contactId: "427963864300",
        status: "active",
        inboundCount: 5,
        outboundCount: 7,
        lastInboundAt: Timestamp.fromMillis(ORIG_MS), // pointe sur orig
      });
    await db
      .collection("conversations")
      .doc(CONVERSATION_ID)
      .collection("messages")
      .doc(ORIGINAL_ID)
      .set({
        direction: "inbound",
        status: "received",
        externalId: EXPECTED_EXTERNAL_ID,
        createdAt: Timestamp.fromMillis(ORIG_MS),
      });
    await db
      .collection("conversations")
      .doc(CONVERSATION_ID)
      .collection("messages")
      .doc(DUPLICATE_ID)
      .set({
        direction: "inbound",
        status: "received",
        externalId: EXPECTED_EXTERNAL_ID,
        createdAt: Timestamp.fromMillis(DUP_MS),
      });

    const state = await loadState(db);
    const corrections = computeConversationCorrections(state);
    expect(corrections.lastInboundAt.changed).toBe(false);
    expect(corrections.lastInboundAt.source).toBe("unchanged");

    await applyMutation(db, corrections, {
      Timestamp,
      appendAuditLogTxFn: appendAuditLogTx,
    });

    const convSnap = await db.collection("conversations").doc(CONVERSATION_ID).get();
    expect((convSnap.data()?.lastInboundAt as Timestamp).toMillis()).toBe(ORIG_MS);
  });
});
