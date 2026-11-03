/**
 * CHECK-ORPHAN-INDEXES (PR2c tour 2a) — vérifie que chaque forme de
 * requête émise par les routes `/api/admin/orphan-inbounds*` possède un
 * index composite en prod.
 *
 * Modèle miroir `scripts/check-conversation-list-indexes.mjs`.
 *
 * ⚠ LANCEMENT :
 *     npx tsx scripts/check-orphan-indexes.mjs
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Lecture seule stricte
 *
 *   - Aucune écriture : chaque requête est un `limit(1)` ou une
 *     agrégation `count()`.
 *   - Les probes utilisent des IDs volontairement improbables.
 *   - Les requêtes passent par les MÊMES formes que `listOrphanInbounds`
 *     et `countOrphanInboundsByState` (cf. `orphan-list-query-forms.ts`).
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

import { countFromResult } from "../src/lib/firestore/check-indexes-count.ts";
import { QUERY_FORMS } from "../src/lib/firestore/orphan-list-query-forms.ts";
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
console.log("CHECK-ORPHAN-INDEXES — lecture seule");
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
    // Firestore inclut un lien de création d'index dans le message quand
    // l'index manque. On l'extrait pour affichage opérateur.
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
