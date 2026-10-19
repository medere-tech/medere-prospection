/**
 * DIAG-STALE-ORPHANS — lecture seule stricte des messages orphelins
 * `status in {draft, queued}` de plus d'une heure. Prouve pour chacun
 * s'il a bien ete envoye cote OVH ou pas.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Usage
 *
 *   npx tsx scripts/diag-stale-orphans.mjs
 *
 * Exit codes :
 *   0  : lecture complete reussie (0 ou N orphelins, pas d'erreur).
 *   1  : DIAGNOSTIC INCOMPLET (toute erreur de lecture Firestore ou OVH).
 *   2  : env manquant.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Ce que ce script fait
 *
 *   1. Firestore : appelle `listStaleMessages` directement depuis
 *      `src/lib/firestore/messages.ts:2236` — exactement la MEME fonction
 *      que le cron `monitor-orphan-messages.ts:106,239,245-262` qui tourne
 *      chaque heure en prod. L'index composite requis
 *      `(direction ASC, status ASC, createdAt ASC)` queryScope
 *      COLLECTION_GROUP est deja deploye (cf. firestore.indexes.json et
 *      le fait que le cron fonctionne). Pas de nouvel index.
 *
 *   2. `listStaleMessages` renvoie uniquement `{conversationId, messageId,
 *      createdAt, status}` — anti-PII strict (messages.ts:2213-2217). Pour
 *      enrichir avec body/externalReceiver/externalId pour ce diagnostic,
 *      on relit CHAQUE message par doc ref individuelle
 *      (`conversations/{convId}/messages/{msgId}`) — c'est une lecture
 *      directe par path, pas une query, donc aucun index composite requis.
 *
 *   3. Pour chaque message outbound : GET `/sms/{service}/outgoing` avec
 *      creationDatetime +/- 10 min autour de createdAt + receiver.
 *      - 0 job retourne  -> preuve d'absence d'envoi.
 *      - >= 1 job        -> dump creationDatetime + id + sender + receiver
 *                           + ptt + deliveryReceipt (phones masques).
 *
 *   4. Resume : total / jamais envoyes / sans delivery / delivres. Les ids
 *      sont tous affiches en clair pour le script de nettoyage ulterieur.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Fail-fast R4-fix
 *
 * Toute erreur de lecture (Firestore collection group, Firestore doc.get,
 * OVH request) -> `failFast(message, err)` qui log "DIAGNOSTIC INCOMPLET"
 * sur stderr et exit code 1. On NE conclut JAMAIS "aucun orphelin trouve"
 * sur une erreur silencieuse.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

import { getContact } from "../src/lib/firestore/contacts.ts";
import { listStaleMessages } from "../src/lib/firestore/messages.ts";
import { getOvhClient } from "../src/lib/ovh/client.ts";
import { getOvhEnv } from "../src/lib/security/env.ts";
import { scrubOvhErrorMessage } from "./_lib/ovh-scrub.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1h - aligne monitor-orphan-messages
const QUERY_LIMIT = 100; // aligne monitor-orphan-messages
const OVH_SEARCH_WINDOW_MS = 10 * 60 * 1000; // +/- 10 min autour du createdAt

// ─────────────────────────────────────────────────────────────────────────────
// Fail-fast
// ─────────────────────────────────────────────────────────────────────────────

function failFast(message, err) {
  // scrubOvhErrorMessage : le `message` peut contenir un path OVH
  // (receiver=0033...) et `err.message` recopie souvent l'URL de la
  // requete en echec. On masque AVANT stderr pour eviter la fuite PII
  // dans un dump terminal / shell history / log file.
  const detail = err && err.message ? err.message : String(err ?? "unknown");
  console.error("");
  console.error("DIAGNOSTIC INCOMPLET");
  console.error(`  ${scrubOvhErrorMessage(message)}`);
  console.error(`  erreur : ${scrubOvhErrorMessage(detail)}`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Init
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

function maskSenderIfNumeric(sender) {
  if (typeof sender !== "string") return "(absent)";
  if (/^\+?\d+$/.test(sender.trim())) return maskPhone(sender);
  return sender;
}

function formatDate(value) {
  if (value === undefined || value === null) return "absent";
  try {
    const d = value instanceof Timestamp ? value.toDate() : new Date(value);
    if (Number.isNaN(d.getTime())) return "invalid";
    return d
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, "Z");
  } catch {
    return "invalid";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. listStaleMessages (meme fonction que le cron prod)
// ─────────────────────────────────────────────────────────────────────────────

async function listStaleOrphansViaProductionFunction(db) {
  const now = new Date();
  console.log(
    `\n1. FIRESTORE — listStaleMessages (meme fonction que monitor-orphan-messages, now=${formatDate(now)})\n`,
  );

  // Draft
  let staleDrafts;
  try {
    staleDrafts = await listStaleMessages({
      status: "draft",
      maxAgeMs: STALE_THRESHOLD_MS,
      limit: QUERY_LIMIT,
      now,
    });
  } catch (err) {
    failFast("listStaleMessages status=draft a echoue", err);
  }
  console.log(`   status=draft  : ${staleDrafts.length} entry/entries`);

  // Queued
  let staleQueued;
  try {
    staleQueued = await listStaleMessages({
      status: "queued",
      maxAgeMs: STALE_THRESHOLD_MS,
      limit: QUERY_LIMIT,
      now,
    });
  } catch (err) {
    failFast("listStaleMessages status=queued a echoue", err);
  }
  console.log(`   status=queued : ${staleQueued.length} entry/entries`);

  // Enrichissement doc par doc (lecture directe par path, pas de query).
  const enriched = [];
  for (const entry of [...staleDrafts, ...staleQueued]) {
    const path = `conversations/${entry.conversationId}/messages/${entry.messageId}`;
    let snap;
    try {
      snap = await db.doc(path).get();
    } catch (err) {
      failFast(`db.doc("${path}").get() a echoue`, err);
    }
    if (!snap.exists) {
      failFast(
        `Doc introuvable (course sur delete pendant le scan)`,
        new Error(`${path} n'existe plus`),
      );
    }
    enriched.push({
      messageId: entry.messageId,
      conversationId: entry.conversationId,
      createdAt: entry.createdAt,
      status: entry.status,
      data: snap.data(),
    });
  }

  if (enriched.length === 0) {
    console.log("   (aucun message stale orphelin trouve via listStaleMessages)");
    return [];
  }

  console.log(`\n   Total enrichi : ${enriched.length} message(s)\n`);
  for (const r of enriched) {
    const d = r.data;
    console.log(`   --- ${r.messageId} ---`);
    console.log(`     conversationId   : ${r.conversationId}`);
    console.log(`     direction        : ${d.direction ?? "(absent)"}`);
    console.log(`     status           : ${d.status ?? "(absent)"}`);
    console.log(`     outboundKind     : ${d.outboundKind ?? "(absent)"}`);
    console.log(`     externalId       : ${d.externalId ?? "(absent)"}`);
    console.log(`     externalReceiver : ${maskPhone(d.externalReceiver ?? "")}`);
    console.log(`     createdAt        : ${formatDate(r.createdAt)}`);
    console.log(`     body             : ${JSON.stringify(d.body ?? "(absent)")}`);
    console.log(`     error            : ${d.error ? JSON.stringify(d.error) : "(absent)"}`);
  }
  return enriched;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Pour chaque outbound stale : chercher cote OVH /outgoing
// ─────────────────────────────────────────────────────────────────────────────

async function resolveReceiverE164(msg) {
  // Priorite 1 : externalReceiver du doc message si present.
  if (typeof msg.data.externalReceiver === "string" && msg.data.externalReceiver.length > 0) {
    return msg.data.externalReceiver;
  }
  // Priorite 2 (R5-fix) : lire le phone du contact via conversationId.
  // conversationId = `${contactId}_${campaignId}` -> split au premier `_`.
  const sep = msg.conversationId.indexOf("_");
  const contactId = sep > 0 ? msg.conversationId.slice(0, sep) : msg.conversationId;
  if (contactId.length === 0) return null;
  let contact;
  try {
    contact = await getContact(contactId);
  } catch (err) {
    failFast(`getContact(${contactId}) a echoue (fallback phone pour msg=${msg.messageId})`, err);
  }
  if (contact === null || !contact.phone || typeof contact.phone.e164 !== "string") {
    return null;
  }
  return contact.phone.e164;
}

async function searchOvhOutgoingForMessage(serviceName, msg) {
  const createdAt = msg.createdAt instanceof Timestamp ? msg.createdAt.toDate() : null;
  if (!createdAt) {
    return { searched: false, reason: "missing createdAt" };
  }
  const receiverE164 = await resolveReceiverE164(msg);
  if (!receiverE164) {
    return { searched: false, reason: "no externalReceiver and contact.phone.e164 missing" };
  }

  const fromIso = new Date(createdAt.getTime() - OVH_SEARCH_WINDOW_MS).toISOString();
  const toIso = new Date(createdAt.getTime() + OVH_SEARCH_WINDOW_MS).toISOString();
  const receiver = receiverE164.replace(/^\+/, "00");

  const path = `/sms/${encodeURIComponent(serviceName)}/outgoing?creationDatetime.from=${encodeURIComponent(fromIso)}&creationDatetime.to=${encodeURIComponent(toIso)}&receiver=${encodeURIComponent(receiver)}`;

  let ids;
  try {
    ids = await requestReadOnly(path);
  } catch (err) {
    failFast(`OVH GET ${path} a echoue`, err);
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    return { searched: true, found: 0, jobs: [] };
  }
  const jobs = [];
  for (const id of ids.slice(0, 5)) {
    let job;
    try {
      job = await requestReadOnly(`/sms/${encodeURIComponent(serviceName)}/outgoing/${id}`);
    } catch (err) {
      failFast(`OVH GET /sms/${serviceName}/outgoing/${id} a echoue`, err);
    }
    jobs.push({
      id,
      creationDatetime: job.creationDatetime,
      sender: maskSenderIfNumeric(job.sender),
      receiver: maskPhone(job.receiver),
      ptt: job.ptt,
      deliveryReceipt: job.deliveryReceipt,
      credits: job.credits,
    });
  }
  return { searched: true, found: ids.length, jobs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const { db } = initFirebaseAdminOrDie();
  let serviceName;
  try {
    const { OVH_SMS_SERVICE_NAME } = getOvhEnv();
    serviceName = OVH_SMS_SERVICE_NAME;
  } catch (err) {
    failFast("getOvhEnv() a echoue", err);
  }
  if (!serviceName) {
    console.error("Env manquant : OVH_SMS_SERVICE_NAME");
    process.exit(2);
  }

  const stale = await listStaleOrphansViaProductionFunction(db);
  if (stale.length === 0) {
    console.log("\nFini. Rien a nettoyer.");
    return;
  }

  console.log("\n2. OVH /outgoing — preuve d'envoi ou d'absence d'envoi\n");

  let neverSent = 0;
  let sentNoDelivery = 0;
  let delivered = 0;

  for (const msg of stale) {
    if (msg.data.direction !== "outbound") {
      console.log(
        `   --- ${msg.messageId} (direction=${msg.data.direction}) : skip (pas outbound)`,
      );
      continue;
    }
    const r = await searchOvhOutgoingForMessage(serviceName, msg);
    console.log(`   --- ${msg.messageId} ---`);
    if (!r.searched) {
      console.log(`     SKIP recherche OVH : ${r.reason}`);
      continue;
    }
    console.log(`     jobs OVH trouves (+/-10min du createdAt, meme receiver) : ${r.found}`);
    if (r.found === 0) {
      // R5-fix : wording precis. "Aucun job OVH trouve" factuel, pas
      // "jamais envoye" (qui serait une conclusion plus forte que la preuve).
      console.log("     => aucun job OVH trouve dans +/- 10 min");
      neverSent += 1;
    } else {
      for (const j of r.jobs) {
        console.log(
          `       job ${j.id} : creationDatetime=${j.creationDatetime}, sender=${j.sender}, receiver=${j.receiver}, ptt=${j.ptt}, deliveryReceipt=${j.deliveryReceipt}, credits=${j.credits}`,
        );
        if (j.deliveryReceipt === 1 || j.ptt === "1") delivered += 1;
        else sentNoDelivery += 1;
      }
    }
  }

  console.log("\n3. RESUME\n");
  console.log(`   stale total                   : ${stale.length}`);
  console.log(`   aucun job OVH +/- 10 min      : ${neverSent}`);
  console.log(`   envoyes sans delivery         : ${sentNoDelivery}`);
  console.log(`   delivres                      : ${delivered}`);
  console.log(
    "\nLes ids ci-dessus sont la liste exacte pour `scripts/close-stale-orphans.mjs --apply` (prochain tour, apres validation Dethie).",
  );
}

main().catch((err) => failFast("exception non-geree dans main()", err));
