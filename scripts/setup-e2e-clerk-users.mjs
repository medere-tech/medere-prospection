/**
 * SETUP-E2E-CLERK-USERS — provisionne les 2 comptes Clerk utilisés par
 * le harnais Playwright PR1.14.
 *
 * ⚠ LANCEMENT : ce fichier importe `getClerkEnv` depuis un module `.ts`
 *   (`src/lib/security/env.ts`). Node ne charge pas de `.ts` nativement,
 *   il faut passer par `tsx` :
 *     npx tsx scripts/setup-e2e-clerk-users.mjs            # dry-run
 *     npx tsx scripts/setup-e2e-clerk-users.mjs --apply    # exécute
 *   Un lancement direct `node scripts/setup-e2e-clerk-users.mjs` fail-fast
 *   (fail-closed de fait — rien n'est écrit) mais c'est le pattern à
 *   suivre partout dans ce repo (cf. `scripts/seed-contacts-from-hubspot.mjs`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Comptes gérés (whitelist stricte — tout autre email → refusé)
 *
 *   1. e2e-commercial       : role=commercial, slackUserId=UE2ECOMMERCIAL
 *   2. e2e-commercial-owner : role=commercial, slackUserId=U05UVHGBURX (Déthié)
 *   3. e2e-admin            : role=admin, PAS de slackUserId (test fallback)
 *   4. e2e-no-role          : PAS de role, PAS de slackUserId — PR1.14.2
 *                             scénario S10 (page forbidden propre).
 *
 *   Tous les emails ont le suffixe local `+clerk_test` → mode test Clerk
 *   (code OTP figé `424242`, aucune livraison réelle). Tous portent
 *   `publicMetadata.testAccount = true` → la base de code peut filtrer
 *   dans un audit "tous les users prod sauf ceux-là", et le cleanup
 *   script refuse de supprimer un user sans ce flag.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Garde-fous (jamais compromis — compte Déthié intouchable)
 *
 *   - Dry-run par défaut : rien n'est écrit sans `--apply`.
 *   - Whitelist stricte sur l'email : la fonction `isWhitelistedEmail`
 *     vérifie que l'email termine par `+clerk_test@<E2E_EMAIL_DOMAIN>`
 *     ET commence par `e2e-commercial-` ou `e2e-admin-`. Si Clerk retourne
 *     un user inattendu, la mise à jour est refusée.
 *   - Idempotence : si le user existe, on met à jour publicMetadata ;
 *     s'il n'existe pas, on crée. Deux appels successifs produisent le
 *     même état.
 *   - Aucune écriture Firestore. Zéro.
 *   - Jamais de secret ni de token dans la sortie stdout. `CLERK_SECRET_KEY`
 *     et les sign-in tokens générés par Playwright ne passent pas ici.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Variables d'environnement (toutes validées via getClerkEnv())
 *
 *   CLERK_SECRET_KEY            (requis, sk_test_* ou sk_live_*)
 *   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY  (requis pour la validation env)
 *   E2E_EMAIL_DOMAIN            (optionnel, défaut `example.com`)
 *
 * Usage :
 *   node scripts/setup-e2e-clerk-users.mjs            # dry-run
 *   node scripts/setup-e2e-clerk-users.mjs --apply    # exécute
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClerkClient } from "@clerk/backend";

import { getClerkEnv } from "../src/lib/security/env.ts";

const APPLY = process.argv.includes("--apply");
const DOMAIN = process.env.E2E_EMAIL_DOMAIN ?? "example.com";

// M2 security-reviewer PR1.14 : valider le domaine avant toute whitelist.
// Un `endsWith` sur `+clerk_test@.com` matchait n'importe quel sous-TLD si
// l'opérateur mettait `E2E_EMAIL_DOMAIN=".com"`. On refuse tout format
// autre qu'un FQDN simple (ex. `medere-e2e.test`, `example.com`).
if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(DOMAIN)) {
  console.error(
    `E2E_EMAIL_DOMAIN invalide : "${DOMAIN}". Attendu un FQDN simple ` +
      `(ex. "example.com", "medere-e2e.test"). Abandon.`,
  );
  process.exit(5);
}

const E2E_USERS = /** @type {const} */ ([
  {
    key: "commercial",
    emailLocal: "e2e-commercial",
    firstName: "E2E",
    lastName: "Commercial",
    publicMetadata: {
      role: "commercial",
      slackUserId: "UE2ECOMMERCIAL",
      testAccount: true,
    },
  },
  {
    // PR1.14.1 — 3ᵉ compte pour le cas "commercial titulaire".
    // Partage DÉLIBÉRÉMENT le slackUserId de Déthié (U05UVHGBURX) : les
    // conversations réelles de prod lui sont assignées, aucune écriture
    // Firestore n'est nécessaire pour tester le cas owner. La signature
    // Clerk reste distincte (userId Clerk différent, email +clerk_test
    // différent, flag `testAccount` + `role: commercial` qui limite les
    // droits côté app).
    //
    // Les notifications Slack (hand-off, alertes) sont adressées PAR
    // slackUserId, donc le double emploi n'ouvre PAS de voie d'escalade :
    // tout message qui atterrit sur U05UVHGBURX est lu par Déthié, pas
    // par le user Clerk. Idem pour l'audit log serveur qui identifie
    // l'auteur par Clerk userId (immuable), pas par slackUserId.
    key: "commercial-owner",
    emailLocal: "e2e-commercial-owner",
    firstName: "E2E",
    lastName: "CommercialOwner",
    publicMetadata: {
      role: "commercial",
      slackUserId: "U05UVHGBURX",
      testAccount: true,
    },
  },
  {
    key: "admin",
    emailLocal: "e2e-admin",
    firstName: "E2E",
    lastName: "Admin",
    publicMetadata: {
      role: "admin",
      testAccount: true,
      // Pas de slackUserId : couvre le cas admin sans mapping Slack.
    },
  },
  {
    // PR1.14.2 — 4ᵉ compte pour le scénario S10 : page de refus propre
    // (`src/app/admin/forbidden.tsx`). publicMetadata SANS role ni
    // slackUserId → `requireRole` throw ForbiddenError → `forbidden()`.
    // On garde `testAccount: true` pour :
    //   - permettre au cleanup script de le supprimer (garde-fou interne),
    //   - garantir le refus en VERCEL_ENV=production (défense en profondeur).
    key: "no-role",
    emailLocal: "e2e-no-role",
    firstName: "E2E",
    lastName: "NoRole",
    publicMetadata: {
      testAccount: true,
    },
  },
]);

