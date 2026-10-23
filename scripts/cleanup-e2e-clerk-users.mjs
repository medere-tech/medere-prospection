/**
 * CLEANUP-E2E-CLERK-USERS — supprime les 4 comptes Clerk provisionnés
 * par `scripts/setup-e2e-clerk-users.mjs`.
 *
 * ⚠ LANCEMENT : importe `getClerkEnv` depuis un module `.ts`
 *   (`src/lib/security/env.ts`). Node ne charge pas de `.ts` nativement,
 *   il faut passer par `tsx` :
 *     npx tsx scripts/cleanup-e2e-clerk-users.mjs            # dry-run
 *     npx tsx scripts/cleanup-e2e-clerk-users.mjs --apply    # exécute
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Comptes gérés (whitelist stricte — tout autre email → refusé)
 *
 *   1. e2e-commercial       — role=commercial, slackUserId=UE2ECOMMERCIAL
 *   2. e2e-commercial-owner — role=commercial, slackUserId=U05UVHGBURX (Déthié)
 *   3. e2e-admin            — role=admin
 *   4. e2e-no-role          — PAS de role, PAS de slackUserId (S10 forbidden)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Garde-fous (jamais compromis — compte Déthié intouchable)
 *
 *   - Dry-run par défaut : rien n'est écrit sans `--apply`.
 *   - Whitelist stricte : la fonction `isWhitelistedEmail` vérifie que
 *     l'email termine par `+clerk_test@<E2E_EMAIL_DOMAIN>` ET commence
 *     par `e2e-commercial`, `e2e-commercial-owner` ou `e2e-admin`.
 *   - **Vérif `publicMetadata.testAccount === true` avant toute
 *     suppression** : si Clerk retourne un user dont le flag n'est pas
 *     posé (manquant / false / autre), on REFUSE la suppression et on
 *     exit code 7. C'est la défense principale contre une suppression
 *     accidentelle d'un compte prod homonyme.
 *   - Validation FQDN du domaine (miroir M2 security-reviewer PR1.14).
 *   - Refus `sk_live_` sauf `ALLOW_E2E_ON_LIVE_CLERK=1` (miroir H1
 *     security-reviewer PR1.14).
 *   - Idempotence : si le user n'existe pas, NOOP (deux appels successifs
 *     laissent la même absence).
 *   - Aucune écriture Firestore. Zéro.
 *   - Jamais de secret ni de token dans la sortie stdout.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Codes de sortie
 *
 *   0 — Succès (dry-run ou apply)
 *   2 — Env Clerk invalide (getClerkEnv throw)
 *   3 — Échec sur un user (exception Clerk inattendue)
 *   4 — Erreur fatale non catchée
 *   5 — E2E_EMAIL_DOMAIN invalide
 *   6 — Clé sk_live_ sans ALLOW_E2E_ON_LIVE_CLERK=1
 *   7 — User trouvé SANS publicMetadata.testAccount=true (refus strict)
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClerkClient } from "@clerk/backend";

import { getClerkEnv } from "../src/lib/security/env.ts";

const APPLY = process.argv.includes("--apply");
const DOMAIN = process.env.E2E_EMAIL_DOMAIN ?? "example.com";

// Miroir M2 setup : validation FQDN du domaine.
if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(DOMAIN)) {
  console.error(
    `E2E_EMAIL_DOMAIN invalide : "${DOMAIN}". Attendu un FQDN simple ` +
      `(ex. "example.com", "medere-e2e.test"). Abandon.`,
  );
  process.exit(5);
}

const E2E_LOCAL_PARTS = /** @type {const} */ ([
  "e2e-commercial",
  "e2e-commercial-owner",
  "e2e-admin",
  "e2e-no-role",
]);

function buildEmail(local) {
  return `${local}+clerk_test@${DOMAIN}`;
}

function isWhitelistedEmail(email) {
  if (typeof email !== "string") return false;
  if (!email.endsWith(`+clerk_test@${DOMAIN}`)) return false;
  const localPart = email.split("+clerk_test@")[0];
  return E2E_LOCAL_PARTS.includes(localPart);
}

function logAction(verb, email, extra) {
  const suffix = extra ? ` ${extra}` : "";
  console.log(`  [${APPLY ? "APPLY" : "DRY  "}] ${verb} ${email}${suffix}`);
}

async function findUserByEmail(clerk, email) {
  const list = await clerk.users.getUserList({ emailAddress: [email] });
  const users = list.data ?? list;
  if (!Array.isArray(users) || users.length === 0) return null;
  if (users.length > 1) {
    throw new Error(
      `Clerk a retourné ${users.length} users pour ${email} — attendu 0 ou 1. ` +
        `Investigation manuelle requise avant tout --apply.`,
    );
  }
  return users[0];
}

