/**
 * Supprime tous les contacts orphelins préfixés "test-mvp-" ou "test-debug-"
 * qui auraient pu être laissés par un script de test qui a crashé.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { getAdminDb } from "../src/lib/firestore/admin.ts";

const db = getAdminDb();

const prefixes = ["test-mvp-", "test-debug-"];
let totalDeleted = 0;

for (const prefix of prefixes) {
  // Firestore range query : tout doc dont l'ID commence par <prefix>
  const snap = await db
    .collection("contacts")
    .where("hubspotId", ">=", prefix)
    .where("hubspotId", "<", prefix + "\uf8ff")
    .get();

  console.log(`Préfixe "${prefix}" : ${snap.size} contact(s) à supprimer`);
  for (const doc of snap.docs) {
    console.log(`  → ${doc.id}`);
    await doc.ref.delete();
    totalDeleted++;
  }
}

console.log(`\n✅ ${totalDeleted} contact(s) supprimé(s) au total`);
