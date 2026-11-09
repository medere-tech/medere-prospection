#!/usr/bin/env node
/**
 * RESET-E2E-PR4-CONV — thin CLI wrapper autour de
 * `src/lib/firestore/seed-reset-e2e-pr4-core.ts`.
 *
 * Usage :
 *   npx tsx scripts/reset-e2e-pr4-conv.mjs                    # dry-run
 *   npx tsx scripts/reset-e2e-pr4-conv.mjs --apply <projectId>  # efface si projectId OK
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import { E2E_CONV_ID_PR4 } from "../src/lib/conversations/e2e-conversation-ids.ts";
import {
  applyReset,
  assertProjectIdMatches,
  scanReset,
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
console.log(`RESET-E2E-PR4-CONV — ${APPLY ? "APPLY" : "DRY-RUN"}`);
console.log(`  Conv ciblée : ${E2E_CONV_ID_PR4}`);
console.log(`  projectId   : ${env.FIREBASE_PROJECT_ID}`);
console.log("─".repeat(72));

try {
  const decision = await scanReset(db);
  switch (decision.kind) {
    case "absent":
      console.log(`  ↪ Conv ${E2E_CONV_ID_PR4} absente. Rien à annuler.`);
      process.exit(0);

    case "no-marking":
      console.log(`  ↪ Aucun marquage « j'ai contacté » à annuler. No-op.`);
      break;
    case "has-marking":
      console.log(`  ↪ Marquage détecté :`);
      console.log(`      contactedBy   = ${decision.contactedBy}`);
      console.log(`      contactedAtMs = ${decision.contactedAtMs}`);
      break;
  }

  if (!APPLY) {
    console.log("");
    console.log("DRY-RUN terminé. Relancer avec `--apply <projectId>` pour écrire.");
    process.exit(0);
  }

  const result = await applyReset(db);
  console.log(`  ✓ Reset appliqué (cleared=${result.cleared}, auditWritten=${result.wroteAudit}).`);
  process.exit(0);
} catch (err) {
  console.error(`Échec : ${err?.message ?? err}`);
  process.exit(1);
}
