#!/usr/bin/env node
/**
 * RESET-E2E-ORPHANS (PR2c tour 2a bis) — remet les fixtures orphan e2e
 * en `processingState: "pending"` et nettoie les messages dérivés sur
 * la conversation e2e dédiée.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Discipline de suppression (fail-closed strict)
 *
 *   Scope autorisé :
 *     1. Les 4 docs `inbound_messages_orphans/{oih_...}` dont la clef
 *        d'idempotence correspond à une FIXTURE (liste figée ci-dessous
 *        — mêmes clefs que `seed-e2e-orphans.mjs`).
 *     2. Les docs `conversations/{E2E_CONV_ID}/messages/{msgId}` dont
 *        `attachedFromOrphan.orphanId` pointe vers une de ces fixtures,
 *        ET dont le message existe EFFECTIVEMENT sur la conv e2e.
 *
 *   REFUS :
 *     - Toute conv autre que `E2E_CONV_ID`.
 *     - Tout orphan dont `isTestFixture !== true`.
 *     - Tout message dont `attachedFromOrphan.orphanId` ne match pas une
 *       fixture connue.
 *
 *   Les orphans eux-mêmes NE SONT JAMAIS SUPPRIMÉS (invariant append-only
 *   `inbound_messages_orphans/`). On ramène `processingState: "pending"`
 *   et on efface `attachment`/`dismissal`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Recomputation des champs de liste de la conv
 *
 *   Après delete des messages fixtures, on efface les champs
 *   `lastMessagePreview`, `lastMessageAt`, `lastInboundAt` + on
 *   RE-CALCULE `inboundCount` depuis les messages restants, puis on
 *   appelle `computeBackfillUpdatesForConversation` (fonction unique du
 *   projet) pour que `lastMessagePreview`/`lastMessageAt` reflètent le
 *   dernier message RESTANT (celui d'avant les attachements e2e).
 *
 * Usage :
 *   npx tsx scripts/reset-e2e-orphans.mjs           # dry-run
 *   npx tsx scripts/reset-e2e-orphans.mjs --apply   # applique
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

import { computeBackfillUpdatesForConversation } from "../src/lib/firestore/backfill-conversation-list-fields.ts";
import { ORPHAN_INBOUNDS_COLLECTION } from "../src/lib/firestore/orphan-inbounds.ts";
import { getFirebaseEnv } from "../src/lib/security/env.ts";
import { safeExternalIdHash } from "../src/lib/utils/pii-detector.ts";

const APPLY = process.argv.includes("--apply");

/** Conv e2e dédiée aux rattachements fixtures. HARDCODED fail-closed. */
const E2E_CONV_ID = "427963864300_hubspot-list-6081";

/** Clefs des fixtures — même liste que `seed-e2e-orphans.mjs`. */
const IDEMPOTENCY_KEYS = [
  "e2e-orphan-fixture-no-conversation-v1",
  "e2e-orphan-fixture-unknown-contact-v1",
  "e2e-orphan-fixture-parse-failed-v1",
  "e2e-orphan-fixture-enqueue-failed-v1",
];

let env;
try {
  env = getFirebaseEnv();
} catch (err) {
  console.error("Env Firebase invalide :", err?.message ?? err);
  process.exit(2);
}

if (getApps().length === 0) {
  initializeApp({
    credential: cert({
      projectId: env.FIREBASE_PROJECT_ID,
      clientEmail: env.FIREBASE_CLIENT_EMAIL,
      privateKey: env.FIREBASE_PRIVATE_KEY,
    }),
  });
}
const db = getFirestore();

console.log("");
console.log("─".repeat(72));
console.log(`RESET-E2E-ORPHANS — ${APPLY ? "APPLY" : "DRY-RUN"}`);
console.log(`  Conv ciblée : ${E2E_CONV_ID}`);
console.log("─".repeat(72));

// ─── 1) Pré-calcul des docIds fixtures ────────────────────────────────────
const fixtureOrphanDocIds = IDEMPOTENCY_KEYS.map((k) => ({
  key: k,
  docId: safeExternalIdHash(k),
}));

// ─── 2) Lecture des orphans et des messages dérivés ───────────────────────
const touchedMessageIds = [];
const touchedOrphanIds = [];
let refusedCount = 0;

