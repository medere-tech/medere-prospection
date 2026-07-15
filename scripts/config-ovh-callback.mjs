/**
 * scripts/config-ovh-callback.mjs — Configure le callback SMS entrant OVH
 * pour pusher les réponses vers le webhook Vercel (S9.6-CONFIG, INFRA-SMS-001).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 CE SCRIPT PEUT ÉCRIRE SUR OVH (PUT /sms/{serviceName})
 *
 *   - Sans `--execute` : DRY-RUN. Aucune écriture, affiche seulement le body
 *     PUT qui SERAIT envoyé. Défaut safe-by-construction.
 *   - Avec `--execute` : demande une confirmation typée `YES-WRITE-OVH`
 *     avant de PUTter. Sans cette chaîne exacte : abandon.
 *
 * Le script ne fait AUCUN autre write : ni POST, ni DELETE, ni PATCH.
 * Une seule écriture PUT ciblant `/sms/{serviceName}` (champ `smsResponse`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Utilisation :
 *
 *   # 1. DRY-RUN — affiche le body PUT sans rien écrire
 *   npx tsx scripts/config-ovh-callback.mjs \
 *     --url=https://medere-prospection.vercel.app/api/webhooks/ovh-sms \
 *     --responseType=cgi
 *
 *   # 2. EXÉCUTION RÉELLE — écrit sur OVH après confirmation typée
 *   npx tsx scripts/config-ovh-callback.mjs \
 *     --url=https://medere-prospection.vercel.app/api/webhooks/ovh-sms \
 *     --responseType=cgi \
 *     --execute
 *
 * Alternative : passer l'URL via env `WEBHOOK_URL` au lieu de `--url=`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Env requises (lues via dotenv depuis .env.local) :
 *
 *   OVH_ENDPOINT           (ex: ovh-eu)
 *   OVH_APP_KEY
 *   OVH_APP_SECRET
 *   OVH_CONSUMER_KEY       ⚠️ doit inclure PUT /sms/{svc} dans son scope.
 *                             Le CK actuel a été créé sans ce droit (cf.
 *                             skill medere-ovh-sms:42-51 + observation
 *                             S9.6-EXPLORE 403 sur GET /sms global) → un
 *                             403 est attendu sur --execute. À ce moment,
 *                             régénérer un CK avec PUT /sms/* via POST
 *                             /auth/credential (procédure séparée).
 *   OVH_SMS_SERVICE_NAME   (ex: sms-ng66707-1)
 *   OVH_WEBHOOK_SECRET     (min 16 chars — token en query param appended)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ⚠️ VALEUR DE `--responseType` — À CONFIRMER PAR DÉTHIÉ VIA CONSOLE OVH
 *
 * Aucune valeur par défaut n'est devinée. Le script REFUSE de tourner sans
 * `--responseType=<valeur>` explicite.
 *
 * L'enum exact est listé dans la doc console OVH :
 *   https://eu.api.ovh.com/console/#/sms/%7BserviceName%7D#PUT
 *   → section `smsResponse.responseType` (avec session OVH connectée).
 *
 * Valeur ACTUELLE observée sur sms-ng66707-1 : "none" (désactivé).
 * Valeurs plausibles (parallèle sémantique à `cgiUrl`) mais NON VÉRIFIÉES :
 *   - "cgi"      → POST du texte de réponse vers cgiUrl (candidat n°1)
 *   - possibles variantes historiques : "cgiText", "cgiJson"…
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Anti-fuite secrets :
 *   - `OVH_WEBHOOK_SECRET` masqué dans TOUS les logs (`***MASKED***`)
 *   - `OVH_APP_SECRET`, `OVH_CONSUMER_KEY` jamais loggés (gérés par SDK)
 *   - Le token EST envoyé en clair dans le PUT à OVH — c'est le comportement
 *     attendu (c'est le shared secret que le webhook vérifie), mais il ne
 *     doit JAMAIS apparaître dans un log console.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import readline from "node:readline";

import { getOvhClient } from "../src/lib/ovh/client.ts";

// ─────────────────────────────────────────────────────────────────────────────
// CLI args parsing (manuel, pas de dépendance)
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { execute: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--execute") {
      args.execute = true;
    } else if (arg === "--dry-run") {
      // No-op explicite (le défaut est déjà dry-run)
      args.execute = false;
    } else if (arg.startsWith("--url=")) {
      args.url = arg.slice("--url=".length);
    } else if (arg.startsWith("--responseType=")) {
      args.responseType = arg.slice("--responseType=".length);
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      console.error(`❌ Argument inconnu : ${arg}`);
      process.exit(1);
    }
  }
  return args;
}

const args = parseArgs(process.argv);

if (args.help) {
  console.log(
    "Usage: npx tsx scripts/config-ovh-callback.mjs --url=<URL> --responseType=<VALUE> [--execute]\n" +
      "  --url=<URL>              URL du webhook Vercel (ou env WEBHOOK_URL)\n" +
      "  --responseType=<VALUE>   Enum OVH — à confirmer via console API OVH\n" +
      "  --execute                Écrit réellement (défaut = dry-run)\n" +
      "  --dry-run                Force le dry-run (défaut)",
  );
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard env + args
// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED_ENV = [
  "OVH_ENDPOINT",
  "OVH_APP_KEY",
  "OVH_APP_SECRET",
  "OVH_CONSUMER_KEY",
  "OVH_SMS_SERVICE_NAME",
  "OVH_WEBHOOK_SECRET",
];

const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`❌ Vars env manquantes dans .env.local : ${missing.join(", ")}`);
  process.exit(1);
}

if (process.env.OVH_WEBHOOK_SECRET.length < 16) {
  console.error("❌ OVH_WEBHOOK_SECRET fait moins de 16 caractères — Zod refuserait au boot Next.");
  process.exit(1);
}

const WEBHOOK_URL = args.url ?? process.env.WEBHOOK_URL;
if (!WEBHOOK_URL) {
  console.error(
    "❌ URL du webhook manquante. Passe --url=https://... ou set WEBHOOK_URL dans .env.local",
  );
  process.exit(1);
}

// Sanity URL : doit être https + finir par /api/webhooks/ovh-sms (contrat figé)
if (!WEBHOOK_URL.startsWith("https://")) {
  console.error(`❌ URL doit être en https:// — reçu : ${WEBHOOK_URL}`);
  process.exit(1);
}
if (!WEBHOOK_URL.endsWith("/api/webhooks/ovh-sms")) {
  console.error(
    `❌ URL doit se terminer par /api/webhooks/ovh-sms (path figé S9.6) — reçu : ${WEBHOOK_URL}`,
  );
  process.exit(1);
}

if (!args.responseType) {
  console.error(
    "❌ --responseType=<valeur> est OBLIGATOIRE.\n\n" +
      "   Aucune valeur n'est devinée par le script — l'enum exact des valeurs\n" +
      "   valides côté OVH n'est PAS documenté dans le repo. Confirme la valeur\n" +
      "   via la console API OVH :\n" +
      "     https://eu.api.ovh.com/console/#/sms/%7BserviceName%7D#PUT\n" +
      "     → section smsResponse.responseType (session OVH connectée)\n\n" +
      "   Valeur actuelle observée : 'none' (désactivé)\n" +
      "   Candidat plausible mais NON VÉRIFIÉ : 'cgi'",
  );
  process.exit(1);
}

const SERVICE_NAME = process.env.OVH_SMS_SERVICE_NAME;
const ENDPOINT = process.env.OVH_ENDPOINT;
const SECRET = process.env.OVH_WEBHOOK_SECRET;

/** URL réelle (envoyée à OVH) — jamais loggée telle quelle. */
const REAL_CGI_URL = `${WEBHOOK_URL}?token=${SECRET}`;
/** URL masquée (loggée) — le secret est remplacé par ***MASKED***. */
const MASKED_CGI_URL = `${WEBHOOK_URL}?token=***MASKED***`;

