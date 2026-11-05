#!/usr/bin/env node
/**
 * BACKFILL-AUDIT-ACTOR-TEST-ACCOUNT (PR3 tour 2b bis quater) — pose le
 * champ top-level `actorTestAccount: boolean` sur les docs `audit_log`
 * qui ne l'ont pas encore.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi ce rattrapage
 *
 *   Toute entrée d'audit écrite AVANT ce PR (ou par un rollback transitoire
 *   de prod pointant la même base que les previews) n'a pas de champ
 *   `actorTestAccount` au premier niveau. La query indexée du journal
 *   d'un compte réel (`where("actorTestAccount", "==", false)`) ne les
 *   remonte pas (Firestore ne matche pas un champ absent à `== false`).
 *   Sans rattrapage, ces entrées disparaissent du panneau « Journal ».
 *
 *   La logique vit dans `src/lib/firestore/backfill-actor-test-account-core.ts`
 *   et est partagée avec `tests/firestore/backfill-audit-actor-test-account.test.ts`
 *   (idempotent, aucun autre champ modifié, mutation testée).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Compat « append-only »
 *
 *   La règle projet dit : on N'ÉDITE PAS l'événement (action, actorId,
 *   actorType, payload, timestamp, targetType, targetId). On AJOUTE une
 *   donnée DÉRIVÉE, calculable a posteriori à partir du payload :
 *
 *     actorTestAccount := (payload.actorTestAccount === true)
 *
 *   Aucune donnée de l'événement n'est effacée ni modifiée.
 *
 * ⚠ LANCEMENT :
 *     npx tsx scripts/backfill-audit-actor-test-account.mjs           # dry-run (safe)
 *     npx tsx scripts/backfill-audit-actor-test-account.mjs --apply   # écrit après confirmation
 *     echo medere-prospection-mvp | npx tsx scripts/backfill-audit-actor-test-account.mjs --apply  # CI
 *
 * Garde-fous opérationnels :
 *   - Dry-run par défaut.
 *   - `--apply` doit être confirmé par la frappe EXACTE du projectId
 *     (pattern identique à `scripts/backfill-conversation-list-fields.mjs`).
 *   - Idempotent : les docs qui ont DÉJÀ le champ sont ignorés par le scan.
 *   - Aucun audit log posé par le backfill (par choix : c'est un
 *     enrichissement de donnée, pas une action métier).
 *
 * Codes de sortie :
 *   0 — succès (dry-run ou apply).
 *   2 — env Firebase invalide.
 *   3 — erreur fatale non catchée.
 *   4 — lookup Clerk a échoué OU aucun user testAccount trouvé.
 *   5 — confirmation refusée par l'opérateur (projectId non confirmé).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

// ⚠ `createClerkClient` de `@clerk/backend` est un factory pur (pas
// d'`import.meta`/top-level read de `process.env`). Il peut être importé
// AVANT ou APRÈS dotenv, le secretKey est lu à l'appel. NE PAS importer
// `clerkClient` depuis `@clerk/nextjs/server` : son module `constants.js`
// capture `process.env.CLERK_SECRET_KEY` à l'évaluation de l'import ESM
// (cf. `scripts/_lib/clerk-admin-client.mjs` pour le JSDoc complet).
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { getAdminDb } from "../src/lib/firestore/admin.ts";
import {
  EmptyTestUserSetError,
  fetchTestAccountUserIds,
  runBackfill,
} from "../src/lib/firestore/backfill-actor-test-account-core.ts";
import { getFirebaseEnv } from "../src/lib/security/env.ts";
import { makeClerkAdminClient } from "./_lib/clerk-admin-client.mjs";

const APPLY = process.argv.includes("--apply");

function resolveProjectId() {
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  if (typeof emulatorHost === "string" && emulatorHost.length > 0) {
    return process.env.GCLOUD_PROJECT ?? "medere-test";
  }
  try {
    const env = getFirebaseEnv();
    return env.FIREBASE_PROJECT_ID;
  } catch (err) {
    console.error(
      "[backfill-audit-actor-test-account] env Firebase invalide :",
      err instanceof Error ? err.message : err,
    );
    process.exit(2);
  }
}

async function confirmProjectId(expected) {
  const rl = createInterface({ input, output });
  try {
    const typed = (await rl.question(`Pour confirmer, tape le projectId cible : `)).trim();
    return typed === expected;
  } finally {
    rl.close();
  }
}

async function main() {
  const projectId = resolveProjectId();
  const mode = APPLY ? "APPLY" : "dry-run";
  console.log(`[backfill-audit-actor-test-account] projectId=${projectId} mode=${mode}`);

  // ── 1. Lecture Clerk des comptes test (fail-closed) ──────────────────
  // Client instancié APRÈS `config({ path: ".env.local" })` via
  // `createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY })`.
  // Le helper arrête proprement avec un exit 2 si la variable est absente.
  let testUserIds;
  try {
    const client = makeClerkAdminClient();
    testUserIds = await fetchTestAccountUserIds({
      getUserList: (opts) => client.users.getUserList(opts),
    });
  } catch (err) {
    console.error(
      "[backfill-audit-actor-test-account] lookup Clerk a échoué :",
      err instanceof Error ? err.message : err,
    );
    process.exit(4);
  }
  console.log(
    `[backfill-audit-actor-test-account] comptes test Clerk trouvés : ${testUserIds.size}`,
  );
  if (testUserIds.size === 0) {
    console.error(
      "[backfill-audit-actor-test-account] aucun user Clerk avec publicMetadata.testAccount=true — refus d'appliquer.",
    );
    process.exit(4);
  }

  // ── 2. Confirmation projectId AVANT apply ────────────────────────────
  if (APPLY) {
    const ok = await confirmProjectId(projectId);
    if (!ok) {
      console.error(
        "[backfill-audit-actor-test-account] projectId non confirmé — refus d'appliquer.",
      );
      process.exit(5);
    }
  }

  // ── 3. Scan + (dry-run | apply) ──────────────────────────────────────
  const db = getAdminDb();
  let stats;
  try {
    stats = await runBackfill(db, {
      apply: APPLY,
      testUserIds,
      onBatch: (s) => {
        console.log(
          `  scanned=${s.scanned} needsUpdate=${s.needsUpdate} updated=${s.updated} ofWhichTest=${s.testCount}`,
        );
      },
    });
  } catch (err) {
    if (err instanceof EmptyTestUserSetError) {
      // En théorie déjà filtré ci-dessus — ceinture et bretelles.
      console.error("[backfill-audit-actor-test-account]", err.message);
      process.exit(4);
    }
    throw err;
  }

  // ── 4. Récapitulatif + ventilation par action ────────────────────────
  console.log("─".repeat(72));
  console.log(
    `[backfill-audit-actor-test-account] TOTAL :\n` +
      `  scanned      = ${stats.scanned} docs\n` +
      `  needsUpdate  = ${stats.needsUpdate} docs (sans actorTestAccount top-level)\n` +
      `  updated      = ${stats.updated} docs ${APPLY ? "(écrits)" : "(dry-run — rien écrit)"}\n` +
      `  testCount    = ${stats.testCount} docs posés à true\n` +
      `                 (payload.actorTestAccount === true OR actorId ∈ testUserIds)`,
  );
  const actions = Object.keys(stats.testCountByAction).sort();
  if (actions.length > 0) {
    console.log("  ventilation testCount par action :");
    for (const action of actions) {
      console.log(`    - ${action.padEnd(40, " ")} ${stats.testCountByAction[action]}`);
    }
  } else {
    console.log("  ventilation testCount par action : aucune (testCount=0)");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill-audit-actor-test-account] FATAL :", err);
  process.exit(3);
});
