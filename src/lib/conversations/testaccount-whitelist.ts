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
 *   - `E2E_CONV_ID` (`427963864300_hubspot-list-6081`) — importé depuis
 *     `src/lib/firestore/reset-e2e-orphans-core.ts` (défini là-bas
 *     ligne 44) pour garder UNE SEULE source de vérité. C'est la
 *     conversation réelle de Déthié, désormais au statut `opted_out`,
 *     utilisée par les specs e2e orphelins (PR2c) et par la spec e2e
 *     PR3 reveal-phone.
 *
 *   - `E2E_CONV_ID_PR4` (`427963864300_hubspot-list-999999`) — nouvelle
 *     conversation de test dédiée au harnais PR4 (`handed_off` +
 *     `handoff.assignedTo: "U05UVHGBURX"`, sur le même contactId
 *     `427963864300` que la conv A). Seedée par
 *     `scripts/seed-e2e-pr4-conv.mjs`, reset par
 *     `scripts/reset-e2e-pr4-conv.mjs`.
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

import { E2E_CONV_ID } from "@/lib/firestore/reset-e2e-orphans-core";
import { ForbiddenError } from "@/lib/utils/errors";

/**
 * docId Firestore de la conversation PR4 (seedée par le script). Choisi
 * pour être strictement différent de `E2E_CONV_ID` tout en pointant le
 * MÊME `contactId` (le PS de test de Déthié) pour éviter d'avoir à
 * seeder un nouveau contact.
 *
 * Format : `<contactId>_hubspot-list-<campaignListId>`, conforme à
 * `CAMPAIGN_ID_REGEX = /^hubspot-list-\d+$/` déjà appliqué partout où
 * le `campaignId` est validé côté serveur.
 */
export const E2E_CONV_ID_PR4 = "427963864300_hubspot-list-999999";

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
