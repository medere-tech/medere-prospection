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

import { getAdminDb } from "../src/lib/firestore/admin.ts";
import { QUERY_FORMS } from "../src/lib/firestore/conversation-list-query-forms.ts";

// Résout le vrai projectId depuis le SDK Admin (seul source de vérité :
// `FIRESTORE_PROJECT_ID` est historiquement absent côté backend —
// Firebase Admin lit `GOOGLE_APPLICATION_CREDENTIALS`, `FIREBASE_CONFIG`,
// ou le service account JSON injecté par `admin.ts`). Fallback explicite
// si le SDK ne l'expose pas (ne devrait pas arriver, log diagnostique).
const db = getAdminDb();
const projectId =
  db.app?.options?.projectId ??
  process.env.FIRESTORE_PROJECT_ID ??
  process.env.GOOGLE_CLOUD_PROJECT ??
  "(unknown — SDK admin n'a pas exposé projectId)";

console.log("");
console.log("─".repeat(72));
console.log("CHECK-CONVERSATION-LIST-INDEXES — lecture seule");
console.log("");
console.log(`  FIRESTORE_PROJECT : ${projectId}`);
console.log(`  Formes à vérifier : ${QUERY_FORMS.length}`);
console.log("─".repeat(72));
console.log("");

/** @typedef {{ label: string, category: string, status: "OK"|"FAIL", count?: number, error?: string, indexLink?: string | null }} FormResult */

/** @type {FormResult[]} */
const results = [];

for (const form of QUERY_FORMS) {
  try {
    const r = await form.run();
    // Compte sans AFFICHER le contenu des documents (contrat PR2a).
    let count = 0;
    if (r && typeof r === "object") {
      if ("conversations" in r && Array.isArray(r.conversations)) {
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
const oks = results.filter((r) => r.status === "OK");

console.log("");
console.log("─".repeat(72));
console.log(`Résumé : ${results.length} forme(s) — OK=${oks.length}  FAIL=${fails.length}`);

if (fails.length > 0) {
  console.log("");
  console.log(
    "Index manquants (déduire le composite depuis la requête, PAS cliquer sur le lien) :",
  );
  for (const f of fails) {
    console.log(`  - ${f.label}`);
    if (f.indexLink) console.log(`      ↳ (lien console à titre indicatif) ${f.indexLink}`);
  }
  console.log("");
  console.log("Source de vérité : `firestore.indexes.json`. Déduire le composite");
  console.log("depuis les égalités de la requête → `contactNameSearch asc` si");
  console.log("recherche → `lastMessageAt desc`. Puis `npm run firebase:deploy:indexes`.");
  process.exit(1);
}

console.log("");
console.log("Toutes les formes de requête ont trouvé leur index en prod.");
process.exit(0);
