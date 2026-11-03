/**
 * Core logique de reset-e2e-orphans — fonctions pures/injectables sans
 * CLI, sans dotenv, sans `process.exit`. Partagé par le script
 * `scripts/reset-e2e-orphans.mjs` ET par les tests emulator
 * `tests/firestore/reset-full-scenario.test.ts` (PR2c tour 2b bloc C
 * quater — fin de la duplication constatée au hook pre-push).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Contrat
 *
 *   - ZÉRO `process.exit`. Les fonctions retournent des structures ou
 *     throw ; le script traduit en code de sortie.
 *   - ZÉRO console.log. Le script log depuis les structures retournées
 *     (`scanFixturesForReset().logs`, `predictConvStateAfterReset()`).
 *   - Toutes les écritures Firestore vivent dans `applyResetWrites`.
 *     `scanFixturesForReset` et `predictConvStateAfterReset` sont
 *     lecture seule — un dry-run les appelle sans jamais mordre sur
 *     la base.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Fail-closed `assertSafeReset`
 *
 *   Si `predictConvStateAfterReset` retourne `{ abort: string }`, c'est
 *   qu'aucun message ne reste avec un `createdAt: Timestamp` exploitable.
 *   Appliquer le reset dans ce cas effacerait `lastMessageAt` sans le
 *   reposer → la conv sortirait de la liste admin (orderBy desc).
 *
 *   `assertSafeReset` throw dans ce cas. MUTATION SENTINELLE : retirer
 *   cette garde et le test `assertSafeReset lève sur abort posé`
 *   échoue immédiatement (preuve rejouée dans la restitution).
 */
import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { safeExternalIdHash } from "@/lib/utils/pii-detector";

import { computeBackfillUpdatesForConversation } from "./backfill-conversation-list-fields";
import { buildLastMessagePreview, sanitizeLastMessageText } from "./conversation-list-fields";
import { ORPHAN_INBOUNDS_COLLECTION } from "./orphan-inbounds";

/** Conv e2e dédiée aux rattachements fixtures. HARDCODED fail-closed. */
export const E2E_CONV_ID = "427963864300_hubspot-list-6081";

/** Clefs idempotence des 4 fixtures — même liste que `seed-e2e-orphans.mjs`. */
export const E2E_IDEMPOTENCY_KEYS = [
  "e2e-orphan-fixture-no-conversation-v1",
  "e2e-orphan-fixture-unknown-contact-v1",
  "e2e-orphan-fixture-parse-failed-v1",
  "e2e-orphan-fixture-enqueue-failed-v1",
] as const;

// ─────────────────────────────────────────────────────────────────────────
// Scan — étape lecture seule : identifie orphans + messages à nettoyer
// ─────────────────────────────────────────────────────────────────────────

export interface TouchedOrphan {
  readonly key: string;
  readonly docId: string;
}

export interface TouchedMessage {
  readonly orphanKey: string;
  readonly messageId: string;
  readonly direction: "inbound" | "outbound";
}

export type ResetScanLogKind =
  | "ABSENT" // doc orphan n'existe pas
  | "REAL_DOC_REFUSED" // isTestFixture !== true (safety)
  | "WRONG_CONV_REFUSED" // attachment.conversationId ≠ E2E_CONV_ID
  | "CROSS_REF_MISMATCH_REFUSED" // message.attachedFromOrphan.orphanId ≠ docId
  | "NO_ATTACHMENT" // orphan en pending ou dismissed — rien à supprimer côté message
  | "MSG_ALREADY_GONE" // attachment.messageId pointe un doc inexistant
  | "OK"; // message rattaché prêt à être supprimé

export interface ResetScanLog {
  readonly kind: ResetScanLogKind;
  readonly key: string;
  readonly detail?: string;
}

export interface ResetScanResult {
  readonly touchedOrphans: readonly TouchedOrphan[];
  readonly touchedMessages: readonly TouchedMessage[];
  readonly refusedCount: number;
  readonly logs: readonly ResetScanLog[];
}

/**
 * Scanne les 4 fixtures. Lecture seule. Chaque orphan refusé incrémente
 * `refusedCount` ; les orphans fixtures sans attachement sont ajoutés
 * à `touchedOrphans` (reset à `pending` + effacement `dismissal` lingering).
 */
