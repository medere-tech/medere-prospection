/**
 * scripts/explore-ovh-sms.mjs — Reconnaissance READ-ONLY de l'API OVH SMS
 * pour préparer le webhook entrant Time2Chat (S9.6-EXPLORE, INFRA-SMS-001).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ⚠️ CE SCRIPT NE FAIT QUE DES `GET`. Aucun PUT / POST / DELETE / PATCH.
 * Il ne modifie RIEN sur le compte OVH. Il ne configure aucun callback.
 * Il ne crée ni ne révoque aucun consumer key. Objectif unique : LIRE la
 * config actuelle du service SMS + observer le format brut d'un SMS
 * entrant réel pour figer le parser du webhook (S9.6).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Utilisation :
 *
 *   npx tsx scripts/explore-ovh-sms.mjs
 *
 * (Pattern identique à `scripts/test-ovh-direct.mjs` : `.mjs` + tsx pour
 * résoudre l'import TS `../src/lib/ovh/client.ts` + le path alias `@/*`
 * via tsconfig.)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Env requises (lues depuis .env.local via dotenv) :
 *
 *   OVH_ENDPOINT           (ex: ovh-eu)
 *   OVH_APP_KEY
 *   OVH_APP_SECRET
 *   OVH_CONSUMER_KEY
 *   OVH_SMS_SERVICE_NAME   (ex: sms-ng66707-1)
 *
 * Le client OVH est le SINGLETON existant `getOvhClient()` de
 * `src/lib/ovh/client.ts` — donc auth strictement identique au pipeline
 * d'envoi qui tourne déjà en prod. Zéro ré-invention.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Anti-fuite secrets :
 *   - AUCUN dump de `OVH_APP_SECRET` / `OVH_CONSUMER_KEY` (ni entiers, ni
 *     tronqués). Seul un last-8 de l'APP_KEY (public par nature côté OVH)
 *     est loggé pour identification opérateur.
 *   - Le SDK `@ovhcloud/node-ovh` v3 ne loggue rien par défaut (cf.
 *     `src/lib/ovh/client.ts:35-36`).
 *   - Les réponses OVH sont loggées TELLES QUELLES pour figer le parser.
 *     Si un SMS entrant contient un vrai numéro/texte, c'est du test
 *     interne Déthié — on l'assume pour cette reco one-shot.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Tolérance aux erreurs :
 *   Chaque GET est isolé dans un try/catch. Un 403 (scope consumer key
 *   insuffisant) ou un 404 (endpoint inexistant sur ce type de service)
 *   NE stoppe PAS le script — on veut le maximum d'info en un seul run.
 *   Les erreurs sont loggées avec `{error, message}` (shape reject du
 *   SDK v3, cf. `src/lib/ovh/client.ts:20`).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { getOvhClient } from "../src/lib/ovh/client.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Guard env
// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED = [
  "OVH_ENDPOINT",
  "OVH_APP_KEY",
  "OVH_APP_SECRET",
  "OVH_CONSUMER_KEY",
  "OVH_SMS_SERVICE_NAME",
];

const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`❌ Vars OVH manquantes dans .env.local : ${missing.join(", ")}`);
  process.exit(1);
}

const SERVICE_NAME = process.env.OVH_SMS_SERVICE_NAME;
const ENDPOINT = process.env.OVH_ENDPOINT;
const APP_KEY_TAIL = process.env.OVH_APP_KEY.slice(-8);

// ─────────────────────────────────────────────────────────────────────────────
// En-tête
// ─────────────────────────────────────────────────────────────────────────────

console.log("=".repeat(80));
console.log("🔍 EXPLORE OVH SMS API — READ-ONLY (GET uniquement, zéro mutation)");
console.log("=".repeat(80));
console.log(`Endpoint OVH   : ${ENDPOINT}`);
console.log(`Service ciblé  : ${SERVICE_NAME}`);
console.log(`AppKey (last8) : …${APP_KEY_TAIL}`);
console.log("AppSecret      : [MASQUÉ]  ConsumerKey : [MASQUÉ] (jamais loggés)");
console.log("=".repeat(80));

// ─────────────────────────────────────────────────────────────────────────────
// Construction du client (peut throw ConfigError si Zod fail)
// ─────────────────────────────────────────────────────────────────────────────

let client;
try {
  client = getOvhClient();
} catch (err) {
  console.error("❌ getOvhClient() a throw — env probablement mal formée (Zod ConfigError) :");
  console.error(`  name    : ${err?.name}`);
  console.error(`  message : ${err?.message}`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper : GET tolérant, log complet, jamais fatal
// ─────────────────────────────────────────────────────────────────────────────

async function safeGet(label, path) {
  console.log("\n" + "─".repeat(80));
  console.log(`▶ ${label}`);
  console.log(`  GET ${path}`);
  console.log("─".repeat(80));
  try {
    const result = await client.requestPromised("GET", path);
    console.log(JSON.stringify(result, null, 2));
    return { ok: true, data: result };
  } catch (err) {
    // SDK OVH v3 reject avec { error, message } (cf. client.ts:20).
    const errObj = err && typeof err === "object" ? err : {};
    console.error("⚠️  Erreur (non fatale, on continue) :");
    console.error(`  error   : ${errObj.error ?? "(absent)"}`);
    console.error(`  message : ${errObj.message ?? "(absent)"}`);
    if (errObj.error === undefined && errObj.message === undefined) {
      console.error(`  raw     : ${String(err)}`);
    }
    return { ok: false, err: errObj };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Séquence de reconnaissance
// ─────────────────────────────────────────────────────────────────────────────

// 1. Liste des serviceName SMS du compte
//    → confirme quel service correspond (attendu sms-ng66707-1).
await safeGet("1. Liste des services SMS du compte", "/sms");

// 2. Config du service ciblé — c'est ICI que vivent les champs de
//    callback (callBack, smsResponse, autoResponder, etc.) qu'OVH accepte
//    en PUT. On ne PUT rien ici, on lit juste les noms de champs
//    disponibles pour savoir quoi câbler ensuite.
const serviceCfg = await safeGet(`2. Config du service ${SERVICE_NAME}`, `/sms/${SERVICE_NAME}`);

if (
  serviceCfg.ok &&
  serviceCfg.data &&
  typeof serviceCfg.data === "object" &&
  !Array.isArray(serviceCfg.data)
) {
  const CALLBACK_HINT_REGEX = /callback|callBack|response|url|hook|inbound/i;
  const callbackKeys = Object.keys(serviceCfg.data).filter((k) => CALLBACK_HINT_REGEX.test(k));
  console.log("\n🎯 Champs liés au callback trouvés dans la config service :");
  if (callbackKeys.length > 0) {
    for (const k of callbackKeys) {
      console.log(`   - ${k} = ${JSON.stringify(serviceCfg.data[k])}`);
    }
  } else {
    console.log(
      "   (aucun champ matchant /callback|response|url|hook|inbound/ — " +
        "à vérifier avec la doc OVH SMS actuelle, ou creuser un sous-endpoint " +
        "type /sms/{svc}/settings)",
    );
  }
}

// 3. Expéditeurs rattachés — le numéro Time2Chat +33939070545 doit y
//    figurer. Le nom d'endpoint OVH varie selon le type d'expéditeur :
//    - /senders       : expéditeurs alpha (Medere) + short codes
//    - /virtualNumbers: numéros virtuels type Time2Chat
//    On tente les 2 ; un 404 sur l'un est OK.
await safeGet("3a. Expéditeurs alpha / short codes (senders)", `/sms/${SERVICE_NAME}/senders`);
await safeGet(
  "3b. Numéros virtuels (virtualNumbers — probable Time2Chat)",
  `/sms/${SERVICE_NAME}/virtualNumbers`,
);

// 4. IDs des SMS entrants déjà stockés côté OVH (probablement vide au
//    départ si aucun test n'a encore été fait sur +33939070545).
const inbound = await safeGet(
  "4. IDs des SMS entrants stockés (incoming)",
  `/sms/${SERVICE_NAME}/incoming`,
);

// 5. Détail d'UN SMS entrant réel — 🎯 objectif clef : figer le format brut
//    OVH pour écrire le parser sans deviner.
if (inbound.ok && Array.isArray(inbound.data) && inbound.data.length > 0) {
  const firstId = inbound.data[0];
  await safeGet(
    `5. 🎯 PAYLOAD COMPLET d'un SMS entrant réel (id=${firstId})`,
    `/sms/${SERVICE_NAME}/incoming/${firstId}`,
  );
} else {
  console.log("\n" + "─".repeat(80));
  console.log("▶ 5. Détail SMS entrant");
  console.log("─".repeat(80));
  console.log(
    "ℹ️  Aucun SMS entrant à inspecter (étape 4 vide, en erreur, ou shape\n" +
      "   inattendue).\n" +
      "\n" +
      "   → Envoie 1 SMS de test depuis un mobile perso vers +33939070545,\n" +
      "     attends ~30s, puis relance ce script. L'étape 5 loggera alors\n" +
      "     le payload brut OVH tel qu'il sera aussi envoyé au webhook.",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Fin
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n" + "=".repeat(80));
console.log("✅ Reconnaissance terminée — READ-ONLY, aucune écriture chez OVH.");
console.log("=".repeat(80));
