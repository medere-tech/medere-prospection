/**
 * Core helpers de close-stale-orphans.mjs — fonctions pures sans effet
 * de bord. Permettent d'ecrire des tests Vitest sans emulator ni OVH reel.
 *
 * Contrat :
 *   - Zero `process.exit` ici (le script est responsable des exit codes).
 *   - Zero Firestore / OVH direct (injection de dependance obligatoire).
 *   - Zero PII dans les sorties — reproduit la discipline du script.
 *
 * Les assertions renvoient `{ ok: true }` ou `{ ok: false, exitCode, errors }`.
 * Le script traduit en console.error + process.exit, les tests inspectent
 * le resultat directement.
 */
import { Timestamp } from "firebase-admin/firestore";

// Re-export du scrubber OVH : source unique dans `ovh-scrub.mjs`
// (partage avec les scripts diag-*.mjs qui touchent aussi OVH).
export { scrubOvhErrorMessage } from "./ovh-scrub.mjs";

export const CONVERSATION_ID = "427963864300_hubspot-list-6081";

export const MESSAGE_SPECS = [
  { id: "USqzioSTVioix630LgDs", expectedStatus: "draft" },
  { id: "AdaORskN73zCCQmY8akj", expectedStatus: "queued" },
  { id: "oZkis4s1XdnZDHmJGKyp", expectedStatus: "queued" },
];

export const NEW_STATUS = "abandoned";
export const ABANDON_REASON = "stale_pre_launch_test_cleanup";
export const AUDIT_ACTOR_ID = "U05UVHGBURX";
export const AUDIT_REASON = "stale pre-launch test cleanup — orphelin confirme sans job OVH";
export const OVH_SEARCH_WINDOW_MS = 10 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// maskPhone : expose pour tests + reutilisation
// ─────────────────────────────────────────────────────────────────────────────

export function maskPhone(raw) {
  if (typeof raw !== "string") return "****";
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 4) return "****";
  return "****" + digits.slice(-4);
}

// ─────────────────────────────────────────────────────────────────────────────
// Garde-fou constantes figees
// ─────────────────────────────────────────────────────────────────────────────

