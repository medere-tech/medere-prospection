/**
 * scripts/regenerate-ovh-ck.mjs -- Genere un NOUVEAU consumer key OVH avec
 * un scope elargi (ajoute PUT /sms/*) pour debloquer S9.6-CONFIG
 * (config du callback smsResponse.cgiUrl via PUT /sms/{serviceName}).
 *
 * ---------------------------------------------------------------------------
 * [!] CE QUE FAIT CE SCRIPT
 *
 *   - Un SEUL appel reseau : POST /auth/credential sur l'API OVH avec
 *     les accessRules ci-dessous + une redirection cosmetique.
 *   - AUCUN write "metier" : ne touche a AUCUNE donnee SMS/contact.
 *   - Le CK retourne est INACTIF tant que Dethie n'a pas visite la
 *     validationUrl et clique "Valider" cote OVH connecte.
 *   - N'ecrit RIEN dans .env.local -- Dethie colle le CK a la main.
 *
 * ---------------------------------------------------------------------------
 * SCOPE DEMANDE (skill medere-ovh-sms:42-51 + PUT /sms/* ajoute S9.6-CK)
 *
 *   GET  /sms                    -- liste globale (403 avec le CK actuel)
 *   GET  /sms/*                  -- wildcard sur les sous-endpoints
 *   POST /sms/* /jobs            -- envoi SMS (deja utilise par send-sms.ts)
 *   GET  /sms/* /outgoing[/*]    -- historique sortant
 *   GET  /sms/* /incoming[/*]    -- historique entrant (explore S9.6-EXPLORE)
 *   PUT  /sms/*                  -- [NEW] config service (callback cgiUrl)
 *
 * ---------------------------------------------------------------------------
 * ANTI-FUITE SECRETS
 *
 *   - OVH_APP_SECRET : jamais logge (gere par SDK, pas manipule ici).
 *   - OVH_CONSUMER_KEY actuel : PAS lu par ce script (le nouveau CK est
 *     cree independamment via appKey+appSecret uniquement).
 *   - Le NOUVEAU consumerKey est logge EN CLAIR -- c'est le livrable
 *     attendu du script, pas une fuite. Dethie le copie manuellement.
 *   - validationUrl loggee -- c'est une URL ephemere qu'OVH utilise pour
 *     valider le CK, publiquement partageable sans risque.
 *
 * ---------------------------------------------------------------------------
 * Utilisation :
 *
 *   npx tsx scripts/regenerate-ovh-ck.mjs
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import ovhApi from "@ovhcloud/node-ovh";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/**
 * Scope demande. Reprend integralement le scope documente dans le skill
 * medere-ovh-sms:42-51 (snapshot du scope initial voulu) + ajoute PUT
 * /sms/* (nouveau droit S9.6-CK pour configurer le callback).
 *
 * On garde GET /sms meme si le CK actuel donnait 403 dessus -- le nouveau
 * CK doit l'avoir pour eviter tout futur 403 sur la liste globale.
 *
 * [!] Ordre strictement controle, wildcards limites a /sms/* -- principe
 * du moindre privilege. Pas de DELETE, pas de /me/*, pas de PUT/POST hors
 * /sms/*.
 */
const ACCESS_RULES = [
  { method: "GET", path: "/sms" },
  { method: "GET", path: "/sms/*" },
  { method: "POST", path: "/sms/*/jobs" },
  { method: "GET", path: "/sms/*/outgoing" },
  { method: "GET", path: "/sms/*/outgoing/*" },
  { method: "GET", path: "/sms/*/incoming" },
  { method: "GET", path: "/sms/*/incoming/*" },
  { method: "PUT", path: "/sms/*" },
];

/**
 * URL de redirection apres validation manuelle du CK cote OVH. Purement
 * cosmetique -- OVH y redirige le navigateur apres le "Valider" pour un
 * retour propre. Aucun impact sur le CK lui-meme.
 */
const REDIRECTION = "https://www.ovh.com/";

// ---------------------------------------------------------------------------
// Guard env
// ---------------------------------------------------------------------------

const REQUIRED_ENV = ["OVH_ENDPOINT", "OVH_APP_KEY", "OVH_APP_SECRET"];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`[ERR] Vars env manquantes dans .env.local : ${missing.join(", ")}`);
  process.exit(1);
}

const ENDPOINT = process.env.OVH_ENDPOINT;
const APP_KEY = process.env.OVH_APP_KEY;
const APP_SECRET = process.env.OVH_APP_SECRET;

// ---------------------------------------------------------------------------
// En-tete
// ---------------------------------------------------------------------------

console.log("=".repeat(80));
console.log("[KEY] REGENERATE OVH CONSUMER KEY -- S9.6-CK (INFRA-SMS-001)");
console.log("=".repeat(80));
console.log(`Endpoint OVH     : ${ENDPOINT}`);
console.log(`AppKey (last 8)  : ...${APP_KEY.slice(-8)}`);
console.log(`AppSecret        : [MASQUE]`);
console.log(`Redirection      : ${REDIRECTION}`);
console.log("");
console.log("AccessRules demandees :");
for (const r of ACCESS_RULES) {
  const marker = r.method === "PUT" ? "[NEW]" : "     ";
  console.log(`  ${marker} ${r.method.padEnd(5)} ${r.path}`);
}
console.log("=".repeat(80));

