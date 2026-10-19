/**
 * BACKFILL-ASSIGNED-TO — rattrape le champ racine `assignedTo` sur les
 * conversations existantes (VUE-CONVERSATION PR0, dénormalisation).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi ce script
 *
 *   Avant VUE-CONVERSATION PR0, `conversations/{id}` n'avait pas de champ
 *   `assignedTo` racine — l'info vivait uniquement dans `handoff.assignedTo`
 *   (chemin imbriqué). Avec PR0, on dénormalise à la racine pour permettre
 *   `where("assignedTo", "==", null)` (onglet « À traiter »).
 *
 *   `setHandoff` écrit maintenant les deux champs dans la MÊME tx.
 *   `getOrCreateInitialConversation` pose `assignedTo: null` à la création.
 *   Mais les docs legacy n'ont ni l'un ni l'autre → ils sont INVISIBLES
 *   aux queries `listUnassignedConversations` et `listConversationsByAssignee`.
 *
 *   Ce script scanne TOUTES les conversations existantes et, pour chaque
 *   doc où `assignedTo === undefined`, écrit la valeur dérivée :
 *     - `handoff.assignedTo` défini → `assignedTo = handoff.assignedTo`
 *     - sinon                       → `assignedTo = null`
 *   dans une transaction + audit `manual_override` par doc.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Usage
 *
 *   npx tsx scripts/backfill-assigned-to.mjs            # dry-run / lecture seule
 *   npx tsx scripts/backfill-assigned-to.mjs --apply    # applique
 *
 *   Lance via `tsx` (import TS direct de `appendAuditLogTx`).
 *
 * Pré-requis .env.local :
 *   - FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY
 *   - AUDIT_PII_PEPPER (scrubber audit)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Garde-fous (fail-closed)
 *
 *   1. Doc avec `assignedTo` déjà défini (string ou null) → no-op, skip.
 *   2. Doc avec `handoff.assignedTo` mal formé (regex /^U[A-Z0-9]+$/ fail)
 *      → refus, exit code 5.
 *   3. Doc avec `handoff` présent sans `assignedTo` interne → refus, exit code 5.
 *   4. Mutation ATOMIQUE par doc : tx.update + appendAuditLogTx dans la
 *      même transaction. Pas de trou forensic.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Exit codes
 *   0 OK (dry-run OK ou --apply OK)
 *   1 erreur I/O Firestore
 *   2 env manquant
 *   3 collection conversations vide
 *   4 exception non gérée
 *   5 garde-fou refusé (slackUserId mal formé, handoff incomplet)
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

import { appendAuditLogTx } from "../src/lib/firestore/audit-log.ts";

const SLACK_USER_ID_REGEX = /^U[A-Z0-9]+$/;
const CONVERSATIONS_COLLECTION = "conversations";
const AUDIT_ACTOR_ID = "U05UVHGBURX"; // Dethie (Admin/Tech)
const AUDIT_REASON =
  "VUE-CONVERSATION PR0 — backfill racine assignedTo depuis handoff.assignedTo (null si pas de handoff)";

// Taille de batch de scan. Firestore permet d'itérer la collection via
// un orderBy + startAfter paginé. On traite doc par doc en tx indépendantes
// (atomicité par doc, pas par batch — plus facile à retry).
const SCAN_PAGE_SIZE = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Init Firebase
// ─────────────────────────────────────────────────────────────────────────────

function getAdminDbOrDie() {
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
// Scan paginé
// ─────────────────────────────────────────────────────────────────────────────

async function* scanConversations(db) {
  let cursor;
  while (true) {
    let q = db
      .collection(CONVERSATIONS_COLLECTION)
      .orderBy("createdAt", "asc")
      .limit(SCAN_PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) return;
    for (const doc of snap.docs) {
      yield doc;
    }
    cursor = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < SCAN_PAGE_SIZE) return;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Décision par doc
// ─────────────────────────────────────────────────────────────────────────────

function decideAction(data, docId) {
  // Case 1: assignedTo déjà défini (string ou null) → noop.
  if ("assignedTo" in data) {
    return { action: "noop", reason: "assignedTo déjà présent" };
  }
  // Case 2: pas de handoff → assignedTo = null (conv jamais prise par un commercial).
  const handoff = data.handoff;
  if (handoff === undefined || handoff === null) {
    return { action: "set_null", value: null, reason: "pas de handoff" };
  }
  // Case 3: handoff présent — doit avoir assignedTo string.
  if (typeof handoff !== "object" || typeof handoff.assignedTo !== "string") {
    return {
      action: "refused",
      reason: `handoff présent sans assignedTo string valide (docId=${docId})`,
    };
  }
  if (!SLACK_USER_ID_REGEX.test(handoff.assignedTo)) {
    return {
      action: "refused",
      reason: `handoff.assignedTo mal formé "${handoff.assignedTo}" (docId=${docId})`,
    };
  }
  // Case 4: tout propre → recopier à la racine.
  return {
    action: "set_string",
    value: handoff.assignedTo,
    reason: `recopie depuis handoff.assignedTo`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Apply par doc (tx + audit)
// ─────────────────────────────────────────────────────────────────────────────

async function applyBackfillOneDoc(db, docId, newValue, previousState) {
  await db.runTransaction(async (tx) => {
    const ref = db.collection(CONVERSATIONS_COLLECTION).doc(docId);
    const inTx = await tx.get(ref);
    if (!inTx.exists) {
      throw new Error(`Race : doc ${docId} disparu entre scan et tx`);
    }
    const inTxData = inTx.data();

    // Re-check idempotence dans la tx.
    if ("assignedTo" in inTxData) {
      // Un autre caller a écrit entre notre scan et la tx. On ne touche pas.
      return;
    }

    const now = Timestamp.now();
    tx.update(ref, {
      assignedTo: newValue,
      updatedAt: now,
    });

    appendAuditLogTx(tx, {
      actorId: AUDIT_ACTOR_ID,
      actorType: "human",
      action: "manual_override",
      targetType: "conversation",
      targetId: docId,
      payload: {
        reason: AUDIT_REASON,
        backfillField: "assignedTo",
        previousState,
        newValueKind: newValue === null ? "null" : "string",
      },
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const apply = process.argv.includes("--apply");
  const { db, projectId } = getAdminDbOrDie();

  console.log("");
  console.log(`BACKFILL-ASSIGNED-TO — mode : ${apply ? "APPLY" : "dry-run / lecture seule"}`);
  console.log(`Projet Firestore : ${projectId}`);
  console.log(`Collection       : ${CONVERSATIONS_COLLECTION}`);
  console.log("");

  const counts = {
    scanned: 0,
    noop: 0,
    set_null: 0,
    set_string: 0,
    refused: 0,
  };
  const refusals = [];
  const pending = [];

  console.log("Scan paginé...");
  for await (const doc of scanConversations(db)) {
    counts.scanned += 1;
    const decision = decideAction(doc.data(), doc.id);
    counts[decision.action] = (counts[decision.action] ?? 0) + 1;
    if (decision.action === "refused") {
      refusals.push({ docId: doc.id, reason: decision.reason });
      continue;
    }
    if (decision.action === "noop") continue;
    pending.push({
      docId: doc.id,
      newValue: decision.value,
      reason: decision.reason,
      previousState: "handoff" in doc.data() ? "handoff_present" : "no_handoff",
    });
  }

  if (counts.scanned === 0) {
    console.error("Collection conversations vide.");
    process.exit(3);
  }

  console.log("");
  console.log("--- Compteurs ---");
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(12)} : ${v}`);
  console.log("");

  if (refusals.length > 0) {
    console.error("Refus (garde-fou) :");
    for (const r of refusals) {
      console.error(`  - ${r.docId} : ${r.reason}`);
    }
    console.error("Aucune écriture effectuée. Corriger les docs listés et relancer.");
    process.exit(5);
  }

  if (pending.length === 0) {
    console.log("Rien à backfiller (tous les docs ont déjà assignedTo).");
    return;
  }

  console.log(`--- ${pending.length} doc(s) à backfiller ---`);
  for (const p of pending.slice(0, 10)) {
    console.log(
      `  ${p.docId}  →  assignedTo = ${p.newValue === null ? "null" : `"${p.newValue}"`}  (${p.reason})`,
    );
  }
  if (pending.length > 10) console.log(`  ... et ${pending.length - 10} autre(s).`);
  console.log("");

  if (!apply) {
    console.log("Dry-run : aucune écriture Firestore effectuée.");
    console.log(`Rejouer avec --apply pour écrire ${pending.length} doc(s).`);
    return;
  }

  console.log(`APPLY — ${pending.length} tx(s) Firestore...`);
  let ok = 0;
  for (const p of pending) {
    try {
      await applyBackfillOneDoc(db, p.docId, p.newValue, p.previousState);
      ok += 1;
    } catch (err) {
      console.error(`  KO  ${p.docId} : ${err && err.message ? err.message : "unknown"}`);
    }
  }
  console.log("");
  console.log(`${ok}/${pending.length} tx(s) commit.`);
  console.log("Audit manual_override posé pour chaque doc backfillé.");
}

main().catch((err) => {
  console.error(
    `Erreur fatale : ${err && err.name ? err.name : "unknown"} - ${err && err.message ? err.message : "no message"}`,
  );
  process.exit(4);
});
