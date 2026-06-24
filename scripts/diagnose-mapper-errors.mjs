/**
 * Script diagnostic ad-hoc S10.1.3-DIAG-MAPPER-ERRORS-001.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Usage :
 *   npx tsx scripts/diagnose-mapper-errors.mjs
 *
 * Lance le pipeline HubSpot → mapper en READ-ONLY (zéro écriture Firestore,
 * zéro audit log). Affiche les fingerprints sanitisés des contacts skippés
 * pour permettre à l'équipe Médéré (Maylis, Elodie) de nettoyer la data
 * HubSpot avant scale 26k.
 *
 * Pré-requis dans .env.local :
 *   - HUBSPOT_ACCESS_TOKEN (pat-eu1-*)
 *   - (optionnel) NEXT_PUBLIC_HUBSPOT_PORTAL_ID — pour générer des liens
 *     cliquables vers chaque contact HubSpot. Si absent, fallback
 *     "{portalId}" littéral à remplacer à la main par Déthié.
 *
 * Exit codes :
 *   0 → diagnostic terminé (même si N>0 erreurs détectées, c'est le but)
 *   2 → env var HUBSPOT_ACCESS_TOKEN manquante OU annulation utilisateur
 *   3 → erreur HubSpot propagée (anti-absorption silencieuse)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Anti-PII (règle CLAUDE.md compliance)
 *
 *   - JAMAIS de firstName/lastName/phone/email/civilite dans les logs.
 *   - hubspotId est un identifiant OPAQUE interne CRM (semi-PII : permet
 *     de retrouver UN contact spécifique côté HubSpot mais pas sans
 *     accès au portail Médéré, donc OK à logger pour l'équipe interne).
 *   - professionFingerprint = djb2 hash 8 chars (cf. mapper.ts) — pas la
 *     valeur brute de la profession.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Anti-hardcode
 *
 *   - listId / listName / portalId : aucun en dur dans le code. listId
 *     vient du choix utilisateur (prompt interactif), portalId vient
 *     de l'env (fallback placeholder).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createInterface } from "node:readline/promises";

import { getContactsInList } from "../src/lib/hubspot/contacts.ts";
import { listSmsLists } from "../src/lib/hubspot/lists.ts";
import { mapHubSpotContactToFirestoreContact } from "../src/lib/hubspot/mapper.ts";
// 🚨 S10.1.3-DIAG-002 : pas d'import `ValidationError`. Le check est par
// duck-typing (cf. catch handler dans la boucle) pour éviter le bug tsx
// class duplication. Si on importait la classe ici, ce serait du dead code.

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

const PORTAL_ID = process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID ?? "{portalId}";
const DIAGNOSE_CAMPAIGN_ID = "diagnose-only"; // jamais persisté, juste shape valide pour le mapper

// ─────────────────────────────────────────────────────────────────────────────
// Validation env vars (minimaliste — read-only)
// ─────────────────────────────────────────────────────────────────────────────

if (!process.env.HUBSPOT_ACCESS_TOKEN) {
  console.error("❌ Variable d'env HUBSPOT_ACCESS_TOKEN manquante dans .env.local");
  process.exit(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — catégorisation errorCode depuis err.context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dérive un errorCode lisible depuis le context du ValidationError. Les
 * mapper throw 6 cas distincts différenciés par context.missingField /
 * context.invalidField (cf. mapper.ts:167-246). ValidationError.code lui-même
 * vaut "VALIDATION" pour tous les cas — pas utilisable pour différencier.
 */
function deriveErrorCode(context) {
  const missing = context?.missingField;
  const invalid = context?.invalidField;
  if (missing === "firstname") return "CONTACT_FIRSTNAME_MISSING";
  if (missing === "lastname") return "CONTACT_LASTNAME_MISSING";
  if (missing === "profession") return "CONTACT_PROFESSION_MISSING";
  if (missing === "phone|mobilephone") return "CONTACT_NO_PHONE";
  if (invalid === "profession") return "CONTACT_PROFESSION_UNKNOWN";
  if (invalid === "phone") return "CONTACT_PHONE_INVALID";
  return "CONTACT_OTHER_VALIDATION";
}

// ─────────────────────────────────────────────────────────────────────────────
// Header + readline
// ─────────────────────────────────────────────────────────────────────────────

