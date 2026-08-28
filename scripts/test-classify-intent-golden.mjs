/**
 * Golden test manuel PR1-AUTO-REPLY-OBSERVE — classifier d'intent v1.1.0.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * POURQUOI CE SCRIPT EXISTE
 *
 * Les tests unitaires du classifier MOCKENT `generateWithTool` : ils
 * prouvent le câblage, jamais la capacité du prompt à discriminer. Un test
 * qui affirme « "Réponse automatique : absent" → AUTO_REPLY » avec un mock
 * ne prouve rien — il vérifie que le mock renvoie ce qu'on lui a dit de
 * renvoyer.
 *
 * Seuls des appels Haiku RÉELS peuvent valider ce prompt. C'est l'objet de
 * ce script (pattern miroir `test-first-sms-golden.mjs`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 CE QUI EST VÉRIFIÉ — DEUX EXIGENCES, PAS UNE
 *
 *   1. **Détection** — les accusés machine sont bien classés AUTO_REPLY.
 *
 *   2. **ZÉRO RÉGRESSION** (exigence Déthié) — les 4 intents historiques
 *      classent EXACTEMENT comme avant v1.1.0. Le retrait de « Bien reçu »
 *      / « accusé de réception » du bloc NEUTRE ne doit déplacer AUCUN cas
 *      existant. Le corpus `REGRESSION` reprend les cas du prompt v1.0.1 et
 *      des fixtures GUARD-001.
 *
 *   3. **Non sur-détection** — les humains brefs ("ok reçu merci", "vu")
 *      et les humains qui mentionnent une absence ("je suis absent mais
 *      rappelez-moi lundi") NE doivent PAS basculer AUTO_REPLY.
 *
 * Un faux positif (humain → AUTO_REPLY) est l'échec le plus grave : en PR2
 * il signifierait qu'on cesse silencieusement de répondre à un vrai PS. Le
 * script le compte séparément et le remonte en tête de rapport.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Exit code :
 *   - 0 si 100% des cas classent comme attendu
 *   - 1 si au moins 1 écart
 *   - 2 si ANTHROPIC_API_KEY manquante
 *   - 3 si tmp/ n'est pas gitignored (garde anti-fuite, cf. first-sms golden)
 *
 * 🚨 Lancé manuellement, JAMAIS en CI :
 *   - Coût estimé : ~$0.02 (RUNS_PER_CASE × corpus, Haiku 4.5, messages courts)
 *   - Nécessite ANTHROPIC_API_KEY réel dans .env.local
 *
 * Usage :
 *   $ npm run golden:intent
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { classifyReply } from "../src/lib/claude/intent-classifier.ts";
import {
  CLASSIFY_INTENT_MODEL,
  CLASSIFY_INTENT_PROMPT_VERSION,
  CLASSIFY_INTENT_TEMPERATURE,
} from "../src/lib/claude/prompts/classify-intent.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Temperature = 0 côté prompt → le classifier est censé être déterministe.
 * On lance quand même 2 runs par cas : un écart entre les deux runs révèle
 * une non-reproductibilité qui serait un bug compliance en soi (deux PS
 * identiques traités différemment).
 */
const RUNS_PER_CASE = 2;

/**
 * 🚨 Données 100% FICTIVES. Aucun message de vrai PS. Les accusés
 * automatiques sont des formulations génériques de messagerie.
 */

/** Corpus 1 — ANTI-RÉGRESSION : doit classer comme avant v1.1.0. */
const REGRESSION_CASES = [
  { message: "STOP", expected: "STOP", note: "mot-clé court-form" },
  {
    message: "Je vous remercie mais je préfère ne plus recevoir de messages de votre part",
    expected: "STOP",
    note: "fixture GUARD-001 long-form",
  },
  { message: "Foutez-moi la paix", expected: "STOP", note: "hostilité" },
  { message: "Pas intéressé pour l'instant", expected: "OBJECTION", note: "refus poli" },
  {
    message: "Je n'ai pas le temps là, peut-être plus tard",
    expected: "OBJECTION",
    note: "refus temporel",
  },
  { message: "C'est cher !", expected: "OBJECTION", note: "scepticisme prix" },
  { message: "C'est quoi exactement ?", expected: "INTERESSE", note: "question contenu" },
  { message: "C'est combien ?", expected: "INTERESSE", note: "tarif neutre" },
  { message: "Oui ça m'intéresse", expected: "INTERESSE", note: "intérêt explicite" },
  {
    message: "OK je vais voir avec mes associés",
    expected: "NEUTRE",
    note: "différé non discriminant",
  },
  { message: "?", expected: "NEUTRE", note: "une seule ponctuation" },
];