// ---------------------------------------------------------------------------
// Mini-client OVH dedie (SANS consumerKey -- normal, on en cree un nouveau)
// ---------------------------------------------------------------------------

/**
 * Client OVH minimal, distinct du singleton getOvhClient() de
 * src/lib/ovh/client.ts. Ne prend PAS consumerKey -- l'endpoint
 * POST /auth/credential n'en a pas besoin (c'est justement celui qui
 * CREE un CK). Isolation propre + pas de dependance a OVH_CONSUMER_KEY
 * (qui va justement etre remplace apres ce run).
 */
const ovh = ovhApi({
  endpoint: ENDPOINT,
  appKey: APP_KEY,
  appSecret: APP_SECRET,
});

// ---------------------------------------------------------------------------
// Appel POST /auth/credential
// ---------------------------------------------------------------------------

console.log("\n> POST /auth/credential -- generation d'un nouveau CK...\n");

let result;
try {
  result = await ovh.requestPromised("POST", "/auth/credential", {
    accessRules: ACCESS_RULES,
    redirection: REDIRECTION,
  });
} catch (err) {
  const errObj = err && typeof err === "object" ? err : {};
  console.error("[ERR] POST /auth/credential a echoue :");
  console.error(`  error   : ${errObj.error ?? "(absent)"}`);
  console.error(`  message : ${errObj.message ?? "(absent)"}`);
  if (errObj.error === undefined && errObj.message === undefined) {
    console.error(`  raw     : ${String(err)}`);
  }
  console.error("");
  console.error("Causes possibles :");
  console.error("  - OVH_APP_KEY/OVH_APP_SECRET invalides ou revoques");
  console.error("  - OVH_ENDPOINT ne correspond pas a la region de l'app OVH");
  console.error("  - Panne temporaire OVH (retry dans quelques minutes)");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Livrable -- consumerKey + validationUrl
// ---------------------------------------------------------------------------

const { consumerKey, validationUrl, state } = result ?? {};

if (!consumerKey || !validationUrl) {
  console.error("[ERR] Reponse OVH inattendue -- champs consumerKey/validationUrl manquants :");
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}

console.log("[OK] Nouveau CK genere avec succes (INACTIF tant que non valide).\n");
console.log("-".repeat(80));
console.log("[LIVRABLE] a copier maintenant");
console.log("-".repeat(80));
console.log("");
console.log("  NEW OVH_CONSUMER_KEY =");
console.log(`  ${consumerKey}`);
console.log("");
console.log("  VALIDATION URL (a ouvrir dans un navigateur avec ta session OVH) =");
console.log(`  ${validationUrl}`);
console.log("");
console.log(`  Etat initial      : ${state ?? "(inconnu)"}`);
console.log("-".repeat(80));

// ---------------------------------------------------------------------------
// Marche a suivre
// ---------------------------------------------------------------------------

console.log("");
console.log("[MARCHE A SUIVRE] :");
console.log("");
console.log("  1. COPIE le consumerKey ci-dessus (il n'est visible qu'ICI, une seule fois).");
console.log("");
console.log("  2. OUVRE la validation URL dans ton navigateur, connecte-toi a OVH avec");
console.log("     ton compte admin, et clique sur 'Valider'. Sans cette etape le CK");
console.log("     reste 'pendingValidation' et TOUT appel API avec lui renverra 403.");
console.log("");
console.log("  3. Dans .env.local, REMPLACE la valeur de OVH_CONSUMER_KEY par le");
console.log("     nouveau CK copie a l'etape 1. Ne SUPPRIME PAS l'ancien tout de suite --");
console.log("     garde-le en commentaire au cas ou (# OVH_CONSUMER_KEY_OLD=...).");
console.log("");
console.log("  4. Verifie que le nouveau CK est actif (preuve : GET /sms qui donnait");
console.log("     403 avant doit maintenant renvoyer la liste) :");
console.log("");
console.log("       npx tsx scripts/explore-ovh-sms.mjs");
console.log("");
console.log("     Si l'etape 1 (GET /sms) donne toujours 403, retourne a l'etape 2");
console.log("     (validation manuelle non effectuee).");
console.log("");
console.log("  5. Relance le script de config callback (d'abord dry-run, puis --execute) :");
console.log("");
console.log("       # Dry-run pour verifier le body PUT");
console.log("       npx tsx scripts/config-ovh-callback.mjs \\");
console.log("         --url=https://<domaine-vercel>/api/webhooks/ovh-sms \\");
console.log("         --responseType=<valeur confirmee via console API OVH>");
console.log("");
console.log("       # Execute reel (avec confirmation typee YES-WRITE-OVH)");
console.log("       npx tsx scripts/config-ovh-callback.mjs \\");
console.log("         --url=https://<domaine-vercel>/api/webhooks/ovh-sms \\");
console.log("         --responseType=<valeur confirmee> \\");
console.log("         --execute");
console.log("");
console.log("  6. Une fois le PUT accepte, envoie 1 SMS test depuis un mobile perso vers");
console.log("     +33939070545 et verifie dans le dashboard Inngest que l'event");
console.log("     medere/sms.reply.received est bien recu et traite par process-reply.");
console.log("");
console.log("=".repeat(80));
console.log("[OK] Script termine -- aucun write sur les donnees SMS. A toi de jouer.");
console.log("=".repeat(80));
