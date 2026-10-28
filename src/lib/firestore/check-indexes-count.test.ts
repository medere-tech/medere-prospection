/**
 * Tests `countFromResult` — PR2c tour 2b.
 *
 * Scope : couvre tous les shapes attendus Firestore + le fallback
 * fail-closed (throw sur forme inconnue). Reproduit en particulier le
 * bug « AggregateQuerySnapshot sur collection vide → count=1 » qui
 * affichait un chiffre trompeur dans `check-orphan-indexes.mjs`.
 */
import { describe, expect, it } from "vitest";

import { countFromResult, UnknownQueryResultShapeError } from "./check-indexes-count";

describe("countFromResult", () => {
  describe("AggregateQuerySnapshot (PR2c tour 2b)", () => {
    it("collection VIDE → count=0 (plus `return 1` arbitraire)", () => {
      const emptyAgg = { data: () => ({ count: 0 }) };
      expect(countFromResult(emptyAgg)).toBe(0);
    });

    it("collection peuplée → count exact", () => {
      const agg = { data: () => ({ count: 42 }) };
      expect(countFromResult(agg)).toBe(42);
    });

    it(".data() ne retourne pas {count: number} → throw fail-closed", () => {
      const bad = { data: () => ({ nonsense: true }) };
      expect(() => countFromResult(bad)).toThrow(UnknownQueryResultShapeError);
    });
  });

  describe("QuerySnapshot", () => {
    it("size=0, docs=[] → 0 (truthy object trap évité)", () => {
      expect(countFromResult({ size: 0, docs: [] })).toBe(0);
    });

    it("size=5 → 5", () => {
      expect(countFromResult({ size: 5, docs: [1, 2, 3, 4, 5] })).toBe(5);
    });
  });

  describe("DocumentSnapshot", () => {
    it("exists=false → 0", () => {
      expect(countFromResult({ exists: false })).toBe(0);
    });

    it("exists=true → 1", () => {
      expect(countFromResult({ exists: true })).toBe(1);
    });
  });

  describe("ListConversationsOutput / ListOrphanInboundsOutput", () => {
    it("conversations: [] → 0", () => {
      expect(countFromResult({ conversations: [], nextCursor: null })).toBe(0);
    });

    it("orphans: [] → 0", () => {
      expect(countFromResult({ orphans: [], nextCursor: null })).toBe(0);
    });

    it("orphans: [a, b, c] → 3", () => {
      expect(countFromResult({ orphans: [{}, {}, {}], nextCursor: null })).toBe(3);
    });
  });

  describe("ConversationListVersionResult", () => {
    it("topConversationId=null → 0", () => {
      expect(countFromResult({ topConversationId: null })).toBe(0);
    });

    it("topConversationId='abc_hubspot-list-1' → 1", () => {
      expect(countFromResult({ topConversationId: "abc_hubspot-list-1" })).toBe(1);
    });
  });

  describe("Legacy getActiveConversationByContactId", () => {
    it("null → 0", () => {
      expect(countFromResult(null)).toBe(0);
    });

    it("{conversationId, conversation} → 1", () => {
      expect(countFromResult({ conversationId: "c_hubspot-list-1", conversation: {} })).toBe(1);
    });
  });

  describe("Fail-closed (fallback explicite)", () => {
    it("undefined → throw", () => {
      expect(() => countFromResult(undefined)).toThrow(UnknownQueryResultShapeError);
    });

    it("string arbitraire → throw", () => {
      expect(() => countFromResult("unexpected")).toThrow(UnknownQueryResultShapeError);
    });

    it("objet non reconnu → throw avec hint des clefs", () => {
      try {
        countFromResult({ foo: 1, bar: 2 });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(UnknownQueryResultShapeError);
        expect((err as Error).message).toMatch(/foo,bar/);
      }
    });
  });

  describe("Nombre direct (number pass-through)", () => {
    it("0 → 0", () => {
      expect(countFromResult(0)).toBe(0);
    });

    it("7 → 7 (countConversations retourne un number)", () => {
      expect(countFromResult(7)).toBe(7);
    });
  });
});
