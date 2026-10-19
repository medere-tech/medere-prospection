/**
 * Core helpers de close-duplicate-inbound.mjs — fonctions pures sans effet
 * de bord. Permettent d'ecrire des tests Vitest sans emulator reel.
 *
 * Contrat identique a close-stale-orphans-core : zero process.exit, zero
 * Firestore direct, zero PII en sortie, injection de dependance.
 */
import { Timestamp } from "firebase-admin/firestore";

export const CONVERSATION_ID = "427963864300_hubspot-list-6081";
export const ORIGINAL_ID = "yRWdzWgvWPZ6DtCS4KFO";
export const DUPLICATE_ID = "2IE2dosHsojSk2Bf5OgI";
export const EXPECTED_EXTERNAL_ID = "119256955";
export const EXPECTED_DUPLICATE_STATUS = "received";
export const NEW_STATUS = "duplicate";
export const AUDIT_ACTOR_ID = "U05UVHGBURX";
export const AUDIT_REASON =
  "BUG-DEDUP-RACE pre-fix (#48) : inbound stocke 2x avec meme externalId, doublon marque duplicate";
export const LAST_INBOUND_QUERY_LIMIT = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de format (zero PII en sortie)
// ─────────────────────────────────────────────────────────────────────────────

export function toMillisOrNull(value) {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return null;
}

export function formatTimestamp(value) {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (value === undefined || value === null) return "absent";
  return "non-timestamp";
}

// ─────────────────────────────────────────────────────────────────────────────
// Garde-fou constantes figees
// ─────────────────────────────────────────────────────────────────────────────

