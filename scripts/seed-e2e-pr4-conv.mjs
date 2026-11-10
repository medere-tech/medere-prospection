#!/usr/bin/env node
/**
 * SEED-E2E-PR4-CONV — thin CLI wrapper autour de
 * `src/lib/firestore/seed-reset-e2e-pr4-core.ts`. Zero logique métier
 * ici — tout vit dans le core testé.
 *
 * Usage :
 *   npx tsx scripts/seed-e2e-pr4-conv.mjs                    # dry-run
 *   npx tsx scripts/seed-e2e-pr4-conv.mjs --apply <projectId>  # ecrit si projectId OK
 *
 * `--apply` DOIT recevoir le `projectId` cible — défense contre un
 * `--apply` lance par erreur sur la mauvaise base.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import { E2E_CONV_ID_PR4 } from "../src/lib/conversations/e2e-conversation-ids.ts";
import {
  applySeed,
  assertProjectIdMatches,
  describeSeedDecision,
  describeSeedResult,
  E2E_PR4_CAMPAIGN_ID,
  E2E_PR4_CONTACT_ID,
  E2E_PR4_HANDOFF_ASSIGNED_TO,
  scanSeed,
} from "../src/lib/firestore/seed-reset-e2e-pr4-core.ts";
import { getFirebaseEnv } from "../src/lib/security/env.ts";

const APPLY_INDEX = process.argv.indexOf("--apply");
const APPLY = APPLY_INDEX !== -1;
const APPLY_PROJECT_ID = APPLY ? process.argv[APPLY_INDEX + 1] : undefined;

let env;
try {
  env = getFirebaseEnv();
} catch (err) {
  console.error("Env Firebase invalide :", err?.message ?? err);
  process.exit(2);
}

if (APPLY) {
  if (!APPLY_PROJECT_ID) {
    console.error("--apply doit être suivi du projectId exact. Ex: --apply medere-test");
    process.exit(2);
  }
  try {
    assertProjectIdMatches(env.FIREBASE_PROJECT_ID, APPLY_PROJECT_ID);
  } catch (err) {
    console.error(`Projet refusé : ${err?.message ?? err}`);
    process.exit(2);
  }
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
console.log(`SEED-E2E-PR4-CONV — ${APPLY ? "APPLY" : "DRY-RUN"}`);
console.log(`  Conv ciblée      : ${E2E_CONV_ID_PR4}`);
console.log(`  contactId        : ${E2E_PR4_CONTACT_ID}`);
console.log(`  campaignId       : ${E2E_PR4_CAMPAIGN_ID}`);
console.log(`  handoff.assigned : ${E2E_PR4_HANDOFF_ASSIGNED_TO}`);
console.log(`  projectId        : ${env.FIREBASE_PROJECT_ID}`);
console.log("─".repeat(72));

try {
  const decision = await scanSeed(db);
  const scanOut = describeSeedDecision(decision);
  for (const line of scanOut.lines) console.log(line);

  if (!APPLY) {
    console.log("");
    if (scanOut.exitCode === 0) {
      console.log("DRY-RUN terminé. Relancer avec `--apply <projectId>` pour écrire.");
    }
    process.exit(scanOut.exitCode);
  }

  // Si le scan a détecté un doc existant incomplet, on ne tente PAS
  // d'apply : la décision sort en 1, l'opérateur doit corriger la base.
  if (scanOut.exitCode === 1) process.exit(1);

  const result = await applySeed(db);
  const applyOut = describeSeedResult(result);
  for (const line of applyOut.lines) console.log(line);
  process.exit(applyOut.exitCode);
} catch (err) {
  console.error(`Échec : ${err?.message ?? err}`);
  process.exit(1);
}
