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
 *     echo yes | npx tsx scripts/backfill-conversation-list-fields.mjs --apply  # CI
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * UN SEUL PROJET FIRESTORE
 *
 *   Prouvé en PR1 : les previews Vercel lisent la même base que la prod
 *   (pas de projet Firestore séparé par environnement). Il n'y a donc
 *   pas de notion « preview vs prod » à filtrer dans ce script.
 *   Le garde-fou est opérationnel, pas environnemental :
 *     - Dry-run par défaut (rien n'est écrit).
 *     - `--apply` doit être combiné à une CONFIRMATION interactive
 *       (lecture de `stdin`). Dans un CI, `echo yes | ...` suffit.
 *     - Affichage explicite du `FIRESTORE_PROJECT_ID` effectif.
 *     - Transaction par doc + relecture dans la tx + idempotence par
 *       champ (ne réécrit jamais un champ déjà posé).
 *     - Jamais de suppression (uniquement `tx.update(...)` additif).
 *     - Audit log par doc modifié (`backfill_conversation_list_fields`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * `campaignName` est HORS SCOPE
 *
 *   Nécessite un appel HubSpot externe. Soit un script séparé plus tard,
 *   soit un join cache HubSpot au render de la liste (coût négligeable
 *   grâce au cache 5 min). Non posé ici.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Codes de sortie
 *
 *   0 — succès (dry-run ou apply)
 *   2 — env Firebase invalide
 *   3 — erreur fatale non catchée
 *   5 — confirmation refusée par l'opérateur
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { Timestamp } from "firebase-admin/firestore";

import { getAdminDb } from "../src/lib/firestore/admin.ts";
import { appendAuditLogTx } from "../src/lib/firestore/audit-log.ts";
import {
  buildLastMessagePreview,
  computeContactDisplayName,
  normalizeContactNameSearch,
} from "../src/lib/firestore/conversation-list-fields.ts";

const APPLY = process.argv.includes("--apply");

// ─────────────────────────────────────────────────────────────────────────────
// 1. Affichage du projet effectif + confirmation
// ─────────────────────────────────────────────────────────────────────────────

const projectId = process.env.FIRESTORE_PROJECT_ID ?? "(non défini)";

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
console.log("  Garde-fous : idempotent, jamais de delete, 1 tx par doc, audit log.");
console.log("─".repeat(72));
console.log("");

if (APPLY) {
  // Confirmation interactive. Dans un CI, piper `echo yes | ...`.
  const rl = createInterface({ input, output });
  const answer = (
    await rl.question(`  ⚠ Confirme l'écriture sur ${projectId} ? Tape "yes" pour continuer : `)
  )
    .trim()
    .toLowerCase();
  rl.close();
  if (answer !== "yes") {
    console.log("");
    console.log("  Confirmation refusée. Aucune écriture.");
    process.exit(5);
  }
  console.log("");
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Boucle de backfill
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
  const conv = convDoc.data();
  const posed = /** @type {string[]} */ ([]);
  const updates = /** @type {Record<string, unknown>} */ ({});

  // ── Lecture contact (best-effort, idempotent par champ) ──────────────
  if (
    !conv.contactDisplayName ||
    !conv.contactNameSearch ||
    !conv.contactSpecialty ||
    !conv.contactCity
  ) {
    try {
      const cSnap = await db.collection("contacts").doc(conv.contactId).get();
      if (cSnap.exists) {
        const raw = cSnap.data() ?? {};
        if (!conv.contactDisplayName) {
          const dn = computeContactDisplayName({
            civilite: typeof raw.civilite === "string" ? raw.civilite : undefined,
            firstName: typeof raw.firstName === "string" ? raw.firstName : "",
            lastName: typeof raw.lastName === "string" ? raw.lastName : "",
          });
          if (dn.length > 0) {
            updates.contactDisplayName = dn;
            posed.push("contactDisplayName");
            report.byField.contactDisplayName++;
          }
        }
        if (!conv.contactNameSearch) {
          const ns = normalizeContactNameSearch(`${raw.firstName ?? ""} ${raw.lastName ?? ""}`);
          if (ns.length > 0) {
            updates.contactNameSearch = ns;
            posed.push("contactNameSearch");
            report.byField.contactNameSearch++;
          }
        }
        if (
          !conv.contactSpecialty &&
          typeof raw.speciality === "string" &&
          raw.speciality.length > 0
        ) {
          updates.contactSpecialty = raw.speciality;
          posed.push("contactSpecialty");
          report.byField.contactSpecialty++;
        }
        if (!conv.contactCity && typeof raw.city === "string" && raw.city.length > 0) {
          updates.contactCity = raw.city;
          posed.push("contactCity");
          report.byField.contactCity++;
        }
      }
    } catch (e) {
      console.error(`  ! contact lecture échec ${convId} : ${e?.message ?? e}`);
    }
  }

  // ── Dernier message (preview + lastHumanOutboundAt) ──────────────────
  if (!conv.lastMessagePreview || !conv.lastHumanOutboundAt) {
    try {
      if (!conv.lastMessagePreview) {
        const lastMsgSnap = await db
          .collection("conversations")
          .doc(convId)
          .collection("messages")
          .orderBy("createdAt", "desc")
          .limit(1)
          .get();
        if (!lastMsgSnap.empty) {
          const m = lastMsgSnap.docs[0].data();
          const direction = m.direction === "outbound" ? "outbound" : "inbound";
          const authorKind =
            direction === "inbound" ? "contact" : m.generatedBy === "human" ? "human" : "ai";
          if (typeof m.body === "string") {
            updates.lastMessagePreview = buildLastMessagePreview({
              direction,
              authorKind,
              text: m.body,
              at: m.createdAt instanceof Timestamp ? m.createdAt : Timestamp.now(),
            });
            posed.push("lastMessagePreview");
            report.byField.lastMessagePreview++;
          }
        }
      }
      if (!conv.lastHumanOutboundAt) {
        const lastHumanSnap = await db
          .collection("conversations")
          .doc(convId)
          .collection("messages")
          .where("direction", "==", "outbound")
          .where("generatedBy", "==", "human")
          .orderBy("createdAt", "desc")
          .limit(1)
          .get();
        if (!lastHumanSnap.empty) {
          const t = lastHumanSnap.docs[0].data().createdAt;
          if (t instanceof Timestamp) {
            updates.lastHumanOutboundAt = t;
            posed.push("lastHumanOutboundAt");
            report.byField.lastHumanOutboundAt++;
          }
        }
      }
    } catch (e) {
      console.error(`  ! messages lecture échec ${convId} : ${e?.message ?? e}`);
    }
  }

  if (posed.length === 0) {
    report.skippedIdempotent++;
    continue;
  }

  console.log(`  [${APPLY ? "APPLY" : "DRY  "}] ${convId}  posed=${posed.join(",")}`);

  if (APPLY) {
    try {
      await db.runTransaction(async (tx) => {
        const freshRef = db.collection("conversations").doc(convId);
        const fresh = await tx.get(freshRef);
        if (!fresh.exists) throw new Error("conversation disparue en cours de tx");
        // Re-check idempotent avec données fraîches : écrit UNIQUEMENT les
        // champs toujours manquants (une autre tx peut les avoir posés).
        const freshData = fresh.data() ?? {};
        const freshUpdates = /** @type {Record<string, unknown>} */ ({});
        for (const [k, v] of Object.entries(updates)) {
          if (freshData[k] === undefined) freshUpdates[k] = v;
        }
        if (Object.keys(freshUpdates).length > 0) {
          // Pose aussi `updatedAt` pour que `/version` reflète le backfill
          // comme toute autre mutation visible dans la liste.
          freshUpdates.updatedAt = Timestamp.now();
          tx.update(freshRef, freshUpdates);
          // Audit log via le pipeline canonique (`appendAuditLogTx`) :
          // Zod + scrubber PII appliqués. Payload = NOMS des champs posés
          // uniquement (pas de valeurs).
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
if (!APPLY) console.log("Dry-run terminé. Pour appliquer : --apply");
