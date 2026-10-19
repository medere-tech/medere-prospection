/**
 * Tests EMULATOR Firestore pour `scripts/close-stale-orphans.mjs`
 * (R5-Point4). Prouve :
 *   - Dry-run n'ecrit RIEN : `loadMessages` seul laisse les 3 docs intacts.
 *   - --apply ecrit exactement ce qui est prevu : 3 updates + 3 audit logs,
 *     dans la MEME transaction (append-only).
 *   - Refus si etat inattendu : race entre pre-flight et apply → throw,
 *     aucune ecriture partielle (atomicite tx).
 *   - L'original (hors scope stale) ne doit JAMAIS etre modifie si on
 *     seed des docs voisins.
 *
 * Patterns conformes aux autres tests emulator (`orphan-inbounds.test.ts`,
 * `opt-out-chain-no-conversation.test.ts`) : `fullReset()` entre tests,
 * `AUDIT_PII_PEPPER` stub, `deleteApp` + `__resetFirestoreAdminForTests`.
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

// Import des core helpers (`.mjs`) — DI de db + Timestamp + appendAuditLogTxFn.
import {
  ABANDON_REASON,
  applyMutation,
  CONVERSATION_ID,
  loadMessages,
  MESSAGE_SPECS,
  NEW_STATUS,
} from "../../scripts/_lib/close-stale-orphans-core.mjs";

const PEPPER = "b".repeat(64);

async function fullReset() {
  vi.restoreAllMocks();
  __resetFirestoreAdminForTests();
  const app = __getAppByName(__APP_NAME_FOR_TESTS);
  if (app) await deleteApp(app);
  __resetEnvCacheForTests();
}

/**
 * Seed les 3 messages dans l'etat attendu par le script (draft/queued/queued).
 * createdAt arbitraire mais Timestamp valide.
 */
async function seedTargetMessages() {
  const db = getAdminDb();
  const t = Timestamp.fromMillis(1_700_000_000_000);
  // MESSAGE_SPECS est fige en constante (3 elements verifies par
  // assertIdsAreTargets) — l'optional chaining est la juste pour
  // noUncheckedIndexedAccess.
  const states = [
    { id: MESSAGE_SPECS[0]?.id ?? "", status: "draft" },
    { id: MESSAGE_SPECS[1]?.id ?? "", status: "queued" },
    { id: MESSAGE_SPECS[2]?.id ?? "", status: "queued" },
  ];
  for (const s of states) {
    await db.collection("conversations").doc(CONVERSATION_ID).collection("messages").doc(s.id).set({
      status: s.status,
      direction: "outbound",
      outboundKind: "solicitation",
      createdAt: t,
      externalReceiver: "+33612349876",
      body: "Bonjour, test pre-launch",
    });
  }
}

/**
 * Seed un message voisin dans la MEME conv qui N'EST PAS cible — sanity
 * check que le script ne touche QUE les 3 ids figes.
 */
async function seedNeighborMessage(id: string, status: string): Promise<void> {
  const db = getAdminDb();
  await db
    .collection("conversations")
    .doc(CONVERSATION_ID)
    .collection("messages")
    .doc(id)
    .set({
      status,
      direction: "inbound",
      createdAt: Timestamp.fromMillis(1_700_000_000_000 + 1000),
      body: "voisin inbound",
    });
}

async function fakeOvhCheckInResults(results: Array<Record<string, unknown>>) {
  // Simule `ovhSearchOrDie` qui n'a trouve 0 job (etat valide pour --apply).
  for (const r of results) {
    r.ovhCheck = {
      searched: true,
      found: 0,
      windowMs: 600_000,
      receiverMasked: "****9876",
      createdAtIso: new Date(1_700_000_000_000).toISOString(),
    };
  }
}

