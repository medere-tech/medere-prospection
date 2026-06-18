/**
 * Golden test manuel S10.1.2.a — 5 contacts × 5 runs Claude réels.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Sentinelle compliance-critical drift 0% (décision Déthié S10.1.2.0 A-3,
 * A-a4).
 *
 * Vérifie que le prompt `first-sms.ts` v1.0.0 + temperature 0.3 produisent
 * un drift acceptable :
 *   - 5 contacts diversifiés (matchant les 3 few-shot + 1 cas Pr +
 *     1 cas civilité=undefined)
 *   - 5 runs Claude réels par contact (25 calls total)
 *   - Pour chaque body : hasAIDisclosure + hasOptOut +
 *     hasAdvertiserIdentification + length ∈ [50, 160]
 *
 * Exit code :
 *   - 0 si 25/25 conformes
 *   - 1 si au moins 1 body non conforme (diff loggé sans body brut)
 *
 * Output :
 *   - Console : sommaire sans body brut (compliance flags + length seul)
 *   - tmp/first-sms-golden-${timestamp}.json : rapport complet (avec
 *     bodies — usage forensic local uniquement, JAMAIS commit ce fichier)
 *
 * 🚨 Lancé manuellement par Déthié pré-prod, JAMAIS en CI :
 *   - Coût estimé : ~$0.25 (25 calls Sonnet 4.6, ~250 tokens chacun)
 *   - Nécessite ANTHROPIC_API_KEY réel dans .env.local
 *   - tmp/ ne doit PAS être commit (cf. .gitignore)
 *
 * Usage :
 *   $ node scripts/test-first-sms-golden.mjs
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { generateFirstSms } from "../src/lib/claude/first-sms-generator.ts";
import {
  FIRST_SMS_MAX_BODY_CHARS,
  FIRST_SMS_MIN_BODY_CHARS,
  FIRST_SMS_MODEL,
  FIRST_SMS_PROMPT_VERSION,
  FIRST_SMS_TEMPERATURE,
} from "../src/lib/claude/prompts/first-sms.ts";
import { hasAdvertiserIdentification } from "../src/lib/compliance/advertiser-identification.ts";
import { hasAIDisclosure } from "../src/lib/compliance/ai-disclosure.ts";
import { hasOptOut } from "../src/lib/compliance/opt-out.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes test
// ─────────────────────────────────────────────────────────────────────────────

const RUNS_PER_CONTACT = 5;

/**
 * 5 contacts mocks diversifiés sur 4 dimensions :
 *   1. civilité présente (Dr/Pr/Mme) vs absente
 *   2. spécialité (3 enum différents)
 *   3. ville présente vs vide
 *   4. cas féminin/masculin/prénom unisexe
 *
 * 🚨 Données 100% FICTIVES — pas de vrais PS. Si tu reconnaîs un nom,
 * c'est une coïncidence, change-le.
 */