export function assertIdsAreTargets(constants) {
  const errors = [];
  if (constants.CONVERSATION_ID !== "427963864300_hubspot-list-6081") {
    errors.push("CONVERSATION_ID a ete modifie");
  }
  const expectedIds = ["USqzioSTVioix630LgDs", "AdaORskN73zCCQmY8akj", "oZkis4s1XdnZDHmJGKyp"];
  if (
    constants.MESSAGE_SPECS.length !== 3 ||
    constants.MESSAGE_SPECS.some((s, i) => s.id !== expectedIds[i])
  ) {
    errors.push("MESSAGE_SPECS ont ete modifies");
  }
  if (errors.length > 0) {
    return { ok: false, exitCode: 5, errors };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Garde-fou etat : chaque message doit avoir le status attendu + aucun job OVH
// trouve +/- 10 min + recherche OVH effectuee
// ─────────────────────────────────────────────────────────────────────────────

export function assertAllAreAbandonable(results) {
  const errors = [];
  for (const r of results) {
    if (r.actualStatus !== r.expectedStatus) {
      errors.push(
        `msg=${r.messageId} status="${r.actualStatus}" (attendu "${r.expectedStatus}") — etat change`,
      );
    }
    if (r.ovhCheck.searched && r.ovhCheck.found > 0) {
      errors.push(
        `msg=${r.messageId} — OVH a trouve ${r.ovhCheck.found} job(s) ` +
          `dans +/- ${r.ovhCheck.windowMs / 60000} min du createdAt`,
      );
    }
    if (!r.ovhCheck.searched) {
      errors.push(`msg=${r.messageId} — verif OVH impossible (${r.ovhCheck.reason})`);
    }
  }
  if (errors.length > 0) {
    return { ok: false, exitCode: 5, errors };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution E.164 via injection getContactFn — testable
// ─────────────────────────────────────────────────────────────────────────────

export async function resolveReceiverE164(messageData, conversationId, getContactFn) {
  if (
    messageData &&
    typeof messageData.externalReceiver === "string" &&
    messageData.externalReceiver.length > 0
  ) {
    return messageData.externalReceiver;
  }
  const sep = conversationId.indexOf("_");
  const contactId = sep > 0 ? conversationId.slice(0, sep) : conversationId;
  if (contactId.length === 0) return null;
  const contact = await getContactFn(contactId);
  if (contact === null || !contact || !contact.phone || typeof contact.phone.e164 !== "string") {
    return null;
  }
  return contact.phone.e164;
}

// ─────────────────────────────────────────────────────────────────────────────
// Construction params OVH search — fonction pure, testable
// ─────────────────────────────────────────────────────────────────────────────

export function buildOvhSearchPath(serviceName, receiverE164, createdAt) {
  if (!(createdAt instanceof Date)) {
    throw new Error("buildOvhSearchPath: createdAt doit etre Date");
  }
  const fromIso = new Date(createdAt.getTime() - OVH_SEARCH_WINDOW_MS).toISOString();
  const toIso = new Date(createdAt.getTime() + OVH_SEARCH_WINDOW_MS).toISOString();
  const receiver = receiverE164.replace(/^\+/, "00");
  return `/sms/${encodeURIComponent(serviceName)}/outgoing?creationDatetime.from=${encodeURIComponent(fromIso)}&creationDatetime.to=${encodeURIComponent(toIso)}&receiver=${encodeURIComponent(receiver)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit payload builder — garantit zero PII en clair (phone / email)
// ─────────────────────────────────────────────────────────────────────────────

export function buildAuditPayload(result, previousStatus) {
  return {
    reason: AUDIT_REASON,
    conversationId: CONVERSATION_ID,
    previousStatus,
    newStatus: NEW_STATUS,
    abandonReason: ABANDON_REASON,
    ovhProof: {
      searched: result.ovhCheck.searched,
      foundJobs: result.ovhCheck.found,
      windowMs: result.ovhCheck.windowMs,
      messageCreatedAtIso: result.ovhCheck.createdAtIso,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot builder — fonction pure (serialisation Timestamp-safe)
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
// loadMessages + applyMutation — exposes Firestore interactions pour test
// emulator. Pure DI : prennent db + Timestamp + appendAuditLogTxFn en args.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lit les 3 messages cibles depuis Firestore. Ne touche PAS a OVH.
 * Retourne la forme `results` consommee par `applyMutation`, avec
 * `ovhCheck` par defaut `{ searched: false, reason: "not_called_in_this_fn" }`.
 * Le script en prod remplace `ovhCheck` par le resultat reel avant d'appeler
 * `assertAllAreAbandonable` + `applyMutation`.
 */
export async function loadMessages(db) {
  const results = [];
  for (const spec of MESSAGE_SPECS) {
    const path = `conversations/${CONVERSATION_ID}/messages/${spec.id}`;
    const snap = await db.doc(path).get();
    if (!snap.exists) {
      throw new Error(`Message introuvable : ${path}`);
    }
    const data = snap.data();
    const actualStatus = typeof data.status === "string" ? data.status : "(absent)";
    results.push({
      messageId: spec.id,
      expectedStatus: spec.expectedStatus,
      actualStatus,
      direction: typeof data.direction === "string" ? data.direction : "(absent)",
      outboundKind: typeof data.outboundKind === "string" ? data.outboundKind : "(absent)",
      createdAt: data.createdAt,
      hasExternalReceiver:
        typeof data.externalReceiver === "string" && data.externalReceiver.length > 0,
      ovhCheck: { searched: false, reason: "not_called_in_this_fn" },
      rawData: data,
    });
  }
  return results;
}

/**
 * Transaction atomique : 3 updates vers "abandoned" + 3 audit logs
 * via `appendAuditLogTxFn`. Re-check status DANS la tx.
 */
export async function applyMutation(db, results, { Timestamp, appendAuditLogTxFn }) {
  await db.runTransaction(async (tx) => {
    const messageRefs = [];
    const previousStatuses = [];
    for (const r of results) {
      const messageRef = db
        .collection("conversations")
        .doc(CONVERSATION_ID)
        .collection("messages")
        .doc(r.messageId);
      const messageSnap = await tx.get(messageRef);
      if (!messageSnap.exists) {
        throw new Error(
          `Race detectee : msg=${r.messageId} a disparu entre lecture pre-flight et tx.`,
        );
      }
      const inTxData = messageSnap.data();
      const inTxStatus = typeof inTxData.status === "string" ? inTxData.status : "(absent)";
      if (inTxStatus !== r.expectedStatus) {
        throw new Error(
          `Race detectee : msg=${r.messageId} status="${inTxStatus}" (attendu "${r.expectedStatus}"). Tx abandonnee.`,
        );
      }
      messageRefs.push(messageRef);
      previousStatuses.push(inTxStatus);
    }

    const now = Timestamp.now();
    for (let i = 0; i < results.length; i += 1) {
      const r = results[i];
      const messageRef = messageRefs[i];
      const previousStatus = previousStatuses[i];

      tx.update(messageRef, {
        status: NEW_STATUS,
        abandonedAt: now,
        abandonReason: ABANDON_REASON,
        updatedAt: now,
      });

      appendAuditLogTxFn(tx, {
        actorId: AUDIT_ACTOR_ID,
        actorType: "human",
        action: "manual_override",
        targetType: "message",
        targetId: r.messageId,
        payload: buildAuditPayload(r, previousStatus),
      });
    }
  });
}

export function buildSnapshotPayload(results, projectId) {
  return {
    snapshotCreatedAt: new Date().toISOString(),
    projectId,
    conversationId: CONVERSATION_ID,
    messages: results.map((r) => ({
      messageId: r.messageId,
      expectedStatus: r.expectedStatus,
      actualStatus: r.actualStatus,
      ovhCheck: {
        searched: r.ovhCheck.searched,
        found: r.ovhCheck.found ?? null,
        windowMs: r.ovhCheck.windowMs ?? null,
        createdAtIso: r.ovhCheck.createdAtIso ?? null,
        reason: r.ovhCheck.reason ?? null,
      },
      data: toSnapshotSafe(r.rawData),
    })),
    note:
      "Snapshot pre-mutation. Reset doit relire ce fichier et appliquer " +
      "les anciennes valeurs (JAMAIS de rollback de memoire). JAMAIS de delete.",
  };
}
