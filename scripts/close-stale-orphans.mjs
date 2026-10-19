/**
 * CLOSE-STALE-ORPHANS — ferme manuellement 3 messages orphelins pre-launch
 * figes dans la conversation de test 427963864300_hubspot-list-6081.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CONTEXTE
 *
 *   La conversation 427963864300_hubspot-list-6081 (test pre-launch, Dr
 *   Mediouni) contient 3 messages figes depuis juillet 2025 (confirmes
 *   orphelins par `diag-stale-orphans.mjs`) :
 *     - USqzioSTVioix630LgDs (draft, jamais commit par OVH)
 *     - AdaORskN73zCCQmY8akj (queued, aucun job OVH dans +/- 10 min du createdAt)
 *     - oZkis4s1XdnZDHmJGKyp (queued, aucun job OVH dans +/- 10 min du createdAt)
 *
 *   Ils encombrent `listStaleMessages` et generent du bruit Sentry
 *   (alerte orphans_detected hebdo). JAMAIS envoyes au contact (aucune
 *   facturation OVH, aucun DLR). Nettoyage forensic sans suppression.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * STRATEGIE
 *
 *   Transition vers un nouveau statut terminal manuel `abandoned` + champs
 *   `abandonedAt` + `abandonReason: "stale_pre_launch_test_cleanup"`.
 *
 *   Preuve forensique qu'un message `abandoned` est intraçable a l'envoi
 *   dans TOUS les chemins actifs du code :
 *
 *     - src/lib/firestore/send-reply.ts:344 — `commitDraftToQueued` throw
 *       ValidationError si `draft.status !== "draft"`. Un message en
 *       status "abandoned" (ou "queued" transitionne vers "abandoned") ne
 *       peut PAS etre commit vers queued → aucune enqueue OVH possible.
 *
 *     - src/lib/inngest/functions/send-reply.ts:334 — defense-in-depth,
 *       throw si `message.status !== "queued"` apres `commitDraftToQueued`.
 *       Jamais atteint si le step 1 a deja refuse (ci-dessus).
 *
 *     - src/lib/inngest/functions/send-first-sms.ts:212 — prend
 *       `{contactId, campaignId, body}` et cree un NOUVEAU message a chaque
 *       enqueue. Ne reactive JAMAIS un message existant → les docs
 *       `abandoned` sont inertes.
 *
 *     - src/lib/inngest/functions/monitor-orphan-messages.ts:247,257 —
 *       scanne UNIQUEMENT `status="draft"` et `status="queued"` via
 *       `listStaleMessages`. Un message `abandoned` n'y figure jamais →
 *       plus d'alerte Sentry orphans_detected sur ces 3 docs.
 *
 *     - src/lib/compliance/rate-limits.ts (RATE_LIMIT_COUNTED_STATUSES) —
 *       whitelist stricte : seuls `sent`, `queued`, `delivered` comptent
 *       pour le plafond 4/30j. `abandoned` est exclu PAR CONSTRUCTION
 *       (jamais ajoute a la whitelist). Les 3 messages, meme en
 *       "queued" aujourd'hui, ne devraient pas compter car tous
 *       outboundKind="solicitation" ont ete comptes avant → la transition
 *       vers "abandoned" rend le comptage futur impossible (defense).
 *
 *     - src/lib/firestore/messages.ts:1777 — `listRecentMessages` filtre
 *       `abandoned` + `duplicate` hors de l'historique envoye au prompt
 *       Claude. Pas de re-generation possible a partir de ces docs.
 *
 *     - src/lib/firestore/messages.ts:2056 — `updateMessageStatus` refuse
 *       toute transition DEPUIS `abandoned`/`duplicate`/`draft`/`received`.
 *       Statut terminal : ne peut etre repris.
 *
 *   JAMAIS DE DELETE : append-only Firestore + conservation forensic 3 ans.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Usage :
 *   npx tsx scripts/close-stale-orphans.mjs            # dry-run / lecture seule
 *   npx tsx scripts/close-stale-orphans.mjs --apply    # applique les 3 mutations
 *
 *   Lance via `tsx` (PAS `node`) pour pouvoir importer `appendAuditLogTx`
 *   depuis TS (meme chemin que `test-pr-a-setup.mjs`).
 *
 * Pre-requis .env.local :
 *   - FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY
 *   - OVH_APPLICATION_KEY / OVH_APPLICATION_SECRET / OVH_CONSUMER_KEY
 *     / OVH_ENDPOINT / OVH_SMS_SERVICE_NAME (verif OVH +/- 10 min)
 *   - AUDIT_PII_PEPPER (min 32 chars, requis par le scrubber audit)
 *
 * Exit codes :
 *   0  OK (dry-run OK ou --apply OK)
 *   1  erreur non-garde-fou (fetch Firestore / OVH / audit)
 *   2  env manquant
 *   3  doc Firestore introuvable (id change ou purge ?)
 *   4  exception non-geree dans main()
 *   5  garde-fou refuse (statut inattendu, job OVH trouve, id modifie)
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

// Imports TS via tsx (loader implicite). Chemin RELATIF — l'alias `@/` du
// tsconfig n'est pas resolu par tsx CLI direct. Pattern miroir avec
// `test-pr-a-setup.mjs` et `diag-stale-orphans.mjs`.
import { appendAuditLogTx } from "../src/lib/firestore/audit-log.ts";
import { getContact } from "../src/lib/firestore/contacts.ts";
import { getOvhClient } from "../src/lib/ovh/client.ts";
import { getOvhEnv } from "../src/lib/security/env.ts";
// Core helpers (fonctions pures, zero process.exit, zero I/O direct) —
// extraits dans `scripts/_lib/close-stale-orphans-core.mjs` pour permettre
// l'ecriture de tests Vitest unitaires sans emulator ni OVH reel.
import {
  ABANDON_REASON,
  applyMutation,
  assertAllAreAbandonable as pureAssertAllAreAbandonable,
  assertIdsAreTargets as pureAssertIdsAreTargets,
  AUDIT_ACTOR_ID,
  AUDIT_REASON,
  buildAuditPayload,
  buildOvhSearchPath,
  buildSnapshotPayload,
  CONVERSATION_ID,
  maskPhone,
  MESSAGE_SPECS,
  NEW_STATUS,
  OVH_SEARCH_WINDOW_MS,
  resolveReceiverE164 as pureResolveReceiverE164,
  scrubOvhErrorMessage,
} from "./_lib/close-stale-orphans-core.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Init Firestore (meme pattern que test-pr-a-setup.mjs)
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
// Init OVH
// ─────────────────────────────────────────────────────────────────────────────

function getOvhOrDie() {
  let serviceName;
  try {
    const env = getOvhEnv();
    serviceName = env.OVH_SMS_SERVICE_NAME;
  } catch (err) {
    console.error(`Env OVH invalide : ${err && err.message ? err.message : String(err)}`);
    process.exit(2);
  }
  if (!serviceName) {
    console.error("Env manquant : OVH_SMS_SERVICE_NAME");
    process.exit(2);
  }
  const ovh = getOvhClient();
  return { ovh, serviceName };
}

async function requestReadOnly(ovh, path) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("requestReadOnly: path invalide");
  }
  return ovh.requestPromised("GET", path);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers d'affichage locaux (maskPhone est importe du core)
// ─────────────────────────────────────────────────────────────────────────────

function formatTimestamp(value) {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (value === undefined || value === null) return "absent";
  return "non-timestamp";
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution du receveur E.164 (via core, injection getContact)
// ─────────────────────────────────────────────────────────────────────────────

async function resolveReceiverE164(messageData, conversationId) {
  return pureResolveReceiverE164(messageData, conversationId, getContact);
}

// ─────────────────────────────────────────────────────────────────────────────
// Verif OVH +/- 10 min — strict : si on trouve ne serait-ce qu'1 job
// matchant, on REFUSE de marquer abandoned (le SMS a potentiellement ete
// envoye, on ne doit pas effacer sa trace Firestore sans investiguer).
// ─────────────────────────────────────────────────────────────────────────────

async function ovhSearchOrDie(ovh, serviceName, messageData, conversationId, messageId) {
  const createdAt =
    messageData.createdAt instanceof Timestamp ? messageData.createdAt.toDate() : null;
  if (!createdAt) {
    return { searched: false, reason: "missing createdAt" };
  }
  const receiverE164 = await resolveReceiverE164(messageData, conversationId);
  if (!receiverE164) {
    return { searched: false, reason: "no externalReceiver and contact.phone.e164 missing" };
  }

  const path = buildOvhSearchPath(serviceName, receiverE164, createdAt);

  let ids;
  try {
    ids = await requestReadOnly(ovh, path);
  } catch (err) {
    console.error(
      `OVH search a echoue pour msg=${messageId} (ne pas marquer abandoned sans preuve).`,
    );
    // scrubOvhErrorMessage : OVH /outgoing contient `receiver=0033...` dans
    // l'URL ; `@ovhcloud/node-ovh` recopie l'URL dans `err.message`. On
    // masque les numeros aux 4 derniers chiffres AVANT stderr pour eviter
    // la fuite PII dans un dump de terminal / shell history.
    const rawDetail = err && err.message ? err.message : String(err);
    console.error(`  erreur : ${scrubOvhErrorMessage(rawDetail)}`);
    process.exit(1);
  }
  if (!Array.isArray(ids)) {
    console.error(`OVH /outgoing a renvoye non-tableau pour msg=${messageId}.`);
    process.exit(1);
  }
  return {
    searched: true,
    found: ids.length,
    windowMs: OVH_SEARCH_WINDOW_MS,
    receiverMasked: maskPhone(receiverE164),
    createdAtIso: createdAt.toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lecture des 3 messages + verif Firestore + verif OVH
// ─────────────────────────────────────────────────────────────────────────────

async function loadAndCheckAll(db, ovh, serviceName) {
  const results = [];
  for (const spec of MESSAGE_SPECS) {
    const path = `conversations/${CONVERSATION_ID}/messages/${spec.id}`;
    const snap = await db.doc(path).get();
    if (!snap.exists) {
      console.error(`Message introuvable : ${path}`);
      console.error("Verifier l'id (purge RGPD ? renomme ?). Aucune mutation.");
      process.exit(3);
    }
    const data = snap.data();
    const actualStatus = typeof data.status === "string" ? data.status : "(absent)";

    const ovhCheck = await ovhSearchOrDie(ovh, serviceName, data, CONVERSATION_ID, spec.id);
    results.push({
      messageId: spec.id,
      expectedStatus: spec.expectedStatus,
      actualStatus,
      direction: typeof data.direction === "string" ? data.direction : "(absent)",
      outboundKind: typeof data.outboundKind === "string" ? data.outboundKind : "(absent)",
      createdAt: data.createdAt,
      hasExternalReceiver:
        typeof data.externalReceiver === "string" && data.externalReceiver.length > 0,
      ovhCheck,
      rawData: data,
    });
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Garde-fous (fail-closed)
// ─────────────────────────────────────────────────────────────────────────────

function assertIdsAreTargetsOrExit() {
  const res = pureAssertIdsAreTargets({ CONVERSATION_ID, MESSAGE_SPECS });
  if (!res.ok) {
    for (const e of res.errors) {
      console.error(`Garde-fou : ${e}. Refus.`);
    }
    process.exit(res.exitCode);
  }
}

function assertAllAreAbandonableOrExit(results) {
  const res = pureAssertAllAreAbandonable(results);
  if (!res.ok) {
    for (const e of res.errors) {
      console.error(`Garde-fou : ${e}. Refus.`);
    }
    process.exit(res.exitCode);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot forensique AVANT ecriture (payload build via core, write local)
// ─────────────────────────────────────────────────────────────────────────────

function writeSnapshotOrDie(results) {
  const nowIso = new Date().toISOString().replace(/[:.]/g, "-");
  const relPath = `tmp/close-stale-orphans-snapshot-${nowIso}.json`;
  const absPath = resolvePath(process.cwd(), relPath);
  const payload = buildSnapshotPayload(results, process.env.FIREBASE_PROJECT_ID);
  writeFileSync(absPath, JSON.stringify(payload, null, 2), { encoding: "utf8" });
  return relPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transaction mutation — delegue a `applyMutation` du core (DI de db +
// Timestamp + appendAuditLogTx) pour permettre tests emulator.
// ─────────────────────────────────────────────────────────────────────────────

async function applyMutationViaCore(db, results) {
  await applyMutation(db, results, {
    Timestamp,
    appendAuditLogTxFn: appendAuditLogTx,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Affichage
// ─────────────────────────────────────────────────────────────────────────────

function printPlanSummary(results) {
  console.log("--- Plan ---");
  for (const r of results) {
    console.log(`  msg=${r.messageId}`);
    console.log(`    status actuel     : ${r.actualStatus} (attendu "${r.expectedStatus}")`);
    console.log(`    direction         : ${r.direction}`);
    console.log(`    outboundKind      : ${r.outboundKind}`);
    console.log(`    createdAt         : ${formatTimestamp(r.createdAt)}`);
    console.log(
      `    externalReceiver  : ${r.hasExternalReceiver ? "present" : "absent (fallback contact.phone.e164)"}`,
    );
    if (r.ovhCheck.searched) {
      console.log(
        `    OVH +/-10min      : ${r.ovhCheck.found} job(s) trouve(s) ` +
          `(receiver=${r.ovhCheck.receiverMasked})`,
      );
    } else {
      console.log(`    OVH +/-10min      : non recherche (${r.ovhCheck.reason})`);
    }
    console.log(
      `    => transition     : "${r.actualStatus}" -> "${NEW_STATUS}" ` +
        `+ abandonedAt + abandonReason="${ABANDON_REASON}"`,
    );
  }
  console.log("");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const apply = process.argv.includes("--apply");

  assertIdsAreTargetsOrExit();

  const { db, projectId } = getAdminDbOrDie();
  const { ovh, serviceName } = getOvhOrDie();

  console.log("");
  console.log(`CLOSE-STALE-ORPHANS — mode : ${apply ? "APPLY" : "dry-run / lecture seule"}`);
  console.log(`Projet Firestore : ${projectId}`);
  console.log(`Service OVH      : ${serviceName}`);
  console.log(`Conversation     : ${CONVERSATION_ID}`);
  console.log(`Messages cibles  : ${MESSAGE_SPECS.map((s) => s.id).join(", ")}`);
  console.log("");

  console.log("Lecture Firestore + verif OVH (+/- 10 min du createdAt)...");
  const results = await loadAndCheckAll(db, ovh, serviceName);
  console.log("");

  printPlanSummary(results);

  if (!apply) {
    console.log("Dry-run : rien n'est ecrit. Aucune mutation Firestore, aucun audit.");
    console.log("Ce qui SERAIT fait avec --apply :");
    console.log(`  1. Re-check OVH +/- 10 min (defense-in-depth, meme code).`);
    console.log(`  2. Snapshot ecrit dans tmp/close-stale-orphans-snapshot-<ISO>.json.`);
    console.log(`  3. Transaction unique :`);
    console.log(
      `       - 3 x tx.update(messages/{id}, { status: "abandoned", abandonedAt, abandonReason, updatedAt })`,
    );
    console.log(
      `       - 3 x appendAuditLogTx (action="manual_override", targetType="message", payload avec preuve OVH)`,
    );
    console.log(`     => atomique : tout commit ou rien.`);
    console.log("");
    console.log("Rejoue avec --apply pour executer. Garde-fous :");
    console.log("  - refus si un msg a change de statut entre dry-run et apply (race)");
    console.log("  - refus si OVH trouve >= 1 job dans +/- 10 min (SMS potentiellement envoye)");
    console.log("  - refus si verif OVH impossible (pas de receveur, pas de createdAt)");
    return;
  }

  // APPLY : re-exec complete (verif OVH refaite dans loadAndCheckAll ci-dessus)
  // + garde-fous stricts avant toute ecriture.
  assertAllAreAbandonableOrExit(results);

  console.log("Snapshot pre-mutation...");
  const snapshotPath = writeSnapshotOrDie(results);
  console.log(`  ecrit : ${snapshotPath}`);
  console.log("");

  console.log("Transaction (3 x update + 3 x audit)...");
  await applyMutationViaCore(db, results);
  console.log("  commit OK");
  console.log("");

  // Relecture pour verifier l'etat final.
  console.log("Relecture post-mutation...");
  const after = await loadAndCheckAll(db, ovh, serviceName);
  for (const r of after) {
    console.log(
      `  msg=${r.messageId} : status="${r.actualStatus}" ` +
        `(attendu "${NEW_STATUS}" apres mutation) ` +
        (r.actualStatus === NEW_STATUS ? "OK" : "KO"),
    );
  }
  console.log("");

  console.log("Terminé. Pour reset :");
  console.log(`  - relire ${snapshotPath} (jamais de rollback de memoire)`);
  console.log("  - script de reset a venir (hors scope de celui-ci).");
}

main().catch((err) => {
  // scrubOvhErrorMessage : une exception OVH propagee jusqu'ici peut
  // porter l'URL /outgoing?receiver=0033... dans err.message.
  const name = err && err.name ? err.name : "unknown";
  const msg = err && err.message ? err.message : "no message";
  console.error(`Erreur fatale : ${name} - ${scrubOvhErrorMessage(msg)}`);
  process.exit(4);
});