export function assertIdsAreTargets(constants) {
  const errors = [];
  if (constants.CONVERSATION_ID !== "427963864300_hubspot-list-6081") {
    errors.push("CONVERSATION_ID a ete modifie");
  }
  if (constants.ORIGINAL_ID !== "yRWdzWgvWPZ6DtCS4KFO") {
    errors.push("ORIGINAL_ID a ete modifie");
  }
  if (constants.DUPLICATE_ID !== "2IE2dosHsojSk2Bf5OgI") {
    errors.push("DUPLICATE_ID a ete modifie");
  }
  if (constants.EXPECTED_EXTERNAL_ID !== "119256955") {
    errors.push("EXPECTED_EXTERNAL_ID a ete modifie");
  }
  if (errors.length > 0) {
    return { ok: false, exitCode: 5, errors };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Garde-fou etat : doublon = received inbound, externalId identique a
// l'original, createdAt doublon >= createdAt original
// ─────────────────────────────────────────────────────────────────────────────

export function assertStateIsDuplicable(state) {
  const errors = [];

  if (state.duplicate.direction !== "inbound") {
    errors.push(`doublon direction="${state.duplicate.direction}" (attendu "inbound")`);
  }
  if (state.original.direction !== "inbound") {
    errors.push(`original direction="${state.original.direction}" (attendu "inbound")`);
  }
  if (state.duplicate.status !== EXPECTED_DUPLICATE_STATUS) {
    errors.push(
      `doublon status="${state.duplicate.status}" (attendu "${EXPECTED_DUPLICATE_STATUS}")`,
    );
  }
  if (state.original.externalId !== EXPECTED_EXTERNAL_ID) {
    errors.push(
      `original externalId="${state.original.externalId}" (attendu "${EXPECTED_EXTERNAL_ID}")`,
    );
  }
  if (state.duplicate.externalId !== EXPECTED_EXTERNAL_ID) {
    errors.push(
      `doublon externalId="${state.duplicate.externalId}" (attendu "${EXPECTED_EXTERNAL_ID}")`,
    );
  }
  if (state.original.externalId !== state.duplicate.externalId) {
    errors.push("les 2 docs n'ont PAS le meme externalId");
  }

  const origMs = toMillisOrNull(state.original.createdAt);
  const dupMs = toMillisOrNull(state.duplicate.createdAt);
  if (origMs === null || dupMs === null) {
    errors.push("createdAt manquant ou non-Timestamp sur un des docs");
  } else if (dupMs < origMs) {
    errors.push('le "doublon" est anterieur a l\'"original" (identification inversee)');
  }

  if (errors.length > 0) {
    return { ok: false, exitCode: 5, errors };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Calcul des corrections denormalisees de la conversation
//
// Reglas :
//   - inboundCount : -1 (toujours).
//   - lastInboundAt : si lastInboundAt == doublon.createdAt (meme ms),
//     chercher le prochain inbound non-doublon dans inboundCandidates.
//     Sinon inchange.
// ─────────────────────────────────────────────────────────────────────────────

export function computeConversationCorrections(state) {
  const currentInboundCount =
    typeof state.conv.inboundCount === "number" ? state.conv.inboundCount : 0;
  const newInboundCount = Math.max(0, currentInboundCount - 1);

  const currentLastInboundAt = state.conv.lastInboundAt;
  const currentLastMs = toMillisOrNull(currentLastInboundAt);
  const duplicateMs = toMillisOrNull(state.duplicate.createdAt);

  let newLastInboundAt = currentLastInboundAt;
  let lastInboundAtChanged = false;
  let lastInboundAtSource = "unchanged";

  if (currentLastMs !== null && duplicateMs !== null && currentLastMs === duplicateMs) {
    const candidate = state.inboundCandidates.find(
      (c) => c.id !== DUPLICATE_ID && c.status !== "duplicate",
    );
    if (candidate) {
      newLastInboundAt = candidate.createdAt;
      lastInboundAtChanged = toMillisOrNull(candidate.createdAt) !== currentLastMs;
      lastInboundAtSource = `message/${candidate.id}`;
    } else {
      newLastInboundAt = null;
      lastInboundAtChanged = true;
      lastInboundAtSource = "no_remaining_inbound_null";
    }
  }

  return {
    inboundCount: {
      before: currentInboundCount,
      after: newInboundCount,
      changed: newInboundCount !== currentInboundCount,
    },
    lastInboundAt: {
      beforeIso: currentLastInboundAt ? formatTimestamp(currentLastInboundAt) : "absent",
      afterIso: newLastInboundAt ? formatTimestamp(newLastInboundAt) : "null",
      changed: lastInboundAtChanged,
      source: lastInboundAtSource,
      newValue: newLastInboundAt,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit payload builder — garantit zero PII (phone/email) en clair
// ─────────────────────────────────────────────────────────────────────────────

export function buildAuditPayload(corrections) {
  return {
    reason: AUDIT_REASON,
    conversationId: CONVERSATION_ID,
    originalMessageId: ORIGINAL_ID,
    duplicateMessageId: DUPLICATE_ID,
    duplicateOf: ORIGINAL_ID,
    previousStatus: EXPECTED_DUPLICATE_STATUS,
    newStatus: NEW_STATUS,
    counterCorrection: {
      inboundCount: {
        before: corrections.inboundCount.before,
        after: corrections.inboundCount.after,
        changed: corrections.inboundCount.changed,
      },
      lastInboundAt: {
        beforeIso: corrections.lastInboundAt.beforeIso,
        afterIso: corrections.lastInboundAt.afterIso,
        changed: corrections.lastInboundAt.changed,
        source: corrections.lastInboundAt.source,
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot (idem shape que test-pr-a-setup / close-stale-orphans)
// ─────────────────────────────────────────────────────────────────────────────

export function toSnapshotSafe(value) {
  if (value instanceof Timestamp) {
    return {
      __firestoreTimestamp__: true,
      seconds: value.seconds,
      nanoseconds: value.nanoseconds,
      iso: value.toDate().toISOString(),
    };
  }
  if (value instanceof Date) {
    return { __jsDate__: true, iso: value.toISOString() };
  }
  if (Array.isArray(value)) {
    return value.map(toSnapshotSafe);
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = toSnapshotSafe(v);
    }
    return out;
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// loadState + applyMutation — Firestore interactions exposees pour tests
// emulator. Pure DI : prennent db + Timestamp + appendAuditLogTxFn en args.
// ─────────────────────────────────────────────────────────────────────────────

export async function loadState(db) {
  const convRef = db.collection("conversations").doc(CONVERSATION_ID);
  const convSnap = await convRef.get();
  if (!convSnap.exists) {
    throw new Error(`Conversation introuvable : conversations/${CONVERSATION_ID}`);
  }
  const conv = convSnap.data();

  const originalRef = convRef.collection("messages").doc(ORIGINAL_ID);
  const originalSnap = await originalRef.get();
  if (!originalSnap.exists) {
    throw new Error(
      `Message original introuvable : conversations/${CONVERSATION_ID}/messages/${ORIGINAL_ID}`,
    );
  }
  const original = originalSnap.data();

  const duplicateRef = convRef.collection("messages").doc(DUPLICATE_ID);
  const duplicateSnap = await duplicateRef.get();
  if (!duplicateSnap.exists) {
    throw new Error(
      `Message doublon introuvable : conversations/${CONVERSATION_ID}/messages/${DUPLICATE_ID}`,
    );
  }
  const duplicate = duplicateSnap.data();

  const inboundsSnap = await convRef
    .collection("messages")
    .where("direction", "==", "inbound")
    .orderBy("createdAt", "desc")
    .limit(LAST_INBOUND_QUERY_LIMIT)
    .get();
  const inboundCandidates = inboundsSnap.docs.map((d) => ({
    id: d.id,
    createdAt: d.data().createdAt,
    status: d.data().status,
    externalId: d.data().externalId,
  }));

  return { conv, original, duplicate, inboundCandidates };
}

export async function applyMutation(db, corrections, { Timestamp, appendAuditLogTxFn }) {
  await db.runTransaction(async (tx) => {
    const convRef = db.collection("conversations").doc(CONVERSATION_ID);
    const duplicateRef = convRef.collection("messages").doc(DUPLICATE_ID);
    const originalRef = convRef.collection("messages").doc(ORIGINAL_ID);

    // Phase 1 : reads
    const [convSnap, duplicateSnap, originalSnap] = await Promise.all([
      tx.get(convRef),
      tx.get(duplicateRef),
      tx.get(originalRef),
    ]);
    if (!convSnap.exists || !duplicateSnap.exists || !originalSnap.exists) {
      throw new Error("Race detectee : conv/original/doublon disparu entre pre-flight et tx.");
    }
    const convInTx = convSnap.data();
    const duplicateInTx = duplicateSnap.data();
    const originalInTx = originalSnap.data();

    if (duplicateInTx.status !== EXPECTED_DUPLICATE_STATUS) {
      throw new Error(
        `Race detectee : doublon status="${duplicateInTx.status}" (attendu "${EXPECTED_DUPLICATE_STATUS}"). Tx abandonnee.`,
      );
    }
    if (
      duplicateInTx.externalId !== EXPECTED_EXTERNAL_ID ||
      originalInTx.externalId !== EXPECTED_EXTERNAL_ID
    ) {
      throw new Error(
        `Race detectee : externalId a change (dup=${duplicateInTx.externalId}, orig=${originalInTx.externalId}). Tx abandonnee.`,
      );
    }
    const currentInboundCountInTx =
      typeof convInTx.inboundCount === "number" ? convInTx.inboundCount : 0;
    if (currentInboundCountInTx !== corrections.inboundCount.before) {
      throw new Error(
        `Race detectee : inboundCount in-tx=${currentInboundCountInTx}, pre-flight=${corrections.inboundCount.before}. Tx abandonnee.`,
      );
    }

    const now = Timestamp.now();

    // Phase 2 : writes
    tx.update(duplicateRef, {
      status: NEW_STATUS,
      duplicateOf: ORIGINAL_ID,
      updatedAt: now,
    });

    const convUpdate = {
      inboundCount: corrections.inboundCount.after,
      updatedAt: now,
    };
    if (corrections.lastInboundAt.changed) {
      convUpdate.lastInboundAt = corrections.lastInboundAt.newValue;
    }
    tx.update(convRef, convUpdate);

    appendAuditLogTxFn(tx, {
      actorId: AUDIT_ACTOR_ID,
      actorType: "human",
      action: "manual_override",
      targetType: "message",
      targetId: DUPLICATE_ID,
      payload: buildAuditPayload(corrections),
    });
  });
}

export function buildSnapshotPayload(state, corrections, projectId) {
  return {
    snapshotCreatedAt: new Date().toISOString(),
    projectId,
    conversationId: CONVERSATION_ID,
    original: {
      id: ORIGINAL_ID,
      data: toSnapshotSafe(state.original),
    },
    duplicate: {
      id: DUPLICATE_ID,
      data: toSnapshotSafe(state.duplicate),
    },
    conversationBefore: toSnapshotSafe(state.conv),
    plannedCorrections: {
      inboundCount: corrections.inboundCount,
      lastInboundAt: {
        beforeIso: corrections.lastInboundAt.beforeIso,
        afterIso: corrections.lastInboundAt.afterIso,
        changed: corrections.lastInboundAt.changed,
        source: corrections.lastInboundAt.source,
      },
    },
    note:
      "Snapshot pre-mutation. Reset doit relire ce fichier (JAMAIS de rollback de " +
      "memoire). JAMAIS de delete. L'ORIGINAL reste intact.",
  };
}
