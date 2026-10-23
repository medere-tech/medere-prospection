/**
 * BACKFILL-CONVERSATION-LIST-FIELDS (PR2a) — pose les champs dénormalisés
 * `contactDisplayName`, `contactNameSearch`, `contactSpecialty`,
 * `contactCity` (depuis le doc contact source) + `lastMessagePreview`
 * (dernier message, scrubé) + `lastHumanOutboundAt` (dérivé des messages
 * humains).
 *
 * ⚠ LANCEMENT :
 *     npx tsx scripts/backfill-conversation-list-fields.mjs           # dry-run (safe)
 *     npx tsx scripts/backfill-conversation-list-fields.mjs --apply   # écrit après confirmation
 *     echo medere-prospection-mvp | npx tsx scripts/backfill-conversation-list-fields.mjs --apply  # CI
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Fail-closed sur erreur de lecture (PR2a — corrigé après run dry-run
 * contre medere-prospection-mvp qui avait affiché errors=0 malgré une
 * `FAILED_PRECONDITION` sur une sous-requête `messages`).
 *
 *   - Si UNE lecture (contact OU messages) throw pour un doc conversation
 *     → ce doc est marqué `errors++`, AUCUNE écriture n'est tentée (ni
 *     dry-run ni apply), on passe au suivant.
 *   - Après la boucle, si `errors > 0` → code de sortie 4 (dry-run comme
 *     apply : forensic même en lecture seule).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Garde-fous opérationnels
 *
 *   - Dry-run par défaut.
 *   - `--apply` doit être confirmé par la frappe EXACTE du projectId
 *     (pas "yes" — anti-geste de muscle memory sur un `yes` universel).
 *   - Transaction par doc + relecture dans la tx + idempotence par champ.
 *   - Jamais de suppression.
 *   - Audit log par doc modifié (`backfill_conversation_list_fields`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * `campaignName` HORS SCOPE : nécessite un appel HubSpot externe.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Codes de sortie
 *
 *   0 — succès (dry-run ou apply) ET errors === 0
 *   2 — env Firebase invalide
 *   3 — erreur fatale non catchée
 *   4 — au moins un doc a eu une erreur de lecture / tx
 *   5 — confirmation refusée par l'opérateur (projectId non confirmé)
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { Timestamp } from "firebase-admin/firestore";

import { getAdminDb } from "../src/lib/firestore/admin.ts";
import { appendAuditLogTx } from "../src/lib/firestore/audit-log.ts";
import { computeBackfillUpdatesForConversation } from "../src/lib/firestore/backfill-conversation-list-fields.ts";
import { getFirebaseEnv } from "../src/lib/security/env.ts";

const APPLY = process.argv.includes("--apply");

// ─────────────────────────────────────────────────────────────────────────────
// 1. Résolution du projectId réel (même source que admin.ts prod)
// ─────────────────────────────────────────────────────────────────────────────
//
// Priorité :
//   1. Mode emulator → `GCLOUD_PROJECT` ou `"medere-test"` (admin.ts:89).
//   2. Prod → `getFirebaseEnv().FIREBASE_PROJECT_ID` (admin.ts:95-99,
//      source unique validée par `firebaseEnvSchema` ligne 252 de env.ts).
// Pourquoi pas `getAdminDb().app.options.projectId` : en prod, le projectId
// est passé via `cert({...})` → non exposé sur `app.options.projectId`
// (vérifié : retournait `undefined` sur le run précédent).

function resolveProjectId() {
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  if (typeof emulatorHost === "string" && emulatorHost.length > 0) {
    return process.env.GCLOUD_PROJECT ?? "medere-test";
  }
  const env = getFirebaseEnv();
  return env.FIREBASE_PROJECT_ID;
}

const projectId = resolveProjectId();

console.log("");
console.log("─".repeat(72));
console.log(`BACKFILL-CONVERSATION-LIST-FIELDS`);
console.log("");
console.log(`  Mode              : ${APPLY ? "APPLY (écriture)" : "DRY-RUN"}`);
console.log(`  FIRESTORE_PROJECT : ${projectId}`);
console.log(
  `  Pepper audit      : ${process.env.AUDIT_PII_PEPPER ? "présent" : "ABSENT (fail au 1er audit)"}`,
);
console.log("");
console.log("  Garde-fous : fail-closed, idempotent, jamais de delete, 1 tx/doc, audit log.");
console.log("─".repeat(72));
console.log("");

// ─────────────────────────────────────────────────────────────────────────────
// 2. Confirmation stricte en --apply : taper le projectId EXACT
// ─────────────────────────────────────────────────────────────────────────────

if (APPLY) {
  const rl = createInterface({ input, output });
  const answer = (
    await rl.question(
      `  ⚠ Confirme l'écriture sur ce projet. Tape le projectId EXACT (${projectId}) : `,
    )
  ).trim();
  rl.close();
  if (answer !== projectId) {
    console.log("");
    console.log(
      `  Confirmation refusée (reçu "${answer}", attendu "${projectId}"). Aucune écriture.`,
    );
    process.exit(5);
  }
  console.log("");
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Boucle de backfill — FAIL-CLOSED par doc
// ─────────────────────────────────────────────────────────────────────────────

const db = getAdminDb();
const snap = await db.collection("conversations").get();

const report = {
  totalConversations: snap.docs.length,
  touched: 0,
  skippedIdempotent: 0,
  errors: 0,
  byField: /** @type {Record<string, number>} */ ({
    contactDisplayName: 0,
    contactNameSearch: 0,
    contactSpecialty: 0,
    contactCity: 0,
    lastMessagePreview: 0,
    lastHumanOutboundAt: 0,
  }),
};

