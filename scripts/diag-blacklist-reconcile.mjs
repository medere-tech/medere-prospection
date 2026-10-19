/**
 * DIAG-BLACKLIST-RECONCILE — rapproche la blacklist OVH avec les
 * contacts Firestore prod. LECTURE SEULE stricte des deux cotes.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Usage
 *
 *   npx tsx scripts/diag-blacklist-reconcile.mjs
 *
 * Pre-requis .env.local :
 *   - OVH_ENDPOINT, OVH_APP_KEY, OVH_APP_SECRET, OVH_CONSUMER_KEY
 *   - OVH_SMS_SERVICE_NAME (= sms-ng66707-1 en prod)
 *   - FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 *   - AUDIT_PII_PEPPER (requis par le wrapper audit; non ecrit ici
 *     mais importe via getContactByPhone -> admin SDK)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Contrat ecriture
 *
 *   Zero ecriture OVH : methodes GET uniquement, verrou `requestReadOnly`.
 *   Zero ecriture Firestore : uniquement `getContactByPhone` + lectures
 *   directes de collections (`.get()`). Aucun tx.create/set/update.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Sortie — anti-PII
 *
 *   - Numeros : `****<4 derniers chiffres>`.
 *   - Sender outgoing : affiche TEL QUEL si alpha (ex "Medere"), MASQUE
 *     si c'est un numero E.164 ou FR (ex "+33939070545" -> "****0545").
 *   - Jamais le body SMS (le brief interdit "afficher le corps").
 *   - Jamais l'ovhMessageId ni d'autres identifiants OVH bruts dans la
 *     sortie forensic — seulement les champs demandes par le brief.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Fonction prod utilisee pour la recherche contact
 *
 *   `getContactByPhone(e164)` dans `src/lib/firestore/contacts.ts:442`.
 *   Single-field equality query sur `phone.e164`. Memes garanties que
 *   le pipeline inbound (process-reply step 1 utilise la MEME fonction).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

import { getContactByPhone } from "../src/lib/firestore/contacts.ts";
import { listConversationIdsByContact } from "../src/lib/firestore/conversations.ts";
import { getOvhClient } from "../src/lib/ovh/client.ts";
import { getOvhEnv } from "../src/lib/security/env.ts";
import { toE164 } from "../src/lib/utils/phone.ts";
import { scrubOvhErrorMessage } from "./_lib/ovh-scrub.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// PREUVE LECTURE SEULE (point 4 du brief)
// ─────────────────────────────────────────────────────────────────────────────
//
// `getContactByPhone(e164)` — src/lib/firestore/contacts.ts:442-479
//   -> Un seul chemin d'ecriture possible dans tout Firestore : `.where(...).get()`.
//      Ligne 455-459 : `.collection(CONTACTS_COLLECTION).where("phone.e164","==",e164).limit(2).get()`.
//      Aucun `.set`, `.create`, `.update`, `.delete`. Aucun `appendAuditLogTx`.
//      Aucune `runTransaction`. Les throws (`ValidationError`, `InternalError`)
//      court-circuitent avant toute ecriture — defense-in-depth, pas une
//      ecriture. VERIFIE par grep sur l'implementation complete.
//
// `listConversationIdsByContact(contactId)` — src/lib/firestore/conversations.ts:963-978
//   -> Pattern identique : `.collection(...).where("contactId","==",contactId).get()`.
//      Aucune ecriture. `orderConversationIdsForFanout` est un tri EN MEMOIRE
//      pur, sans I/O (lignes 820+ pour le detail). VERIFIE.
//
// Conclusion : les 2 fonctions prod sont utilisables ici sans dupliquer la
// requete en lecture directe. Si un reviewer souhaite auditer, il peut
// relancer `grep -n "\.set\|\.create\|\.update\|\.delete\|\.runTransaction\|appendAuditLog" src/lib/firestore/contacts.ts src/lib/firestore/conversations.ts`
// et constater que les deux fonctions au-dessus n'y sont PAS listees.

// ─────────────────────────────────────────────────────────────────────────────
// Init Firebase Admin (meme pattern que test-pr-a-setup.mjs)
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
  // scrubOvhErrorMessage : masque receiver=0033... / +33... / 0[1-9]...
  // dans `message` et `err.message` (URL OVH recopiee).
  const detail = err && err.message ? err.message : String(err ?? "unknown");
  console.error("");
  console.error("DIAGNOSTIC INCOMPLET");
  console.error(`  ${scrubOvhErrorMessage(message)}`);
  console.error(`  erreur : ${scrubOvhErrorMessage(detail)}`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Garde OVH : GET uniquement
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

/** Masque un sender SEULEMENT s'il ressemble a un numero (digits ou +digits). */
function maskSenderIfNumeric(sender) {
  if (typeof sender !== "string") return "(absent)";
  if (/^\+?\d+$/.test(sender.trim())) return maskPhone(sender);
  return sender;
}