console.log("=".repeat(80));
console.log("🔍 DIAGNOSTIC mapper errors HubSpot (S10.1.3-DIAG-MAPPER-ERRORS-001)");
console.log("=".repeat(80));
console.log("Mode      : READ-ONLY (aucune écriture Firestore ni audit log)");
console.log(
  `Portal ID : ${PORTAL_ID}${PORTAL_ID === "{portalId}" ? " (env NEXT_PUBLIC_HUBSPOT_PORTAL_ID absent — liens partiels)" : ""}`,
);
console.log();

const rl = createInterface({ input: process.stdin, output: process.stdout });

process.on("SIGINT", () => {
  rl.close();
  console.log("\n\n⚠ Diagnostic interrompu (SIGINT).");
  process.exit(130);
});

try {
  // ── Étape 1 : Lister les listes HubSpot SMS ─────────────────────────────
  console.log("→ Récupération des listes HubSpot SMS…");
  const lists = await listSmsLists();
  if (lists.length === 0) {
    console.log("\n❌ Aucune liste HubSpot ne match 'SMS'. Vérifie le portail.");
    rl.close();
    process.exit(2);
  }

  console.log(`\n📋 ${lists.length} liste(s) trouvée(s) :\n`);
  lists.forEach((l, i) => {
    const size = l.size === undefined ? "?" : l.size;
    console.log(`  [${i + 1}] ${l.name}  (${size} contacts, type=${l.processingType})`);
  });
  console.log(`  [q] Quitter sans rien faire\n`);

  // ── Étape 2 : Choisir un numéro ──────────────────────────────────────────
  const rawChoice = (await rl.question("Numéro de liste à diagnostiquer : ")).trim().toLowerCase();
  if (rawChoice === "q" || rawChoice === "") {
    console.log("\nAnnulation utilisateur.");
    rl.close();
    process.exit(2);
  }

  const choiceIdx = parseInt(rawChoice, 10) - 1;
  if (Number.isNaN(choiceIdx) || choiceIdx < 0 || choiceIdx >= lists.length) {
    console.error(`\n❌ Choix invalide : "${rawChoice}"`);
    rl.close();
    process.exit(2);
  }

  const selected = lists[choiceIdx];
  rl.close();

  console.log();
  console.log(`📌 Liste sélectionnée : ${selected.name} (listId=${selected.listId})`);
  console.log();
  console.log("=".repeat(80));
  console.log("→ Pagination + map READ-ONLY en cours…");
  console.log("=".repeat(80));

  // ── Étape 3 : Paginer + map READ-ONLY ───────────────────────────────────
  const allErrors = [];
  let totalFetched = 0;
  let totalMappable = 0;
  let pagesProcessed = 0;
  let cursor;

  const startMs = Date.now();
  do {
    const page = await getContactsInList(selected.listId, { cursor, limit: 100 });
    pagesProcessed++;
    totalFetched += page.contacts.length;

    for (const raw of page.contacts) {
      try {
        mapHubSpotContactToFirestoreContact({
          raw,
          campaignId: DIAGNOSE_CAMPAIGN_ID,
        });
        totalMappable++;
      } catch (err) {
        // 🚨 S10.1.3-DIAG-002 : duck-typing au lieu de `err instanceof ValidationError`.
        // tsx charge errors.ts DEUX FOIS quand on lance un .mjs qui importe à
        // la fois des .ts du repo (mapper.ts → errors.ts via @/lib/utils/errors,
        // ET script .mjs → errors.ts via ../src/lib/utils/errors.ts). Les deux
        // imports résolvent vers le même fichier mais créent DEUX classes
        // ValidationError distinctes en runtime — `err instanceof ValidationError`
        // (la classe vue par le script) retourne `false` pour un `err` instancié
        // côté mapper (l'autre classe). Workaround : check par nom + structure
        // (duck-typing). Pattern adopté volontairement pour ce script ad-hoc
        // — le code prod (`processContact` dans `seed-runner.ts`) tourne tout en
        // .ts, n'a pas ce souci et garde le `instanceof` propre.
        const isValidationError =
          err?.constructor?.name === "ValidationError" && typeof err?.context === "object";

        if (isValidationError) {
          allErrors.push({
            hubspotId: raw.id,
            errorCode: deriveErrorCode(err.context),
            // Champs sanitisés du context — JAMAIS le raw HubSpot.
            missingField: err.context?.missingField,
            invalidField: err.context?.invalidField,
            professionFingerprint: err.context?.professionFingerprint,
          });
        } else {
          // Vraie erreur non-validation (TypeError résiduel, ExternalServiceError
          // HubSpot, etc.). Improbable post fix S10.1.3-FIX-TYPEERROR-NO-PHONE-001
          // mais on garde le filet pour visibilité forensique.
          allErrors.push({
            hubspotId: raw.id,
            errorCode: "OTHER_NON_VALIDATION",
            errorName: err?.constructor?.name ?? "Error",
          });
        }
      }
    }

    process.stdout.write(
      `\r  page ${pagesProcessed} traitée — ${totalFetched} fetched, ${allErrors.length} errors`,
    );
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  console.log(); // newline après le progress
  const durationS = Math.round((Date.now() - startMs) / 1000);

  // ── Étape 4 : Breakdown par errorCode ───────────────────────────────────
  const breakdown = {};
  for (const e of allErrors) {
    breakdown[e.errorCode] = (breakdown[e.errorCode] ?? 0) + 1;
  }

  // ── Étape 5 : Display synthèse + détail ─────────────────────────────────
  console.log();
  console.log("=".repeat(80));
  console.log("📊 Diagnostic terminé");
  console.log("=".repeat(80));
  console.log(`  Liste              : ${selected.name}`);
  console.log(`  Total fetched      : ${totalFetched}`);
  console.log(`  Mappables          : ${totalMappable}`);
  console.log(`  Mapper errors      : ${allErrors.length}`);
  console.log(`  Pages processed    : ${pagesProcessed}`);
  console.log(`  Duration           : ${durationS}s`);
  console.log();

  if (allErrors.length === 0) {
    console.log("✅ Aucun mapper error. Tous les contacts sont mappables.");
    process.exit(0);
  }

  console.log("📋 Breakdown par errorCode :");
  // Tri descendant par count pour focus rapide sur les cas les plus fréquents.
  const sortedBreakdown = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  for (const [code, count] of sortedBreakdown) {
    console.log(`  - ${code.padEnd(32)} : ${count} contact(s)`);
  }
  console.log();

  console.log("📂 Détail par contact (hubspotId opaque, lien direct HubSpot) :");
  console.log();
  // Groupé par errorCode pour faciliter le briefing data team (Maylis/Elodie).
  for (const [code] of sortedBreakdown) {
    console.log(`  ── ${code} ──`);
    const errorsForCode = allErrors.filter((e) => e.errorCode === code);
    for (const e of errorsForCode) {
      const link = `https://app.hubspot.com/contacts/${PORTAL_ID}/contact/${e.hubspotId}`;
      // Affiche les champs context sanitisés (anti-PII : ce sont des noms de
      // FIELDS HubSpot ou des hash djb2, jamais des valeurs PII brutes).
      const parts = [];
      if (e.missingField !== undefined) parts.push(`missingField=${e.missingField}`);
      if (e.invalidField !== undefined) parts.push(`invalidField=${e.invalidField}`);
      if (e.professionFingerprint !== undefined) parts.push(`profFP=${e.professionFingerprint}`);
      if (e.errorName !== undefined) parts.push(`err=${e.errorName}`);
      const extra = parts.length > 0 ? ` ${parts.join(" ")}` : "";
      console.log(`    hubspotId=${e.hubspotId}${extra} → ${link}`);
    }
    console.log();
  }

  console.log("✅ Diagnostic terminé. Aucune écriture effectuée.");
  process.exit(0);
} catch (err) {
  rl.close();
  console.error();
  console.error("=".repeat(80));
  console.error("❌ Erreur fatale diagnostic");
  console.error("=".repeat(80));
  console.error(`Name      : ${err?.constructor?.name ?? "Error"}`);
  console.error(`Code      : ${err?.code ?? "(none)"}`);
  // Pattern identique seed CLI S10.1.3 T1 #1 : pas de message brut (anti-PII
  // potential dans wrapper HubSpot/SDK error message).
  console.error();
  console.error("Aucune donnée Firestore ou audit log n'a été touchée (read-only).");
  process.exit(3);
}
