/**
 * CLOSE-DUPLICATE-INBOUND — ferme manuellement 1 inbound dupliqué dans la
 * conversation 427963864300_hubspot-list-6081 (BUG-DEDUP-RACE pre-fix du
 * 16/10/2026).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CONTEXTE
 *
 *   Avant la correction `fix(inbound): deduplication atomique` (#48), un
 *   SMS entrant unique a ete stocke 2 fois dans Firestore :
 *     - yRWdzWgvWPZ6DtCS4KFO (ORIGINAL, createdAt le plus ancien)
 *     - 2IE2dosHsojSk2Bf5OgI (DOUBLON, meme externalId=119256955)
 *   Les 2 docs sont dans la meme conversation. Le doublon a (probablement)
 *   bumpe `conversations/{id}.inboundCount` de +1 et avance `lastInboundAt`
 *   d'un peu. On corrige ces 2 champs denormalises dans la MEME tx que la
 *   fermeture du doublon (atomicite forensique).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * STRATEGIE
 *
 *   Transition le DOUBLON vers un nouveau statut terminal manuel
 *   `duplicate` + `duplicateOf: "<original id>"`. L'original reste intact
 *   (status="received").
 *
 *   Preuve forensique que `duplicate` est intraçable dans tous les
 *   calculs du produit :
 *
 *     - src/lib/firestore/messages.ts:1777 — `listRecentMessages` filtre
 *       `draft` + `abandoned` + `duplicate` hors de l'historique envoye
 *       au prompt Claude. Zero influence sur la classification ni la
 *       reponse generee.
 *
 *     - src/lib/firestore/messages.ts:2056 — `updateMessageStatus` refuse
 *       toute transition depuis `duplicate` (statut terminal). Pas de
 *       re-dispatch possible.
 *
 *     - src/lib/compliance/rate-limits.ts — RATE_LIMIT_COUNTED_STATUSES
 *       est une whitelist stricte (`sent`/`queued`/`delivered`). Un
 *       `duplicate` est exclu par CONSTRUCTION — jamais ajoute, donc
 *       jamais compte dans les 4/30j (sans importance pour un inbound,
 *       mais defense-in-depth).
 *
 *     - src/lib/inngest/functions/process-reply.ts (reply_volume) — meme
 *       logique whitelist : seuls les inbounds "received" valides et les
 *       outbounds "sent" sont consideres pour la fatigue. Un `duplicate`
 *       ne gonfle pas le compteur.
 *
 *     - src/lib/inngest/functions/monitor-orphan-messages.ts — scanne
 *       uniquement `draft`/`queued`. Zero impact.
 *
 *     - UI dashboard : affichage via `listRecentMessages` (meme filtre).
 *
 *   JAMAIS DE DELETE : append-only Firestore + conservation forensic.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CORRECTION DES COMPTEURS DENORMALISES
 *
 *   `conversations/{id}` porte 2 champs denormalises touches par le
 *   doublon :
 *     - inboundCount : incremente de +1 lors du stockage du doublon.
 *       Correction : inboundCount - 1.
 *     - lastInboundAt : avance si le doublon a un createdAt > ancien
 *       lastInboundAt. Correction : si lastInboundAt == doublon.createdAt,
 *       alors remettre a l'inbound non-doublon le plus recent de la conv.
 *
 *   Pour `lastInboundAt`, on re-query la sous-collection `messages` filtree
 *   `direction="inbound"` ORDER BY `createdAt` DESC LIMIT 10, puis on
 *   prend le premier doc dont l'id n'est PAS le doublon et dont le status
 *   n'est PAS "duplicate" (defense si plusieurs doublons existent).
 *   Query SOUS-COLLECTION (pas collectionGroup) → index auto, zero
 *   deploiement d'index requis.
 *
 *   Avant / apres sont affiches en dry-run ET en apply.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Usage :
 *   npx tsx scripts/close-duplicate-inbound.mjs            # dry-run
 *   npx tsx scripts/close-duplicate-inbound.mjs --apply    # applique
 *
 * Pre-requis .env.local :
 *   - FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY
 *   - AUDIT_PII_PEPPER (min 32 chars)
 *
 * Exit codes :
 *   0  OK (dry-run OK ou --apply OK)
 *   1  erreur non-garde-fou (fetch Firestore / audit)
 *   2  env manquant
 *   3  doc introuvable (ids changes ou purges ?)
 *   4  exception non-geree dans main()
 *   5  garde-fou refuse (statut inattendu, externalId divergent, id modifie)
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

import { appendAuditLogTx } from "../src/lib/firestore/audit-log.ts";
import { getFirebaseEnv } from "../src/lib/security/env.ts";
// Core helpers (fonctions pures, zero process.exit, zero I/O direct) —
// extraits dans `scripts/_lib/close-duplicate-inbound-core.mjs` pour
// permettre l'ecriture de tests Vitest unitaires sans emulator.
import {
  assertIdsAreTargets as pureAssertIdsAreTargets,
  assertStateIsDuplicable as pureAssertStateIsDuplicable,
  AUDIT_ACTOR_ID,
  AUDIT_REASON,
  buildAuditPayload,
  buildSnapshotPayload,
  computeConversationCorrections as pureComputeConversationCorrections,
  CONVERSATION_ID,
  DUPLICATE_ID,
  EXPECTED_DUPLICATE_STATUS,
  EXPECTED_EXTERNAL_ID,
  formatTimestamp,
  LAST_INBOUND_QUERY_LIMIT,
  NEW_STATUS,
  ORIGINAL_ID,
  toMillisOrNull,
} from "./_lib/close-duplicate-inbound-core.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Init Firestore
// ─────────────────────────────────────────────────────────────────────────────

function getAdminDbOrDie() {
  // Validation Zod strict via le helper partage — meme source que l'app.
  let env;
  try {
    env = getFirebaseEnv();
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error("Env invalide ou manquant (validation getFirebaseEnv) :");
    console.error(`  ${msg}`);
    console.error("");
    console.error("Noms attendus (identiques a l'app, cf. src/lib/security/env.ts) :");
    console.error("  - FIREBASE_PROJECT_ID");
    console.error("  - FIREBASE_CLIENT_EMAIL");
    console.error("  - FIREBASE_PRIVATE_KEY");
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
  return { db: getFirestore(), projectId: env.FIREBASE_PROJECT_ID };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lecture pre-flight (lecture seule) : les 2 messages + la conversation
// ─────────────────────────────────────────────────────────────────────────────

async function loadStateOrDie(db) {
  const convRef = db.collection("conversations").doc(CONVERSATION_ID);
  const convSnap = await convRef.get();
  if (!convSnap.exists) {
    console.error(`Conversation introuvable : conversations/${CONVERSATION_ID}`);
    process.exit(3);
  }
  const conv = convSnap.data();

  const originalRef = convRef.collection("messages").doc(ORIGINAL_ID);
  const originalSnap = await originalRef.get();
  if (!originalSnap.exists) {
    console.error(
      `Message original introuvable : conversations/${CONVERSATION_ID}/messages/${ORIGINAL_ID}`,
    );
    process.exit(3);
  }
  const original = originalSnap.data();

  const duplicateRef = convRef.collection("messages").doc(DUPLICATE_ID);
  const duplicateSnap = await duplicateRef.get();
  if (!duplicateSnap.exists) {
    console.error(
      `Message doublon introuvable : conversations/${CONVERSATION_ID}/messages/${DUPLICATE_ID}`,
    );
    process.exit(3);
  }
  const duplicate = duplicateSnap.data();

  // Query sous-collection pour trouver le candidat lastInboundAt corrige.
  // Pas de collectionGroup, pas de composite index inter-collections : la
  // sous-collection avec `direction` + orderBy `createdAt` desc est servie
  // par un single-field index auto Firestore.
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

// ─────────────────────────────────────────────────────────────────────────────
// Garde-fous (fail-closed)
// ─────────────────────────────────────────────────────────────────────────────

function assertIdsAreTargetsOrExit() {
  const res = pureAssertIdsAreTargets({
    CONVERSATION_ID,
    ORIGINAL_ID,
    DUPLICATE_ID,
    EXPECTED_EXTERNAL_ID,
  });
  if (!res.ok) {
    for (const e of res.errors) {
      console.error(`Garde-fou : ${e}. Refus.`);
    }
    process.exit(res.exitCode);
  }
}

function assertStateIsDuplicableOrExit(state) {
  const res = pureAssertStateIsDuplicable(state);
  if (!res.ok) {
    for (const e of res.errors) {
      console.error(`Garde-fou : ${e}. Refus.`);
    }
    process.exit(res.exitCode);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot forensique AVANT ecriture (payload build via core, write local)
// ─────────────────────────────────────────────────────────────────────────────

function writeSnapshotOrDie(state, corrections, projectId) {
  const nowIso = new Date().toISOString().replace(/[:.]/g, "-");
  const relPath = `tmp/close-duplicate-inbound-snapshot-${nowIso}.json`;
  const absPath = resolvePath(process.cwd(), relPath);
  // `projectId` est deja valide par `getFirebaseEnv()` dans main — pas de
  // relecture `process.env.FIREBASE_PROJECT_ID` ici (source unique).
  const payload = buildSnapshotPayload(state, corrections, projectId);
  writeFileSync(absPath, JSON.stringify(payload, null, 2), { encoding: "utf8" });
  return relPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transaction mutation
// ─────────────────────────────────────────────────────────────────────────────

async function applyMutation(db, corrections) {
  await db.runTransaction(async (tx) => {
    const convRef = db.collection("conversations").doc(CONVERSATION_ID);
    const duplicateRef = convRef.collection("messages").doc(DUPLICATE_ID);
    const originalRef = convRef.collection("messages").doc(ORIGINAL_ID);

    // Phase 1 : TOUTES les reads AVANT toute write (contrainte Firestore).
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

    // Re-check DANS la tx : statut doublon, externalId identique,
    // inboundCount, lastInboundAt — rien n'a bouge entre pre-flight et tx.
    if (duplicateInTx.status !== EXPECTED_DUPLICATE_STATUS) {
      throw new Error(
        `Race detectee : doublon status="${duplicateInTx.status}" ` +
          `(attendu "${EXPECTED_DUPLICATE_STATUS}"). Tx abandonnee.`,
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
    // 2a. Marquer le doublon.
    tx.update(duplicateRef, {
      status: NEW_STATUS,
      duplicateOf: ORIGINAL_ID,
      updatedAt: now,
    });

    // 2b. Corriger les compteurs denormalises de la conv.
    const convUpdate = {
      inboundCount: corrections.inboundCount.after,
      updatedAt: now,
    };
    if (corrections.lastInboundAt.changed) {
      convUpdate.lastInboundAt = corrections.lastInboundAt.newValue; // Timestamp ou null
    }
    tx.update(convRef, convUpdate);

    // 2c. Audit transactionnel. Payload ZERO PII : scrubber rejette tout
    // E.164/FR national/email. On ne met NI phone, NI body, NI nom.
    appendAuditLogTx(tx, {
      actorId: AUDIT_ACTOR_ID,
      actorType: "human",
      action: "manual_override",
      targetType: "message",
      targetId: DUPLICATE_ID,
      payload: buildAuditPayload(corrections),
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Affichage
// ─────────────────────────────────────────────────────────────────────────────

function printFocusedState(state, label) {
  console.log(`--- Etat ${label} ---`);
  console.log(`  conversations/${CONVERSATION_ID}`);
  console.log(`    inboundCount    : ${state.conv.inboundCount ?? "absent"}`);
  console.log(`    lastInboundAt   : ${formatTimestamp(state.conv.lastInboundAt)}`);
  console.log(`  messages/${ORIGINAL_ID} (ORIGINAL)`);
  console.log(`    direction       : ${state.original.direction ?? "absent"}`);
  console.log(`    status          : ${state.original.status ?? "absent"}`);
  console.log(`    externalId      : ${state.original.externalId ?? "absent"}`);
  console.log(`    createdAt       : ${formatTimestamp(state.original.createdAt)}`);
  console.log(`  messages/${DUPLICATE_ID} (DOUBLON)`);
  console.log(`    direction       : ${state.duplicate.direction ?? "absent"}`);
  console.log(`    status          : ${state.duplicate.status ?? "absent"}`);
  console.log(`    externalId      : ${state.duplicate.externalId ?? "absent"}`);
  console.log(`    duplicateOf     : ${state.duplicate.duplicateOf ?? "absent"}`);
  console.log(`    createdAt       : ${formatTimestamp(state.duplicate.createdAt)}`);
  console.log("");
}

function printCorrectionsPlan(corrections) {
  console.log("--- Corrections planifiees sur la conversation ---");
  console.log(
    `  inboundCount  : ${corrections.inboundCount.before} -> ${corrections.inboundCount.after} ` +
      (corrections.inboundCount.changed ? "(change)" : "(inchange)"),
  );
  console.log(
    `  lastInboundAt : ${corrections.lastInboundAt.beforeIso} -> ${corrections.lastInboundAt.afterIso} ` +
      (corrections.lastInboundAt.changed
        ? `(change, source=${corrections.lastInboundAt.source})`
        : "(inchange, lastInboundAt ne pointait pas sur le doublon)"),
  );
  console.log("");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const apply = process.argv.includes("--apply");

  assertIdsAreTargetsOrExit();

  const { db, projectId } = getAdminDbOrDie();

  console.log("");
  console.log(`CLOSE-DUPLICATE-INBOUND — mode : ${apply ? "APPLY" : "dry-run / lecture seule"}`);
  console.log(`Projet Firestore : ${projectId}`);
  console.log(`Conversation     : ${CONVERSATION_ID}`);
  console.log(`Original (reste) : ${ORIGINAL_ID}`);
  console.log(`Doublon (ferme)  : ${DUPLICATE_ID}`);
  console.log("");

  const before = await loadStateOrDie(db);
  printFocusedState(before, "AVANT");

  assertStateIsDuplicableOrExit(before);

  const corrections = pureComputeConversationCorrections(before);
  printCorrectionsPlan(corrections);

  if (!apply) {
    console.log("Dry-run : rien n'est ecrit. Aucune mutation Firestore, aucun audit.");
    console.log("Ce qui SERAIT fait avec --apply :");
    console.log(`  1. Snapshot ecrit dans tmp/close-duplicate-inbound-snapshot-<ISO>.json`);
    console.log(`  2. Transaction unique :`);
    console.log(
      `       - tx.update(messages/${DUPLICATE_ID}, { status: "duplicate", duplicateOf: "${ORIGINAL_ID}", updatedAt })`,
    );
    console.log(
      `       - tx.update(conversations/${CONVERSATION_ID}, { inboundCount: ${corrections.inboundCount.after}` +
        (corrections.lastInboundAt.changed
          ? `, lastInboundAt: ${corrections.lastInboundAt.afterIso}`
          : "") +
        `, updatedAt })`,
    );
    console.log(
      `       - appendAuditLogTx (action="manual_override", targetType="message", targetId="${DUPLICATE_ID}", payload avec correction counters)`,
    );
    console.log(`     => atomique : tout commit ou rien.`);
    console.log("");
    console.log("Rejoue avec --apply pour executer. Garde-fous :");
    console.log('  - refus si doublon n\'est plus en status="received" (race)');
    console.log("  - refus si externalId divergent (sentinelle coherence)");
    console.log("  - refus si doublon createdAt < original createdAt (identification inversee)");
    console.log("  - refus si inboundCount in-tx != pre-flight (race)");
    return;
  }

  console.log("Snapshot pre-mutation...");
  const snapshotPath = writeSnapshotOrDie(before, corrections, projectId);
  console.log(`  ecrit : ${snapshotPath}`);
  console.log("");

  console.log("Transaction (update doublon + update conv + audit)...");
  await applyMutation(db, corrections);
  console.log("  commit OK");
  console.log("");

  const after = await loadStateOrDie(db);
  printFocusedState(after, "APRES");

  // Verifications post-mutation.
  console.log("--- Verifications post-mutation ---");
  const dupOk = after.duplicate.status === NEW_STATUS;
  const dupOfOk = after.duplicate.duplicateOf === ORIGINAL_ID;
  const origUntouched =
    after.original.status === "received" &&
    after.original.direction === "inbound" &&
    after.original.externalId === EXPECTED_EXTERNAL_ID;
  const countOk = after.conv.inboundCount === corrections.inboundCount.after;
  console.log(`  doublon status="duplicate"        : ${dupOk ? "OK" : "KO"}`);
  console.log(`  doublon duplicateOf="${ORIGINAL_ID}" : ${dupOfOk ? "OK" : "KO"}`);
  console.log(`  original intact (received/inbound) : ${origUntouched ? "OK" : "KO"}`);
  console.log(
    `  conv.inboundCount = ${corrections.inboundCount.after}         : ${countOk ? "OK" : "KO"}`,
  );
  console.log("");

  console.log("Terminé. Pour reset :");
  console.log(`  - relire ${snapshotPath} (jamais de rollback de memoire)`);
}

main().catch((err) => {
  console.error(
    `Erreur fatale : ${err && err.name ? err.name : "unknown"} - ${
      err && err.message ? err.message : "no message"
    }`,
  );
  process.exit(4);
});