const TEST_CONTACTS = [
  {
    label: "Dr+Chirurgien-dentiste+Paris (matching few-shot 1)",
    contact: {
      firstName: "Marie",
      lastName: "Dupuis",
      civilite: "Dr",
      speciality: "Chirurgien-dentiste",
      city: "Paris",
    },
  },
  {
    label: "Dr+Médecin+Lyon (matching few-shot 2)",
    contact: {
      firstName: "Pierre",
      lastName: "Martin",
      civilite: "Dr",
      speciality: "Médecin",
      city: "Lyon",
    },
  },
  {
    label: "undefined+Sage-Femme+vide (matching few-shot 3 — worst case)",
    contact: {
      firstName: "Sophie",
      lastName: "Bernard",
      civilite: undefined,
      speciality: "Sage-Femme",
      city: "",
    },
  },
  {
    label: "Pr+Médecin+Bordeaux (cas rare Professeur)",
    contact: {
      firstName: "Henri",
      lastName: "Charrier",
      civilite: "Pr",
      speciality: "Médecin",
      city: "Bordeaux",
    },
  },
  {
    label: "Mme+IDE+Toulouse (cas féminin Mme + IDE)",
    contact: {
      firstName: "Camille",
      lastName: "Roux",
      civilite: "Mme",
      speciality: "IDE",
      city: "Toulouse",
    },
  },
  {
    label: "M.+MKDE+Marseille (cas masculin M. + MKDE worst-case civilité — F11 compliance v1.0.1)",
    contact: {
      firstName: "Julien",
      lastName: "Lefebvre",
      civilite: "M.",
      speciality: "MKDE",
      city: "Marseille",
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Validation env + setup tmp/
// ─────────────────────────────────────────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("❌ ANTHROPIC_API_KEY manquante dans .env.local");
  console.error("   Ajoute la dans .env.local pour lancer ce script.");
  process.exit(2);
}

// 🚨 Sentinelle defense-in-depth (security-reviewer T2-2) : vérifier runtime
// que `tmp/` est gitignored AVANT d'y écrire des bodies (PII potentielle si
// tests sur vrais contacts). Si un futur dev supprime l'entrée du
// .gitignore, ce script refuse de tourner pour éviter une fuite commit.
const gitignorePath = resolve(process.cwd(), ".gitignore");
if (!existsSync(gitignorePath)) {
  console.error("❌ .gitignore introuvable à la racine du projet");
  console.error("   Refus de tourner — risque de commit des bodies générés.");
  process.exit(3);
}
const gitignoreContent = readFileSync(gitignorePath, "utf-8");
if (!/^tmp\/?$/m.test(gitignoreContent)) {
  console.error("❌ .gitignore ne contient pas 'tmp/'");
  console.error("   Refus de tourner — le rapport JSON contiendrait des bodies");
  console.error("   potentiellement PII et risquerait d'être commit par accident.");
  console.error("   Action : ajouter 'tmp/' au .gitignore puis relancer.");
  process.exit(3);
}

const TMP_DIR = resolve(process.cwd(), "tmp");
mkdirSync(TMP_DIR, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputPath = resolve(TMP_DIR, `first-sms-golden-${timestamp}.json`);

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline golden test
// ─────────────────────────────────────────────────────────────────────────────

console.log("=".repeat(80));
console.log("🎯 GOLDEN TEST — first-sms prompt S10.1.2.a v" + FIRST_SMS_PROMPT_VERSION);
console.log("=".repeat(80));
console.log(`Model       : ${FIRST_SMS_MODEL}`);
console.log(`Temperature : ${FIRST_SMS_TEMPERATURE}`);
console.log(`Contacts    : ${TEST_CONTACTS.length}`);
console.log(`Runs/contact: ${RUNS_PER_CONTACT}`);
console.log(`Total calls : ${TEST_CONTACTS.length * RUNS_PER_CONTACT}`);
console.log(`Output JSON : ${outputPath}`);
console.log();

const report = {
  timestamp: new Date().toISOString(),
  promptVersion: FIRST_SMS_PROMPT_VERSION,
  model: FIRST_SMS_MODEL,
  temperature: FIRST_SMS_TEMPERATURE,
  totalCalls: 0,
  compliancePassed: 0,
  contacts: [],
};

let totalCalls = 0;
let compliancePassed = 0;
let totalDurationMs = 0;
let totalTokensInput = 0;
let totalTokensOutput = 0;

for (const { label, contact } of TEST_CONTACTS) {
  console.log(`\n→ ${label}`);
  const contactReport = {
    label,
    contactSummary: {
      firstName: contact.firstName,
      lastName: contact.lastName,
      civilite: contact.civilite ?? "(undefined)",
      speciality: contact.speciality,
      city: contact.city === "" ? "(vide)" : contact.city,
    },
    runs: [],
  };

  for (let i = 0; i < RUNS_PER_CONTACT; i++) {
    totalCalls++;
    try {
      const result = await generateFirstSms({ contact });
      const hasAI = hasAIDisclosure(result.body);
      const hasOpt = hasOptOut(result.body);
      const hasAdv = hasAdvertiserIdentification(result.body);
      const length = result.body.length;
      const lengthOk = length >= FIRST_SMS_MIN_BODY_CHARS && length <= FIRST_SMS_MAX_BODY_CHARS;
      const allPass = hasAI && hasOpt && hasAdv && lengthOk;

      totalDurationMs += result.generationDurationMs;
      totalTokensInput += result.tokensInput;
      totalTokensOutput += result.tokensOutput;

      if (allPass) compliancePassed++;

      // Console : pas le body brut, juste flags + length.
      const flags = `AI=${hasAI ? "✓" : "✗"} STOP=${hasOpt ? "✓" : "✗"} MEDERE=${hasAdv ? "✓" : "✗"} len=${length}`;
      console.log(
        `  Run ${i + 1}/${RUNS_PER_CONTACT}: ${allPass ? "✅" : "❌"} ${flags} (${result.generationDurationMs}ms)`,
      );

      contactReport.runs.push({
        runIdx: i + 1,
        body: result.body,
        reasoning: result.reasoning,
        length,
        compliance: { hasAI, hasOpt, hasAdv, lengthOk },
        allPass,
        durationMs: result.generationDurationMs,
        tokensInput: result.tokensInput,
        tokensOutput: result.tokensOutput,
      });
    } catch (err) {
      console.log(
        `  Run ${i + 1}/${RUNS_PER_CONTACT}: ❌ EXCEPTION ${err.constructor?.name ?? "Error"}`,
      );
      const code = err.code ?? "(no code)";
      const message = err.message ?? "(no message)";
      console.log(`    ${code}: ${message}`);

      // 🆕 S10.1.2.a.2.0 — expose Zod issues sanitisées pour diagnostic.
      // `err.context.issues` est posé par `client.ts::generateWithTool` (S7a.1)
      // au format [{path: string, code: string}] — déjà sanitized (pas de
      // valeur brute, anti-fuite PII garantie côté wrapper).
      const issues = err.context?.issues ?? null;
      if (issues) {
        console.log(`    Zod issues : ${JSON.stringify(issues)}`);
      }

      contactReport.runs.push({
        runIdx: i + 1,
        error: {
          name: err.constructor?.name,
          code,
          message,
          // Diag-only : path + code sanitized depuis client.ts wrapper.
          // Pas de body/reasoning brut (anti-fuite PII).
          issues,
        },
        allPass: false,
      });
    }
  }
  report.contacts.push(contactReport);
}

report.totalCalls = totalCalls;
report.compliancePassed = compliancePassed;
report.averageDurationMs = Math.round(totalDurationMs / totalCalls);
report.totalTokensInput = totalTokensInput;
report.totalTokensOutput = totalTokensOutput;

writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf-8");

// ─────────────────────────────────────────────────────────────────────────────
// Sommaire final
// ─────────────────────────────────────────────────────────────────────────────

console.log();
console.log("=".repeat(80));
console.log(`📊 Sommaire : ${compliancePassed}/${totalCalls} conformes`);
console.log("=".repeat(80));
console.log(`Average duration : ${report.averageDurationMs}ms/call`);
console.log(`Total tokens in  : ${totalTokensInput}`);
console.log(`Total tokens out : ${totalTokensOutput}`);
console.log(`Rapport JSON     : ${outputPath}`);
console.log();

if (compliancePassed === totalCalls) {
  console.log("✅ GOLDEN TEST PASSED — drift 0% sur " + totalCalls + " runs.");
  console.log("   Prompt v" + FIRST_SMS_PROMPT_VERSION + " est compliance-conformé.");
  process.exit(0);
} else {
  console.log(
    "❌ GOLDEN TEST FAILED — " + (totalCalls - compliancePassed) + " bodies non conformes.",
  );
  console.log("   Inspecte le rapport JSON pour les détails (bodies + reasoning).");
  console.log("   Actions possibles :");
  console.log("     1. Re-lancer (transitoire SDK ?)");
  console.log("     2. Renforcer SYSTEM prompt sur le marqueur manquant");
  console.log("     3. Bumper prompt-engineer subagent pour révision");
  process.exit(1);
}