function buildEmail(local) {
  return `${local}+clerk_test@${DOMAIN}`;
}

function isWhitelistedEmail(email) {
  if (typeof email !== "string") return false;
  if (!email.endsWith(`+clerk_test@${DOMAIN}`)) return false;
  const localPart = email.split("+clerk_test@")[0];
  return (
    localPart === "e2e-commercial" ||
    localPart === "e2e-commercial-owner" ||
    localPart === "e2e-admin" ||
    localPart === "e2e-no-role"
  );
}

function logAction(verb, email, extra) {
  // Jamais d'ID Clerk ni de token ici — uniquement l'email whitelisté.
  const suffix = extra ? ` ${extra}` : "";
  console.log(`  [${APPLY ? "APPLY" : "DRY  "}] ${verb} ${email}${suffix}`);
}

/**
 * PR1.14.2 — libellé du résumé en dry-run. "created"/"updated" sont les
 * actions au passé (déjà exécutées) ; en dry-run on affiche ce qui
 * SERAIT fait au prochain --apply.
 */
function describeAction(action, isDryRun) {
  if (!isDryRun) return action;
  if (action === "created") return "serait créé";
  if (action === "updated") return "serait mis à jour";
  if (action === "noop") return "déjà à jour (aucun changement)";
  return action;
}

