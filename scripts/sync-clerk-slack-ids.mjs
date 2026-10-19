/**
 * SYNC-CLERK-SLACK-IDS — peuple `publicMetadata.slackUserId` dans Clerk
 * à partir de la table Airtable Commerciaux (VUE-CONVERSATION PR0).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi ce script
 *
 *   Avant VUE-CONVERSATION PR0, les comptes Clerk des commerciaux n'ont
 *   pas de `publicMetadata.slackUserId`. Sans ce champ, l'onglet
 *   « Mes conversations » de la vue conversation sera vide pour tout le
 *   monde (fallback onglet « À traiter »).
 *
 *   Ce script lit la table Airtable Commerciaux (même source que
 *   `src/lib/airtable/commerciaux.ts`) et, pour chaque ligne active
 *   avec un `slack_user_id` renseigné, associe au compte Clerk
 *   correspondant par EMAIL puis écrit `publicMetadata.slackUserId` via
 *   la Clerk Backend REST API (`PATCH /v1/users/{id}`).
 *
 *   Ne touche AUCUN autre champ `publicMetadata`. Ne crée pas de compte
 *   Clerk. Ne supprime pas de compte. Lecture seule par défaut (dry-run).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Usage
 *
 *   npx tsx scripts/sync-clerk-slack-ids.mjs            # dry-run
 *   npx tsx scripts/sync-clerk-slack-ids.mjs --apply    # applique
 *   npx tsx scripts/sync-clerk-slack-ids.mjs --apply --force-overwrite
 *     # écrit même si un slackUserId est déjà présent et diffère
 *
 * Pré-requis .env.local :
 *   - CLERK_SECRET_KEY (sk_...) — Clerk Backend REST API
 *   - AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_COMMERCIAUX_TABLE_ID
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Garde-fous (fail-closed)
 *
 *   1. Email Airtable sans compte Clerk → ligne tracée comme `no_clerk`,
 *      PAS d'écriture, PAS d'exit en dry-run. En --apply : refuse l'écriture
 *      de CETTE ligne mais continue (rapport final liste tous les manquants).
 *   2. Email Airtable ambigu (2 lignes Airtable même email, OU 2 users Clerk
 *      même email) → ligne tracée `ambiguous`, PAS d'écriture, exit code 5.
 *   3. slackUserId Clerk déjà présent ET différent de l'Airtable → PAS
 *      d'écrasement sans `--force-overwrite`, exit code 5.
 *   4. slackUserId Clerk déjà présent ET identique → no-op, log `noop`.
 *   5. slackUserId Airtable mal formé (regex /^U[A-Z0-9]+$/ fail) → refus,
 *      exit code 5.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Exit codes
 *   0 OK (dry-run OK ou --apply OK sans conflit)
 *   1 erreur I/O (fetch Clerk ou Airtable échoué)
 *   2 env manquant
 *   3 ressource introuvable (table Airtable vide, etc.)
 *   4 exception non gérée
 *   5 garde-fou refusé (ambiguïté, écrasement sans --force-overwrite, format)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Zéro PII en stdout/stderr
 *
 *   Les emails sont AFFICHÉS MASQUÉS (`****@domain.tld`). Les slackUserId
 *   ne sont pas PII (identifiant workspace technique). Le rapport final
 *   agrège par action (`updated`, `noop`, `conflict`, `no_clerk`, ...).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

const SLACK_USER_ID_REGEX = /^U[A-Z0-9]+$/;
const CLERK_API_BASE = "https://api.clerk.com/v1";
const AIRTABLE_API_BASE = "https://api.airtable.com/v0";

// ─────────────────────────────────────────────────────────────────────────────
// Env
// ─────────────────────────────────────────────────────────────────────────────

function getEnvOrDie() {
  const required = [
    "CLERK_SECRET_KEY",
    "AIRTABLE_API_KEY",
    "AIRTABLE_BASE_ID",
    "AIRTABLE_COMMERCIAUX_TABLE_ID",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Env manquant : ${missing.join(", ")}`);
    process.exit(2);
  }
  return {
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY,
    AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
    AIRTABLE_COMMERCIAUX_TABLE_ID: process.env.AIRTABLE_COMMERCIAUX_TABLE_ID,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Masquage email (zéro PII logs)
// ─────────────────────────────────────────────────────────────────────────────

function maskEmail(email) {
  if (typeof email !== "string" || email.length === 0) return "****@****";
  const atIdx = email.indexOf("@");
  if (atIdx < 1) return "****@****";
  const domain = email.slice(atIdx);
  return `****${domain}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Airtable fetch (sans dep, direct REST)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchAirtableCommerciaux(env) {
  // On demande explicitement email + slack_user_id + Statut + hubspot_name.
  // `email` n'est PAS demandé par src/lib/airtable/commerciaux.ts (data min),
  // mais ici il nous est strictement nécessaire pour le matching Clerk.
  const url = new URL(
    `${AIRTABLE_API_BASE}/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_COMMERCIAUX_TABLE_ID}`,
  );
  const fields = ["email", "slack_user_id", "Statut", "hubspot_name"];
  for (const f of fields) url.searchParams.append("fields[]", f);
  url.searchParams.set("pageSize", "100");

  let allRecords = [];
  let offset;
  let pageCount = 0;
  do {
    const u = new URL(url.toString());
    if (offset) u.searchParams.set("offset", offset);
    const res = await fetch(u, {
      headers: { Authorization: `Bearer ${env.AIRTABLE_API_KEY}` },
    });
    if (!res.ok) {
      console.error(`Airtable fetch failed: ${res.status} ${res.statusText}`);
      process.exit(1);
    }
    const data = await res.json();
    allRecords = allRecords.concat(data.records ?? []);
    offset = data.offset;
    pageCount += 1;
    if (pageCount > 10) break; // defense anti-boucle
  } while (offset);
  return allRecords;
}

// ─────────────────────────────────────────────────────────────────────────────
// Clerk fetch
// ─────────────────────────────────────────────────────────────────────────────

async function fetchAllClerkUsers(env) {
  const users = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const url = new URL(`${CLERK_API_BASE}/users`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
    });
    if (!res.ok) {
      console.error(`Clerk fetch failed: ${res.status} ${res.statusText}`);
      process.exit(1);
    }
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    users.push(...page);
    if (page.length < limit) break;
    offset += limit;
    if (offset > 10_000) break; // defense anti-boucle
  }
  return users;
}

/** Patch le `publicMetadata` d'un user Clerk via API REST. */
async function patchClerkUserMetadata(env, userId, newSlackUserId) {
  const res = await fetch(`${CLERK_API_BASE}/users/${userId}/metadata`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${env.CLERK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ public_metadata: { slackUserId: newSlackUserId } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Clerk PATCH ${userId} failed: ${res.status} ${res.statusText} — ${text}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation Airtable
// ─────────────────────────────────────────────────────────────────────────────

function firstOrString(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") return value[0];
  return undefined;
}

/** Normalise un record Airtable en forme interne. */
function normalizeAirtableRecord(rec) {
  const f = rec.fields ?? {};
  const email = firstOrString(f.email);
  const slackUserId = firstOrString(f.slack_user_id);
  const name = firstOrString(f.hubspot_name) ?? "(sans nom)";
  const statut = firstOrString(f.Statut);
  const active = typeof statut === "string" && statut.trim().toLowerCase() === "actif";
  return {
    airtableRecordId: rec.id,
    emailNormalized: typeof email === "string" ? email.trim().toLowerCase() : undefined,
    slackUserId,
    name,
    active,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Résolution Clerk users par email (normalisé lowercase)
// ─────────────────────────────────────────────────────────────────────────────

function buildClerkEmailIndex(users) {
  const map = new Map();
  const ambiguous = new Set();
  for (const u of users) {
    const emails = Array.isArray(u.email_addresses) ? u.email_addresses : [];
    for (const e of emails) {
      const addr = typeof e?.email_address === "string" ? e.email_address.trim().toLowerCase() : "";
      if (addr.length === 0) continue;
      if (map.has(addr)) {
        // 2 users Clerk partagent cet email → ambiguïté.
        ambiguous.add(addr);
      } else {
        map.set(addr, u);
      }
    }
  }
  return { map, ambiguous };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const apply = process.argv.includes("--apply");
  const forceOverwrite = process.argv.includes("--force-overwrite");
  const env = getEnvOrDie();

  console.log("");
  console.log(`SYNC-CLERK-SLACK-IDS — mode : ${apply ? "APPLY" : "dry-run / lecture seule"}`);
  console.log(`Force overwrite : ${forceOverwrite ? "oui" : "non"}`);
  console.log("");

  // 1. Fetch Airtable + Clerk en parallèle
  console.log("Lecture Airtable Commerciaux + Clerk Users en parallèle...");
  const [airtableRecords, clerkUsers] = await Promise.all([
    fetchAirtableCommerciaux(env),
    fetchAllClerkUsers(env),
  ]);
  console.log(`  Airtable : ${airtableRecords.length} ligne(s)`);
  console.log(`  Clerk    : ${clerkUsers.length} user(s)`);
  console.log("");

  if (airtableRecords.length === 0) {
    console.error("Airtable Commerciaux est VIDE. Aucune ligne à synchroniser.");
    process.exit(3);
  }

  // 2. Build index Clerk par email
  const { map: clerkByEmail, ambiguous: clerkAmbiguous } = buildClerkEmailIndex(clerkUsers);

  // 3. Détecte les doublons d'email côté Airtable
  const airtableByEmail = new Map();
  const airtableAmbiguous = new Set();
  for (const rec of airtableRecords) {
    const n = normalizeAirtableRecord(rec);
    if (!n.emailNormalized) continue;
    if (airtableByEmail.has(n.emailNormalized)) {
      airtableAmbiguous.add(n.emailNormalized);
    } else {
      airtableByEmail.set(n.emailNormalized, n);
    }
  }

  // 4. Pour chaque ligne Airtable, décider action
  const actions = [];
  for (const rec of airtableRecords) {
    const n = normalizeAirtableRecord(rec);
    const row = {
      airtableRecordId: n.airtableRecordId,
      maskedEmail: n.emailNormalized ? maskEmail(n.emailNormalized) : "(absent)",
      name: n.name,
      slackUserIdAirtable: n.slackUserId ?? null,
      active: n.active,
      clerkUserId: null,
      currentClerkSlackUserId: null,
      action: null, // updated | noop | conflict | no_clerk | ambiguous | invalid_format | skipped_inactive | skipped_no_slack
      reason: null,
    };

    if (!n.active) {
      row.action = "skipped_inactive";
      row.reason = "Statut Airtable != 'Actif'";
      actions.push(row);
      continue;
    }
    if (!n.slackUserId) {
      row.action = "skipped_no_slack";
      row.reason = "slack_user_id Airtable absent";
      actions.push(row);
      continue;
    }
    if (!SLACK_USER_ID_REGEX.test(n.slackUserId)) {
      row.action = "invalid_format";
      row.reason = `slack_user_id Airtable mal formé : "${n.slackUserId}"`;
      actions.push(row);
      continue;
    }
    if (!n.emailNormalized) {
      row.action = "no_clerk";
      row.reason = "Email Airtable absent, impossible à matcher Clerk";
      actions.push(row);
      continue;
    }
    if (airtableAmbiguous.has(n.emailNormalized)) {
      row.action = "ambiguous";
      row.reason = "Email dupliqué dans Airtable Commerciaux";
      actions.push(row);
      continue;
    }
    if (clerkAmbiguous.has(n.emailNormalized)) {
      row.action = "ambiguous";
      row.reason = "Email dupliqué entre 2 users Clerk";
      actions.push(row);
      continue;
    }

    const clerkUser = clerkByEmail.get(n.emailNormalized);
    if (!clerkUser) {
      row.action = "no_clerk";
      row.reason = "Aucun user Clerk avec cet email";
      actions.push(row);
      continue;
    }

    row.clerkUserId = clerkUser.id;
    const currentSlack =
      clerkUser.public_metadata && typeof clerkUser.public_metadata === "object"
        ? clerkUser.public_metadata.slackUserId
        : undefined;
    row.currentClerkSlackUserId = typeof currentSlack === "string" ? currentSlack : null;

    if (row.currentClerkSlackUserId === n.slackUserId) {
      row.action = "noop";
      row.reason = "Déjà synchronisé";
      actions.push(row);
      continue;
    }

    if (row.currentClerkSlackUserId && row.currentClerkSlackUserId !== n.slackUserId) {
      if (!forceOverwrite) {
        row.action = "conflict";
        row.reason = `Clerk a "${row.currentClerkSlackUserId}", Airtable a "${n.slackUserId}". Lancer --force-overwrite pour écraser.`;
      } else {
        row.action = "updated";
        row.reason = `Écrasement de "${row.currentClerkSlackUserId}" par "${n.slackUserId}" (--force-overwrite)`;
      }
    } else {
      row.action = "updated";
      row.reason = `Première écriture de "${n.slackUserId}"`;
    }
    actions.push(row);
  }

  // 5. Rapport pré-apply
  console.log("--- Rapport actions ---");
  const header = `${"email masqué".padEnd(25)} | ${"name".padEnd(20)} | ${"airtable slackUserId".padEnd(14)} | ${"action".padEnd(18)} | reason`;
  console.log(header);
  console.log("-".repeat(header.length + 20));
  for (const r of actions) {
    const slackCell = (r.slackUserIdAirtable ?? "-").padEnd(14);
    console.log(
      `${r.maskedEmail.padEnd(25)} | ${r.name.slice(0, 20).padEnd(20)} | ${slackCell} | ${(r.action ?? "-").padEnd(18)} | ${r.reason ?? ""}`,
    );
  }
  console.log("");

  // 6. Compteurs
  const counts = {
    updated: 0,
    noop: 0,
    conflict: 0,
    no_clerk: 0,
    ambiguous: 0,
    invalid_format: 0,
    skipped_inactive: 0,
    skipped_no_slack: 0,
  };
  for (const r of actions) counts[r.action] = (counts[r.action] ?? 0) + 1;
  console.log("--- Compteurs ---");
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(18)} : ${v}`);
  console.log("");

  // 7. Garde-fou pré-apply
  const hasInvalid = counts.invalid_format > 0;
  const hasAmbiguous = counts.ambiguous > 0;
  const hasConflict = counts.conflict > 0 && !forceOverwrite;

  if (hasInvalid || hasAmbiguous || hasConflict) {
    console.error("Garde-fou refusé :");
    if (hasInvalid)
      console.error(`  - ${counts.invalid_format} slack_user_id Airtable mal formé(s)`);
    if (hasAmbiguous) console.error(`  - ${counts.ambiguous} email(s) ambigu(s)`);
    if (hasConflict)
      console.error(
        `  - ${counts.conflict} conflit(s) de slackUserId existant Clerk vs Airtable (relancer --apply --force-overwrite si vraiment voulu)`,
      );
    console.error("Aucune écriture Clerk effectuée.");
    process.exit(5);
  }

  if (!apply) {
    console.log("Dry-run : aucune écriture Clerk effectuée.");
    console.log(`Rejouer avec --apply pour écrire ${counts.updated} slackUserId dans Clerk.`);
    return;
  }

  // 8. APPLY — PATCH Clerk pour chaque action "updated"
  console.log(`APPLY — PATCH ${counts.updated} user(s) Clerk...`);
  let patchedOk = 0;
  for (const r of actions) {
    if (r.action !== "updated") continue;
    try {
      await patchClerkUserMetadata(env, r.clerkUserId, r.slackUserIdAirtable);
      patchedOk += 1;
      console.log(`  OK  ${r.maskedEmail} ← ${r.slackUserIdAirtable}`);
    } catch (err) {
      console.error(`  KO  ${r.maskedEmail} : ${err && err.message ? err.message : "unknown"}`);
    }
  }
  console.log("");
  console.log(`${patchedOk}/${counts.updated} patch(es) Clerk appliqué(s).`);
  console.log(
    "Les claims JWT seront rafraîchis au prochain refresh de session de chaque utilisateur.",
  );
}

main().catch((err) => {
  console.error(
    `Erreur fatale : ${err && err.name ? err.name : "unknown"} - ${err && err.message ? err.message : "no message"}`,
  );
  process.exit(4);
});