for (const convDoc of snap.docs) {
  const convId = convDoc.id;
  const { posed, updates, readErrors } = await computeBackfillUpdatesForConversation(convDoc, db);

  // ── FAIL-CLOSED : si une seule lecture a échoué → errors++, zéro écriture ──
  if (readErrors.length > 0) {
    report.errors++;
    for (const err of readErrors) {
      console.error(`  ! lecture échec ${convId} — ${err}`);
    }
    console.error(`  × ${convId} : zéro écriture (fail-closed sur erreur de lecture)`);
    continue;
  }

  if (posed.length === 0) {
    report.skippedIdempotent++;
    continue;
  }

  console.log(`  [${APPLY ? "APPLY" : "DRY  "}] ${convId}  posed=${posed.join(",")}`);

  // Comptabilise par champ UNIQUEMENT au moment où le write est tenté (ou
  // simulé en dry-run) — pas pendant la détection, pour que les champs
  // d'un doc en fail-closed ne soient JAMAIS comptés.
  for (const field of posed) {
    report.byField[field] = (report.byField[field] ?? 0) + 1;
  }

  if (APPLY) {
    try {
      await db.runTransaction(async (tx) => {
        const freshRef = db.collection("conversations").doc(convId);
        const fresh = await tx.get(freshRef);
        if (!fresh.exists) throw new Error("conversation disparue en cours de tx");
        const freshData = fresh.data() ?? {};
        const freshUpdates = /** @type {Record<string, unknown>} */ ({});
        for (const [k, v] of Object.entries(updates)) {
          if (freshData[k] === undefined) freshUpdates[k] = v;
        }
        if (Object.keys(freshUpdates).length > 0) {
          freshUpdates.updatedAt = Timestamp.now();
          tx.update(freshRef, freshUpdates);
          appendAuditLogTx(tx, {
            actorId: "system",
            actorType: "system",
            action: "backfill_conversation_list_fields",
            targetType: "conversation",
            targetId: convId,
            payload: { fieldsPosed: Object.keys(freshUpdates).filter((k) => k !== "updatedAt") },
          });
        }
      });
      report.touched++;
    } catch (e) {
      report.errors++;
      console.error(`  × tx échec ${convId} : ${e?.message ?? e}`);
    }
  } else {
    report.touched++;
  }
}

console.log("");
console.log("Résumé :");
console.log(JSON.stringify(report, null, 2));
console.log("");

if (report.errors > 0) {
  console.error(
    `✗ ${report.errors} doc(s) ont eu au moins une erreur de lecture / tx (fail-closed, zéro écriture pour eux).`,
  );
  process.exit(4);
}

if (!APPLY) console.log("Dry-run terminé. Pour appliquer : --apply");
process.exit(0);
