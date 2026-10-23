/**
 * Stub Vitest pour `server-only` (PR1.14.2, security-reviewer M-2).
 *
 * Le package `server-only` npm throw à l'import quand il n'est pas chargé
 * dans un contexte Server (il check le process env). En runtime Vitest
 * (Node direct, pas Next.js serveur), il throw → casse toute la suite
 * unit qui importerait transitivement `require-role.ts` ou tout autre
 * module server-only.
 *
 * Vitest alias ce chemin vers ce stub vide (cf. `vitest.config.ts`
 * section `resolve.alias`), ce qui neutralise le side-effect SANS
 * désactiver la protection côté build Next.js (qui résout `server-only`
 * normalement et fait échouer tout `"use client"` qui l'importerait).
 *
 * Pratique standard documentée côté Vitest / Next.js :
 *   - https://nextjs.org/docs/app/building-your-application/rendering/composition-patterns#keeping-server-only-code-out-of-the-client-environment
 *   - https://vitest.dev/config/#alias
 */
export {};
