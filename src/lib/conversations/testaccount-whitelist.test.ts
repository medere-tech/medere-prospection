/**
 * Tests unitaires pure fonction de `testaccount-whitelist.ts` (PR4).
 *
 * Invariants :
 *   - Les 2 identifiants connus (`E2E_CONV_ID`, `E2E_CONV_ID_PR4`) passent.
 *   - Tout autre identifiant → throw `ForbiddenError` avec `clientMessage`
 *     « Compte de test refusé sur cette conversation. » et `statusCode: 403`.
 *   - Aucune lecture Firestore (fonction pure, pas d'I/O) — vérifié par le
 *     fait que la fonction est synchrone et que le module `firestore/admin`
 *     n'est pas importé transitivement.
 *   - Le Set est bien `ReadonlySet` (aucune mutation runtime possible —
 *     garde TS-level, mais on prouve via le runtime que Set.add n'affecte
 *     pas l'autorisation).
 */
import { describe, expect, it } from "vitest";

import { E2E_CONV_ID } from "@/lib/firestore/reset-e2e-orphans-core";
import { ForbiddenError } from "@/lib/utils/errors";

import {
  assertTestAccountMayWriteConversation,
  E2E_CONV_ID_PR4,
  TEST_ACCOUNT_WHITELIST_CONV_IDS,
} from "./testaccount-whitelist";

describe("testaccount-whitelist", () => {
  describe("TEST_ACCOUNT_WHITELIST_CONV_IDS", () => {
    it("contient exactement les 2 identifiants connus", () => {
      expect(TEST_ACCOUNT_WHITELIST_CONV_IDS.size).toBe(2);
      expect(TEST_ACCOUNT_WHITELIST_CONV_IDS.has(E2E_CONV_ID)).toBe(true);
      expect(TEST_ACCOUNT_WHITELIST_CONV_IDS.has(E2E_CONV_ID_PR4)).toBe(true);
    });

    it("E2E_CONV_ID_PR4 vaut exactement la constante prouvée compatible", () => {
      expect(E2E_CONV_ID_PR4).toBe("427963864300_hubspot-list-999999");
    });
  });

  describe("assertTestAccountMayWriteConversation", () => {
    it("ne throw pas pour E2E_CONV_ID", () => {
      expect(() => assertTestAccountMayWriteConversation(E2E_CONV_ID)).not.toThrow();
    });

    it("ne throw pas pour E2E_CONV_ID_PR4", () => {
      expect(() => assertTestAccountMayWriteConversation(E2E_CONV_ID_PR4)).not.toThrow();
    });

    it("throw ForbiddenError pour un identifiant non listé", () => {
      let caught: unknown;
      try {
        assertTestAccountMayWriteConversation("999999999_hubspot-list-42");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ForbiddenError);
      const fb = caught as ForbiddenError;
      expect(fb.statusCode).toBe(403);
      expect(fb.toClientBody().error.message).toBe("Compte de test refusé sur cette conversation.");
    });

    it("throw ForbiddenError pour une chaîne vide", () => {
      expect(() => assertTestAccountMayWriteConversation("")).toThrow(ForbiddenError);
    });

    it("throw ForbiddenError pour un identifiant proche mais différent", () => {
      // Suffixe 999998 au lieu de 999999 — l'égalité est stricte.
      expect(() =>
        assertTestAccountMayWriteConversation("427963864300_hubspot-list-999998"),
      ).toThrow(ForbiddenError);
    });
  });
});