async function findUserByEmail(clerk, email) {
  const list = await clerk.users.getUserList({ emailAddress: [email] });
  // L'API Clerk retourne `{ data, totalCount }`.
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

async function provisionUser(clerk, spec) {
  const email = buildEmail(spec.emailLocal);
  if (!isWhitelistedEmail(email)) {
    throw new Error(
      `Garde-fou : email calculé ${email} hors whitelist. ` +
        `Vérifier E2E_EMAIL_DOMAIN et la config du script.`,
    );
  }

  const existing = await findUserByEmail(clerk, email);

  // Garde-fou supplémentaire : si Clerk retourne un user, re-vérifier
  // que son email primaire est bien celui attendu AVANT toute écriture.
  if (existing) {
    const primaryEmail = existing.emailAddresses?.find?.(
      (e) => e.id === existing.primaryEmailAddressId,
    )?.emailAddress;
    if (primaryEmail && !isWhitelistedEmail(primaryEmail)) {
      throw new Error(
        `Garde-fou : user Clerk trouvé pour ${email} mais email primaire ` +
          `(${primaryEmail}) hors whitelist. Compte protégé — abandon.`,
      );
    }
  }

  if (!existing) {
    logAction("CREATE", email, `role=${spec.publicMetadata.role ?? "(absent)"}`);
    if (APPLY) {
      await clerk.users.createUser({
        emailAddress: [email],
        firstName: spec.firstName,
        lastName: spec.lastName,
        publicMetadata: spec.publicMetadata,
        skipPasswordChecks: true,
        skipPasswordRequirement: true,
      });
    }
    return { key: spec.key, email, action: "created" };
  }

  // Idempotence : on compare publicMetadata avant d'écrire.
  const currentMeta = existing.publicMetadata ?? {};
  const same =
    JSON.stringify(currentMeta) === JSON.stringify(spec.publicMetadata) &&
    existing.firstName === spec.firstName &&
    existing.lastName === spec.lastName;
  if (same) {
    logAction("NOOP  ", email, `déjà à jour`);
    return { key: spec.key, email, action: "noop" };
  }

  logAction("UPDATE", email, `role=${spec.publicMetadata.role ?? "(absent)"}`);
  if (APPLY) {
    await clerk.users.updateUser(existing.id, {
      firstName: spec.firstName,
      lastName: spec.lastName,
      publicMetadata: spec.publicMetadata,
    });
  }
  return { key: spec.key, email, action: "updated" };
}

async function main() {
  console.log("");
  console.log(
    `SETUP-E2E-CLERK-USERS — mode ${APPLY ? "APPLY (écriture Clerk)" : "DRY-RUN (lecture seule)"}`,
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

  // Ne JAMAIS logger la clé elle-même. On indique uniquement le prefix
  // (sk_test_ ou sk_live_) pour l'opérateur.
  const keyPrefix = env.CLERK_SECRET_KEY.startsWith("sk_live_")
    ? "sk_live_"
    : env.CLERK_SECRET_KEY.startsWith("sk_test_")
      ? "sk_test_"
      : "sk_?_";
  console.log(`Clerk secret key : ${keyPrefix}… (jamais loggée en entier)`);
  // H1 security-reviewer PR1.14 : refus par défaut en sk_live_. Le compte
  // `e2e-admin` a `role=admin` dans publicMetadata → en prod, OTP figé
  // `424242` + email `+clerk_test` = login admin trivial. Pour autoriser
  // explicitement (ex. première provision en prod sous supervision),
  // positionner ALLOW_E2E_ON_LIVE_CLERK=1.
  if (keyPrefix === "sk_live_") {
    if (process.env.ALLOW_E2E_ON_LIVE_CLERK !== "1") {
      console.error(
        "Refus : clé Clerk LIVE détectée. Provisionner `e2e-admin` en prod " +
          "ouvre un login admin via OTP figé.\n" +
          "Pour forcer (sous supervision) : ALLOW_E2E_ON_LIVE_CLERK=1 npx tsx scripts/setup-e2e-clerk-users.mjs --apply",
      );
      process.exit(6);
    }
    console.warn(
      "ATTENTION : clé Clerk LIVE autorisée via ALLOW_E2E_ON_LIVE_CLERK=1. " +
        "La whitelist stricte reste la seule garantie d'intégrité.",
    );
  }
  console.log("");

  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });

  const results = [];
  for (const spec of E2E_USERS) {
    try {
      const res = await provisionUser(clerk, spec);
      results.push(res);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error(`ÉCHEC pour ${spec.key} : ${msg}`);
      process.exit(3);
    }
  }

  console.log("");
  console.log("Résumé :");
  for (const r of results) {
    console.log(`  - ${r.key.padEnd(10)} ${r.email}  →  ${describeAction(r.action, !APPLY)}`);
  }
  console.log("");

  if (!APPLY) {
    console.log("Dry-run terminé. Pour exécuter :");
    console.log("  npx tsx scripts/setup-e2e-clerk-users.mjs --apply");
  } else {
    console.log("Apply terminé. Les sign-in tokens sont générés par le harnais Playwright,");
    console.log("JAMAIS stockés sur disque (clerkSetup injecte un token court dans");
    console.log("le navigateur de test au setup de chaque worker).");
  }
}

main().catch((err) => {
  const name = err && err.name ? err.name : "unknown";
  const msg = err && err.message ? err.message : "no message";
  console.error(`Erreur fatale : ${name} - ${msg}`);
  process.exit(4);
});
