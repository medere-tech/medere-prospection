/**
 * CHECK-AUDIT-INDEXES (PR3 tour 2b bis quater) — vérifie que chaque
 * forme de requête émise par le journal / le rattrapage sur `audit_log`
 * possède un index composite en prod.
 *
 * Modèle miroir `scripts/check-orphan-indexes.mjs`.
 *
 * ⚠ LANCEMENT :
 *     npx tsx scripts/check-audit-indexes.mjs
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi un script dédié
 *
 *   La requête du journal d'un compte réel
 *   (`where actorTestAccount == false + orderBy timestamp desc + limit 20`,
 *   index #15) n'est contrôlée sur la vraie base par aucun autre script :
 *     - Le dry-run du rattrapage ne l'exécute pas (il ordonne par
 *       `__name__`, index #16).
 *     - L'e2e Playwright ne la touche pas : les comptes de test passent
 *       par la lecture simple (index #12).
 *
 *   Ce script sonde les 2 formes (#12 + #15) en lecture seule contre
 *   Firestore prod, affiche un ✓ ou ✗ par forme, et renvoie un code
 *   de sortie non-nul en cas d'index manquant.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Lecture seule stricte
 *
 *   - Aucune écriture : chaque requête est un `limit(1)` sur un targetId
 *     volontairement improbable.
 *   - Les requêtes passent par les MÊMES formes que `listAuditLogByTarget`
 *     et `fetchJournalEntriesRealOnly` (cf. `audit-query-forms.ts`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Codes de sortie
 *
 *   0 — toutes les formes OK
 *   1 — au moins une forme a échoué (lien de création d'index affiché)
 *   2 — env Firebase invalide / erreur fatale non catchée
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { QUERY_FORMS } from "../src/lib/firestore/audit-query-forms.ts";
import { countFromResult } from "../src/lib/firestore/check-indexes-count.ts";
import { getFirebaseEnv } from "../src/lib/security/env.ts";

function resolveProjectId() {
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  if (typeof emulatorHost === "string" && emulatorHost.length > 0) {
    return process.env.GCLOUD_PROJECT ?? "medere-test";
  }
  const env = getFirebaseEnv();
  return env.FIREBASE_PROJECT_ID;
}

const projectId = resolveProjectId();

console.log("");
console.log("─".repeat(72));
console.log("CHECK-AUDIT-INDEXES — lecture seule");
console.log("");
console.log(`  FIRESTORE_PROJECT : ${projectId}`);
console.log(`  Formes à vérifier : ${QUERY_FORMS.length}`);
console.log("─".repeat(72));
console.log("");

const results = [];

for (const form of QUERY_FORMS) {
  try {
    const r = await form.run();
    const count = countFromResult(r);
    results.push({ label: form.label, category: form.category, status: "OK", count });
    process.stdout.write(`  ✓ ${form.label}  (count=${count})\n`);
  } catch (err) {
    const message = String(err?.message ?? err);
    const linkMatch = message.match(/https:\/\/console\.firebase\.google\.com\/[^\s)]+/);
    results.push({
      label: form.label,
      category: form.category,
      status: "FAIL",
      error: message,
      indexLink: linkMatch?.[0] ?? null,
    });
    process.stdout.write(`  ✗ ${form.label}\n`);
    process.stdout.write(`      ${message}\n`);
    if (linkMatch) {
      process.stdout.write(`      Create: ${linkMatch[0]}\n`);
    }
  }
}

console.log("");
console.log("─".repeat(72));
const failed = results.filter((r) => r.status === "FAIL");
if (failed.length > 0) {
  console.log(`✗ ${failed.length} / ${results.length} forme(s) KO.`);
  process.exit(1);
}
console.log(`✓ ${results.length} / ${results.length} formes OK.`);
process.exit(0);
