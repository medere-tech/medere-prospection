#!/usr/bin/env node
/**
 * RESET-E2E-ORPHANS — thin CLI wrapper autour de
 * `src/lib/firestore/reset-e2e-orphans-core.ts` (PR2c tour 2b bloc C
 * quater — extraction du core partagé avec le test emulator).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Responsabilités du script
 *
 *   - Parsing CLI (`--apply`).
 *   - Connexion Firebase Admin (dotenv + credentials).
 *   - Affichage des logs du scan + diff conv prédite.
 *   - Codes de sortie (0 OK / 1 refus de pre-flight / 2 env invalide).
 *
 *   TOUTE autre logique (scan, prédiction, garde fail-closed, écriture,
 *   recompute) vit dans `reset-e2e-orphans-core.ts` et est partagée avec
 *   `tests/firestore/reset-full-scenario.test.ts` — zéro duplication.
 *
 * Usage :
 *   npx tsx scripts/reset-e2e-orphans.mjs           # dry-run + diff conv
 *   npx tsx scripts/reset-e2e-orphans.mjs --apply   # applique si safe
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import {
  applyResetWrites,
  assertSafeReset,
  E2E_CONV_ID,
  formatConvSnapshot,
  predictConvStateAfterReset,
  scanFixturesForReset,
} from "../src/lib/firestore/reset-e2e-orphans-core.ts";
import { getFirebaseEnv } from "../src/lib/security/env.ts";

const APPLY = process.argv.includes("--apply");

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

// ─── 1) Scan lecture seule ────────────────────────────────────────────────
const scan = await scanFixturesForReset(db);
for (const log of scan.logs) {
  switch (log.kind) {
    case "ABSENT":
      console.log(`  — ABSENT ${log.key}  (docId=${log.detail ?? "?"})`);
      break;
    case "REAL_DOC_REFUSED":
      console.log(`  ✗ REFUSED ${log.key}  (isTestFixture !== true — DOC RÉEL, refus)`);
      break;
    case "WRONG_CONV_REFUSED":
      console.log(`  ✗ REFUSED ${log.key}  (${log.detail})`);
      break;
    case "CROSS_REF_MISMATCH_REFUSED":
      console.log(`  ✗ REFUSED ${log.key}  (${log.detail})`);
      break;
    case "NO_ATTACHMENT":
      console.log(`  — ${log.key}  (pas d'attachement à nettoyer)`);
      break;
    case "MSG_ALREADY_GONE":
      console.log(`  — ${log.key}  (message ${log.detail ?? "?"} déjà absent)`);
      break;
    case "OK":
      console.log(`  ✓ TOUCH  ${log.key}  (message=${log.detail ?? "?"})`);
      break;
  }
}

console.log("");
console.log(`  Orphans fixtures trouvés : ${scan.touchedOrphans.length}`);
console.log(`  Messages dérivés à supprimer : ${scan.touchedMessages.length}`);
console.log(`  Refus (safety) : ${scan.refusedCount}`);

// ─── 2) Prédiction partagée dry-run / --apply ─────────────────────────────
if (scan.touchedMessages.length > 0) {
  const prediction = await predictConvStateAfterReset(db, E2E_CONV_ID, scan.touchedMessages);
  console.log("");
  console.log(`  ─── Conv ${E2E_CONV_ID} — diff prévue ───`);
  console.log(`    Avant  :  ${formatConvSnapshot(prediction.current)}`);
  console.log(`    Après  :  ${formatConvSnapshot(prediction.predicted)}`);

  try {
    assertSafeReset(prediction);
  } catch (err) {
    console.error("");
    console.error(`✗ Pre-flight refusé : ${err?.message ?? err}`);
    console.error("  Aucune écriture effectuée. La conv resterait dans la liste admin.");
    process.exit(1);
  }
}

if (!APPLY) {
  console.log("");
  console.log("Dry-run terminé — `--apply` pour écrire.");
  process.exit(0);
}

if (scan.refusedCount > 0) {
  console.error("");
  console.error("✗ Refus détecté — abort. Investiguer avant --apply.");
  process.exit(1);
}

// ─── 3) Écriture (TOUT ou RIEN) ───────────────────────────────────────────
try {
  const result = await applyResetWrites({
    db,
    convId: E2E_CONV_ID,
    touchedOrphans: scan.touchedOrphans,
    touchedMessages: scan.touchedMessages,
  });
  for (const mid of result.deletedMessageIds) console.log(`  ✓ DEL message ${mid}`);
  for (const k of result.resetOrphanKeys) console.log(`  ✓ RESET orphan ${k}`);
  if (result.recomputed.length > 0) {
    console.log(`  ✓ RECOMPUTE conv list fields: ${result.recomputed.join(", ")}`);
  } else if (scan.touchedMessages.length > 0) {
    console.log(`  = conv list fields déjà alignés`);
  }
} catch (err) {
  console.error("");
  console.error(`✗ Écriture reset échouée : ${err?.message ?? err}`);
  process.exit(1);
}

console.log("");
console.log("Reset appliqué.");
process.exit(0);
