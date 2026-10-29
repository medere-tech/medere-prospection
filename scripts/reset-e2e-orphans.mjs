#!/usr/bin/env node
/**
 * RESET-E2E-ORPHANS (PR2c tour 2a bis + bloc C fail-closed) — remet les
 * fixtures orphan e2e en `processingState: "pending"` et nettoie les
 * messages dérivés sur la conversation e2e dédiée.
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
 * Pre-flight fail-closed PR2c bloc C
 *
 *   AVANT TOUTE ÉCRITURE (dry-run comme --apply), on calcule l'état
 *   PRÉDIT de la conv après reset :
 *     - `lastMessageAt`      : createdAt du 1er message restant (desc).
 *     - `lastInboundAt`      : createdAt du 1er inbound restant (desc).
 *     - `lastMessagePreview` : preview buildée depuis ce message, SCRUBBE
 *                              numéros/emails via `sanitizeLastMessageText`
 *                              (point d'entrée unique PII, cf. helper).
 *     - `lastHumanOutboundAt`: createdAt du 1er outbound humain restant.
 *     - `inboundCount`       : current count - touched inbound count.
 *
 *   Si AUCUN message avec `createdAt: Timestamp` ne reste après filtre,
 *   on ABORT avant tout write — la conv serait sinon sans
 *   `lastMessageAt`, donc hors de la liste admin (orderBy desc).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Recomputation des champs de liste de la conv
 *
 *   Après delete des messages fixtures, on efface les 4 champs d'état
 *   (`lastMessagePreview`, `lastMessageAt`, `lastInboundAt`,
 *   `lastHumanOutboundAt`) + on RE-CALCULE `inboundCount` depuis les
 *   messages restants, puis on appelle `computeBackfillUpdatesForConversation`
 *   (fonction unique du projet) qui, depuis le fix PR2c bloc C, repose
 *   AUSSI `lastMessageAt` et `lastInboundAt` quand absents.
 *
 * Usage :
 *   npx tsx scripts/reset-e2e-orphans.mjs           # dry-run (affiche
 *                                                     la diff conv complète)
 *   npx tsx scripts/reset-e2e-orphans.mjs --apply   # applique après
 *                                                     pre-flight OK
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";

import { computeBackfillUpdatesForConversation } from "../src/lib/firestore/backfill-conversation-list-fields.ts";
import {
  buildLastMessagePreview,
  sanitizeLastMessageText,
} from "../src/lib/firestore/conversation-list-fields.ts";
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
  // Capture `direction` du message touché pour prédire `inboundCount`
  // AVANT la suppression (sans quoi la soustraction ferait une query
  // supplémentaire inutile).
  const direction = msgData?.direction === "inbound" ? "inbound" : "outbound";
  touchedMessageIds.push({
    orphanKey: key,
    messageId: attachment.messageId,
    direction,
  });
}

console.log("");
console.log(`  Orphans fixtures trouvés : ${touchedOrphanIds.length}`);
console.log(`  Messages dérivés à supprimer : ${touchedMessageIds.length}`);
console.log(`  Refus (safety) : ${refusedCount}`);

// ─── Pre-flight PR2c bloc C — prédit l'état post-reset de la conv, abort
// avant TOUT WRITE si le dernier message restant n'a pas de `createdAt`
// exploitable. Partagé entre dry-run (affichage) et --apply (gate).
let prediction = null;
if (touchedMessageIds.length > 0) {
  prediction = await predictConvStateAfterReset(db, E2E_CONV_ID, touchedMessageIds);
  console.log("");
  console.log(`  ─── Conv ${E2E_CONV_ID} — diff prévue ───`);
  console.log(`    Avant  :  ${formatConvSnapshot(prediction.current)}`);
  console.log(`    Après  :  ${formatConvSnapshot(prediction.predicted)}`);
  if (prediction.abort) {
    console.error("");
    console.error(`✗ Pre-flight refusé : ${prediction.abort}`);
    console.error("  Aucune écriture effectuée. La conv resterait dans la liste admin.");
    process.exit(1);
  }
}

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

  // Backfill repose les 4 champs d'état depuis le dernier message
  // restant + le dernier inbound + le dernier outbound humain + les
  // champs contact (PR2c bloc C — ajout `lastMessageAt` + `lastInboundAt`).
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

// ─────────────────────────────────────────────────────────────────────────
// Helpers de prédiction PR2c bloc C — un seul endroit, pas d'écriture.
// Hoisted (déclarations `function`) → utilisables depuis le top-level.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Prédit l'état `(lastMessageAt, lastInboundAt, lastMessagePreview,
 * lastHumanOutboundAt, inboundCount)` de la conv après que les
 * `touched.messageId` ont été supprimés. ZÉRO écriture. Fail-closed :
 * si aucun message avec `createdAt: Timestamp` ne reste, pose `abort`.
 *
 * On lit N+5 messages par ordre decroissant pour avoir une marge
 * confortable face à des timestamps identiques — en pratique le reset
 * touche 1 à 4 messages, donc on scanne ~10 docs max.
 */
async function predictConvStateAfterReset(db, convId, touched) {
  const convRef = db.collection("conversations").doc(convId);
  const convSnap = await convRef.get();
  const convData = convSnap.data() ?? {};
  const touchedSet = new Set(touched.map((t) => t.messageId));

  // Snapshot "avant" lu depuis le doc actuel — ces champs seront
  // affichés dans la diff et comparés par le test strict.
  const current = {
    lastMessageAt: convData.lastMessageAt ?? null,
    lastInboundAt: convData.lastInboundAt ?? null,
    lastMessagePreview: convData.lastMessagePreview ?? null,
    lastHumanOutboundAt: convData.lastHumanOutboundAt ?? null,
    inboundCount: typeof convData.inboundCount === "number" ? convData.inboundCount : null,
  };

  const limit = touched.length + 5;

  // Dernier message restant (desc) → lastMessageAt + preview.
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
  const predictedPreview = buildPreviewFromMsg(firstData);

  // Dernier inbound restant (desc).
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

  // inboundCount prédit = count actuel - touched inbound count.
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
 * Construit un preview `{direction, authorKind, text, at}` depuis un
 * doc message — réutilise la fonction UNIQUE `buildLastMessagePreview`
 * dont `sanitizeLastMessageText` scrubbe numéros/emails.
 */
function buildPreviewFromMsg(m) {
  const direction = m.direction === "outbound" ? "outbound" : "inbound";
  const authorKind =
    direction === "inbound" ? "contact" : m.generatedBy === "human" ? "human" : "ai";
  const text = typeof m.body === "string" ? m.body : "";
  return buildLastMessagePreview({
    direction,
    authorKind,
    text,
    at: m.createdAt instanceof Timestamp ? m.createdAt : Timestamp.now(),
  });
}

/**
 * Formate un snapshot `{lastMessageAt, lastInboundAt, lastMessagePreview,
 * lastHumanOutboundAt, inboundCount}` en une ligne — timestamps en ISO,
 * preview déjà scrubbée par `sanitizeLastMessageText`.
 */
function formatConvSnapshot(snap) {
  if (snap === null) return "(abort pre-flight)";
  const iso = (t) => (t instanceof Timestamp ? t.toDate().toISOString() : "∅");
  // Scrub défensif supplémentaire du texte preview : garantit zéro
  // numéro FR / email dans la sortie console même si le doc actuel
  // porte un preview antérieur au scrub (data historique).
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
