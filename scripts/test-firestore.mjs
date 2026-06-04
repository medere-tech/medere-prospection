/**
 * Script de test manuel de la couche Firestore Médéré (S6).
 *
 * Utilisation :
 *   npx tsx scripts/test-firestore.mjs
 *
 * Charge .env.local, se connecte au vrai Firestore via le service account,
 * crée un faux contact "test-debug", appelle les opérations CRUD, vérifie
 * les invariants, supprime le contact en fin de run.
 *
 * IMPORTANT : ce script écrit dans le VRAI Firestore (pas l'emulator).
 * Il utilise un contactId préfixé "test-debug-" pour ne jamais collisionner
 * avec un vrai contact PS.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { Timestamp } from "firebase-admin/firestore";

import { getAdminDb } from "../src/lib/firestore/admin.ts";

const TEST_CONTACT_ID = `test-debug-${Date.now()}`;

console.log("=".repeat(80));
console.log("🧪 Test Firestore Médéré — Phase 1 / S6 (sur vrai Firestore prod)");
console.log("=".repeat(80));
console.log(`📋 Contact test : ${TEST_CONTACT_ID}`);
console.log();

const db = getAdminDb();

// === ÉTAPE 1 : Créer un contact de test ===
console.log("→ Étape 1 : créer le contact test...");
const contactRef = db.collection("contacts").doc(TEST_CONTACT_ID);
await contactRef.set({
  hubspotId: TEST_CONTACT_ID,
  phone: "+33612345678",
  firstName: "Test",
  lastName: "Debug",
  status: "new",
  optedOut: false,
  bloctelChecked: false,
  legitimateInterest:
    "Test manuel de la couche Firestore S6 sur vrai backend prod, exécuté par Déthié pour valider l'intégration end-to-end avant Inngest S8.",
  createdAt: Timestamp.now(),
  updatedAt: Timestamp.now(),
});
console.log("   ✅ Contact créé");

// === ÉTAPE 2 : Lire le contact ===
console.log("→ Étape 2 : lire le contact...");
const snapshot = await contactRef.get();
if (!snapshot.exists) {
  throw new Error("Contact pas trouvé après création !");
}
const data = snapshot.data();
console.log(`   ✅ Contact lu : ${data.firstName} ${data.lastName} / ${data.phone}`);
console.log(`   status=${data.status}, optedOut=${data.optedOut}`);

// === ÉTAPE 3 : Marquer optedOut (simulation STOP) ===
console.log("→ Étape 3 : marquer optedOut: true...");
await contactRef.update({
  optedOut: true,
  optedOutAt: Timestamp.now(),
  updatedAt: Timestamp.now(),
});
console.log("   ✅ Contact marqué opted-out");

// === ÉTAPE 4 : Vérifier que optedOut est bien à true ===
console.log("→ Étape 4 : relire pour vérifier...");
const verifySnap = await contactRef.get();
const verifyData = verifySnap.data();
if (verifyData.optedOut !== true) {
  throw new Error(`optedOut devrait être true, mais c'est ${verifyData.optedOut} !`);
}
console.log(
  `   ✅ Vérifié : optedOut=${verifyData.optedOut}, optedOutAt=${verifyData.optedOutAt.toDate().toISOString()}`,
);

// === ÉTAPE 5 : Écrire un audit log ===
console.log("→ Étape 5 : écrire dans audit_log...");
const auditRef = await db.collection("audit_log").add({
  actorId: "system",
  actorType: "system",
  action: "contact_status_changed",
  targetType: "contact",
  targetId: TEST_CONTACT_ID,
  payload: { oldStatus: "new", newStatus: "opted_out", source: "test-firestore-script" },
  createdAt: Timestamp.now(),
});
console.log(`   ✅ Audit créé : ${auditRef.id}`);

// === ÉTAPE 6 : Nettoyer ===
console.log("→ Étape 6 : nettoyer (supprimer contact + audit)...");
await contactRef.delete();
await auditRef.delete();
console.log("   ✅ Nettoyé");

console.log();
console.log("=".repeat(80));
console.log("✅ Test Firestore RÉUSSI — toute la chaîne fonctionne en réel");
console.log("=".repeat(80));
console.log();
console.log("Ce qui vient d'être validé :");
console.log("  ✓ Authentification Firebase Admin via service account");
console.log("  ✓ Écriture dans collection 'contacts'");
console.log("  ✓ Lecture par docId");
console.log("  ✓ Update partiel");
console.log("  ✓ Écriture dans collection 'audit_log'");
console.log("  ✓ Suppression");
console.log();
console.log("Prochaine étape : connecter le tout dans une Inngest function S8.");