for (const { key, docId } of fixtureOrphanDocIds) {
  const orphanRef = db.collection(ORPHAN_INBOUNDS_COLLECTION).doc(docId);
  const snap = await orphanRef.get();

  if (!snap.exists) {
    console.log(`  — ABSENT ${key}  (docId=${docId})`);
    continue;
  }
  const data = snap.data();
  if (data.isTestFixture !== true) {
    console.log(`  ✗ REFUSED ${key}  (isTestFixture !== true — DOC RÉEL, refus)`);
    refusedCount++;
    continue;
  }
  touchedOrphanIds.push({ key, docId });

  const attachment = data.attachment;
  if (!attachment) {
    console.log(`  — ${key}  (pas d'attachement à nettoyer)`);
    continue;
  }
  if (attachment.conversationId !== E2E_CONV_ID) {
    console.log(
      `  ✗ REFUSED ${key}  (attachement vers ${attachment.conversationId} ≠ ${E2E_CONV_ID})`,
    );
    refusedCount++;
    continue;
  }

  // Vérif cross-ref : le message doit effectivement référencer cet orphan.
  const msgRef = db
    .collection("conversations")
    .doc(E2E_CONV_ID)
    .collection("messages")
    .doc(attachment.messageId);
  const msgSnap = await msgRef.get();
  if (!msgSnap.exists) {
    console.log(`  — ${key}  (message ${attachment.messageId} déjà absent)`);
    continue;
  }
  const msgData = msgSnap.data();
  const linked = msgData?.attachedFromOrphan?.orphanId;
  if (linked !== docId) {
    console.log(
      `  ✗ REFUSED ${key}  (message ${attachment.messageId}.attachedFromOrphan.orphanId=${linked} ≠ ${docId})`,
    );
    refusedCount++;
    continue;
  }
  touchedMessageIds.push({ orphanKey: key, messageId: attachment.messageId });
}

console.log("");
console.log(`  Orphans fixtures trouvés : ${touchedOrphanIds.length}`);
console.log(`  Messages dérivés à supprimer : ${touchedMessageIds.length}`);
console.log(`  Refus (safety) : ${refusedCount}`);

if (!APPLY) {
  console.log("");
  console.log("Dry-run terminé — `--apply` pour écrire.");
  process.exit(0);
}

if (refusedCount > 0) {
  console.error("");
  console.error("✗ Refus détecté — abort. Investiguer avant --apply.");
  process.exit(1);
}

// ─── 3) Delete messages dérivés + reset orphans ───────────────────────────
for (const { messageId } of touchedMessageIds) {
  await db
    .collection("conversations")
    .doc(E2E_CONV_ID)
    .collection("messages")
    .doc(messageId)
    .delete();
  console.log(`  ✓ DEL message ${messageId}`);
}

for (const { key, docId } of touchedOrphanIds) {
  await db.collection(ORPHAN_INBOUNDS_COLLECTION).doc(docId).update({
    processingState: "pending",
    attachment: FieldValue.delete(),
    dismissal: FieldValue.delete(),
  });
  console.log(`  ✓ RESET orphan ${key}`);
}

// ─── 4) Recompute conv list fields via la fonction unique ─────────────────
if (touchedMessageIds.length > 0) {
  const convRef = db.collection("conversations").doc(E2E_CONV_ID);

  // Clear les champs preview + timestamps pour que `computeBackfillUpdatesForConversation`
  // les re-pose depuis le dernier message RESTANT (son code `if (!conv.lastMessagePreview)`
  // n'écrit que lorsqu'absent → clear d'abord, re-pose ensuite).
  await convRef.update({
    lastMessagePreview: FieldValue.delete(),
    lastMessageAt: FieldValue.delete(),
    lastInboundAt: FieldValue.delete(),
    lastHumanOutboundAt: FieldValue.delete(),
  });

  // Recompute inboundCount depuis les messages restants (le backfill ne
  // gère pas les compteurs — delta explicite).
  const remainingInbound = await convRef
    .collection("messages")
    .where("direction", "==", "inbound")
    .count()
    .get();
  await convRef.update({
    inboundCount: remainingInbound.data().count,
  });

  // Backfill des champs lastMessagePreview + lastHumanOutboundAt + denorm contact.
  const convSnap = await convRef.get();
  const { updates, posed, readErrors } = await computeBackfillUpdatesForConversation(convSnap, db);
  if (readErrors.length > 0) {
    console.error(`  ✗ Backfill read errors: ${readErrors.join(" | ")}`);
    process.exit(1);
  }
  if (Object.keys(updates).length > 0) {
    await convRef.update(updates);
    console.log(`  ✓ RECOMPUTE conv list fields: ${posed.join(", ")}`);
  } else {
    console.log(`  = conv list fields déjà alignés`);
  }
}

console.log("");
console.log("Reset appliqué.");
process.exit(0);