// ─────────────────────────────────────────────────────────────────────────────
// En-tête
// ─────────────────────────────────────────────────────────────────────────────

console.log("=".repeat(80));
console.log("🛠️  CONFIG OVH SMS CALLBACK — S9.6-CONFIG (INFRA-SMS-001)");
console.log("=".repeat(80));
console.log(`Endpoint OVH    : ${ENDPOINT}`);
console.log(`Service ciblé   : ${SERVICE_NAME}`);
console.log(`Webhook URL     : ${WEBHOOK_URL}`);
console.log(`Token (masqué)  : ***MASKED*** (${SECRET.length} chars)`);
console.log(`responseType    : ${args.responseType}`);
console.log(
  `Mode            : ${args.execute ? "🚨 EXECUTE (PUT réel)" : "🛡️  DRY-RUN (aucune écriture)"}`,
);
console.log("=".repeat(80));

// ─────────────────────────────────────────────────────────────────────────────
// Construction du client
// ─────────────────────────────────────────────────────────────────────────────

let client;
try {
  client = getOvhClient();
} catch (err) {
  console.error("❌ getOvhClient() a throw — env probablement mal formée :");
  console.error(`  name    : ${err?.name}`);
  console.error(`  message : ${err?.message}`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function logSection(title) {
  console.log("\n" + "─".repeat(80));
  console.log(`▶ ${title}`);
  console.log("─".repeat(80));
}

function logOvhError(err) {
  const errObj = err && typeof err === "object" ? err : {};
  console.error(`  error   : ${errObj.error ?? "(absent)"}`);
  console.error(`  message : ${errObj.message ?? "(absent)"}`);
  if (errObj.error === undefined && errObj.message === undefined) {
    console.error(`  raw     : ${String(err)}`);
  }
}

function askConfirmation(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ÉTAPE A — GET config actuelle (toujours, lecture seule)
// ─────────────────────────────────────────────────────────────────────────────

logSection(`A. GET /sms/${SERVICE_NAME} — config smsResponse actuelle`);

let currentSmsResponse;
try {
  const cfg = await client.requestPromised("GET", `/sms/${SERVICE_NAME}`);
  if (cfg && typeof cfg === "object" && "smsResponse" in cfg) {
    currentSmsResponse = cfg.smsResponse;
    console.log("Config smsResponse actuelle :");
    console.log(JSON.stringify(currentSmsResponse, null, 2));
  } else {
    console.log("⚠️  Champ smsResponse absent de la réponse — shape service inattendue.");
    console.log(JSON.stringify(cfg, null, 2));
  }
} catch (err) {
  console.error("❌ GET a échoué — impossible de lire la config actuelle. On stoppe :");
  logOvhError(err);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// ÉTAPE B — Construction et affichage du body PUT (dry-run + execute)
// ─────────────────────────────────────────────────────────────────────────────

const putBody = {
  smsResponse: {
    cgiUrl: REAL_CGI_URL,
    responseType: args.responseType,
  },
};

const maskedBody = {
  smsResponse: {
    cgiUrl: MASKED_CGI_URL,
    responseType: args.responseType,
  },
};

logSection(`B. Body PUT à envoyer (token masqué dans ce log)`);
console.log(`  PUT /sms/${SERVICE_NAME}`);
console.log(JSON.stringify(maskedBody, null, 2));

// Diff résumé
if (currentSmsResponse) {
  console.log("\n📊 Changement demandé :");
  console.log(`   cgiUrl        : "${currentSmsResponse.cgiUrl ?? ""}"  →  "${MASKED_CGI_URL}"`);
  console.log(
    `   responseType  : "${currentSmsResponse.responseType ?? ""}"  →  "${args.responseType}"`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ÉTAPE C — PUT (uniquement si --execute + confirmation typée)
// ─────────────────────────────────────────────────────────────────────────────

if (!args.execute) {
  console.log("\n" + "=".repeat(80));
  console.log("🛡️  DRY-RUN — aucune écriture effectuée sur OVH.");
  console.log("   Pour écrire réellement, relance avec --execute :");
  console.log(
    `     npx tsx scripts/config-ovh-callback.mjs --url=${WEBHOOK_URL} --responseType=${args.responseType} --execute`,
  );
  console.log("=".repeat(80));
  process.exit(0);
}

logSection("C. Confirmation avant PUT réel");
console.log("🚨 Tu es sur le point d'ÉCRIRE la config OVH.");
console.log("   Le token du webhook sera envoyé en clair dans le body (comportement");
console.log("   attendu — c'est le shared secret que le webhook vérifie).");
console.log("");
console.log("   Tape exactement `YES-WRITE-OVH` (sans backticks) pour confirmer,");
console.log("   n'importe quoi d'autre pour abandonner.");
console.log("");
const answer = (await askConfirmation("Confirmation> ")).trim();

if (answer !== "YES-WRITE-OVH") {
  console.log(`\n⛔ Confirmation invalide (reçu : "${answer}"). Aucune écriture. Abandon.`);
  process.exit(0);
}

logSection("C.bis. PUT en cours...");
try {
  const putResult = await client.requestPromised("PUT", `/sms/${SERVICE_NAME}`, putBody);
  console.log("✅ PUT accepté par OVH.");
  console.log("Réponse brute (peut être null pour un PUT réussi) :");
  console.log(JSON.stringify(putResult, null, 2));
} catch (err) {
  console.error("❌ PUT a échoué :");
  logOvhError(err);
  const errObj = err && typeof err === "object" ? err : {};
  if (errObj.error === 403) {
    console.error("");
    console.error("🔑 403 → le consumer key actuel n'inclut probablement PAS PUT /sms/*.");
    console.error("   Régénère un CK avec le scope étendu via POST /auth/credential :");
    console.error("     accessRules: [ ...scope actuel..., { method: 'PUT', path: '/sms/*' } ]");
    console.error("   Puis valide l'URL retournée et remplace OVH_CONSUMER_KEY dans .env.local.");
  }
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// ÉTAPE D — Vérif post-PUT via re-GET
// ─────────────────────────────────────────────────────────────────────────────

logSection(`D. Vérif post-PUT — re-GET /sms/${SERVICE_NAME}`);

try {
  const cfgAfter = await client.requestPromised("GET", `/sms/${SERVICE_NAME}`);
  const smsResponseAfter =
    cfgAfter && typeof cfgAfter === "object" ? cfgAfter.smsResponse : undefined;

  if (!smsResponseAfter) {
    console.log("⚠️  smsResponse absent post-GET — vérif visuelle impossible.");
    process.exit(1);
  }

  console.log("Config smsResponse APRÈS PUT :");
  // Masque le token si OVH le renvoie tel quel dans le GET.
  const maskedAfter = {
    ...smsResponseAfter,
    cgiUrl:
      typeof smsResponseAfter.cgiUrl === "string" && smsResponseAfter.cgiUrl.includes("token=")
        ? smsResponseAfter.cgiUrl.replace(/token=[^&]+/, "token=***MASKED***")
        : smsResponseAfter.cgiUrl,
  };
  console.log(JSON.stringify(maskedAfter, null, 2));

  // Assertions
  const expectedCgi = REAL_CGI_URL;
  const okCgi = smsResponseAfter.cgiUrl === expectedCgi;
  const okType = smsResponseAfter.responseType === args.responseType;

  console.log("\n📋 Vérif :");
  console.log(`   cgiUrl        : ${okCgi ? "✅ OK" : "❌ MISMATCH"} (attendu ${MASKED_CGI_URL})`);
  console.log(
    `   responseType  : ${okType ? "✅ OK" : "❌ MISMATCH"} (attendu ${args.responseType})`,
  );

  if (okCgi && okType) {
    console.log("\n" + "=".repeat(80));
    console.log("✅ Callback OVH configuré. OVH POSTera désormais les SMS entrants vers :");
    console.log(`   ${MASKED_CGI_URL}`);
    console.log("");
    console.log("   Prochaine étape : envoyer 1 SMS de test depuis un mobile perso vers");
    console.log("   +33939070545, puis vérifier dans le dashboard Inngest que l'event");
    console.log("   medere/sms.reply.received est bien reçu et traité par process-reply.");
    console.log("=".repeat(80));
  } else {
    console.log("\n⚠️  Un ou plusieurs champs ne correspondent pas à ce qui a été PUT.");
    console.log("    OVH a peut-être rejeté silencieusement la valeur responseType.");
    console.log("    Consulte la doc console API OVH pour l'enum exact.");
    process.exit(1);
  }
} catch (err) {
  console.error("❌ Re-GET a échoué — impossible de vérifier :");
  logOvhError(err);
  process.exit(1);
}
