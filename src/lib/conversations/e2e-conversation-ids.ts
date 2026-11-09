/**
 * Constantes des conversations e2e — SOURCE UNIQUE des identifiants,
 * sans `server-only`, importable par les scripts CLI (`tsx`), les
 * tests, le dashboard SSR et les fonctions server.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi ce module distinct de `testaccount-whitelist.ts`
 *
 *   `testaccount-whitelist.ts` porte `import "server-only"` (pattern RSC :
 *   build échoue si un Client Component l'importe ; `tsx` throw à
 *   l'import). Mais ses identifiants sont les mêmes que ceux consommés
 *   par les scripts `seed-e2e-pr4-conv.mjs` / `reset-e2e-pr4-conv.mjs` et
 *   par le core qu'ils appellent — ces scripts tournent sous `tsx`
 *   (Node CLI) et doivent pouvoir les lire sans `server-only`.
 *
 *   Solution : extraire les 2 identifiants dans ce module, SANS
 *   `server-only`. La liste blanche vraie (`TEST_ACCOUNT_WHITELIST_CONV_IDS`)
 *   reste dans `testaccount-whitelist.ts` et consomme ces constantes.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Source unique par identifiant
 *
 *   - `E2E_CONV_ID` est défini dans
 *     `src/lib/firestore/reset-e2e-orphans-core.ts:44`. On le RÉ-EXPORTE
 *     ici, aucune copie en dur. Si ce fichier disparaissait, l'import
 *     casserait au build — anti-drift.
 *   - `E2E_CONV_ID_PR4` est défini ICI. `testaccount-whitelist.ts`
 *     l'importe (voir file:line là-bas).
 */
export { E2E_CONV_ID } from "@/lib/firestore/reset-e2e-orphans-core";

/**
 * docId Firestore de la conversation de test PR4 (seedée par
 * `scripts/seed-e2e-pr4-conv.mjs`). Pointe le MÊME `contactId`
 * `427963864300` que `E2E_CONV_ID` (PS de test de Déthié) avec un
 * `campaignId` distinct → 2 conversations indépendantes sur le même
 * contact, sans nouveau seed de contact nécessaire.
 *
 * Format `<contactId>_hubspot-list-<campaignListId>`, conforme à
 * `CAMPAIGN_ID_REGEX = /^hubspot-list-\d+$/` et à la regex d'`attach`
 * `^[^/]+_hubspot-list-\d+$` (prouvé lors du cadrage PR4 A1.3).
 */
export const E2E_CONV_ID_PR4 = "427963864300_hubspot-list-999999";