export async function scanFixturesForReset(
  db: FirebaseFirestore.Firestore,
  convId: string = E2E_CONV_ID,
  idempotencyKeys: readonly string[] = E2E_IDEMPOTENCY_KEYS,
): Promise<ResetScanResult> {
  const touchedOrphans: TouchedOrphan[] = [];
  const touchedMessages: TouchedMessage[] = [];
  const logs: ResetScanLog[] = [];
  let refusedCount = 0;

  for (const key of idempotencyKeys) {
    const docId = safeExternalIdHash(key);
    const orphanRef = db.collection(ORPHAN_INBOUNDS_COLLECTION).doc(docId);
    const snap = await orphanRef.get();
    if (!snap.exists) {
      logs.push({ kind: "ABSENT", key, detail: docId });
      continue;
    }
    const data = snap.data() ?? {};
    if (data.isTestFixture !== true) {
      logs.push({ kind: "REAL_DOC_REFUSED", key });
      refusedCount++;
      continue;
    }
    touchedOrphans.push({ key, docId });

    const attachment = data.attachment as { conversationId: string; messageId: string } | undefined;
    if (!attachment) {
      logs.push({ kind: "NO_ATTACHMENT", key });
      continue;
    }
    if (attachment.conversationId !== convId) {
      logs.push({
        kind: "WRONG_CONV_REFUSED",
        key,
        detail: `${attachment.conversationId} ≠ ${convId}`,
      });
      refusedCount++;
      continue;
    }

    const msgRef = db
      .collection("conversations")
      .doc(convId)
      .collection("messages")
      .doc(attachment.messageId);
    const msgSnap = await msgRef.get();
    if (!msgSnap.exists) {
      logs.push({ kind: "MSG_ALREADY_GONE", key, detail: attachment.messageId });
      continue;
    }
    const msgData = msgSnap.data() ?? {};
    const linked = (msgData.attachedFromOrphan as { orphanId?: string } | undefined)?.orphanId;
    if (linked !== docId) {
      logs.push({
        kind: "CROSS_REF_MISMATCH_REFUSED",
        key,
        detail: `message.attachedFromOrphan.orphanId=${linked ?? "∅"}`,
      });
      refusedCount++;
      continue;
    }

    const direction: "inbound" | "outbound" =
      msgData.direction === "inbound" ? "inbound" : "outbound";
    touchedMessages.push({ orphanKey: key, messageId: attachment.messageId, direction });
    logs.push({ kind: "OK", key, detail: attachment.messageId });
  }

  return { touchedOrphans, touchedMessages, refusedCount, logs };
}

// ─────────────────────────────────────────────────────────────────────────
// Prédiction — ce que la conv ressemblera après reset (lecture seule)
// ─────────────────────────────────────────────────────────────────────────

export interface ConvSnapshot {
  readonly lastMessageAt: Timestamp | null;
  readonly lastInboundAt: Timestamp | null;
  readonly lastMessagePreview: {
    readonly direction: string;
    readonly authorKind: string;
    readonly text: string;
    readonly at: Timestamp;
  } | null;
  readonly lastHumanOutboundAt: Timestamp | null;
  readonly inboundCount: number | null;
}

export interface ResetPrediction {
  readonly current: ConvSnapshot;
  readonly predicted: ConvSnapshot | null;
  /** `null` si tout va bien, chaîne explicative si la prédiction refuse. */
  readonly abort: string | null;
}

function toSnapshotLike(data: Record<string, unknown>): ConvSnapshot {
  const preview = data.lastMessagePreview as
    | { direction: string; authorKind: string; text: string; at: Timestamp }
    | undefined;
  const num = typeof data.inboundCount === "number" ? data.inboundCount : null;
  return {
    lastMessageAt: data.lastMessageAt instanceof Timestamp ? data.lastMessageAt : null,
    lastInboundAt: data.lastInboundAt instanceof Timestamp ? data.lastInboundAt : null,
    lastMessagePreview: preview ?? null,
    lastHumanOutboundAt:
      data.lastHumanOutboundAt instanceof Timestamp ? data.lastHumanOutboundAt : null,
    inboundCount: num,
  };
}

