/**
 * Script de test manuel du classifier d'intent Médéré.
 *
 * Utilisation :
 *   node scripts/test-classifier.mjs
 *
 * Charge .env.local, appelle classifyReply() sur des fixtures réalistes,
 * affiche les résultats. PAS de production, juste un smoke test manuel.
 */

import { config } from "dotenv";

import { classifyReply } from "../src/lib/claude/intent-classifier.ts";

// Charge .env.local (la clé ANTHROPIC_API_KEY)
config({ path: ".env.local" });

// Fixtures réalistes — 4 cas couvrant les 4 intents + 3 long-form GUARD-001
const fixtures = [
  // Cas courts évidents
  { label: "STOP court", message: "STOP" },
  { label: "Question tarif", message: "C'est combien ?" },
  { label: "Refus poli court", message: "Pas intéressé" },
  { label: "Accusé réception", message: "OK" },
  { label: "Méchant", message: "Allez vous faire foutre" },

  // Cas LONG-FORM GUARD-001 (>50 chars, sans mot-clé STOP/ARRET/etc.)
  {
    label: "Long-form politesse",
    message:
      "Je vous remercie mais je préfère ne plus recevoir de messages de votre part, bonne journée à vous.",
  },
  {
    label: "Long-form admin",
    message:
      "Bonjour, pouvez-vous me retirer de votre liste de diffusion et ne plus me solliciter à l'avenir s'il vous plaît.",
  },
  {
    label: "Long-form RGPD",
    message:
      "Merci de ne plus me contacter par ce moyen ni aucun autre, je n'ai pas donné mon accord pour ce démarchage.",
  },

  // Cas ambigus
  { label: "Hésitant", message: "Je vais voir mais pour l'instant je ne sais pas trop" },
  {
    label: "Demande RDV",
    message: "Comment je peux m'inscrire à votre prochaine formation sur les caries pédiatriques ?",
  },
];

console.log("=".repeat(80));
console.log("🧪 Test du classifier d'intent Médéré — Phase 1 / S7a.2");
console.log("=".repeat(80));

const startTotal = Date.now();
const results = [];

for (const fixture of fixtures) {
  const start = Date.now();
  try {
    const result = await classifyReply(fixture.message);
    const durationMs = Date.now() - start;
    results.push({ ...fixture, ...result, durationMs, error: null });

    console.log(`\n📨 ${fixture.label} (${durationMs}ms)`);
    console.log(
      `   Message : "${fixture.message.substring(0, 60)}${fixture.message.length > 60 ? "..." : ""}"`,
    );
    console.log(`   Intent  : ${result.intent}${result.fallback ? "  ⚠️  FALLBACK" : ""}`);
    console.log(`   Confidence : ${result.confidence.toFixed(2)}`);
    console.log(`   Reasoning  : ${result.reasoning}`);
  } catch (err) {
    const durationMs = Date.now() - start;
    results.push({ ...fixture, intent: null, durationMs, error: err.message });
    console.log(`\n❌ ${fixture.label} — ERREUR (${durationMs}ms)`);
    console.log(`   ${err.message}`);
  }
}

const totalMs = Date.now() - startTotal;

console.log("\n" + "=".repeat(80));
console.log(`✅ Terminé en ${totalMs}ms (${results.length} fixtures)`);
console.log("=".repeat(80));

// Statistiques rapides
const fallbacks = results.filter((r) => r.fallback).length;
const errors = results.filter((r) => r.error).length;
const avgMs = Math.round(results.reduce((sum, r) => sum + r.durationMs, 0) / results.length);

console.log(`\n📊 Stats :`);
console.log(`   - Latence moyenne : ${avgMs}ms par classification`);
console.log(`   - Fallbacks       : ${fallbacks}/${results.length}`);
console.log(`   - Erreurs         : ${errors}/${results.length}`);
