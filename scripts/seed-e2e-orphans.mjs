#!/usr/bin/env node
/**
 * SEED-E2E-ORPHANS (PR2c tour 2a) — pose 4 orphans `isTestFixture: true`,
 * un par raison réelle (`no_conversation`, `unknown_contact`, `parse_failed`,
 * `enqueue_failed`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Usage
 *
 *   # Dry-run : ne touche rien, affiche ce qui serait écrit.
 *   npx tsx scripts/seed-e2e-orphans.mjs
 *
 *   # Appliquer : écrit les 4 docs via `addOrphanInboundIdempotent`.
 *   npx tsx scripts/seed-e2e-orphans.mjs --apply
 *
 * Idempotent : chaque orphan a un `idempotencyKey` déterministe —
 * ré-exécuter `--apply` ne crée pas de doublons.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Discipline anti-PII
 *
 *   - Les 4 bodies sont des textes synthétiques sans PII.
 *   - Pas de `phoneHash` pour les variantes qui le portent — le hash
 *     exige un numéro E.164 que ce script ne produit délibérément pas.
 *     Le harnais e2e teste donc le cas `hasPhoneHash: false` par défaut ;
 *     pour tester `true`, modifier le phone synthétique ci-dessous.
 *   - Les docs sont marqués `isTestFixture: true` et JAMAIS retournés
 *     aux admins réels (fail-closed `listOrphanInbounds`).
 *
 * Codes de sortie :
 *   0 — OK
 *   2 — env Firebase invalide
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { addOrphanInboundIdempotent } from "../src/lib/firestore/orphan-inbounds.ts";
import { getFirebaseEnv } from "../src/lib/security/env.ts";

const APPLY = process.argv.includes("--apply");

/**
 * Les 4 fixtures. `idempotencyKey` est déterministe → ré-apply = idempotent.
 */
const FIXTURES = [
  {
    reason: "no_conversation",
    body: "SEED E2E — no_conversation. Contact connu, aucune conversation.",
    idempotencyKey: "e2e-orphan-fixture-no-conversation-v1",
    source: "process-reply",
    contactId: "e2e-fixture-contact-no-conv",
  },
  {
    reason: "unknown_contact",
    body: "SEED E2E — unknown_contact. Expéditeur non référencé.",
    idempotencyKey: "e2e-orphan-fixture-unknown-contact-v1",
    source: "process-reply",
  },
  {
    // PR2c tour 2b bloc B — body volontairement VIDE : reproduit le cas
    // réel « payload illisible » (OVH envoie un corps vide ou que le
    // décodage utf-8 échoue). `addOrphanInboundIdempotent` l'accepte
    // pour `parse_failed` ET `enqueue_failed` uniquement
    // (validation `allowEmptyBody` ligne 255). L'invariant testé en e2e
    // (O5) : la fixture parse_failed NE PEUT PAS être rattachée via l'UI
    // — le bouton « Rattacher définitivement » est désactivé tant que
    // `orphanBody.trim().length === 0`, le serveur refuse de toute façon
    // (`ValidationError` « body must be non-empty » dans
    // `attachOrphanToConversation`).
    reason: "parse_failed",
    body: "",
    idempotencyKey: "e2e-orphan-fixture-parse-failed-v1",
    source: "webhook-ovh-sms",
  },
  {
    reason: "enqueue_failed",
    body: "SEED E2E — enqueue_failed. Dispatch Inngest en échec.",
    idempotencyKey: "e2e-orphan-fixture-enqueue-failed-v1",
    source: "webhook-ovh-sms",
  },
];

try {
  getFirebaseEnv();
} catch (err) {
  console.error("Env Firebase invalide :", err?.message ?? err);
  process.exit(2);
}

console.log("");
console.log("─".repeat(72));
console.log(`SEED-E2E-ORPHANS — ${APPLY ? "APPLY" : "DRY-RUN"}`);
console.log("─".repeat(72));

for (const fx of FIXTURES) {
  if (!APPLY) {
    console.log(`  [DRY] ${fx.reason.padEnd(18)}  key=${fx.idempotencyKey}`);
    continue;
  }
  try {
    const result = await addOrphanInboundIdempotent({
      reason: fx.reason,
      body: fx.body,
      idempotencyKey: fx.idempotencyKey,
      source: fx.source,
      ...(fx.contactId !== undefined ? { contactId: fx.contactId } : {}),
      isTestFixture: true,
    });
    console.log(
      `  ${result.created ? "✓ WROTE" : "= EXISTS"} ${fx.reason.padEnd(18)} docId=${result.docId}`,
    );
  } catch (err) {
    console.error(`  ✗ FAILED ${fx.reason}: ${err?.message ?? err}`);
    process.exit(1);
  }
}

console.log("");
console.log(
  APPLY
    ? "Fin — 4 fixtures posées (ou déjà présentes)."
    : "Dry-run terminé — relancer avec `--apply` pour écrire.",
);
process.exit(0);
