/**
 * CHECK-CONVERSATION-LIST-INDEXES (PR2a) — vérifie que chaque forme de
 * requête émise par les 3 routes `/api/admin/conversations*` ET les
 * lookups legacy par contactId possède un index composite en prod.
 *
 * ⚠ LANCEMENT :
 *     npx tsx scripts/check-conversation-list-indexes.mjs
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Lecture seule stricte
 *
 *   - Aucune écriture : chaque requête est un `limit(1)` ou une agrégation
 *     `count()`. Les probes utilisent des IDs volontairement improbables
 *     (`UPROBE…`, `zzz-probe-…`) qui ne risquent pas de retourner des docs
 *     réels.
 *   - Les requêtes passent par les MÊMES fonctions que les routes
 *     (`listConversations*`, `countConversations`, `queryConversationListVersion`,
 *     `getActiveConversationByContactId`...) — pas de query recopiée à la
 *     main. Si une route change sa query, le script change avec elle.
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

import { QUERY_FORMS } from "../src/lib/firestore/conversation-list-query-forms.ts";

const projectId = process.env.FIRESTORE_PROJECT_ID ?? "(non défini)";

console.log("");
console.log("─".repeat(72));
console.log("CHECK-CONVERSATION-LIST-INDEXES — lecture seule");
console.log("");
console.log(`  FIRESTORE_PROJECT : ${projectId}`);
console.log(`  Formes à vérifier : ${QUERY_FORMS.length}`);
console.log("─".repeat(72));
console.log("");

/** @typedef {{ label: string, category: string, status: "OK"|"SKIP"|"FAIL", count?: number, note?: string, error?: string, indexLink?: string | null }} FormResult */

/** @type {FormResult[]} */
const results = [];

for (const form of QUERY_FORMS) {
  try {
    const r = await form.run();
    // Compte sans AFFICHER le contenu des documents (contrat PR2a).
    let count = 0;
    let note;
    if (r && typeof r === "object") {
      if ("__skip__" in r) {
        note = String(r.__skip__);
        results.push({ label: form.label, category: form.category, status: "SKIP", note });
        process.stdout.write(`  ∘ ${form.label}  — SKIP (${note})\n`);
        continue;
      }
      if (typeof r === "object" && "conversations" in r && Array.isArray(r.conversations)) {
        count = r.conversations.length;
      } else if ("topConversationId" in r) {
        count = r.topConversationId ? 1 : 0;
      } else {
        // get*ByContactId retourne Conversation | null
        count = r ? 1 : 0;
      }
    } else if (typeof r === "number") {
      count = r;
    }
    results.push({ label: form.label, category: form.category, status: "OK", count });
    process.stdout.write(`  ✓ ${form.label}  (count=${count})\n`);
  } catch (err) {
    const message = String(err?.message ?? err);
    const firstLine = message.split("\n")[0].slice(0, 200);
    const linkMatch = message.match(/https:\/\/[^\s)\]"']+/);
    results.push({
      label: form.label,
      category: form.category,
      status: "FAIL",
      error: firstLine,
      indexLink: linkMatch ? linkMatch[0] : null,
    });
    process.stdout.write(`  ✗ ${form.label}  — ${firstLine}\n`);
    if (linkMatch) process.stdout.write(`     ↳ ${linkMatch[0]}\n`);
  }
}

const fails = results.filter((r) => r.status === "FAIL");
const skips = results.filter((r) => r.status === "SKIP");
const oks = results.filter((r) => r.status === "OK");

console.log("");
console.log("─".repeat(72));
console.log(
  `Résumé : ${results.length} forme(s) — OK=${oks.length}  SKIP=${skips.length}  FAIL=${fails.length}`,
);

if (fails.length > 0) {
  console.log("");
  console.log("Index manquants (ouvrir les liens Firebase ci-dessous pour les créer) :");
  for (const f of fails) {
    console.log(`  - ${f.label}`);
    if (f.indexLink) console.log(`      ↳ ${f.indexLink}`);
  }
  console.log("");
  console.log("Après création dans la console Firebase, mirrorer dans");
  console.log("`firestore.indexes.json` puis `npm run firebase:deploy:indexes`.");
  process.exit(1);
}

if (skips.length > 0) {
  console.log("");
  console.log("SKIPs = formes dont la variante sans curseur a déjà couvert l'index requis");
  console.log(
    "(curseur = ajout d'un `startAfter(doc)` sur la même orderBy, mêmes champs filtrés).",
  );
}

console.log("");
console.log("Toutes les formes de requête ont trouvé leur index en prod.");
process.exit(0);