/** Corpus 2 — DÉTECTION : doit classer AUTO_REPLY. */
const AUTO_REPLY_CASES = [
  {
    message:
      "Réponse automatique : je suis absent du 12 au 26 août et ne consulte pas mes messages.",
    expected: "AUTO_REPLY",
    note: "auto-descriptif + disponibilité datée",
  },
  {
    message:
      "Message automatique - le cabinet est fermé jusqu'au 3 septembre. En cas d'urgence composez le 15.",
    expected: "AUTO_REPLY",
    note: "auto-descriptif + redirection urgence",
  },
  {
    message: "Votre message a bien été reçu. Merci de ne pas répondre à ce message.",
    expected: "AUTO_REPLY",
    note: "auto-descriptif 'ne pas répondre'",
  },
  {
    message: "Je suis actuellement en congés et consulterai vos messages à mon retour.",
    expected: "AUTO_REPLY",
    note: "absence sans date mais impersonnel",
  },
  {
    message:
      "Bonjour, le secrétariat est joignable du lundi au vendredi de 9h a 12h et de 14h a 17h. Pour toute urgence, contactez le 15.",
    expected: "AUTO_REPLY",
    note: "long + formaté + horaires + redirection",
  },
];

/**
 * Corpus 3 — NON SUR-DÉTECTION : humains qui NE doivent PAS basculer
 * AUTO_REPLY. C'est le corpus qui compte le plus : chaque échec ici est un
 * PS réel qu'on cesserait de traiter en PR2.
 */
const HUMAN_NOT_AUTO_CASES = [
  { message: "ok reçu merci", expected: "NEUTRE", note: "humain bref — piège brièveté" },
  { message: "Bien reçu", expected: "NEUTRE", note: "humain bref — ex-exemple NEUTRE v1.0.1" },
  { message: "vu", expected: "NEUTRE", note: "humain ultra-bref" },
  { message: "merci", expected: "NEUTRE", note: "humain ultra-bref" },
  // Formulations d'accusé que l'ancienne clause générique NEUTRE couvrait
  // implicitement (review prompt-engineer). Aucune n'est dans la liste
  // littérale d'exemples → elles testent la GÉNÉRALISATION du modèle.
  { message: "Compris", expected: "NEUTRE", note: "accusé hors liste littérale" },
  { message: "Noté", expected: "NEUTRE", note: "accusé hors liste littérale" },
  { message: "D'accord merci", expected: "NEUTRE", note: "accusé hors liste littérale" },
  { message: "Ok pas de souci", expected: "NEUTRE", note: "accusé hors liste littérale" },
  {
    message: "Merci de votre message, je ne suis pas intéressé pour le moment",
    expected: "OBJECTION",
    note: "PIÈGE signal 4 : refus humain impersonnel ET assez long",
  },
  {
    message: "Je suis absent cette semaine mais rappelez-moi lundi",
    expected: "INTERESSE",
    note: "PIÈGE : mentionne absence mais demande rappel = humain",
  },
  {
    message: "Je suis en congés, renvoyez-moi ça en septembre",
    expected: "OBJECTION",
    note: "PIÈGE : mentionne congés mais report personnalisé = humain",
  },
];

const CORPUS = [
  { group: "REGRESSION (4 intents historiques)", cases: REGRESSION_CASES },
  { group: "DETECTION (accusés machine)", cases: AUTO_REPLY_CASES },
  { group: "NON-SUR-DETECTION (humains a preserver)", cases: HUMAN_NOT_AUTO_CASES },
];

// ─────────────────────────────────────────────────────────────────────────────
// Validation env + garde tmp/ (pattern first-sms-golden)
// ─────────────────────────────────────────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("❌ ANTHROPIC_API_KEY manquante dans .env.local");
  process.exit(2);
}

const gitignorePath = resolve(process.cwd(), ".gitignore");
if (!existsSync(gitignorePath)) {
  console.error("❌ .gitignore introuvable — refus de tourner.");
  process.exit(3);
}
if (!/^tmp\/?$/m.test(readFileSync(gitignorePath, "utf-8"))) {
  console.error("❌ .gitignore ne contient pas 'tmp/' — refus de tourner.");
  process.exit(3);
}

