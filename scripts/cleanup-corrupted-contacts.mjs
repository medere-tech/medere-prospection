/**
 * Cleanup CLI — supprime les documents `contacts` Firestore qui ne matchent
 * plus `ContactSchema` (résidus de tests antérieurs, drift de schéma, etc.).
 * S10.1.13-CLEANUP-CORRUPTED-CONTACTS-001.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Usage :
 *   npx tsx scripts/cleanup-corrupted-contacts.mjs              ← DRY-RUN (default)
 *   npx tsx scripts/cleanup-corrupted-contacts.mjs --execute    ← suppression après confirmation
 *
 * Différent de `cleanup-test-contacts.mjs` (Option I S10.1.13) :
 *   - test-contacts : suppression par préfixe `hubspotId` connu (test-mvp-, test-debug-)
 *   - corrupted     : détection par `ContactSchema.safeParse()` puis suppression
 *
 * Scope distinct, scripts mono-responsabilité.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pipeline :
 *
 *   Phase 1 (toujours) :
 *     a. Init Firebase Admin (lazy, via getAdminDb)
 *     b. db.collection("contacts").get() — full load (< 26k OK en RAM)
 *     c. Pour chaque doc : ContactSchema.safeParse(data)
 *     d. Si invalid : push { id, ref, issues: [{path, code}] } (zéro PII)
 *     e. Afficher rapport agrégé + détail par doc
 *
 *   Phase 2 (uniquement si --execute) :
 *     a. Si 0 corrupted → exit 0 "rien à faire"
 *     b. Prompt readline "TYPE 'DELETE N'" (N = nombre exact corrupted)
 *     c. Si mismatch → exit 2 (annulation)
 *     d. Pour chaque doc, SÉQUENTIEL :
 *        - appendAuditLog action=contact_deleted reason=corrupted_schema_cleanup
 *          (AVANT le delete — D-c6 pattern projet, trace forensique posée
 *           même si delete fail ensuite)
 *        - doc.ref.delete()
 *     e. Récap final + exit
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Exit codes :
 *   0 → succès (ou dry-run terminé, ou rien à supprimer)
 *   1 → exécution partielle (au moins 1 erreur audit/delete)
 *   2 → annulation user OU env var manquante
 *   3 → erreur fatale Firebase/Firestore propagée
 *   130 → SIGINT (Ctrl+C)
 *
 * Re-run idempotent : audit AVANT delete → si crash entre les 2, l'audit
 * reste et le doc reste. Re-run finit le job (le doc est toujours corrompu,
 * il sera re-détecté et re-supprimé — l'audit antérieur reste forensique).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Anti-fuite PII (cf. CLAUDE.md règle 9) :
 *
 *   - Logs : uniquement docId (= hubspotId, semi-PII acceptable cohérent
 *     pattern projet) + path/code Zod. JAMAIS de `received` Zod (qui
 *     contiendrait téléphone/email du contact corrompu).
 *   - Audit : `targetId: docId` (semi-PII OK) + `payload: { reason, issues }`.
 *     Le scrubber `detectPiiInPayload` ne check QUE `payload` — confirmé
 *     audit-log.ts:173. Issues ne contiennent que path/code Zod.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { getAdminDb } from "../src/lib/firestore/admin.ts";
import { appendAuditLog } from "../src/lib/firestore/audit-log.ts";
import { ContactSchema } from "../src/lib/firestore/contacts.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

const SCRIPT_OP = "cleanup-corrupted-contacts";

const REQUIRED_ENV = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  // Requis par appendAuditLog (hashPii interne consomme AUDIT_PII_PEPPER même
  // si ce script ne hash rien explicitement — defense-in-depth contre un
  // futur dev qui appellerait safePhoneHash() dans le payload).
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
// Args parsing
// ─────────────────────────────────────────────────────────────────────────────

const executeMode = process.argv.includes("--execute");

// ─────────────────────────────────────────────────────────────────────────────
// Header
// ─────────────────────────────────────────────────────────────────────────────

console.log("=".repeat(80));
console.log("🧹 CLEANUP CORRUPTED CONTACTS (S10.1.13)");
console.log("=".repeat(80));
console.log(`Op    : ${SCRIPT_OP}`);
console.log(
  `Mode  : ${executeMode ? "EXECUTE (delete after confirmation)" : "DRY-RUN (no deletion)"}`,
);
console.log();

const db = getAdminDb();
const rl = createInterface({ input, output });

// Defense-in-depth : si CTRL+C en plein run, close le readline propre pour
// éviter un terminal cassé. SIGINT propagé après cleanup.
process.on("SIGINT", () => {
  rl.close();
  console.log("\n\n⚠ Cleanup interrompu (SIGINT). Re-run idempotent par design.");
  process.exit(130);
});

try {
  // ── Phase 1 : Detection (toujours exécutée) ──────────────────────────────
  console.log("→ Chargement collection contacts…");
  const snap = await db.collection("contacts").get();
  console.log(`📋 Total docs : ${snap.size}`);
  console.log();

  if (snap.empty) {
    console.log("✅ Collection vide. Rien à faire.");
    rl.close();
    process.exit(0);
  }

  const corruptedDocs = [];
  for (const doc of snap.docs) {
    const result = ContactSchema.safeParse(doc.data());
    if (!result.success) {
      corruptedDocs.push({
        id: doc.id,
        ref: doc.ref,
        // 🚨 ANTI-PII : on extrait UNIQUEMENT path + code Zod. Le champ
        // `received` (valeur invalide) est volontairement OMIS — il pourrait
        // contenir téléphone/email/nom du contact corrompu. Cohérent avec
        // pattern parseContactOrThrow (contacts.ts:243-263).
        issues: result.error.issues.map((i) => ({
          path: i.path.join("."),
          code: i.code,
        })),
      });
    }
  }

  console.log(`🔍 ${corruptedDocs.length} doc(s) corrompu(s) détecté(s) sur ${snap.size} total.`);
  console.log();

  if (corruptedDocs.length === 0) {
    console.log("✅ Aucun document corrompu détecté. Rien à faire.");
    rl.close();
    process.exit(0);
  }

  // Détail par doc — zéro PII (juste docId + Zod path/code).
  console.log("📋 Détail des documents corrompus :");
  console.log("─".repeat(80));
  for (const { id, issues } of corruptedDocs) {
    console.log(`  ${id}`);
    for (const issue of issues) {
      console.log(`    ✗ ${issue.path}  (${issue.code})`);
    }
  }
  console.log("─".repeat(80));
  console.log();

  // ── Phase 2 : Deletion (uniquement si --execute) ─────────────────────────
  if (!executeMode) {
    console.log("ℹ DRY-RUN terminé. Aucune suppression effectuée.");
    console.log(`ℹ Pour supprimer les ${corruptedDocs.length} doc(s) ci-dessus :`);
    console.log("    npx tsx scripts/cleanup-corrupted-contacts.mjs --execute");
    rl.close();
    process.exit(0);
  }

  // Confirmation stricte — typing du nombre exact évite un --execute lancé
  // par mégarde sur la mauvaise base (pattern aligné seed-contacts:174-186).
  const expectedConfirm = `DELETE ${corruptedDocs.length}`;
  console.log(`🚨 EXECUTE mode activé. ${corruptedDocs.length} doc(s) seront SUPPRIMÉS.`);
  console.log("🚨 Action IRRÉVERSIBLE (suppression Firestore Cloud).");
  console.log();
  const userInput = (
    await rl.question(`Tape EXACTEMENT '${expectedConfirm}' (majuscules) pour confirmer : `)
  ).trim();

  if (userInput !== expectedConfirm) {
    console.log("\n⚠ Saisie incorrecte. Aucune suppression effectuée.");
    rl.close();
    process.exit(2);
  }

  rl.close();

  // Suppression séquentielle : audit puis delete, par doc. Pas de WriteBatch
  // car `appendAuditLog` utilise `.add()` (pas batchable avec un batch
  // Firestore externe — il faudrait `runTransaction` + `appendAuditLogTx`
  // mais transactions Firestore ont leurs propres contraintes). Pour 200
  // contacts MVP, < 5s total. Si volumétrie change, optimiser plus tard.
  //
  // Pattern audit AVANT delete (D-c6 projet) : la trace forensique reste
  // posée même si le delete crash ensuite. Re-run idempotent.
  console.log();
  console.log("🗑  Suppression en cours…");
  console.log();

  let deletedCount = 0;
  let errorCount = 0;

  for (const { id, ref, issues } of corruptedDocs) {
    try {
      await appendAuditLog({
        actorId: `system:${SCRIPT_OP}`,
        actorType: "system",
        action: "contact_deleted",
        targetType: "contact",
        // hubspotId (= docId Firestore). Semi-PII acceptable cohérent
        // pattern projet (cf. createContact ConflictError context.hubspotId).
        targetId: id,
        payload: {
          reason: "corrupted_schema_cleanup",
          // [{path, code}] — zéro PII (path = chemin Zod, code = enum Zod).
          // Scrubber detectPiiInPayload ne match pas ces structures.
          issues,
        },
      });

      await ref.delete();
      deletedCount++;
      console.log(`  ✓ ${id}  (${deletedCount}/${corruptedDocs.length})`);
    } catch (err) {
      errorCount++;
      // 🚨 ANTI-PII : on log err.constructor.name + code, mais PAS
      // err.message brut (qui peut contenir hubspotId d'un autre doc si
      // erreur Firestore wrappée). Diagnostic forensic via Sentry/Pino
      // côté serveur si configuré.
      console.error(
        `  ✗ ${id} — ${err.constructor?.name ?? "Error"}` +
          `${err.code !== undefined ? ` (code=${err.code})` : ""}`,
      );
    }
  }

  console.log();
  console.log("─".repeat(80));
  console.log("📊 Récap :");
  console.log(`  Supprimés      : ${deletedCount}`);
  console.log(`  Erreurs        : ${errorCount}`);
  console.log(`  Total détectés : ${corruptedDocs.length}`);
  console.log("─".repeat(80));

  if (errorCount > 0) {
    console.log(
      `\n⚠ ${errorCount} erreur(s) durant la suppression. Re-run pour retry les restants (idempotent).`,
    );
    process.exit(1);
  }

  console.log("\n✅ Cleanup terminé avec succès.");
  process.exit(0);
} catch (err) {
  rl.close();
  console.error();
  console.error("=".repeat(80));
  console.error("❌ Erreur fatale cleanup");
  console.error("=".repeat(80));
  console.error(`Name    : ${err.constructor?.name ?? "Error"}`);
  console.error(`Code    : ${err.code ?? "(none)"}`);
  // 🚨 ANTI-PII : on log err.message ici (utile diagnostic Firestore
  // FAILED_PRECONDITION etc.) — cohérent avec amélioration logging
  // S10.1.12-LIST-CONTACTS-DIAGNOSIS-001. Sanitizer Pino projet couvre
  // les fragments PII éventuels si configuré.
  console.error(`Message : ${err.message ?? "(none)"}`);
  console.error();
  console.error("Re-run idempotent par design (audit AVANT delete).");
  process.exit(3);
}