function formatDate(iso) {
  if (iso === undefined || iso === null) return "absent";
  try {
    const d = iso instanceof Timestamp ? iso.toDate() : new Date(iso);
    if (Number.isNaN(d.getTime())) return `invalid`;
    return d
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, "Z");
  } catch {
    return "invalid";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Lookup pipeline par numero
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pour un numero blackliste, agrege toutes les mesures :
 *   - OVH : dateCreation, batchID, smsOutgoingID, (si smsOutgoingID) outgoing details
 *   - Firestore : contact via getContactByPhone, consent.optedOut, convs, msg inbound
 *
 * Retourne un objet pret pour l'affichage tabulaire. Aucune valeur brute
 * (sauf celles necessaires au raisonnement interne, masquees avant log).
 */
async function reconcileNumber(serviceName, rawNumber, db) {
  const rawMasked = maskPhone(rawNumber);
  const row = {
    // Point 2 : affiche format brut OVH + E.164 normalise.
    rawMasked,
    normalizedMasked: null,
    normalizedE164: null,
    normalizationStatus: "unknown",
    // OVH blacklist
    dateCreation: null,
    batchID: null,
    smsOutgoingID: null,
    outgoingFetchStatus: "noId", // 3 etats : "ok" | "idPresentButFetchFailed(<code>)" | "noId"
    outgoingSender: null,
    outgoingSentAt: null,
    outgoingStatus: null,
    // Firestore contact
    firestoreLookupStatus: "notRun", // "ok" | "notRun" | "error:<msg>"
    firestoreContactId: null,
    firestoreContactStatus: null,
    firestoreOptedOut: null,
    firestoreOptedOutAt: null,
    firestoreOptedOutChannel: null,
    conversationIds: [],
    conversationStatuses: [],
    inboundMessages: [], // {convId, createdAt, bodyLength, containsStop, externalReceiverMasked}
    outboundCount: 0,
    lastOutboundAt: null,
    optOutAudits: [], // {timestamp, actorId, actorType, channel, conversationId, reason}
    // Decision (b) R5-fix : chaque erreur intra-reconcileNumber est attachee
    // ici (jamais de silent-swallow). main() compte en fin : si une ligne a
    // au moins une erreur, le script exit 1 + "DIAGNOSTIC INCOMPLET".
    errors: [],
  };

  // 1. Normalisation E.164 (point 2 du brief)
  //    OVH peut renvoyer `+33...`, `0033...`, `33...`, `06...` selon la
  //    source d'origine. On passe par la MEME fonction `toE164` que la
  //    prod (src/lib/utils/phone.ts:134) qui valide ET renvoie l'E.164
  //    canonique ou null.
  const e164 = toE164(rawNumber);
  if (e164 === null) {
    row.normalizationStatus = "FORMAT NON NORMALISABLE";
    // On continue a fetcher OVH /blacklists/{raw} (OVH accepte son propre
    // format) mais on skip Firestore (getContactByPhone exige E.164 strict).
  } else {
    row.normalizationStatus = "ok";
    row.normalizedE164 = e164;
    row.normalizedMasked = maskPhone(e164);
  }

  // Decision (b) R5-fix : rapport ligne-par-ligne (chaque catch attache
  // une info d'erreur a `row.errors[]`). main() compte en fin et exit 1 +
  // "DIAGNOSTIC INCOMPLET" si au moins une ligne a une erreur. Jamais de
  // silent-swallow qui concluerait "diagnostic OK".
  //
  // 2. GET blacklists/{number} — read principal : si fail, failFast tout
  //    le diag (pas d'autre moyen d'avancer sur cette ligne).
  let bl;
  try {
    bl = await requestReadOnly(
      `/sms/${encodeURIComponent(serviceName)}/blacklists/${encodeURIComponent(rawNumber)}`,
    );
  } catch (err) {
    failFast(`OVH GET /blacklists/${rawMasked} a echoue`, err);
  }
  if (bl && typeof bl === "object") {
    row.dateCreation = typeof bl.dateCreation === "string" ? bl.dateCreation : null;
    row.batchID = typeof bl.batchID === "string" ? bl.batchID : null;
    row.smsOutgoingID = bl.smsOutgoingID ?? null;
  }

  // 3. GET outgoing/{id} si smsOutgoingID present — attache erreur a la row.
  if (row.smsOutgoingID !== null && row.smsOutgoingID !== undefined) {
    try {
      const out = await requestReadOnly(
        `/sms/${encodeURIComponent(serviceName)}/outgoing/${encodeURIComponent(String(row.smsOutgoingID))}`,
      );
      if (out && typeof out === "object") {
        row.outgoingSender = maskSenderIfNumeric(
          typeof out.sender === "string" ? out.sender : "(absent)",
        );
        row.outgoingSentAt = typeof out.creationDatetime === "string" ? out.creationDatetime : null;
        row.outgoingStatus =
          typeof out.deliveryReceipt === "string"
            ? out.deliveryReceipt
            : typeof out.ptt === "string"
              ? out.ptt
              : "(absent)";
        row.outgoingFetchStatus = "ok";
      } else {
        row.outgoingFetchStatus = "idPresentButFetchFailed(non-object-response)";
        row.errors.push(`OVH /outgoing/${row.smsOutgoingID} a renvoye non-objet`);
      }
    } catch (err) {
      const code = err && err.message ? err.message : "unknown";
      row.outgoingFetchStatus = `idPresentButFetchFailed(${code})`;
      row.errors.push(`OVH GET /outgoing/${row.smsOutgoingID} : ${code}`);
    }
  }

  // 4. Firestore — SKIP si pas d'E.164 normalisable.
  if (e164 === null) {
    row.firestoreLookupStatus = "skippedNoE164";
    return row;
  }

  let contact;
  try {
    contact = await getContactByPhone(e164);
    row.firestoreLookupStatus = contact === null ? "notFound" : "ok";
  } catch (err) {
    const code = err && err.message ? err.message : "unknown";
    row.firestoreLookupStatus = `error:${code}`;
    row.errors.push(`getContactByPhone(${maskPhone(e164)}) : ${code}`);
    return row;
  }

  if (contact === null) return row;

  row.firestoreContactId = contact.hubspotId;
  row.firestoreContactStatus = contact.status;
  row.firestoreOptedOut = contact.consent?.optedOut === true;
  row.firestoreOptedOutAt = contact.consent?.optedOutAt ?? null;
  row.firestoreOptedOutChannel = contact.consent?.optedOutChannel ?? null;

  // 5. Conversations du contact + messages — attache erreur a la row.
  let convIds;
  try {
    convIds = await listConversationIdsByContact(contact.hubspotId);
    row.conversationIds = convIds;
  } catch (err) {
    const code = err && err.message ? err.message : "unknown";
    row.errors.push(`listConversationIdsByContact(${contact.hubspotId}) : ${code}`);
    convIds = [];
  }

  for (const cid of convIds) {
    const cdoc = await db.collection("conversations").doc(cid).get();
    if (!cdoc.exists) continue;
    const cdata = cdoc.data();
    row.conversationStatuses.push({
      id: cid,
      status: typeof cdata.status === "string" ? cdata.status : "(absent)",
      intent: typeof cdata.intent === "string" ? cdata.intent : "(absent)",
    });

    // Point 1 : liste TOUS les inbounds (single where, pas d'index
    // composite). Le champ `externalReceiver` porte l'E.164 du PS sur
    // un inbound (JSDoc src/types/message.ts:121 : "E.164 destinataire
    // (outbound) ou expediteur (inbound)") — contre-intuitif donc on
    // NE l'utilise PAS comme critere de recherche. On liste et on
    // affiche pour forensic.
    let inboundSnap;
    try {
      inboundSnap = await db
        .collection("conversations")
        .doc(cid)
        .collection("messages")
        .where("direction", "==", "inbound")
        .get();
    } catch (err) {
      const code = err && err.message ? err.message : "unknown";
      row.errors.push(`query inbound msgs conv=${cid} : ${code}`);
      continue;
    }
    for (const d of inboundSnap.docs) {
      const m = d.data();
      const body = typeof m.body === "string" ? m.body : "";
      row.inboundMessages.push({
        convId: cid,
        createdAt:
          m.createdAt instanceof Timestamp
            ? m.createdAt.toDate().toISOString()
            : m.receivedAt instanceof Timestamp
              ? m.receivedAt.toDate().toISOString()
              : null,
        bodyLength: body.length,
        containsStop: /stop/i.test(body),
        externalReceiverMasked: maskPhone(
          typeof m.externalReceiver === "string" ? m.externalReceiver : "",
        ),
      });
    }

    // Outbound stats : nombre total + date dernier (single where)
    let outSnap;
    try {
      outSnap = await db
        .collection("conversations")
        .doc(cid)
        .collection("messages")
        .where("direction", "==", "outbound")
        .get();
    } catch (err) {
      const code = err && err.message ? err.message : "unknown";
      row.errors.push(`query outbound msgs conv=${cid} : ${code}`);
      continue;
    }
    row.outboundCount += outSnap.size;
    for (const d of outSnap.docs) {
      const m = d.data();
      const at =
        m.sentAt instanceof Timestamp
          ? m.sentAt.toDate().getTime()
          : m.createdAt instanceof Timestamp
            ? m.createdAt.toDate().getTime()
            : null;
      if (at !== null && (row.lastOutboundAt === null || at > row.lastOutboundAt)) {
        row.lastOutboundAt = at;
      }
    }
  }

  // 6. Audits opt_out ciblant ce contact (action exacte : "opt_out",
  //    src/lib/firestore/audit-log.ts:85 + src/types/audit-log.ts:166).
  //    Query targetId == contactId puis filtre en memoire sur action
  //    (evite un index composite).
  let auditSnap;
  try {
    auditSnap = await db
      .collection("audit_log")
      .where("targetId", "==", contact.hubspotId)
      .limit(100)
      .get();
  } catch (err) {
    const code = err && err.message ? err.message : "unknown";
    row.errors.push(`query audit_log opt_out contactId=${contact.hubspotId} : ${code}`);
    return row;
  }
  for (const d of auditSnap.docs) {
    const a = d.data();
    if (a.action !== "opt_out") continue;
    const payload = a.payload && typeof a.payload === "object" ? a.payload : {};
    row.optOutAudits.push({
      timestamp: a.timestamp instanceof Timestamp ? a.timestamp.toDate().toISOString() : null,
      actorId: typeof a.actorId === "string" ? a.actorId : "(absent)",
      actorType: typeof a.actorType === "string" ? a.actorType : "(absent)",
      channel: typeof payload.channel === "string" ? payload.channel : "(absent)",
      conversationId:
        typeof payload.conversationId === "string" ? payload.conversationId : "(absent)",
      reason: typeof payload.reason === "string" ? payload.reason : "(absent)",
    });
  }

  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// Impression finale (markdown-like)
// ─────────────────────────────────────────────────────────────────────────────

function describeLinked(row) {
  if (row.outgoingFetchStatus === "ok") return "oui";
  if (row.outgoingFetchStatus === "noId") return "pas d'id";
  // "idPresentButFetchFailed(<reason>)"
  return row.outgoingFetchStatus;
}

function printRow(row) {
  console.log(`--- ${row.rawMasked} ---`);
  console.log(`  Normalisation :`);
  console.log(`    format brut OVH (masque) : ${row.rawMasked}`);
  console.log(`    E.164 utilise (masque)   : ${row.normalizedMasked ?? row.normalizationStatus}`);
  console.log(`    statut                   : ${row.normalizationStatus}`);
  console.log(`  OVH blacklist :`);
  console.log(`    dateCreation      : ${formatDate(row.dateCreation)}`);
  console.log(`    batchID           : ${row.batchID ?? "absent"}`);
  console.log(`    smsOutgoingID     : ${row.smsOutgoingID ?? "absent"}`);
  console.log(`    lie a nos envois  : ${describeLinked(row)}`);
  if (row.outgoingFetchStatus === "ok") {
    console.log(`    outgoing.sender   : ${row.outgoingSender ?? "(absent)"}`);
    console.log(`    outgoing.sentAt   : ${formatDate(row.outgoingSentAt)}`);
    console.log(`    outgoing.status   : ${row.outgoingStatus ?? "(absent)"}`);
  }
  console.log(`  Firestore (via getContactByPhone, lecture seule) :`);
  console.log(`    lookup status      : ${row.firestoreLookupStatus}`);
  console.log(`    contactId          : ${row.firestoreContactId ?? "n/a"}`);
  console.log(`    contact.status     : ${row.firestoreContactStatus ?? "n/a"}`);
  console.log(
    `    consent.optedOut   : ${row.firestoreOptedOut === null ? "n/a" : String(row.firestoreOptedOut)}`,
  );
  console.log(`    consent.optedOutAt : ${formatDate(row.firestoreOptedOutAt)}`);
  console.log(`    consent.optedOutChannel : ${row.firestoreOptedOutChannel ?? "n/a"}`);
  if (row.conversationIds.length > 0) {
    console.log(`    conversations :`);
    for (const c of row.conversationStatuses) {
      console.log(`      - id=${c.id} status=${c.status} intent=${c.intent}`);
    }
  }
  console.log(`    outbound total     : ${row.outboundCount}`);
  console.log(
    `    last outbound at   : ${row.lastOutboundAt === null ? "n/a" : formatDate(new Date(row.lastOutboundAt).toISOString())}`,
  );
  console.log(`    inbound messages (direction=="inbound", single where) :`);
  if (row.inboundMessages.length === 0) {
    console.log(`      (aucun inbound stocke)`);
  } else {
    for (const im of row.inboundMessages) {
      console.log(
        `      - conv=${im.convId} at=${formatDate(im.createdAt)} bodyLength=${im.bodyLength} containsStop=${im.containsStop ? "oui" : "non"} externalReceiver=${im.externalReceiverMasked}`,
      );
    }
  }
  console.log(`    audits "opt_out" (action exacte) :`);
  if (row.optOutAudits.length === 0) {
    console.log(`      (aucun audit opt_out ciblant ce contact)`);
  } else {
    for (const a of row.optOutAudits) {
      console.log(
        `      - at=${formatDate(a.timestamp)} actor=${a.actorType}:${a.actorId} channel=${a.channel} conv=${a.conversationId} reason=${a.reason}`,
      );
    }
  }
  // Decision (b) R5-fix : erreurs intra-reconcileNumber (jamais de silent-swallow).
  if (Array.isArray(row.errors) && row.errors.length > 0) {
    console.log(`  ERREURS DE LECTURE (ligne incomplete, main() exit 1) :`);
    for (const e of row.errors) {
      console.log(`    - ${e}`);
    }
  }
  console.log("");
}

function computeEcart(row) {
  // Regle brief : ECART ne peut valoir "non" que si l'opt-out Firestore
  // est PROUVE. Toute erreur de lecture -> "INDETERMINE (raison)".
  if (row.firestoreLookupStatus === "skippedNoE164") {
    return `INDETERMINE (${row.normalizationStatus})`;
  }
  if (row.firestoreLookupStatus.startsWith("error:")) {
    return `INDETERMINE (${row.firestoreLookupStatus})`;
  }
  if (row.firestoreLookupStatus === "notFound") {
    return "oui (pas de contact FS)";
  }
  // Contact trouve. Opt-out prouve ?
  if (row.firestoreOptedOut === true) {
    // Verifier aussi qu'il y a bien un audit opt_out pour forensic complet.
    if (row.optOutAudits.length === 0) {
      return "INDETERMINE (optedOut=true sans audit opt_out)";
    }
    return "non";
  }
  if (row.firestoreOptedOut === false) {
    return "oui (opt-out manquant)";
  }
  return `INDETERMINE (optedOut=${row.firestoreOptedOut})`;
}

function printTable(rows) {
  console.log("");
  console.log("=".repeat(110));
  console.log("TABLEAU FINAL");
  console.log("=".repeat(110));
  console.log(
    "| numero masque | date blacklist      | lie a nos envois                   | contact FS | opt-out FS            | ECART                        |",
  );
  console.log(
    "|---------------|---------------------|------------------------------------|------------|-----------------------|------------------------------|",
  );
  for (const r of rows) {
    const linked = describeLinked(r);
    const contactFS =
      r.firestoreLookupStatus === "ok"
        ? "present"
        : r.firestoreLookupStatus === "notFound"
          ? "ABSENT"
          : r.firestoreLookupStatus;
    const optOutFS =
      r.firestoreOptedOut === null
        ? "n/a"
        : r.firestoreOptedOut
          ? `oui (${formatDate(r.firestoreOptedOutAt)})`
          : "NON";
    console.log(
      `| ${r.rawMasked.padEnd(13)} | ${formatDate(r.dateCreation).padEnd(19)} | ${linked.padEnd(34)} | ${contactFS.padEnd(10)} | ${optOutFS.padEnd(21)} | ${computeEcart(r).padEnd(28)} |`,
    );
  }
  console.log("");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const { db, projectId } = initFirebaseAdminOrDie();
  const env = getOvhEnv();
  const serviceName = env.OVH_SMS_SERVICE_NAME;

  console.log("");
  console.log("DIAG-BLACKLIST-RECONCILE — lecture seule OVH + Firestore");
  console.log(`OVH endpoint   : ${env.OVH_ENDPOINT}`);
  console.log(`Service        : ${serviceName}`);
  console.log(`Firebase proj  : ${projectId}`);
  console.log("");

  // 0. Listing blacklist pour obtenir les numeros ENTIERS (requis pour
  // getContactByPhone qui exige E.164 strict).
  let listing;
  try {
    listing = await requestReadOnly(`/sms/${encodeURIComponent(serviceName)}/blacklists`);
  } catch (err) {
    failFast(`OVH GET /sms/${serviceName}/blacklists a echoue`, err);
  }
  if (!Array.isArray(listing)) {
    failFast(`OVH /blacklists a renvoye non-tableau`, new Error(`typeof=${typeof listing}`));
  }
  console.log(`${listing.length} numero(s) blackliste(s) a reconcilier.`);
  console.log("");

  // 1. Reconcile chaque numero.
  const rows = [];
  for (const entry of listing) {
    const number = typeof entry === "object" && entry !== null ? (entry.number ?? entry.id) : entry;
    if (typeof number !== "string" || number.length === 0) {
      failFast(
        `entry blacklist mal formee (${JSON.stringify(entry)})`,
        new Error("entry non-string ou vide"),
      );
    }
    const row = await reconcileNumber(serviceName, String(number), db);
    printRow(row);
    rows.push(row);
  }

  printTable(rows);

  // Decision (b) R5-fix : si au moins une ligne a attache une erreur
  // (via row.errors.push dans reconcileNumber), on exit 1 avec un
  // message "DIAGNOSTIC INCOMPLET". Les lignes individuelles ont deja
  // ete affichees avec leurs erreurs par printRow.
  const rowsWithErrors = rows.filter((r) => Array.isArray(r.errors) && r.errors.length > 0);
  if (rowsWithErrors.length > 0) {
    console.error("");
    console.error(
      `DIAGNOSTIC INCOMPLET : ${rowsWithErrors.length}/${rows.length} ligne(s) avec au moins une erreur de lecture.`,
    );
    for (const r of rowsWithErrors) {
      console.error(`  - ${r.rawMasked} :`);
      for (const e of r.errors) {
        console.error(`      * ${e}`);
      }
    }
    console.error("");
    console.error("Aucune ecriture OVH, aucune ecriture Firestore. Corriger et relancer.");
    process.exit(1);
  }

  console.log("Terminé. Aucune ecriture OVH, aucune ecriture Firestore.");
}

main().catch((err) => failFast("exception non-geree dans main()", err));
