/**
 * DIAG-STOP-OBSERVE — observation du pipeline STOP apres configuration
 * de `sms.Account.stopCallBack`. Lecture seule stricte (Firestore + OVH).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Usage
 *
 *   npx tsx scripts/diag-stop-observe.mjs
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Ce que ce script fait
 *
 *   1. Firestore `ovh_stop_callbacks/` : liste tous les docs, affiche
 *      receivedAt (UTC), method, contentType, noms des parametres query
 *      + body avec leurs types et longueurs. Les valeurs sont DEJA
 *      masquees en base (hash `oih_` ou `{type:"text", length}`) — on
 *      NE DEMASQUE PAS, on affiche tel quel.
 *
 *   2. OVH GET uniquement sur la fenetre 2026-10-16T16:45:00Z -> maintenant :
 *      - /sms/{service}/incoming
 *      - /sms/{service}/virtualNumbers/0033939070545/incoming
 *      - /sms/{service}/blacklists (filtre dateCreation > 16:45 UTC)
 *      Numeros toujours masques (4 derniers chiffres).
 *
 *   3. Valeur actuelle de `sms.Account.stopCallBack` du service, URL
 *      masquee (origin + path, query strippee).
 *
 *   4. OVH `/sms/{service}/outgoing` filtre sur la meme fenetre.
 *      Pour chaque id : creationDatetime, sender (masque si numerique),
 *      receiver (4 derniers chiffres), message en TEXTE COMPLET (test,
 *      aucune PS reelle en production sur ce circuit), ptt,
 *      deliveryReceipt, credits.
 *      Ajoute `sms.Account.creditsLeft` actuel du service.
 *
 *   5a. Objet BRUT COMPLET de GET /sms/{service}/outgoing/817595690
 *       (toutes les cles exposees par OVH, y compris tag, batch, sentAt,
 *       differedDelivery...). receiver masque aux 4 derniers chiffres.
 *       Le reste des cles affichees telles quelles (test).
 *   5b. Firestore : TOUS les messages (inbound + outbound) des
 *       conversations du contact 427963864300 crees depuis
 *       2026-10-16T16:45:00Z. Pour chacun : direction, createdAt,
 *       outboundKind, status, externalId (= ovhJobId / ovhMessageId
 *       selon la direction), body (texte complet, test).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Contrat ecriture
 *
 *   Zero ecriture Firestore (tous les reads via `.get()` / `.doc().get()`).
 *   Zero ecriture OVH (verrou `requestReadOnly` qui force la methode a GET).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pre-requis .env.local
 *   - OVH_ENDPOINT, OVH_APP_KEY, OVH_APP_SECRET, OVH_CONSUMER_KEY
 *   - OVH_SMS_SERVICE_NAME (= sms-ng66707-1 en prod)
 *   - FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 *   - AUDIT_PII_PEPPER (requis par le wrapper audit charge indirectement
 *     via le module admin SDK)
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

import { listConversationIdsByContact } from "../src/lib/firestore/conversations.ts";
import { getOvhClient } from "../src/lib/ovh/client.ts";
import { OVH_STOP_CALLBACKS_COLLECTION } from "../src/lib/ovh/stop-callback.ts";
import { getOvhEnv } from "../src/lib/security/env.ts";
import { scrubOvhErrorMessage } from "./_lib/ovh-scrub.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

// Fenetre callbacks Firestore + blacklist OVH : depuis la configuration
// de stopCallBack (bloc 1 + partie blacklist du bloc 2).
const OBSERVATION_WINDOW_FROM_UTC = "2026-10-16T16:45:00Z";

// Fenetre incoming/outgoing elargie (bloc 2.a/2.b + bloc 4) : toute la
// journee du 16/10 UTC. Permet de capter le message qui a declenche la
// reponse automatique OVH du 17/10 11:19:21Z.
const DAY_WINDOW_FROM_UTC = "2026-10-16T00:00:00Z";
const DAY_WINDOW_TO_UTC = "2026-10-16T23:59:59Z";

const VIRTUAL_NUMBER = "0033939070545"; // format OVH natif (sans +)
const OUTGOING_INSPECT_ID = "817595690"; // bloc 5a : dump brut complet
const TEST_CONTACT_ID = "427963864300"; // bloc 5b : contact Firestore scope

// ─────────────────────────────────────────────────────────────────────────────
// Init Firebase Admin
// ─────────────────────────────────────────────────────────────────────────────

function initFirebaseAdminOrDie() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawKey = process.env.FIREBASE_PRIVATE_KEY;
  if (!projectId || !clientEmail || !rawKey) {
    console.error(
      "Env manquant : FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY",
    );
    process.exit(2);
  }
  const privateKey = rawKey.replace(/\\n/g, "\n");
  if (getApps().length === 0) {
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  }
  return { db: getFirestore(), projectId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fail-fast R4-fix : toute erreur de lecture arrete le script
// ─────────────────────────────────────────────────────────────────────────────

function failFast(message, err) {
  // scrubOvhErrorMessage : masque les numeros dans path et err.message.
  const detail = err && err.message ? err.message : String(err ?? "unknown");
  console.error("");
  console.error("DIAGNOSTIC INCOMPLET");
  console.error(`  ${scrubOvhErrorMessage(message)}`);
  console.error(`  erreur : ${scrubOvhErrorMessage(detail)}`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Verrou OVH GET uniquement
// ─────────────────────────────────────────────────────────────────────────────

const ovh = getOvhClient();
async function requestReadOnly(path) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("requestReadOnly: path invalide");
  }
  return ovh.requestPromised("GET", path);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers masquage
// ─────────────────────────────────────────────────────────────────────────────

function maskPhone(raw) {
  if (typeof raw !== "string") return "****";
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 4) return "****";
  return "****" + digits.slice(-4);
}

/**
 * Masque un sender SEULEMENT s'il ressemble a un numero (digits ou +digits).
 * Un sender alpha (ex "Medere") est affiche tel quel : identifiant business
 * non-PII. Pattern miroir avec scripts/diag-blacklist-reconcile.mjs.
 */
