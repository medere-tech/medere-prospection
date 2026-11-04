/**
 * Helper partagé — crée un client Clerk admin APRÈS le chargement de
 * l'environnement, sur le modèle exact des scripts qui fonctionnent déjà
 * (`setup-e2e-clerk-users.mjs:298`, `cleanup-e2e-clerk-users.mjs:197`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi un helper
 *
 *   Le wrapper `clerkClient()` de `@clerk/nextjs/server` capture
 *   `process.env.CLERK_SECRET_KEY` AU CHARGEMENT DU MODULE
 *   (`node_modules/@clerk/nextjs/dist/esm/server/constants.js:9` :
 *   `const SECRET_KEY = process.env.CLERK_SECRET_KEY || "";`).
 *   Comme les `import` ESM sont évalués AVANT l'exécution du top-level
 *   du script, `config({ path: ".env.local" })` passe trop tard : la
 *   constante `SECRET_KEY` est déjà `""` quand le script appelle
 *   `clerkClient()` → échec « Missing Clerk Secret Key ».
 *
 *   `createClerkClient` de `@clerk/backend` est un factory pur qui lit
 *   `secretKey` À L'APPEL, pas à l'import. Tous les scripts admin
 *   devraient l'utiliser APRÈS dotenv.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Garde-fou
 *
 *   Si `CLERK_SECRET_KEY` n'est pas peuplée (dotenv n'a pas trouvé la
 *   variable OU `.env.local` est absent), le helper arrête le script
 *   avec un message qui donne le NOM de la variable mais JAMAIS sa
 *   valeur. Exit code 2 (env Firebase/Clerk invalide, cohérent avec
 *   les autres scripts).
 */
import { createClerkClient } from "@clerk/backend";

/**
 * Instancie un client Clerk admin à partir de `process.env.CLERK_SECRET_KEY`.
 * À APPELER APRÈS `config({ path: ".env.local" })`.
 *
 * @returns {ReturnType<typeof createClerkClient>} client Clerk admin prêt.
 */
export function makeClerkAdminClient() {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (typeof secretKey !== "string" || secretKey.length === 0) {
    // Ne JAMAIS afficher la valeur ni un fragment. Seul le nom de la
    // variable est utile pour l'opérateur.
    console.error(
      "[clerk-admin-client] Variable d'environnement requise manquante :\n" +
        "  CLERK_SECRET_KEY\n" +
        "Vérifier que `.env.local` existe à la racine du projet et porte\n" +
        "cette variable (format sk_test_... ou sk_live_...). Arrêt.",
    );
    process.exit(2);
  }
  return createClerkClient({ secretKey });
}
