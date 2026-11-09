/**
 * Liste blanche des conversations sur lesquelles un compte Clerk
 * `testAccount: true` peut écrire (PR4 — « J'ai contacté »).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi une constante dans le code
 *
 *   D1 (décision Déthié) : fail-closed strict. Un compte test (admin
 *   e2e, commercial titulaire e2e) ne peut écrire QUE sur un
 *   identifiant listé ici. Tout autre identifiant → 403
 *   `ForbiddenError` AVANT lecture Firestore (0 read, 0 write).
 *
 *   Pas de variable d'environnement : la liste est versionnée en git,
 *   revue en PR, impossible à muter sans commit.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Source unique des deux identifiants
 *
 *   Les 2 constantes `E2E_CONV_ID` et `E2E_CONV_ID_PR4` vivent dans
 *   `src/lib/conversations/e2e-conversation-ids.ts` (SANS `server-only`)
 *   pour être lisibles par les scripts CLI `tsx`. Ce fichier re-exporte
 *   `E2E_CONV_ID` lui-même défini dans `src/lib/firestore/reset-e2e-orphans-core.ts:44`.
 *
 *   La liste blanche vraie (`TEST_ACCOUNT_WHITELIST_CONV_IDS`) vit ICI,
 *   derrière `server-only` : un Client Component qui l'importerait
 *   ferait planter le build. Seul le code serveur (routes API, core
 *   mark-handoff-contacted) consomme la garde.
 *
 *   Format du docId prouvé compatible avec tous les parsers (cf.
 *   JSDoc `conversationDocId` dans `src/lib/firestore/conversations.ts:219`
 *   et `IdSchema` dans `src/app/api/admin/conversations/[id]/reveal-phone/route.ts:48`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Usage
 *
 *   ```ts
 *   if (actor.testAccount) {
 *     assertTestAccountMayWriteConversation(conversationId);
 *   }
 *   // ... suite des contrôles (tx.get, droits fins, statut, idempotence).
 *   ```
 */
import "server-only";

import { E2E_CONV_ID, E2E_CONV_ID_PR4 } from "@/lib/conversations/e2e-conversation-ids";
import { ForbiddenError } from "@/lib/utils/errors";

// Re-export pour ne pas casser les callers existants qui importaient
// `E2E_CONV_ID_PR4` depuis ce module (routes, tests, docs). Source unique
// dans `e2e-conversation-ids.ts`.
export { E2E_CONV_ID_PR4 };

/**
 * Set fermé des `conversationId` que les comptes `testAccount: true`
 * peuvent cibler. `ReadonlySet` pour empêcher toute mutation au runtime.
 */
export const TEST_ACCOUNT_WHITELIST_CONV_IDS: ReadonlySet<string> = new Set([
  E2E_CONV_ID,
  E2E_CONV_ID_PR4,
]);

/**
 * Throw `ForbiddenError` si l'`conversationId` n'est pas dans la
 * whitelist. À appeler UNIQUEMENT quand `actor.testAccount === true` ;
 * les comptes réels ne passent pas par cette garde.
 *
 * JAMAIS d'écriture, jamais de lecture Firestore ici. Le fail-closed
 * est prononcé AVANT tout tx.get.
 */
export function assertTestAccountMayWriteConversation(conversationId: string): void {
  if (!TEST_ACCOUNT_WHITELIST_CONV_IDS.has(conversationId)) {
    throw new ForbiddenError({
      message: `testaccount-whitelist: ${conversationId} is not whitelisted`,
      clientMessage: "Compte de test refusé sur cette conversation.",
      context: { conversationId },
    });
  }
}