function maskSenderIfNumeric(sender) {
  if (typeof sender !== "string") return "(absent)";
  if (/^\+?\d+$/.test(sender.trim())) return maskPhone(sender);
  return sender;
}

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

function formatDate(iso) {
  if (iso === undefined || iso === null) return "absent";
  try {
    const d = iso instanceof Timestamp ? iso.toDate() : new Date(iso);
    if (Number.isNaN(d.getTime())) return "invalid";
    return d
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, "Z");
  } catch {
    return "invalid";
  }
}

function isAfterWindow(iso) {
  if (typeof iso !== "string") return false;
  try {
    return new Date(iso).getTime() >= new Date(OBSERVATION_WINDOW_FROM_UTC).getTime();
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Firestore ovh_stop_callbacks
// ─────────────────────────────────────────────────────────────────────────────

async function listStopCallbacks(db) {
  console.log("");
  console.log("1. FIRESTORE — collection ovh_stop_callbacks (deja masquee en base)");

  // Query simple orderBy receivedAt desc. Sans index composite (orderBy
  // sur un seul champ -> index single-field automatique).
  let snap;
  try {
    snap = await db.collection(OVH_STOP_CALLBACKS_COLLECTION).orderBy("receivedAt", "desc").get();
  } catch (err) {
    failFast("Firestore ovh_stop_callbacks .get() a echoue", err);
  }

  console.log(`   ${snap.size} doc(s) stocke(s).`);
  if (snap.empty) {
    console.log("   (aucun appel capture — pipeline stopCallBack jamais declenche)");
    return;
  }

  for (const d of snap.docs) {
    const data = d.data();
    console.log(`   --- ${d.id} ---`);
    console.log(`     receivedAt   : ${formatDate(data.receivedAt)}`);
    console.log(`     method       : ${data.method ?? "(absent)"}`);
    console.log(`     contentType  : ${data.contentType ?? "(absent)"}`);
    if (data.bodyParseError !== undefined) {
      console.log(`     parseError   : ${data.bodyParseError}`);
    }
    const q = Array.isArray(data.queryParams) ? data.queryParams : [];
    console.log(`     queryParams  : ${q.length} entree(s)`);
    for (const p of q) {
      const m = p && typeof p === "object" ? p.masked : {};
      const extra = m.hash ? ` hash=${m.hash} last4=${m.last4 ?? "n/a"}` : "";
      console.log(
        `       - name="${p.name ?? "?"}" type=${m.type ?? "?"} length=${m.length ?? 0}${extra}`,
      );
    }
    const b = Array.isArray(data.bodyParams) ? data.bodyParams : [];
    if (b.length > 0 || data.bodyParams !== undefined) {
      console.log(`     bodyParams   : ${b.length} entree(s)`);
      for (const p of b) {
        const m = p && typeof p === "object" ? p.masked : {};
        const extra = m.hash ? ` hash=${m.hash} last4=${m.last4 ?? "n/a"}` : "";
        console.log(
          `       - name="${p.name ?? "?"}" type=${m.type ?? "?"} length=${m.length ?? 0}${extra}`,
        );
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. OVH — fenetre 16:45 UTC -> now
// ─────────────────────────────────────────────────────────────────────────────

async function fetchOvhIncomingAtPath(path, label, fromIso, toIso) {
  const url = `${path}?creationDatetime.from=${encodeURIComponent(fromIso)}&creationDatetime.to=${encodeURIComponent(toIso)}`;
  console.log(`   ${label} : ${fromIso} -> ${toIso}`);
  let ids;
  try {
    ids = await requestReadOnly(url);
  } catch (err) {
    failFast(`OVH GET ${path} a echoue`, err);
  }
  if (!Array.isArray(ids)) {
    failFast(`OVH ${path} a renvoye non-tableau`, new Error(`typeof=${typeof ids}`));
  }
  console.log(`     ${ids.length} entree(s).`);
  for (const id of ids) {
    let d;
    try {
      d = await requestReadOnly(`${path}/${encodeURIComponent(String(id))}`);
    } catch (err) {
      failFast(`OVH GET ${path}/${id} a echoue`, err);
    }
    const obj = d && typeof d === "object" ? d : {};
    const sender = typeof obj.sender === "string" ? obj.sender : "(absent)";
    const receiver =
      typeof obj.receiver === "string"
        ? obj.receiver
        : typeof obj.to === "string"
          ? obj.to
          : "(absent)";
    const body = typeof obj.message === "string" ? obj.message : "";
    const createdAt = typeof obj.creationDatetime === "string" ? obj.creationDatetime : null;
    const bodySummary =
      body.length <= 10 ? JSON.stringify(body) : `(bodyLength=${body.length}, masked)`;
    console.log(
      `       - id=${id} at=${formatDate(createdAt)} sender=${maskPhone(sender)} receiver=${maskPhone(receiver)} body=${bodySummary}`,
    );
  }
}

async function fetchBlacklistSinceWindow(serviceName) {
  console.log(`   blacklists (dateCreation > ${OBSERVATION_WINDOW_FROM_UTC}) :`);
  let listing;
  try {
    listing = await requestReadOnly(`/sms/${encodeURIComponent(serviceName)}/blacklists`);
  } catch (err) {
    failFast(`OVH GET /sms/${serviceName}/blacklists a echoue`, err);
  }
  if (!Array.isArray(listing)) {
    failFast(`OVH /blacklists a renvoye non-tableau`, new Error(`typeof=${typeof listing}`));
  }
  let countAfter = 0;
  for (const entry of listing) {
    const idOrNumber =
      typeof entry === "object" && entry !== null ? (entry.number ?? entry.id) : entry;
    try {
      const d = await requestReadOnly(
        `/sms/${encodeURIComponent(serviceName)}/blacklists/${encodeURIComponent(String(idOrNumber))}`,
      );
      const obj = d && typeof d === "object" ? d : {};
      const number = typeof obj.number === "string" ? obj.number : String(idOrNumber);
      const createdAt = typeof obj.dateCreation === "string" ? obj.dateCreation : null;
      if (!isAfterWindow(createdAt)) continue;
      countAfter++;
      const type = typeof obj.type === "string" ? obj.type : "(absent)";
      const smsOutgoingID = obj.smsOutgoingID ?? "absent";
      console.log(
        `       - number=${maskPhone(number)} type=${type} since=${formatDate(createdAt)} smsOutgoingID=${smsOutgoingID}`,
      );
    } catch (err) {
      failFast(`OVH GET /blacklists/${idOrNumber} a echoue`, err);
    }
  }
  console.log(`     total apres fenetre : ${countAfter}`);
}

async function fetchOvhWindow(serviceName) {
  console.log("");
  console.log(
    `2. OVH — incoming elargi journee 16/10 UTC + blacklist depuis ${OBSERVATION_WINDOW_FROM_UTC}`,
  );

  // Incoming : fenetre jour complet 00:00Z -> 23:59Z (bloc 6c du brief).
  await fetchOvhIncomingAtPath(
    `/sms/${encodeURIComponent(serviceName)}/incoming`,
    "/sms/{service}/incoming",
    DAY_WINDOW_FROM_UTC,
    DAY_WINDOW_TO_UTC,
  );
  await fetchOvhIncomingAtPath(
    `/sms/${encodeURIComponent(serviceName)}/virtualNumbers/${encodeURIComponent(VIRTUAL_NUMBER)}/incoming`,
    `/sms/{service}/virtualNumbers/${maskPhone(VIRTUAL_NUMBER)}/incoming`,
    DAY_WINDOW_FROM_UTC,
    DAY_WINDOW_TO_UTC,
  );
  // Blacklist : filtre depuis la configuration de stopCallBack (16:45Z).
  await fetchBlacklistSinceWindow(serviceName);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. stopCallBack actuel
// ─────────────────────────────────────────────────────────────────────────────

async function printStopCallbackValue(serviceName) {
  console.log("");
  console.log("3. CONFIG — sms.Account.stopCallBack actuel");
  let svc;
  try {
    svc = await requestReadOnly(`/sms/${encodeURIComponent(serviceName)}`);
  } catch (err) {
    failFast(`OVH GET /sms/${serviceName} a echoue`, err);
  }
  const obj = svc && typeof svc === "object" ? svc : {};
  const value = typeof obj.stopCallBack === "string" ? obj.stopCallBack : "";
  const masked = maskUrl(value);
  console.log(`   stopCallBack (masque) : ${value === "" ? "(VIDE)" : masked}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. OVH outgoing fenetre + creditsLeft
// ─────────────────────────────────────────────────────────────────────────────

async function fetchOvhOutgoingWindow(serviceName) {
  console.log("");
  console.log(`4. OVH — /outgoing elargi journee 16/10 UTC + creditsLeft`);

  const fromIso = DAY_WINDOW_FROM_UTC;
  const toIso = DAY_WINDOW_TO_UTC;
  const path = `/sms/${encodeURIComponent(serviceName)}/outgoing`;
  const url = `${path}?creationDatetime.from=${encodeURIComponent(fromIso)}&creationDatetime.to=${encodeURIComponent(toIso)}`;
  console.log(`   outgoing : ${fromIso} -> ${toIso}`);

  let ids;
  try {
    ids = await requestReadOnly(url);
  } catch (err) {
    failFast(`OVH GET /outgoing a echoue`, err);
  }
  if (!Array.isArray(ids)) {
    failFast(`OVH /outgoing a renvoye non-tableau`, new Error(`typeof=${typeof ids}`));
  }
  console.log(`     ${ids.length} entree(s).`);

  for (const id of ids) {
    let d;
    try {
      d = await requestReadOnly(`${path}/${encodeURIComponent(String(id))}`);
    } catch (err) {
      failFast(`OVH GET /outgoing/${id} a echoue`, err);
    }
    const obj = d && typeof d === "object" ? d : {};
    const sender = typeof obj.sender === "string" ? obj.sender : "(absent)";
    const receiver = typeof obj.receiver === "string" ? obj.receiver : "(absent)";
    const body = typeof obj.message === "string" ? obj.message : "(absent)";
    const createdAt = typeof obj.creationDatetime === "string" ? obj.creationDatetime : null;
    const ptt = typeof obj.ptt === "string" ? obj.ptt : "(absent)";
    const deliveryReceipt =
      typeof obj.deliveryReceipt === "string" ? obj.deliveryReceipt : "(absent)";
    const credits = obj.credits ?? "(absent)";
    console.log(`       --- outgoing id=${id} ---`);
    console.log(`         creationDatetime : ${formatDate(createdAt)}`);
    console.log(`         sender           : ${maskSenderIfNumeric(sender)}`);
    console.log(`         receiver (4 derniers) : ${maskPhone(receiver)}`);
    console.log(`         message (texte complet, test uniquement) : ${JSON.stringify(body)}`);
    console.log(`         ptt              : ${ptt}`);
    console.log(`         deliveryReceipt  : ${deliveryReceipt}`);
    console.log(`         credits          : ${credits}`);
  }

  // creditsLeft actuel du service (sms.Account.creditsLeft)
  let svc2;
  try {
    svc2 = await requestReadOnly(`/sms/${encodeURIComponent(serviceName)}`);
  } catch (err) {
    failFast(`OVH GET /sms/${serviceName} pour creditsLeft a echoue`, err);
  }
  const obj2 = svc2 && typeof svc2 === "object" ? svc2 : {};
  const creditsLeft = obj2.creditsLeft ?? "(absent)";
  console.log("");
  console.log(`   sms.Account.creditsLeft (actuel) : ${creditsLeft}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5a. OVH outgoing single-id — dump brut complet
// ─────────────────────────────────────────────────────────────────────────────

async function dumpOutgoingRaw(serviceName) {
  console.log("");
  console.log(
    `5a. OVH — GET /sms/${serviceName}/outgoing/${OUTGOING_INSPECT_ID} (dump brut complet)`,
  );
  let d;
  try {
    d = await requestReadOnly(
      `/sms/${encodeURIComponent(serviceName)}/outgoing/${encodeURIComponent(OUTGOING_INSPECT_ID)}`,
    );
  } catch (err) {
    failFast(`OVH GET /outgoing/${OUTGOING_INSPECT_ID} a echoue`, err);
  }
  if (d === null || typeof d !== "object") {
    failFast(
      `OVH /outgoing/${OUTGOING_INSPECT_ID} a renvoye non-objet`,
      new Error(`typeof=${typeof d}`),
    );
  }

  // Masque UNIQUEMENT la cle `receiver` (4 derniers chiffres). Toutes
  // les autres cles affichees telles quelles (consigne test : "on affiche
  // le reste intact pour apprendre la shape OVH").
  const masked = { ...d };
  if (typeof masked.receiver === "string") {
    masked.receiver = maskPhone(masked.receiver);
  }
  // `sender` : masque UNIQUEMENT s'il est numerique (alpha reste visible).
  if (typeof masked.sender === "string") {
    masked.sender = maskSenderIfNumeric(masked.sender);
  }

  console.log("   RAW keys : " + Object.keys(d).join(", "));
  console.log("   RAW dump (receiver masque, sender masque si numerique) :");
  console.log(
    JSON.stringify(masked, null, 2)
      .split("\n")
      .map((l) => "     " + l)
      .join("\n"),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 5b. Firestore messages du contact 427963864300 depuis 16:45 UTC
// ─────────────────────────────────────────────────────────────────────────────

async function listContactMessages(db) {
  console.log("");
  console.log(
    `5b. FIRESTORE — messages (in+out) du contact ${TEST_CONTACT_ID} depuis ${OBSERVATION_WINDOW_FROM_UTC}`,
  );

  // 1. Liste les conversations du contact (fonction prod, pure lecture).
  let convIds;
  try {
    convIds = await listConversationIdsByContact(TEST_CONTACT_ID);
  } catch (err) {
    failFast(`listConversationIdsByContact a echoue`, err);
  }
  if (convIds.length === 0) {
    console.log("   (aucune conversation pour ce contact)");
    return;
  }
  console.log(`   ${convIds.length} conversation(s).`);

  const windowTs = Timestamp.fromDate(new Date(OBSERVATION_WINDOW_FROM_UTC));

  // 2. Pour chaque conv : query sur messages/ avec createdAt >= windowTs.
  //    Query sur un seul champ (createdAt) -> index single-field auto.
  //    On lit TOUS les messages de la fenetre (direction=in+out confondus).
  for (const cid of convIds) {
    console.log(`   --- conv ${cid} ---`);
    let msgSnap;
    try {
      msgSnap = await db
        .collection("conversations")
        .doc(cid)
        .collection("messages")
        .where("createdAt", ">=", windowTs)
        .orderBy("createdAt", "asc")
        .get();
    } catch (err) {
      failFast(`query messages conv=${cid} a echoue`, err);
    }
    if (msgSnap.empty) {
      console.log("     (aucun message dans la fenetre)");
      continue;
    }
    console.log(`     ${msgSnap.size} message(s).`);
    for (const d of msgSnap.docs) {
      const m = d.data();
      const direction = typeof m.direction === "string" ? m.direction : "(absent)";
      const createdAt =
        m.createdAt instanceof Timestamp ? m.createdAt.toDate().toISOString() : null;
      const outboundKind = typeof m.outboundKind === "string" ? m.outboundKind : "(n/a)";
      const status = typeof m.status === "string" ? m.status : "(absent)";
      const externalId = typeof m.externalId === "string" ? m.externalId : "(absent)";
      // body affiche en TEXTE COMPLET (consigne test).
      const body = typeof m.body === "string" ? m.body : "(absent)";
      console.log(`       - msgId=${d.id}`);
      console.log(`         direction    : ${direction}`);
      console.log(`         createdAt    : ${formatDate(createdAt)}`);
      console.log(`         outboundKind : ${outboundKind}`);
      console.log(`         status       : ${status}`);
      console.log(`         externalId   : ${externalId}`);
      console.log(`         body         : ${JSON.stringify(body)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Schema OVH /sms (virtualNumbers + keywords) + GET endpoints disponibles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inventaire STATIQUE issu de l'audit du schema OVH
 * `https://eu.api.ovh.com/1.0/sms.json` fait HORS script (voir la
 * restitution). Figé ici pour que la sortie du bloc 6a soit stable sans
 * nouvelle requete reseau. On AFFICHE les descriptions telles quelles.
 */
const VIRTUAL_NUMBER_PATHS = [
  {
    path: "/sms/{serviceName}/virtualNumbers/{number}",
    method: "GET",
    description: "Get a virtual number",
    requiredPathParams: ["number", "serviceName"],
    callable: true,
  },
  {
    path: "/sms/{serviceName}/virtualNumbers/{number}/chatAccess",
    method: "GET",
    description: "Get the web access",
    requiredPathParams: ["number", "serviceName"],
    callable: true,
  },
  {
    path: "/sms/{serviceName}/virtualNumbers/{number}/incoming",
    method: "GET",
    description: "List received SMS",
    requiredPathParams: ["number", "serviceName"],
    callable: true,
  },
  {
    path: "/sms/{serviceName}/virtualNumbers/{number}/incoming/{id}",
    method: "GET",
    description: "Get a received SMS",
    requiredPathParams: ["number", "serviceName", "id"],
    callable: false, // `id` REQUIRED, pas de valeur arbitraire a inventer
  },
  {
    path: "/sms/{serviceName}/virtualNumbers/{number}/jobs",
    method: "GET",
    description: "List pending jobs",
    requiredPathParams: ["number", "serviceName"],
    callable: true,
  },
  {
    path: "/sms/{serviceName}/virtualNumbers/{number}/jobs/{id}",
    method: "GET",
    description: "Get a pending job",
    requiredPathParams: ["number", "serviceName", "id"],
    callable: false,
  },
  {
    path: "/sms/{serviceName}/virtualNumbers/{number}/outgoing",
    method: "GET",
    description: "List sent SMS",
    requiredPathParams: ["number", "serviceName"],
    callable: true,
  },
  {
    path: "/sms/{serviceName}/virtualNumbers/{number}/outgoing/{id}",
    method: "GET",
    description: "Get a sent SMS",
    requiredPathParams: ["number", "serviceName", "id"],
    callable: false,
  },
  {
    path: "/sms/{serviceName}/virtualNumbers/{number}/outgoing/{id}/hlr",
    method: "GET",
    description: "Get the receiver operator",
    requiredPathParams: ["number", "serviceName", "id"],
    callable: false,
  },
];

/**
 * Inventaire STATIQUE des chemins et modeles hors virtualNumbers
 * contenant chat/time2chat/conversation/session/keyword/stop/optout/
 * autoReply/response. Vérifié par audit du JSON schema OVH : SEUL
 * `/virtualNumbers/{number}/chatAccess` sort hors du scope virtualNumbers
 * (il est aussi dans la liste au-dessus). Les 5 modèles associés sont
 * listés tels quels pour reference.
 */
const KEYWORD_MODELS = [
  {
    name: "sms.ChatAccess",
    description: "The web access for your virtual number chat application",
  },
  { name: "sms.Response", description: "A structure describing how to manage an sms Response" },
  { name: "sms.ResponseTrackingMediaEnum", description: "The tracking media response" },
  { name: "sms.ResponseTrackingOptions", description: "The tracking media response" },
  { name: "sms.ResponseTypeEnum", description: "Response type" },
];

async function dumpSchemaAndVirtualNumberEndpoints(serviceName) {
  console.log("");
  console.log("6. OVH SCHEMA + endpoints virtualNumber appelables");

  console.log("");
  console.log(`6a. Chemins sous /sms/{serviceName}/virtualNumbers/{number}/ (schema fige) :`);
  for (const p of VIRTUAL_NUMBER_PATHS) {
    console.log(`   ${p.method} ${p.path}`);
    console.log(`     description : ${p.description}`);
    console.log(`     path params : ${p.requiredPathParams.join(", ")} (REQUIRED)`);
    if (!p.callable) {
      console.log(`     SKIP : parametre {id} obligatoire sans valeur a disposition.`);
    }
  }

  console.log("");
  console.log(
    "6a (bis). Modeles contenant chat|time2chat|conversation|session|keyword|stop|optout|autoReply|response :",
  );
  for (const m of KEYWORD_MODELS) {
    console.log(`   ${m.name} - ${m.description}`);
  }
  console.log(
    "   (Hors des chemins deja listes ci-dessus, AUCUN chemin OVH ne contient ces mots-cles.)",
  );

  console.log("");
  console.log(
    `6b. GET pour le numero ${maskPhone(VIRTUAL_NUMBER)} (reponses brutes completes, test) :`,
  );
  for (const p of VIRTUAL_NUMBER_PATHS) {
    if (!p.callable) continue;
    const concretePath = p.path
      .replace("{serviceName}", encodeURIComponent(serviceName))
      .replace("{number}", encodeURIComponent(VIRTUAL_NUMBER));
    console.log("");
    console.log(`   >>> GET ${p.path}`);
    let resp;
    try {
      resp = await requestReadOnly(concretePath);
    } catch (err) {
      failFast(`OVH GET ${concretePath} a echoue`, err);
    }
    console.log(
      JSON.stringify(resp, null, 2)
        .split("\n")
        .map((l) => "     " + l)
        .join("\n"),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const { db, projectId } = initFirebaseAdminOrDie();
  const env = getOvhEnv();
  const serviceName = env.OVH_SMS_SERVICE_NAME;

  console.log("");
  console.log("DIAG-STOP-OBSERVE — lecture seule Firestore + OVH");
  console.log(`OVH endpoint    : ${env.OVH_ENDPOINT}`);
  console.log(`Service         : ${serviceName}`);
  console.log(`Firebase proj   : ${projectId}`);
  console.log(`Fenetre OVH     : ${OBSERVATION_WINDOW_FROM_UTC} -> now`);

  await listStopCallbacks(db);
  await fetchOvhWindow(serviceName);
  await printStopCallbackValue(serviceName);
  await fetchOvhOutgoingWindow(serviceName);
  await dumpOutgoingRaw(serviceName);
  await listContactMessages(db);
  await dumpSchemaAndVirtualNumberEndpoints(serviceName);

  console.log("");
  console.log("Termine. Aucune ecriture Firestore, aucune ecriture OVH.");
}

main().catch((err) => failFast("exception non-geree dans main()", err));
