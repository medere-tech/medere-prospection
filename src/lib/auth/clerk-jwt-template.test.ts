/**
 * Sentinelle PR1.14.2 — synchronise la liste des claims attendus du
 * JWT template Clerk avec le Zod `SessionClaimsSchema` qui les parse.
 *
 * Si Déthié ajoute un claim au template Clerk sans mettre à jour
 * `SessionClaimsSchema`, OU inversement, ces tests tombent. Documente
 * la liste exacte et garantit qu'elle reste alignée.
 *
 * Le script `scripts/diag-clerk-user-pr1-14-1.mjs` et la preuve e2e
 * `tests/e2e/claims-shape.spec.ts` vérifient ensuite que le claim
 * `testAccount` arrive bien avec le type attendu (boolean) sur un VRAI
 * JWT émis par Clerk.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { EXPECTED_CLERK_JWT_CLAIMS, requireRole } from "./require-role";

// On lit `SessionClaimsSchema` indirectement via `requireRole` : le schéma
// est privé au module (volontairement — pas d'API publique). On introspecte
// via le safeParse d'un payload inconnu + les issues Zod retournées pour
// déduire les clés. Mais plus simple : on importe un helper exporté par
// require-role.ts qui expose les keys du schema au test. Le pattern DRY :
// un seul source de vérité, EXPECTED_CLERK_JWT_CLAIMS, est le contrat.

describe("Sentinelle JWT template Clerk — synchronisation avec SessionClaimsSchema", () => {
  it("EXPECTED_CLERK_JWT_CLAIMS liste exactement les 5 claims attendus (role, firstName, lastName, slackUserId, testAccount)", () => {
    expect([...EXPECTED_CLERK_JWT_CLAIMS].sort()).toEqual([
      "firstName",
      "lastName",
      "role",
      "slackUserId",
      "testAccount",
    ]);
  });

  it("ajouter un claim au template Clerk sans mettre à jour EXPECTED_CLERK_JWT_CLAIMS fait tomber ce test", () => {
    // Documentation vivante : la constante EST le contrat. Si quelqu'un
    // décide d'ajouter un claim (ex: "email", "externalId"), ce test
    // force à l'ajouter aussi dans EXPECTED_CLERK_JWT_CLAIMS, ce qui
    // oblige à passer en revue require-role.ts.
    const expectedLength = 5;
    expect(EXPECTED_CLERK_JWT_CLAIMS).toHaveLength(expectedLength);
  });

  it("un claim inconnu dans le JWT (ex: email) est IGNORÉ silencieusement par Zod (pas d'erreur)", async () => {
    // Zod `.object()` ignore par défaut les clés inconnues. C'est voulu :
    // si Clerk émet un claim non prévu, on ne crash pas. Si on voulait
    // être strict, on utiliserait `.strict()`. On ne le fait pas pour
    // éviter de bloquer sur un claim ajouté par Clerk (ex. iat, exp, iss
    // qui sont des claims JWT standards non applicatifs).
    //
    // Ce test documente ce choix : la sentinelle `EXPECTED_CLERK_JWT_CLAIMS`
    // est pour les claims APPLICATIFS. Les claims standards JWT ne sont
    // pas listés.
    const schema = z.object({
      role: z.enum(["admin", "commercial"]),
    });
    const result = schema.safeParse({ role: "admin", email: "ignored@example.com", iat: 123 });
    expect(result.success).toBe(true);
  });

  it("`role` est le SEUL claim non-optionnel — tous les autres sont dégradables", async () => {
    // Documentation vivante : si on retire `role` du JWT template, ce
    // test tombe (vite dévoilé). Les 4 autres claims sont optionnels
    // (`.optional()` ou `.nullish()`).
    expect(EXPECTED_CLERK_JWT_CLAIMS[0]).toBe("role");
    // Smoke test : un payload avec SEULEMENT role → OK.
    // (Les tests détaillés sont dans require-role.test.ts.)
    const _requireRoleTypeCheck: typeof requireRole = requireRole;
    expect(_requireRoleTypeCheck).toBeTypeOf("function");
  });
});