/**
 * Prédit l'état `(lastMessageAt, lastInboundAt, lastMessagePreview,
 * lastHumanOutboundAt, inboundCount)` de la conv après que les
 * `touched.messageId` auront été supprimés. ZÉRO écriture.
 *
 * Scanne les `touched.length + 5` premiers messages (desc) et filtre
 * ceux à supprimer → marge contre les timestamps identiques. En
 * pratique le reset touche 1 à 4 messages, donc ~10 docs lus max.
 */
export async function predictConvStateAfterReset(
  db: FirebaseFirestore.Firestore,
  convId: string,
  touched: readonly TouchedMessage[],
): Promise<ResetPrediction> {
  const convRef = db.collection("conversations").doc(convId);
  const convSnap = await convRef.get();
  const current = toSnapshotLike(convSnap.data() ?? {});
  const touchedSet = new Set(touched.map((t) => t.messageId));
  const limit = touched.length + 5;

  const topMsgs = await convRef
    .collection("messages")
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  const remainingMsgs = topMsgs.docs.filter((d) => !touchedSet.has(d.id));
  const firstRemaining = remainingMsgs[0];
  const firstData = firstRemaining?.data();

  if (!firstRemaining || !(firstData?.createdAt instanceof Timestamp)) {
    return {
      current,
      predicted: null,
      abort:
        "aucun message restant avec `createdAt: Timestamp` exploitable — " +
        "reset refuserait de reposer `lastMessageAt`, la conv quitterait la liste admin",
    };
  }

  const predictedLastMessageAt = firstData.createdAt;
  const direction = firstData.direction === "outbound" ? "outbound" : "inbound";
  const authorKind =
    direction === "inbound" ? "contact" : firstData.generatedBy === "human" ? "human" : "ai";
  const text = typeof firstData.body === "string" ? firstData.body : "";
  const predictedPreview = buildLastMessagePreview({
    direction,
    authorKind,
    text,
    at: predictedLastMessageAt,
  });

  // Dernier inbound restant.
  const topInbound = await convRef
    .collection("messages")
    .where("direction", "==", "inbound")
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  const remainingInbound = topInbound.docs.filter((d) => !touchedSet.has(d.id));
  const firstInbound = remainingInbound[0]?.data();
  const predictedLastInboundAt =
    firstInbound?.createdAt instanceof Timestamp ? firstInbound.createdAt : null;

  // Dernier outbound humain restant.
  const topHuman = await convRef
    .collection("messages")
    .where("direction", "==", "outbound")
    .where("generatedBy", "==", "human")
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  const remainingHuman = topHuman.docs.filter((d) => !touchedSet.has(d.id));
  const firstHuman = remainingHuman[0]?.data();
  const predictedLastHumanOutboundAt =
    firstHuman?.createdAt instanceof Timestamp ? firstHuman.createdAt : null;

  // inboundCount prédit = count actuel - inbound touché.
  const currentInboundSnap = await convRef
    .collection("messages")
    .where("direction", "==", "inbound")
    .count()
    .get();
  const touchedInboundCount = touched.filter((t) => t.direction === "inbound").length;
  const predictedInboundCount = currentInboundSnap.data().count - touchedInboundCount;

  return {
    current,
    predicted: {
      lastMessageAt: predictedLastMessageAt,
      lastInboundAt: predictedLastInboundAt,
      lastMessagePreview: predictedPreview,
      lastHumanOutboundAt: predictedLastHumanOutboundAt,
      inboundCount: predictedInboundCount,
    },
    abort: null,
  };
}

/**
 * Garde fail-closed PR2c tour 2b bloc C. Throw si `prediction.abort`
 * est posé — le caller NE doit PAS appeler `applyResetWrites`.
 *
 * ⚠ MUTATION SENTINELLE : si on retire ce `throw`, le test unitaire
 * `assertSafeReset lève sur prediction.abort posé` échoue immédiatement
 * (cf. `tests/firestore/reset-full-scenario.test.ts`). Preuve rejouée
 * dans la restitution.
 */
