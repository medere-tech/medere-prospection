/**
 * DIAG-DUPLICATE-INBOUND — lecture seule stricte des 2 docs inbound
 * dupliques du 16/10 (`yRWdzWgvWPZ6DtCS4KFO` / `2IE2dosHsojSk2Bf5OgI`).
 * Lecture DIRECTE par chemin, pas de collectionGroup, pas d'index requis.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Usage
 *
 *   npx tsx scripts/diag-duplicate-inbound.mjs
 *
 * Exit codes :
 *   0  : lecture reussie (que les docs existent ou non).
 *   1  : DIAGNOSTIC INCOMPLET (toute erreur de lecture Firestore).
 *   2  : env manquant.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Ce que ce script fait
 *
 *   1. Lecture directe de
 *      `conversations/427963864300_hubspot-list-6081/messages/{id}`
 *      pour chacun des 2 ids codes en dur. Zero collectionGroup, zero
 *      index composite. Si le doc n'existe pas a CE chemin exact, on
 *      affiche "INTROUVABLE a ce chemin" (on ne cherche pas ailleurs).
 *
 *   2. Pour chaque doc trouve : TOUS les champs (direction, status,
 *      channel, externalId, generatedBy, createdAt, receivedAt, sentAt,
 *      deliveredAt, outboundKind, intent, intentConfidence, intentReasoning,
 *      aiModel, aiPromptVersion, aiTemperature, aiTokens, cost, error).
 *      `externalReceiver` masque aux 4 derniers chiffres, body en clair
 *      (test).
 *
 *   3. Tri par `createdAt ASC` -> original = plus ancien, doublon = plus
 *      recent.
 *
 *   4. Sentinelle coherence : les 2 docs doivent avoir le MEME externalId.
 *      Si different -> ce ne sont PAS des doublons, signale.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Fail-fast R4-fix
 *
 * Toute erreur `db.doc().get()` -> `failFast` + exit 1 + "DIAGNOSTIC
 * INCOMPLET". Un doc INTROUVABLE n'est PAS une erreur (c'est un resultat
 * attendu).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

// ─────────────────────────────────────────────────────────────────────────────
// Cibles codees en dur
// ─────────────────────────────────────────────────────────────────────────────

const CONVERSATION_ID = "427963864300_hubspot-list-6081";
const TARGET_IDS = ["yRWdzWgvWPZ6DtCS4KFO", "2IE2dosHsojSk2Bf5OgI"];

// ─────────────────────────────────────────────────────────────────────────────
// Fail-fast
// ─────────────────────────────────────────────────────────────────────────────

function failFast(message, err) {
  const detail = err && err.message ? err.message : String(err ?? "unknown");
  console.error("");
  console.error("DIAGNOSTIC INCOMPLET");
  console.error(`  ${message}`);
  console.error(`  erreur : ${detail}`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Init Firebase
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
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function maskPhone(raw) {
  if (typeof raw !== "string") return "****";
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 4) return "****";
  return "****" + digits.slice(-4);
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

function printAllFields(data) {
  const safeKeys = [
    "direction",
    "status",
    "channel",
    "externalId",
    "generatedBy",
    "createdAt",
    "receivedAt",
    "sentAt",
    "deliveredAt",
    "outboundKind",
    "intent",
    "intentConfidence",
    "intentReasoning",
    "aiModel",
    "aiPromptVersion",
    "aiTemperature",
    "cost",
  ];
  for (const k of safeKeys) {
    if (data[k] === undefined) continue;
    const v = data[k] instanceof Timestamp ? formatDate(data[k]) : JSON.stringify(data[k]);
    console.log(`     ${k.padEnd(20)}: ${v}`);
  }
  if (data.externalReceiver !== undefined) {
    console.log(`     externalReceiver    : ${maskPhone(data.externalReceiver)}`);
  }
  if (data.body !== undefined) {
    console.log(`     body                : ${JSON.stringify(data.body)}`);
  }
  if (data.aiTokens !== undefined) {
    console.log(`     aiTokens            : ${JSON.stringify(data.aiTokens)}`);
  }
  if (data.error !== undefined) {
    console.log(`     error               : ${JSON.stringify(data.error)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Lecture directe par chemin — zero collectionGroup, zero index
// ─────────────────────────────────────────────────────────────────────────────

async function readTarget(db, messageId) {
  const path = `conversations/${CONVERSATION_ID}/messages/${messageId}`;
  let snap;
  try {
    snap = await db.doc(path).get();
  } catch (err) {
    failFast(`db.doc("${path}").get() a echoue`, err);
  }
  if (!snap.exists) {
    return { messageId, found: false, path };
  }
  return { messageId, found: true, path, data: snap.data() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const { db } = initFirebaseAdminOrDie();

  console.log(`\n1. FIRESTORE — lecture directe conversations/${CONVERSATION_ID}/messages/{id}\n`);
  for (const id of TARGET_IDS) console.log(`   - ${id}`);

  const results = [];
  for (const id of TARGET_IDS) {
    const r = await readTarget(db, id);
    if (!r.found) {
      console.log(
        `\n   X ${id} : INTROUVABLE a ce chemin exact (${r.path}). On ne cherche pas ailleurs.`,
      );
    } else {
      console.log(`\n   V ${id} : trouve`);
      results.push(r);
    }
  }

  if (results.length === 0) {
    console.log("\n   Aucun doc trouve au chemin cible. Fin.");
    return;
  }

  // Tri par createdAt ASC pour identifier l'original.
  const sorted = results.slice().sort((a, b) => {
    const am = a.data.createdAt instanceof Timestamp ? a.data.createdAt.toMillis() : 0;
    const bm = b.data.createdAt instanceof Timestamp ? b.data.createdAt.toMillis() : 0;
    return am - bm;
  });

  console.log("\n2. DUMP DES CHAMPS (tries par createdAt ASC)\n");
  for (let i = 0; i < sorted.length; i += 1) {
    const r = sorted[i];
    const role = i === 0 ? "ORIGINAL (createdAt le plus ancien)" : "DOUBLON";
    console.log(`   --- ${r.messageId} [${role}] ---`);
    console.log(`     path                : ${r.path}`);
    printAllFields(r.data);
    console.log("");
  }

  if (sorted.length >= 2) {
    const extIds = new Set(sorted.map((r) => r.data.externalId));
    console.log("3. SENTINELLE COHERENCE\n");
    if (extIds.size === 1) {
      console.log(
        `   OK externalId unique partage : ${JSON.stringify([...extIds][0])} -> c'est bien un vrai doublon pre-BUG-DEDUP-RACE fix.`,
      );
    } else {
      console.log(
        `   ANOMALIE : externalIds differents (${JSON.stringify([...extIds])}) -> ce ne sont PAS des doublons. Verifier manuellement.`,
      );
    }
    const createdAtDiff =
      sorted[sorted.length - 1].data.createdAt instanceof Timestamp &&
      sorted[0].data.createdAt instanceof Timestamp
        ? sorted[sorted.length - 1].data.createdAt.toMillis() - sorted[0].data.createdAt.toMillis()
        : null;
    if (createdAtDiff !== null) {
      console.log(`   createdAt diff ORIGINAL vs DOUBLON : ${createdAtDiff} ms`);
    }
  }

  console.log(
    "\nL'ORIGINAL est le createdAt le plus ancien. Le script de nettoyage ulterieur (post-validation Dethie) marquera UNIQUEMENT le DOUBLON en statut terminal explicite.",
  );
}

main().catch((err) => failFast("exception non-geree dans main()", err));
