/**
 * SET-STOP-CALLBACK — configure le champ `sms.Account.stopCallBack` du
 * service OVH SMS pour router les STOP vers notre endpoint
 * d'observation `/api/webhooks/ovh-sms-stop` (DIAG-STOP-OVH étape B).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Usage
 *
 *   npx tsx scripts/set-stop-callback.mjs            # dry-run (default)
 *   npx tsx scripts/set-stop-callback.mjs --apply    # applique le PUT
 *   npx tsx scripts/set-stop-callback.mjs --revert   # repasse stopCallBack=""
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Preuve API acceptee
 *
 * Schéma OVH `https://eu.api.ovh.com/1.0/sms.json` (verifie par le
 * script d'audit) :
 *   PUT /sms/{serviceName}
 *     body: sms.Account (object)
 *   sms.Account.stopCallBack :
 *     { type: "string", canBeNull: true, readOnly: false,
 *       description: "URL called when a STOP is received after a
 *                     receiver replied stop to a SMS" }
 *
 * Donc PUT /sms/{service} {stopCallBack: "https://..."} est VALIDE.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Garde-fous
 *
 *   - --apply refuse si `stopCallBack` actuel n'est PAS la chaine vide
 *     (""), sauf si `--force` est explicitement passe (non expose ici
 *     pour minimiser la surface — modif ulterieure = re-review).
 *   - --revert refuse si `stopCallBack` actuel ne pointe PAS vers notre
 *     endpoint. On ne reset pas une valeur qu'on n'a pas posee.
 *   - Dry-run affiche la cible MASQUEE (host + path, query strippee)
 *     pour ne jamais logger le token OVH.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pre-requis .env.local
 *   - OVH_ENDPOINT, OVH_APP_KEY, OVH_APP_SECRET, OVH_CONSUMER_KEY
 *   - OVH_SMS_SERVICE_NAME (= sms-ng66707-1 en prod)
 *   - OVH_WEBHOOK_SECRET (token query de notre endpoint)
 *   - DASHBOARD_URL ou NEXT_PUBLIC_APP_URL optionnel (sinon fallback
 *     https://medere-prospection.vercel.app)
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { getOvhClient } from "../src/lib/ovh/client.ts";
import { getOvhEnv } from "../src/lib/security/env.ts";
import { scrubOvhErrorMessage } from "./_lib/ovh-scrub.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

const ENDPOINT_PATH = "/api/webhooks/ovh-sms-stop";
const DASHBOARD_URL_FALLBACK = "https://medere-prospection.vercel.app";

// ─────────────────────────────────────────────────────────────────────────────
// Garde ecriture pour les GET (lecture seule). Les PUT passent par un
// chemin separe `requestWrite` qui est le SEUL endroit a utiliser `PUT`.
// ─────────────────────────────────────────────────────────────────────────────

const client = getOvhClient();

async function requestReadOnly(path) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("requestReadOnly: path invalide");
  }
  return client.requestPromised("GET", path);
}

async function requestPutUnsafe(path, body) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("requestPutUnsafe: path invalide");
  }
  return client.requestPromised("PUT", path, body);
}

// ─────────────────────────────────────────────────────────────────────────────
// Masquage URL (strippe query = masque le token)
// ─────────────────────────────────────────────────────────────────────────────

function maskUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0) return raw;
  try {
    const u = new URL(raw);
    const queryMasked = u.search ? "?<query-masked>" : "";
    return `${u.origin}${u.pathname}${queryMasked}`;
  } catch {
    return "(malformed-url)";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Construit l'URL cible stopCallBack (token OVH en query)
// ─────────────────────────────────────────────────────────────────────────────

function buildTargetUrl(env) {
  const base =
    typeof env.NEXT_PUBLIC_APP_URL === "string" && env.NEXT_PUBLIC_APP_URL.length > 0
      ? env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")
      : DASHBOARD_URL_FALLBACK;
  // Note : le token OVH_WEBHOOK_SECRET est passe en query param, meme
  // mecanisme que /api/webhooks/ovh-sms. Il ne doit JAMAIS apparaitre
  // dans la console — toutes les sorties passent par `maskUrl`.
  return `${base}${ENDPOINT_PATH}?token=${encodeURIComponent(env.OVH_WEBHOOK_SECRET)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function readCurrentConfig(serviceName) {
  const svc = await requestReadOnly(`/sms/${encodeURIComponent(serviceName)}`);
  if (svc === null || typeof svc !== "object") {
    throw new Error("GET /sms/{service} : reponse OVH inattendue");
  }
  return svc;
}

async function main() {
  const mode = process.argv.includes("--apply")
    ? "apply"
    : process.argv.includes("--revert")
      ? "revert"
      : "dry-run";

  const env = getOvhEnv();
  // NEXT_PUBLIC_APP_URL vient de core, pas de getOvhEnv — on le lit direct.
  const coreEnv = {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    OVH_WEBHOOK_SECRET: env.OVH_WEBHOOK_SECRET,
  };
  const serviceName = env.OVH_SMS_SERVICE_NAME;
  const targetUrl = buildTargetUrl(coreEnv);
  const targetUrlMasked = maskUrl(targetUrl);

  console.log("");
  console.log(`SET-STOP-CALLBACK — mode : ${mode}`);
  console.log(`OVH endpoint   : ${env.OVH_ENDPOINT}`);
  console.log(`Service        : ${serviceName}`);
  console.log(`Cible (masquee): ${targetUrlMasked}`);
  console.log("");

  const before = await readCurrentConfig(serviceName);
  console.log(
    `stopCallBack actuel : ${maskUrl(typeof before.stopCallBack === "string" ? before.stopCallBack : "")} ${before.stopCallBack === "" ? "(VIDE)" : ""}`,
  );
  console.log("");

  if (mode === "dry-run") {
    console.log(
      "Dry-run : aucune ecriture. Pour appliquer : relance avec --apply (si stopCallBack actuel est vide).",
    );
    return;
  }

  if (mode === "apply") {
    if (before.stopCallBack !== "") {
      console.error(
        `Garde-fou : stopCallBack n'est PAS vide (${maskUrl(String(before.stopCallBack))}). Refus de l'ecraser.`,
      );
      console.error(
        "Si tu veux vraiment ecraser, --revert d'abord (si c'est notre valeur) OU edite via le Manager OVH.",
      );
      process.exit(5);
    }
    console.log(
      "Garde-fou OK (actuel vide). Application PUT /sms/{service} {stopCallBack: <cible>}...",
    );
    await requestPutUnsafe(`/sms/${encodeURIComponent(serviceName)}`, {
      stopCallBack: targetUrl,
    });
    console.log("PUT OK. Relecture...");
    const after = await readCurrentConfig(serviceName);
    console.log(
      `stopCallBack apres  : ${maskUrl(typeof after.stopCallBack === "string" ? after.stopCallBack : "")}`,
    );
    if (typeof after.stopCallBack === "string" && after.stopCallBack === targetUrl) {
      console.log("Confirmation : la valeur persistee correspond EXACTEMENT a la cible.");
    } else {
      console.error(
        "ANOMALIE : la valeur relue ne correspond PAS a la cible. Investiguer manuellement.",
      );
      process.exit(6);
    }
    return;
  }

  if (mode === "revert") {
    // On n'accepte revert QUE si la valeur actuelle pointe vers notre
    // endpoint (meme host + meme path), peu importe le token. Sinon la
    // valeur a ete posee par quelqu'un d'autre et on refuse de l'ecraser.
    const current = typeof before.stopCallBack === "string" ? before.stopCallBack : "";
    let currentOrigin = null;
    let currentPath = null;
    try {
      const u = new URL(current);
      currentOrigin = u.origin;
      currentPath = u.pathname;
    } catch {
      // mal formee ou vide
    }
    const targetUrlObj = new URL(targetUrl);
    if (currentOrigin !== targetUrlObj.origin || currentPath !== targetUrlObj.pathname) {
      console.error(
        `Garde-fou revert : la valeur actuelle ne pointe PAS vers notre endpoint (host/path differents). Refus.`,
      );
      process.exit(5);
    }
    console.log("Garde-fou revert OK (valeur actuelle = notre endpoint). PUT stopCallBack=''...");
    await requestPutUnsafe(`/sms/${encodeURIComponent(serviceName)}`, {
      stopCallBack: "",
    });
    const after = await readCurrentConfig(serviceName);
    console.log(
      `stopCallBack apres revert : ${maskUrl(typeof after.stopCallBack === "string" ? after.stopCallBack : "")} ${after.stopCallBack === "" ? "(VIDE)" : ""}`,
    );
    if (after.stopCallBack === "") {
      console.log("Revert OK.");
    } else {
      console.error("ANOMALIE revert : stopCallBack n'est pas vide apres PUT. Investiguer.");
      process.exit(6);
    }
    return;
  }
}

main().catch((err) => {
  // scrubOvhErrorMessage : les erreurs OVH peuvent contenir receiver=0033...
  const name = err && err.name ? err.name : "unknown";
  const msg = err && err.message ? err.message : "no message";
  console.error(`Erreur fatale : ${name} - ${scrubOvhErrorMessage(msg)}`);
  process.exit(1);
});
