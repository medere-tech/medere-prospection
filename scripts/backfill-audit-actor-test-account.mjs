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
 *   5 — confirmation refusée par l'opérateur (projectId non confirmé).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { getAdminDb } from "../src/lib/firestore/admin.ts";
import { runBackfill } from "../src/lib/firestore/backfill-actor-test-account-core.ts";
import { getFirebaseEnv } from "../src/lib/security/env.ts";

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

  if (APPLY) {
    const ok = await confirmProjectId(projectId);
    if (!ok) {
      console.error(
        "[backfill-audit-actor-test-account] projectId non confirmé — refus d'appliquer.",
      );
      process.exit(5);
    }
  }

  const db = getAdminDb();
  const stats = await runBackfill(db, {
    apply: APPLY,
    onBatch: (s) => {
      // Une ligne par batch : scan progressant, écriture potentielle.
      console.log(
        `  scanned=${s.scanned} needsUpdate=${s.needsUpdate} updated=${s.updated} ofWhichTest=${s.testCount}`,
      );
    },
  });

  console.log("─".repeat(72));
  console.log(
    `[backfill-audit-actor-test-account] TOTAL :\n` +
      `  scanned      = ${stats.scanned} docs\n` +
      `  needsUpdate  = ${stats.needsUpdate} docs (sans actorTestAccount top-level)\n` +
      `  updated      = ${stats.updated} docs ${APPLY ? "(écrits)" : "(dry-run — rien écrit)"}\n` +
      `  testCount    = ${stats.testCount} docs posés à true (payload.actorTestAccount === true)`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill-audit-actor-test-account] FATAL :", err);
  process.exit(3);
});