export function assertSafeReset(prediction: ResetPrediction): void {
  if (prediction.abort !== null) {
    throw new Error(`reset refusé : ${prediction.abort}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Écriture — delete messages + reset orphans + recompute conv list fields
// ─────────────────────────────────────────────────────────────────────────

export interface ApplyResetWritesInput {
  readonly db: FirebaseFirestore.Firestore;
  readonly convId: string;
  readonly touchedOrphans: readonly TouchedOrphan[];
  readonly touchedMessages: readonly TouchedMessage[];
}

export interface ApplyResetWritesResult {
  readonly deletedMessageIds: readonly string[];
  readonly resetOrphanKeys: readonly string[];
  /** Clés recomputées par `computeBackfillUpdatesForConversation`. */
  readonly recomputed: readonly string[];
}

/**
 * Applique le reset : TOUT ou RIEN sur l'ordre
 *   delete messages → reset orphans → clear conv fields → recompute.
 *
 * ⚠ Les callers DOIVENT avoir validé la prédiction via `assertSafeReset`
 * AVANT d'appeler cette fonction, sinon la conv peut se retrouver sans
 * `lastMessageAt`.
 */
export async function applyResetWrites(
  input: ApplyResetWritesInput,
): Promise<ApplyResetWritesResult> {
  const { db, convId, touchedOrphans, touchedMessages } = input;

  // 1) Delete messages dérivés.
  const deletedMessageIds: string[] = [];
  for (const { messageId } of touchedMessages) {
    await db.collection("conversations").doc(convId).collection("messages").doc(messageId).delete();
    deletedMessageIds.push(messageId);
  }

  // 2) Reset orphans (processingState → pending, efface attachment/dismissal).
  const resetOrphanKeys: string[] = [];
  for (const { key, docId } of touchedOrphans) {
    await db.collection(ORPHAN_INBOUNDS_COLLECTION).doc(docId).update({
      processingState: "pending",
      attachment: FieldValue.delete(),
      dismissal: FieldValue.delete(),
    });
    resetOrphanKeys.push(key);
  }

  // 3) Recompute conv list fields (seulement si on a touché des messages).
  const recomputed: string[] = [];
  if (touchedMessages.length > 0) {
    const convRef = db.collection("conversations").doc(convId);
    await convRef.update({
      lastMessagePreview: FieldValue.delete(),
      lastMessageAt: FieldValue.delete(),
      lastInboundAt: FieldValue.delete(),
      lastHumanOutboundAt: FieldValue.delete(),
    });
    const remainingInbound = await convRef
      .collection("messages")
      .where("direction", "==", "inbound")
      .count()
      .get();
    await convRef.update({ inboundCount: remainingInbound.data().count });

    const convSnap = await convRef.get();
    const { updates, posed, readErrors } = await computeBackfillUpdatesForConversation(
      convSnap,
      db,
    );
    if (readErrors.length > 0) {
      throw new Error(`reset backfill readErrors: ${readErrors.join(" | ")}`);
    }
    if (Object.keys(updates).length > 0) {
      await convRef.update(updates);
      recomputed.push(...posed);
    }
  }

  return { deletedMessageIds, resetOrphanKeys, recomputed };
}

// ─────────────────────────────────────────────────────────────────────────
// Formatage (display helpers partagés script ↔ test ↔ debug)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Formate un `ConvSnapshot` en une ligne lisible — ISO + preview déjà
 * scrubbée par `sanitizeLastMessageText`. Jamais de PII dans la sortie.
 */
export function formatConvSnapshot(snap: ConvSnapshot | null): string {
  if (snap === null) return "(abort pre-flight)";
  const iso = (t: Timestamp | null): string => (t === null ? "∅" : t.toDate().toISOString());
  const preview =
    snap.lastMessagePreview && typeof snap.lastMessagePreview.text === "string"
      ? sanitizeLastMessageText(snap.lastMessagePreview.text)
      : "∅";
  const inbCount = snap.inboundCount === null ? "∅" : String(snap.inboundCount);
  return (
    `lastMessageAt=${iso(snap.lastMessageAt)} ` +
    `lastInboundAt=${iso(snap.lastInboundAt)} ` +
    `lastHumanOutboundAt=${iso(snap.lastHumanOutboundAt)} ` +
    `inboundCount=${inbCount} ` +
    `preview="${preview.slice(0, 50)}${preview.length > 50 ? "…" : ""}"`
  );
}