const TMP_DIR = resolve(process.cwd(), "tmp");
mkdirSync(TMP_DIR, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputPath = resolve(TMP_DIR, `classify-intent-golden-${timestamp}.json`);

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

const totalCases = CORPUS.reduce((n, g) => n + g.cases.length, 0);

console.log("=".repeat(80));
console.log("🎯 GOLDEN TEST — classify-intent v" + CLASSIFY_INTENT_PROMPT_VERSION);
console.log("=".repeat(80));
console.log(`Model       : ${CLASSIFY_INTENT_MODEL}`);
console.log(`Temperature : ${CLASSIFY_INTENT_TEMPERATURE}`);
console.log(`Cas         : ${totalCases}`);
console.log(`Runs/cas    : ${RUNS_PER_CASE}`);
console.log(`Total calls : ${totalCases * RUNS_PER_CASE}`);
console.log(`Output JSON : ${outputPath}`);
console.log();

const report = {
  timestamp: new Date().toISOString(),
  promptVersion: CLASSIFY_INTENT_PROMPT_VERSION,
  model: CLASSIFY_INTENT_MODEL,
  temperature: CLASSIFY_INTENT_TEMPERATURE,
  runsPerCase: RUNS_PER_CASE,
  groups: [],
};

let totalRuns = 0;
let passedRuns = 0;
/** Faux positifs : humain classé AUTO_REPLY. L'échec le plus grave. */
let falsePositives = 0;
/** Faux négatifs : machine non détectée. Bénin en PR1 (= comportement actuel). */
let falseNegatives = 0;
/** Non-déterminisme : les 2 runs d'un même cas divergent. */
let nonDeterministic = 0;

for (const { group, cases } of CORPUS) {
  console.log(`\n━━━ ${group} ━━━`);
  const groupReport = { group, cases: [] };

  for (const { message, expected, note } of cases) {
    const runs = [];
    for (let i = 0; i < RUNS_PER_CASE; i++) {
      try {
        const r = await classifyReply(message);
        runs.push({ intent: r.intent, confidence: r.confidence, fallback: r.fallback });
      } catch (err) {
        runs.push({ intent: "__ERROR__", error: err instanceof Error ? err.message : "unknown" });
      }
    }

    const intents = runs.map((r) => r.intent);
    const allMatch = intents.every((i) => i === expected);
    const deterministic = new Set(intents).size === 1;

    totalRuns += runs.length;
    passedRuns += intents.filter((i) => i === expected).length;
    if (!deterministic) nonDeterministic += 1;

    // Qualification de l'écart — c'est ce qui pilote la décision PR2.
    let severity = "ok";
    if (!allMatch) {
      if (expected !== "AUTO_REPLY" && intents.includes("AUTO_REPLY")) {
        severity = "FAUX_POSITIF";
        falsePositives += 1;
      } else if (expected === "AUTO_REPLY") {
        severity = "faux_negatif";
        falseNegatives += 1;
      } else {
        severity = "REGRESSION";
      }
    }

    const icon = allMatch ? "✅" : severity === "faux_negatif" ? "🟡" : "🔴";
    const detFlag = deterministic ? "" : " ⚠️ NON-DÉTERMINISTE";
    console.log(
      `${icon} attendu=${expected.padEnd(10)} obtenu=${intents.join("/")}${detFlag}  — ${note}`,
    );

    groupReport.cases.push({ message, expected, note, runs, allMatch, deterministic, severity });
  }
  report.groups.push(groupReport);
}

report.totalRuns = totalRuns;
report.passedRuns = passedRuns;
report.falsePositives = falsePositives;
report.falseNegatives = falseNegatives;
report.nonDeterministic = nonDeterministic;

writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf-8");

// ─────────────────────────────────────────────────────────────────────────────
// Sommaire
// ─────────────────────────────────────────────────────────────────────────────

console.log();
console.log("=".repeat(80));
console.log(`📊 ${passedRuns}/${totalRuns} runs conformes`);
console.log("=".repeat(80));
console.log(`🔴 Faux positifs (humain → AUTO_REPLY) : ${falsePositives}   ← le plus grave`);
console.log(`🟡 Faux négatifs (machine ratée)       : ${falseNegatives}   ← bénin en PR1`);
console.log(`⚠️  Cas non déterministes               : ${nonDeterministic}`);
console.log(`Rapport JSON : ${outputPath}`);
console.log();

if (passedRuns === totalRuns) {
  console.log("✅ GOLDEN PASSED — 0 régression, 0 faux positif.");
  process.exit(0);
}

console.log("❌ GOLDEN FAILED.");
if (falsePositives > 0) {
  console.log("   🔴 Des messages HUMAINS sont classés AUTO_REPLY.");
  console.log("      NE PAS activer la coupure (PR2) en l'état : ces PS");
  console.log("      cesseraient de recevoir des réponses, silencieusement.");
  console.log("      → renforcer la règle de doute / les contre-signaux du prompt.");
}
if (falseNegatives > 0 && falsePositives === 0) {
  console.log("   🟡 Uniquement des machines ratées : sans gravité en PR1");
  console.log("      (= comportement actuel). Décider si on renforce la");
  console.log("      détection ou si on accepte le taux.");
}
process.exit(1);