async function cleanupUser(clerk, localPart) {
  const email = buildEmail(localPart);
  if (!isWhitelistedEmail(email)) {
    throw new Error(
      `Garde-fou : email calculé ${email} hors whitelist. ` +
        `Vérifier E2E_EMAIL_DOMAIN et la config du script.`,
    );
  }

  const existing = await findUserByEmail(clerk, email);

  if (!existing) {
    logAction("NOOP  ", email, "non trouvé (déjà supprimé)");
    return { key: localPart, email, action: "noop" };
  }

  // Garde-fou 1 : re-vérifier emailPrimary avant toute écriture.
  const primaryEmail = existing.emailAddresses?.find?.(
    (e) => e.id === existing.primaryEmailAddressId,
  )?.emailAddress;
  if (primaryEmail && !isWhitelistedEmail(primaryEmail)) {
    throw new Error(
      `Garde-fou : user Clerk trouvé pour ${email} mais email primaire ` +
        `(${primaryEmail}) hors whitelist. Compte protégé — abandon.`,
    );
  }

  // Garde-fou 2 (SPÉCIFIQUE CLEANUP) : refuser toute suppression si
  // publicMetadata.testAccount n'est pas strictement `true`. Ce flag est
  // posé par le setup script et constitue le marqueur anti-collision
  // avec un compte prod homonyme (ex. un commercial embauché qui aurait
  // pris l'email e2e-commercial@... en prod, sans suffixe +clerk_test).
  const meta = existing.publicMetadata ?? {};
  if (meta.testAccount !== true) {
    const observed = meta.testAccount === undefined ? "MISSING" : JSON.stringify(meta.testAccount);
    throw new Error(
      `Garde-fou : user ${email} existe mais publicMetadata.testAccount ` +
        `n'est pas strictement \`true\` (observé : ${observed}). ` +
        `Refus de suppression — compte potentiellement non-test. ` +
        `Pour forcer après revue manuelle : repositionner le flag via le ` +
        `dashboard Clerk puis relancer.`,
    );
  }

  logAction("DELETE", email, `role=${meta.role ?? "?"}`);
  if (APPLY) {
    await clerk.users.deleteUser(existing.id);
  }
  return { key: localPart, email, action: "deleted" };
}

async function main() {
  console.log("");
  console.log(
    `CLEANUP-E2E-CLERK-USERS — mode ${APPLY ? "APPLY (suppression Clerk)" : "DRY-RUN (lecture seule)"}`,
  );
  console.log(`Domaine email : ${DOMAIN}`);
  console.log("");

  let env;
  try {
    env = getClerkEnv();
  } catch (err) {
    console.error("Env Clerk invalide :");
    console.error(`  ${err && err.message ? err.message : String(err)}`);
    process.exit(2);
  }

  // Miroir H1 setup : refus sk_live_ sauf opt-in explicite.
  const keyPrefix = env.CLERK_SECRET_KEY.startsWith("sk_live_")
    ? "sk_live_"
    : env.CLERK_SECRET_KEY.startsWith("sk_test_")
      ? "sk_test_"
      : "sk_?_";
  console.log(`Clerk secret key : ${keyPrefix}… (jamais loggée en entier)`);
  if (keyPrefix === "sk_live_") {
    if (process.env.ALLOW_E2E_ON_LIVE_CLERK !== "1") {
      console.error(
        "Refus : clé Clerk LIVE détectée. Supprimer des comptes `e2e-*` en " +
          "prod n'a aucun intérêt légitime côté MVP.\n" +
          "Pour forcer (sous supervision) : ALLOW_E2E_ON_LIVE_CLERK=1 npx tsx scripts/cleanup-e2e-clerk-users.mjs --apply",
      );
      process.exit(6);
    }
    console.warn(
      "ATTENTION : clé Clerk LIVE autorisée via ALLOW_E2E_ON_LIVE_CLERK=1. " +
        "Les 2 garde-fous whitelist + testAccount=true restent les seules " +
        "garanties d'intégrité.",
    );
  }
  console.log("");

  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });

  const results = [];
  for (const localPart of E2E_LOCAL_PARTS) {
    try {
      const res = await cleanupUser(clerk, localPart);
      results.push(res);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error(`ÉCHEC pour ${localPart} : ${msg}`);
      // testAccount manquant → exit distinct (7) pour signal clair.
      if (msg.includes("testAccount")) process.exit(7);
      process.exit(3);
    }
  }

  console.log("");
  console.log("Résumé :");
  for (const r of results) {
    console.log(`  - ${r.key.padEnd(20)} ${r.email}  →  ${r.action}`);
  }
  console.log("");

  if (!APPLY) {
    console.log("Dry-run terminé. Pour exécuter :");
    console.log("  npx tsx scripts/cleanup-e2e-clerk-users.mjs --apply");
  } else {
    console.log("Apply terminé. Pour re-provisionner :");
    console.log("  npx tsx scripts/setup-e2e-clerk-users.mjs --apply");
  }
}

main().catch((err) => {
  const name = err && err.name ? err.name : "unknown";
  const msg = err && err.message ? err.message : "no message";
  console.error(`Erreur fatale : ${name} - ${msg}`);
  process.exit(4);
});
