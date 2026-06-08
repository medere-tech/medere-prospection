/**
 * Test direct du wrapper OVH sendSms() depuis le terminal local.
 * Bypass Vercel + Inngest pour isoler la variable.
 *
 * Utilisation :
 *   npx tsx scripts/test-ovh-direct.mjs
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { sendSms } from "../src/lib/ovh/send-sms.ts";

const PHONE = process.env.TEST_PHONE_NUMBER;
const BODY =
  "Bonjour Dr Test, je suis Léa, assistante virtuelle de Médéré. Ceci est un message de test du MVP de prospection. Répondez STOP pour ne plus être contacté.";

if (!PHONE) {
  console.error("❌ TEST_PHONE_NUMBER manquant dans .env.local");
  process.exit(1);
}

console.log("=".repeat(80));
console.log("📡 Test direct OVH sendSms() — bypass Inngest+Vercel");
console.log("=".repeat(80));
console.log(`Sender         : ${process.env.OVH_SMS_SENDER}`);
console.log(`Service        : ${process.env.OVH_SMS_SERVICE_NAME}`);
console.log(`Endpoint       : ${process.env.OVH_ENDPOINT}`);
console.log(`Receiver       : ${PHONE}`);
console.log(`Body (${BODY.length} chars) : ${BODY.substring(0, 80)}...`);
console.log("=".repeat(80));

try {
  const result = await sendSms({
    receivers: [PHONE],
    message: BODY,
  });
  console.log("\n✅ SMS envoyé avec succès !");
  console.log("Result:", JSON.stringify(result, null, 2));
} catch (err) {
  console.error("\n❌ Erreur sendSms :");
  console.error("Name      :", err.name);
  console.error("Message   :", err.message);
  console.error("Code      :", err.code);
  console.error("Context   :", JSON.stringify(err.context, null, 2));
  console.error("Cause     :", err.cause);
  console.error("\nFull stack :");
  console.error(err.stack);
  process.exit(1);
}
