/**
 * Seed CLI HubSpot → Firestore (S10.1.3).
 *
 * Importe une liste HubSpot SMS dans la collection Firestore `contacts/`
 * avec traçabilité forensic RGPD complète.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Usage :
 *   npx tsx scripts/seed-contacts-from-hubspot.mjs [--dry-run]
 *
 * Avec npm script :
 *   npm run seed:hubspot
 *   npm run seed:hubspot -- --dry-run
 *
 * Flag --dry-run (OU env SEED_DRY_RUN=true) : aucune écriture Firestore,
 * aucun audit log posé. Validation mapping seulement. Indispensable pour
 * valider AVANT seed prod.
 *
 * Pré-requis dans .env.local :
 *   - HUBSPOT_ACCESS_TOKEN (S10.1.2.b — pat-eu1-*)
 *   - FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 *   - AUDIT_PII_PEPPER (S6.2)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Flow interactif :
 *
 *   1. Affiche les listes HubSpot SMS disponibles (numérotées)
 *   2. Demande de choisir un numéro (ou 'q' pour quitter)
 *   3. Confirmation simple : "Créer N contacts ? (y/N)"
 *   4. Si N > 1000 : double confirmation "Tape 'CONFIRM N' pour valider"
 *   5. Lance runSeed() avec dépendances réelles
 *   6. Affiche sommaire final + exit code
 *
 * Exit codes :
 *   0 → succès (ou dry-run terminé)
 *   1 → exécution avec > 50% d'erreurs (signal opérationnel)
 *   2 → env var manquante OU annulation utilisateur
 *   3 → erreur HubSpot/Firestore propagée (anti-absorption silencieuse)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Sécurité — anti-fuite PII console
 *
 *   Console n'affiche JAMAIS firstName/lastName/phone/email brut.
 *   Seulement : hubspotId opaque (si log par contact), compteurs agrégés,
 *   noms de listes (label business, pas PII).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createInterface } from "node:readline/promises";

import { appendAuditLog } from "../src/lib/firestore/audit-log.ts";
import { createContact } from "../src/lib/firestore/contacts.ts";
import { getContactsInList } from "../src/lib/hubspot/contacts.ts";
import { listSmsLists } from "../src/lib/hubspot/lists.ts";
import { mapHubSpotContactToFirestoreContact } from "../src/lib/hubspot/mapper.ts";
import { runSeed, SEED_RUNNER_OP } from "../src/lib/seed/seed-runner.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes CLI
// ─────────────────────────────────────────────────────────────────────────────

const DOUBLE_CONFIRM_THRESHOLD = 1000;

const REQUIRED_ENV = [
  "HUBSPOT_ACCESS_TOKEN",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "AUDIT_PII_PEPPER",
];

// ─────────────────────────────────────────────────────────────────────────────
// Validation env vars
// ─────────────────────────────────────────────────────────────────────────────

const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length > 0) {
  console.error("❌ Variables d'env manquantes dans .env.local :");
  for (const k of missingEnv) {
    console.error(`   - ${k}`);
  }
  process.exit(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Détection dry-run
// ─────────────────────────────────────────────────────────────────────────────

const isDryRun = process.argv.includes("--dry-run") || process.env.SEED_DRY_RUN === "true";

// ─────────────────────────────────────────────────────────────────────────────
// Header
// ─────────────────────────────────────────────────────────────────────────────

console.log("=".repeat(80));
console.log("🌱 SEED HubSpot → Firestore (S10.1.3)");
console.log("=".repeat(80));
console.log(`Op           : ${SEED_RUNNER_OP}`);
console.log(
  `Dry-run      : ${isDryRun ? "OUI (aucune écriture Firestore)" : "NON (écriture réelle)"}`,
);
console.log();

const rl = createInterface({ input: process.stdin, output: process.stdout });

// 🆕 Defense-in-depth : si CTRL+C en plein run, close le readline propre
// pour éviter un terminal cassé. SIGINT propagé après cleanup.
process.on("SIGINT", () => {
  rl.close();
  console.log("\n\n⚠ Seed interrompu (SIGINT). Re-run idempotent par design.");
  process.exit(130);
});

try {
  // ── Étape 1 : Lister les listes HubSpot SMS ───────────────────────────
  console.log("→ Récupération des listes HubSpot SMS…");
  const lists = await listSmsLists();
  if (lists.length === 0) {
    console.log("\n❌ Aucune liste HubSpot ne match 'SMS'. Vérifie le portail.");
    process.exit(2);
  }

  console.log(`\n📋 ${lists.length} liste(s) trouvée(s) :\n`);
  lists.forEach((l, i) => {
    const size = l.size === undefined ? "?" : l.size;
    console.log(`  [${i + 1}] ${l.name}  (${size} contacts, type=${l.processingType})`);
  });
  console.log(`  [q] Quitter sans rien faire\n`);

  // ── Étape 2 : Choisir un numéro ────────────────────────────────────────
  const rawChoice = (await rl.question("Numéro de liste : ")).trim().toLowerCase();
  if (rawChoice === "q" || rawChoice === "") {
    console.log("\nAnnulation utilisateur.");
    rl.close();
    process.exit(2);
  }

  const choiceIdx = parseInt(rawChoice, 10) - 1;
  if (Number.isNaN(choiceIdx) || choiceIdx < 0 || choiceIdx >= lists.length) {
    console.error(`\n❌ Choix invalide : "${rawChoice}"`);
    rl.close();
    process.exit(2);
  }

  const selected = lists[choiceIdx];
  const expectedCount = selected.size ?? 0;
  const campaignId = `hubspot-list-${selected.listId}`;

  console.log();
  console.log(`📌 Liste sélectionnée : ${selected.name}`);
  console.log(`   listId       : ${selected.listId}`);
  console.log(`   campaignId   : ${campaignId}`);
  console.log(`   expected     : ${expectedCount} contacts`);
  console.log(`   dryRun       : ${isDryRun}`);
  console.log();

  // ── Étape 3 : Confirmation simple ──────────────────────────────────────
  const confirm = (
    await rl.question(
      `Créer ${expectedCount} contact(s) dans Firestore (campaign=${campaignId}, dryRun=${isDryRun}) ? (y/N) : `,
    )
  )
    .trim()
    .toLowerCase();
  if (confirm !== "y") {
    console.log("\nAnnulation utilisateur.");
    rl.close();
    process.exit(2);
  }

  // ── Étape 4 : Double confirmation si N > seuil ─────────────────────────
  if (expectedCount > DOUBLE_CONFIRM_THRESHOLD) {
    const expected = `CONFIRM ${expectedCount}`;
    console.log();
    console.log(
      `🚨 N = ${expectedCount} > ${DOUBLE_CONFIRM_THRESHOLD}. Double confirmation requise.`,
    );
    const doubleConfirm = (
      await rl.question(`Tape '${expected}' (exact, majuscules) pour valider : `)
    ).trim();
    if (doubleConfirm !== expected) {
      console.log("\nAnnulation — saisie incorrecte (anti-DoS accidentel).");
      rl.close();
      process.exit(2);
    }
  }

  rl.close();

  // ── Étape 5 : Lancer runSeed ──────────────────────────────────────────
  console.log();
  console.log("=".repeat(80));
  console.log(`🚀 Démarrage seed (campaign=${campaignId})…`);
  console.log("=".repeat(80));

  const stats = await runSeed(
    {
      listId: selected.listId,
      listName: selected.name,
      expectedCount,
      campaignId,
      dryRun: isDryRun,
    },
    {
      listSmsLists,
      getContactsInList,
      mapHubSpotContactToFirestoreContact,
      createContact,
      appendAuditLog,
    },
  );

  // ── Étape 6 : Sommaire final ──────────────────────────────────────────
  console.log();
  console.log("=".repeat(80));
  console.log(`📊 Sommaire ${isDryRun ? "DRY-RUN" : ""}`);
  console.log("=".repeat(80));
  console.log(`  Pages processed       : ${stats.pagesProcessed}`);
  console.log(`  Fetched               : ${stats.fetchedCount}`);
  console.log(`  Created               : ${stats.createdCount}`);
  console.log(`  Already exists (skip) : ${stats.skippedAlreadyExistsCount}`);
  console.log(`  Mapper errors (skip)  : ${stats.skippedMapperErrorCount}`);
  console.log(`  Duration              : ${Math.round(stats.durationMs / 1000)}s`);
  console.log(`  Started at            : ${stats.startedAt}`);
  console.log(`  Completed at          : ${stats.completedAt}`);
  console.log();

  // Sanity diff expected vs fetched
  if (stats.fetchedCount !== expectedCount) {
    console.log(
      `⚠  Mismatch expected=${expectedCount} vs fetched=${stats.fetchedCount}. ` +
        `Liste HubSpot a peut-être changé entre énumération et fetch.`,
    );
  }

  // Exit code : 1 si > 50% d'erreurs (signal opérationnel)
  const totalProcessed = stats.createdCount + stats.skippedMapperErrorCount;
  const errorRate = totalProcessed === 0 ? 0 : stats.skippedMapperErrorCount / totalProcessed;
  if (errorRate > 0.5) {
    console.log(`❌ Taux d'erreur ${(errorRate * 100).toFixed(0)}% > 50% — investigation requise.`);
    process.exit(1);
  }

  console.log(isDryRun ? "✅ Dry-run terminé (aucune écriture)." : "✅ Seed terminé avec succès.");
  process.exit(0);
} catch (err) {
  rl.close();
  console.error();
  console.error("=".repeat(80));
  console.error("❌ Erreur fatale seed");
  console.error("=".repeat(80));
  console.error(`Name      : ${err.constructor?.name ?? "Error"}`);
  console.error(`Code      : ${err.code ?? "(none)"}`);
  // 🚨 S10.1.3 security T1 #1 : err.message OMIS. Les wrappers HubSpot/
  // Firestore peuvent inclure phone/email du PS dans .message si l'erreur
  // est wrappée autour d'un contact spécifique (ex: validation Zod
  // contact corrompu). Forensic via Sentry/Pino côté serveur (déjà
  // sanitisés). Le CLI affiche uniquement Name + Code (enums fermés).
  // PAS de stack ni de cause/context brut non plus.
  console.error();
  console.error("Re-run idempotent par design (ConflictError absorb les doublons).");
  process.exit(3);
}
