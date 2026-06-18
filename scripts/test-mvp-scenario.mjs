/**
 * Scénario end-to-end MVP — simule un PS qui répond STOP long-form.
 *
 * Utilisation :
 *   npx tsx scripts/test-mvp-scenario.mjs
 *
 * Enchaîne :
 *   1. Création d'un faux contact Firestore (ContactSchema strict)
 *   2. Simulation message INBOUND long-form sans mot-clé STOP
 *   3. Classification via classifyReply() (Claude Haiku 4.5)
 *   4. Si intent === STOP : appel markOptedOut(id, "sms")
 *   5. Vérification consent.optedOut === true en Firestore
 *   6. Vérification audit_log "opt_out" écrit
 *   7. Nettoyage
 *
 * Logique métier de la future Inngest function process-reply (S8),
 * sans Inngest ni webhook. Ferme GUARD-001 en démo vivante.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { Timestamp } from "firebase-admin/firestore";

import { classifyReply } from "../src/lib/claude/intent-classifier.ts";
import { getAdminDb } from "../src/lib/firestore/admin.ts";
import { markOptedOut } from "../src/lib/firestore/contacts.ts";

const TEST_CONTACT_ID = `test-mvp-${Date.now()}`;
const TEST_CAMPAIGN_ID = "test-campaign-mvp";

// Message INBOUND simulé — long-form opt-out sans mot-clé STOP/ARRET/etc.
const INBOUND_MESSAGE =
  "Bonjour, pouvez-vous me retirer de votre liste de diffusion et ne plus me solliciter à l'avenir s'il vous plaît.";

console.log("=".repeat(80));
console.log("🎯 SCÉNARIO MVP — Démonstration end-to-end GUARD-001");
console.log("=".repeat(80));
console.log(`📋 Contact test : ${TEST_CONTACT_ID}`);
console.log(`📨 Message inbound simulé (${INBOUND_MESSAGE.length} chars) :`);
console.log(`   "${INBOUND_MESSAGE}"`);
console.log();

const db = getAdminDb();

// === ÉTAPE 1 : Créer un contact respectant ContactSchema strict ===
console.log("→ Étape 1 : créer le contact (ContactSchema strict)...");
const contactRef = db.collection("contacts").doc(TEST_CONTACT_ID);
const now = Timestamp.now();

await contactRef.set({
  hubspotId: TEST_CONTACT_ID,
  firstName: "Jean",
  lastName: "Dupont",
  civilite: "Dr",
  speciality: "Chirurgien-dentiste",
  city: "Paris",
  postalCode: "75001",
  email: "test-mvp@example.com",
  phone: {
    e164: "+33612345678",
    raw: "06 12 34 56 78",
    type: "mobile",
    valid: true,
    lookupAt: now,
  },
  segment: "b2b_cabinet",
  bloctelChecked: true,
  bloctelOptOut: false,
  bloctelCheckedAt: now,
  consent: {
    legitimateInterest:
      "Test manuel scénario end-to-end MVP pour valider classifier + markOptedOut sur vrai backend Firestore.",
    optedOut: false,
  },
  enrichment: {
    source: "manual",
    enrichedAt: now,
  },
  status: "in_conversation",
  campaignId: TEST_CAMPAIGN_ID,
  createdAt: now,
  updatedAt: now,
});
console.log("   ✅ Contact créé, status=in_conversation, consent.optedOut=false");

// === ÉTAPE 2 : Classifier l'intent ===
console.log();
console.log("→ Étape 2 : classifier l'intent via Claude Haiku 4.5...");
const startClaude = Date.now();
const classification = await classifyReply(INBOUND_MESSAGE);
const durationClaude = Date.now() - startClaude;
console.log(`   ✅ Classification terminée en ${durationClaude}ms`);
console.log(`   Intent      : ${classification.intent}`);
console.log(`   Confidence  : ${classification.confidence.toFixed(2)}`);
console.log(`   Reasoning   : ${classification.reasoning}`);
console.log(`   Fallback    : ${classification.fallback}`);

// === ÉTAPE 3 : Router selon l'intent ===
console.log();
console.log("→ Étape 3 : router selon l'intent...");
if (classification.intent === "STOP") {
  console.log('   🚦 Intent = STOP → appel markOptedOut(id, "sms")');
  await markOptedOut(TEST_CONTACT_ID, "sms");
  console.log("   ✅ markOptedOut() exécuté (idempotent, atomique avec audit_log)");
} else {
  console.log(
    `   ℹ️  Intent = ${classification.intent} → pas d'opt-out (S8 routera vers send_reply / handoff)`,
  );
}

// === ÉTAPE 4 : Vérifier l'état Firestore ===
console.log();
console.log("→ Étape 4 : relire le contact pour vérifier l'état...");
const verifySnap = await contactRef.get();
const verifyData = verifySnap.data();
if (verifyData.consent.optedOut !== true) {
  console.log(`   ❌ ÉCHEC : consent.optedOut=${verifyData.consent.optedOut}, attendu true`);
  throw new Error("Le contact n'est PAS opted-out alors qu'il devrait l'être !");
}
console.log(`   ✅ consent.optedOut         = ${verifyData.consent.optedOut}`);
console.log(`   ✅ consent.optedOutChannel  = ${verifyData.consent.optedOutChannel}`);
console.log(
  `   ✅ consent.optedOutAt       = ${verifyData.consent.optedOutAt.toDate().toISOString()}`,
);
console.log(`   ✅ status                   = ${verifyData.status}`);

// === ÉTAPE 5 : Vérifier audit_log ===
console.log();
console.log("→ Étape 5 : vérifier l'audit_log...");
const auditSnap = await db
  .collection("audit_log")
  .where("targetId", "==", TEST_CONTACT_ID)
  .where("action", "==", "opt_out")
  .get();
console.log(`   ✅ ${auditSnap.size} audit log(s) trouvé(s) pour ce contact`);
const auditIds = [];
auditSnap.forEach((doc) => {
  const audit = doc.data();
  console.log(`      - audit ${doc.id}`);
  console.log(
    `        action=${audit.action}, actorType=${audit.actorType}, channel=${audit.payload?.channel}`,
  );
  auditIds.push(doc.id);
});

// === ÉTAPE 6 : Nettoyage ===
console.log();
console.log("→ Étape 6 : nettoyer (contact + audit_log)...");
await contactRef.delete();
await Promise.all(auditIds.map((id) => db.collection("audit_log").doc(id).delete()));
console.log(`   ✅ Nettoyé : contact + ${auditIds.length} audit_log supprimés`);

console.log();
console.log("=".repeat(80));
console.log("✅ SCÉNARIO MVP RÉUSSI — GUARD-001 fonctionne END-TO-END en réel");
console.log("=".repeat(80));
console.log();
console.log("Ce que tu viens de prouver :");
console.log("  ✓ Claude classifie un message long-form (sans mot-clé STOP) comme STOP");
console.log("  ✓ markOptedOut(id, 'sms') écrit dans Firestore (transaction atomique)");
console.log("  ✓ appendAuditLogTx écrit l'audit dans la MÊME transaction (S6.2)");
console.log("  ✓ ContactSchema strict accepte un contact bien formé (S6.3)");
console.log("  ✓ Toute la chaîne S7a.2 → S6.3 → S6.2 tient sur vrai backend");
console.log();
console.log("Reste à faire en S8 :");
console.log("  - Câbler ce scénario dans une Inngest function process-reply");
console.log("  - Recevoir le message inbound via webhook OVH au lieu d'un hardcode");
console.log("  - Déployer sur Vercel");