describe("close-stale-orphans — persist emulator (R5-Point4)", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_PII_PEPPER", PEPPER);
    await fullReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fullReset();
  });

  it("DRY-RUN : loadMessages seul N'ECRIT RIEN (3 docs inchanges, 0 audit log)", async () => {
    await seedTargetMessages();
    const db = getAdminDb();

    const results = await loadMessages(db);
    expect(results).toHaveLength(3);
    expect(results[0]?.actualStatus).toBe("draft");
    expect(results[1]?.actualStatus).toBe("queued");
    expect(results[2]?.actualStatus).toBe("queued");

    // Verifier qu'AUCUN doc n'a bouge
    for (const spec of MESSAGE_SPECS) {
      const snap = await db
        .collection("conversations")
        .doc(CONVERSATION_ID)
        .collection("messages")
        .doc(spec.id)
        .get();
      const data = snap.data();
      expect(data?.status).toBe(spec.expectedStatus);
      expect(data?.abandonedAt).toBeUndefined();
      expect(data?.abandonReason).toBeUndefined();
    }

    // Aucun audit log
    const auditSnap = await db.collection("audit_log").get();
    expect(auditSnap.size).toBe(0);
  });

  it("APPLY : applyMutation ecrit EXACTEMENT 3 updates + 3 audits en 1 tx", async () => {
    await seedTargetMessages();
    const db = getAdminDb();

    const results = await loadMessages(db);
    await fakeOvhCheckInResults(results);
    await applyMutation(db, results, { Timestamp, appendAuditLogTxFn: appendAuditLogTx });

    // Verifier les 3 docs messages
    for (const spec of MESSAGE_SPECS) {
      const snap = await db
        .collection("conversations")
        .doc(CONVERSATION_ID)
        .collection("messages")
        .doc(spec.id)
        .get();
      const data = snap.data();
      expect(data?.status).toBe(NEW_STATUS);
      expect(data?.abandonedAt).toBeInstanceOf(Timestamp);
      expect(data?.abandonReason).toBe(ABANDON_REASON);
      expect(data?.updatedAt).toBeInstanceOf(Timestamp);
    }

    // Verifier les 3 audit logs : 1 par message, action="manual_override",
    // actorType="human", targetType="message", targetId=messageId
    const auditSnap = await db
      .collection("audit_log")
      .where("action", "==", "manual_override")
      .get();
    expect(auditSnap.size).toBe(3);
    const targetIds = new Set(auditSnap.docs.map((d) => d.data().targetId as string));
    for (const spec of MESSAGE_SPECS) {
      expect(targetIds.has(spec.id)).toBe(true);
    }
    // Chaque audit a une preuve forensique ovhProof
    for (const d of auditSnap.docs) {
      const data = d.data();
      expect(data.actorType).toBe("human");
      expect(data.targetType).toBe("message");
      expect(data.payload.ovhProof.searched).toBe(true);
      expect(data.payload.ovhProof.foundJobs).toBe(0);
      expect(data.payload.conversationId).toBe(CONVERSATION_ID);
      expect(data.payload.newStatus).toBe(NEW_STATUS);
      expect(data.timestamp).toBeInstanceOf(Timestamp);
    }
  });

  it("APPLY : un message voisin de la meme conv N'EST PAS touche", async () => {
    await seedTargetMessages();
    await seedNeighborMessage("neighbor-msg-id-01", "received");
    const db = getAdminDb();

    const results = await loadMessages(db);
    await fakeOvhCheckInResults(results);
    await applyMutation(db, results, { Timestamp, appendAuditLogTxFn: appendAuditLogTx });

    // Le voisin reste intact
    const neighborSnap = await db
      .collection("conversations")
      .doc(CONVERSATION_ID)
      .collection("messages")
      .doc("neighbor-msg-id-01")
      .get();
    const data = neighborSnap.data();
    expect(data?.status).toBe("received");
    expect(data?.abandonedAt).toBeUndefined();
  });

  it("REFUS RACE : si statut change entre pre-flight et apply, applyMutation throw et NE commit RIEN", async () => {
    await seedTargetMessages();
    const db = getAdminDb();
    const results = await loadMessages(db);
    await fakeOvhCheckInResults(results);

    // Race : un autre writer modifie le statut du 2e message entre
    // le pre-flight et l'apply (ici simule par un simple update).
    const raceTarget = MESSAGE_SPECS[1]?.id;
    if (!raceTarget) throw new Error("MESSAGE_SPECS[1] manquant");
    await db
      .collection("conversations")
      .doc(CONVERSATION_ID)
      .collection("messages")
      .doc(raceTarget)
      .update({ status: "failed" });

    await expect(
      applyMutation(db, results, { Timestamp, appendAuditLogTxFn: appendAuditLogTx }),
    ).rejects.toThrow(/Race detectee/);

    // ATOMICITE : aucun des 3 docs n'a bascule en "abandoned"
    // (le 1er aurait pu l'etre si writes etaient appliques avant le throw —
    // mais Firestore tx atomique → tout rollback)
    for (const spec of MESSAGE_SPECS) {
      const snap = await db
        .collection("conversations")
        .doc(CONVERSATION_ID)
        .collection("messages")
        .doc(spec.id)
        .get();
      const data = snap.data();
      expect(data?.status).not.toBe(NEW_STATUS);
    }
    // Aucun audit log cree
    const auditSnap = await db.collection("audit_log").get();
    expect(auditSnap.size).toBe(0);
  });

  it("REFUS DOC DISPARU : un doc delete entre pre-flight et apply → throw", async () => {
    await seedTargetMessages();
    const db = getAdminDb();
    const results = await loadMessages(db);
    await fakeOvhCheckInResults(results);

    // Simule un delete race
    const raceTarget = MESSAGE_SPECS[0]?.id;
    if (!raceTarget) throw new Error("MESSAGE_SPECS[0] manquant");
    await db
      .collection("conversations")
      .doc(CONVERSATION_ID)
      .collection("messages")
      .doc(raceTarget)
      .delete();

    await expect(
      applyMutation(db, results, { Timestamp, appendAuditLogTxFn: appendAuditLogTx }),
    ).rejects.toThrow(/Race detectee.*disparu/);

    // Aucun audit log
    const auditSnap = await db.collection("audit_log").get();
    expect(auditSnap.size).toBe(0);
  });

  it("APPLY idempotence : rejoue applyMutation apres succes → throw (le statut est deja abandoned)", async () => {
    await seedTargetMessages();
    const db = getAdminDb();

    // 1er apply : succes
    const results1 = await loadMessages(db);
    await fakeOvhCheckInResults(results1);
    await applyMutation(db, results1, { Timestamp, appendAuditLogTxFn: appendAuditLogTx });

    // 2eme apply avec les MEMES expectedStatus (draft/queued/queued) alors
    // que les docs sont maintenant abandoned → le re-check in-tx doit refuser
    const results2 = await loadMessages(db);
    await fakeOvhCheckInResults(results2);
    await expect(
      applyMutation(db, results2, { Timestamp, appendAuditLogTxFn: appendAuditLogTx }),
    ).rejects.toThrow(/Race detectee.*attendu/);

    // L'etat reste abandoned (le 2e apply n'a rien touche)
    for (const spec of MESSAGE_SPECS) {
      const snap = await db
        .collection("conversations")
        .doc(CONVERSATION_ID)
        .collection("messages")
        .doc(spec.id)
        .get();
      expect(snap.data()?.status).toBe(NEW_STATUS);
    }
    // 3 audits uniquement (ceux du 1er apply)
    const auditSnap = await db.collection("audit_log").get();
    expect(auditSnap.size).toBe(3);
  });
});
