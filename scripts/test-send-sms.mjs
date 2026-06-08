/**
 * Test manuel S8.6 — émet un event Inngest `medere/sms.send-first.requested`
 * pour déclencher la function `send-first-sms` (S8.4).
 *
 * Utilisation :
 *   npx tsx scripts/test-send-sms.mjs
 *
 * Pré-requis dans .env.local :
 *   - FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY (S6.1)
 *   - AUDIT_PII_PEPPER (S6.2)
 *   - TEST_PHONE_NUMBER (E.164, ex: +33775745453) — destinataire du test
 *   - INNGEST_EVENT_KEY                                — sinon mode dev local
 *     (le SDK tente localhost:8288 — utile en couplant avec
 *     `npx inngest-cli@latest dev` dans un autre terminal)
 *   - DRY_RUN_SMS="true" par défaut (cf. S8.2) → aucun envoi OVH réel
 *
 * Comportement :
 *   1. Crée un contact + une conversation Firestore (ContactSchema +
 *      ConversationSchema strict)
 *   2. Émet `medere/sms.send-first.requested` via `inngest.send()`
 *   3. Affiche le résumé + URLs dashboard Inngest
 *   4. PAS de cleanup automatique — contact + conv restent en Firestore
 *      pour permettre des relances. Cleanup manuel via
 *      `scripts/cleanup-test-contacts.mjs`.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { Timestamp } from "firebase-admin/firestore";

import { getAdminDb } from "../src/lib/firestore/admin.ts";
import { getInngestClient } from "../src/lib/inngest/client.ts";
import { smsSendFirstRequested } from "../src/lib/inngest/events.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes test
// ─────────────────────────────────────────────────────────────────────────────

const TEST_CAMPAIGN_ID = "test-campaign-mvp-s8";

// Body de test ~150 chars, professionnel, identifié explicitement comme test
// (pas de prospection commerciale réelle — important si TEST_PHONE_NUMBER est
// un vrai numéro et que DRY_RUN_SMS=false).
const TEST_BODY =
  "Bonjour Dr Test, je suis Léa, assistante virtuelle de Médéré. Ceci est un message de test du MVP de prospection. Répondez STOP pour ne plus être contacté.";

// Regex E.164 (alignée `inngest/events.ts`, `types/contact.ts`, `twilio/lookup`)
const E164_REGEX = /^\+[1-9]\d{6,14}$/;

// ─────────────────────────────────────────────────────────────────────────────
// Validations pré-vol
// ─────────────────────────────────────────────────────────────────────────────

const TEST_PHONE_NUMBER = process.env.TEST_PHONE_NUMBER;
if (!TEST_PHONE_NUMBER) {
  console.error(
    "❌ TEST_PHONE_NUMBER manquant dans .env.local. Ajoute par exemple :\n" +
      "   TEST_PHONE_NUMBER=+33775745453",
  );
  process.exit(1);
}
if (!E164_REGEX.test(TEST_PHONE_NUMBER)) {
  console.error(
    `❌ TEST_PHONE_NUMBER="${TEST_PHONE_NUMBER}" n'est pas au format E.164.\n` +
      "   Exemple valide : +33775745453 (préfixe + et pays, sans espaces).",
  );
  process.exit(1);
}

// Avertissement (pas un échec) si INNGEST_EVENT_KEY absent — le SDK
// retombera sur le mode dev (localhost:8288).
const INNGEST_DEV_MODE = !process.env.INNGEST_EVENT_KEY;
if (INNGEST_DEV_MODE) {
  console.warn(
    "⚠️  INNGEST_EVENT_KEY absent → mode dev local (localhost:8288).\n" +
      "   Si tu veux émettre vers Inngest Cloud, ajoute INNGEST_EVENT_KEY dans\n" +
      "   .env.local (récupérable sur https://app.inngest.com → Manage → Event Keys).\n" +
      "   Sinon, lance dans un autre terminal :\n" +
      "       npx inngest-cli@latest dev\n",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup test : contact + conversation Firestore
// ─────────────────────────────────────────────────────────────────────────────

const TEST_CONTACT_ID = `test-send-${Date.now()}`;
const TEST_CONVERSATION_ID = `${TEST_CONTACT_ID}_${TEST_CAMPAIGN_ID}`;

console.log("=".repeat(80));
console.log("🚀 S8.6 — Test d'émission event Inngest send-first-sms");
console.log("=".repeat(80));
console.log(`📋 Contact ID      : ${TEST_CONTACT_ID}`);
console.log(`📋 Conversation ID : ${TEST_CONVERSATION_ID}`);
console.log(`📋 Campaign ID     : ${TEST_CAMPAIGN_ID}`);
console.log(`📞 Phone           : ${TEST_PHONE_NUMBER}`);
console.log(`📝 Body (${TEST_BODY.length} chars)    : ${TEST_BODY}`);
console.log();

const db = getAdminDb();
const now = Timestamp.now();

// ── Étape 1 : créer le contact (ContactSchema strict — cf. S6.3) ──────────
console.log("→ Étape 1 : créer le contact Firestore...");
const contactRef = db.collection("contacts").doc(TEST_CONTACT_ID);
await contactRef.set({
  hubspotId: TEST_CONTACT_ID,
  firstName: "Test",
  lastName: "Dentiste",
  civilite: "Dr",
  speciality: "dentiste",
  city: "Paris",
  postalCode: "75001",
  email: "test-send-sms@example.com",
  phone: {
    e164: TEST_PHONE_NUMBER,
    raw: TEST_PHONE_NUMBER,
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
      "Test S8.6 automatisé — validation pipeline Inngest send-first-sms bout-en-bout (Phase 1 MVP Médéré).",
    optedOut: false,
  },
  enrichment: {
    source: "manual",
    enrichedAt: now,
  },
  status: "ready",
  campaignId: TEST_CAMPAIGN_ID,
  createdAt: now,
  updatedAt: now,
});
console.log("   ✅ Contact créé (status=ready, segment=b2b_cabinet)");

// ── Étape 2 : créer la conversation (ConversationSchema strict) ───────────
console.log("→ Étape 2 : créer la conversation Firestore...");
const conversationRef = db.collection("conversations").doc(TEST_CONVERSATION_ID);
await conversationRef.set({
  contactId: TEST_CONTACT_ID,
  campaignId: TEST_CAMPAIGN_ID,
  channel: "sms",
  status: "active",
  intent: "unknown",
  messageCount: 0,
  outboundCount: 0,
  inboundCount: 0,
  followupCount: 0,
  createdAt: now,
  updatedAt: now,
});
console.log("   ✅ Conversation créée (status=active, intent=unknown, messageCount=0)");

// ── Étape 3 : émettre l'event Inngest ──────────────────────────────────────
console.log();
console.log("→ Étape 3 : émettre l'event medere/sms.send-first.requested...");
const inngest = getInngestClient();
const event = smsSendFirstRequested.create({
  contactId: TEST_CONTACT_ID,
  campaignId: TEST_CAMPAIGN_ID,
  body: TEST_BODY,
});

let sendResult;
try {
  sendResult = await inngest.send(event);
} catch (err) {
  console.error("   ❌ Échec inngest.send() :");
  if (err instanceof Error) {
    console.error(`      ${err.message}`);
  } else {
    console.error(err);
  }
  console.error();
  console.error("   Causes probables :");
  console.error("     - INNGEST_EVENT_KEY invalide (mauvaise key copiée depuis le dashboard)");
  console.error("     - Pas d'app Inngest cloud configurée pour ce projet (cf. S8.7)");
  console.error(
    "     - En mode dev local : le dev server n'est pas lancé\n" +
      "       (`npx inngest-cli@latest dev` dans un autre terminal)",
  );
  process.exit(1);
}

const eventId = sendResult.ids?.[0] ?? "(no id returned)";

// ── Étape 4 : affichage structuré ──────────────────────────────────────────
console.log("   ✅ Event émis avec succès");
console.log();
console.log("=".repeat(80));
console.log("✅ Event émis — pipeline send-first-sms déclenché côté Inngest");
console.log("=".repeat(80));
console.log(`Contact ID       : ${TEST_CONTACT_ID}`);
console.log(`Conversation ID  : ${TEST_CONVERSATION_ID}`);
console.log(`Campaign ID      : ${TEST_CAMPAIGN_ID}`);
console.log(`Phone (E.164)    : ${TEST_PHONE_NUMBER}`);
console.log(`Event ID Inngest : ${eventId}`);
console.log(`Mode             : ${INNGEST_DEV_MODE ? "dev local" : "Inngest Cloud"}`);
console.log();
console.log("Prochaines étapes :");
if (INNGEST_DEV_MODE) {
  console.log("  1. Vérifie le run dans le dev server : http://localhost:8288");
  console.log("  2. Le step `ovh-send` doit logger '[DRY_RUN] would send' si");
  console.log("     DRY_RUN_SMS=true (default).");
} else {
  console.log("  1. Vérifie l'event reçu : https://app.inngest.com (Events tab)");
  console.log("  2. Vérifie le run de send-first-sms : https://app.inngest.com (Runs tab)");
  console.log("  3. En DRY_RUN_SMS=true (preview Vercel par défaut), aucun SMS réel.");
  console.log(`  4. En DRY_RUN_SMS=false (prod), un SMS arrive sur ${TEST_PHONE_NUMBER}.`);
}
console.log();
console.log("Cleanup (manuel — pas d'auto-cleanup pour permettre les relances) :");
console.log(`  npx tsx scripts/cleanup-test-contacts.mjs ${TEST_CONTACT_ID}`);
console.log();
