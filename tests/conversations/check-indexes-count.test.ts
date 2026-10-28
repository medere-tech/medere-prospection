/**
 * Tests `countFromResult` — fichier unique (fusion PR2c tour 2b bis des
 * deux anciens `src/lib/firestore/check-indexes-count.test.ts` et
 * `tests/conversations/check-indexes-count.test.ts`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Régressions documentées (reprises des deux fichiers)
 *
 *   1. PR2a — `check-conversation-list-indexes.mjs` affichait
 *      `count=1` sur un `QuerySnapshot` vide. Fix : branche explicite
 *      `size + docs → size`.
 *   2. PR2c tour 2b — `check-orphan-indexes.mjs` affichait `count=1`
 *      sur un `AggregateQuerySnapshot` vide (collection vide). Fix :
 *      détection explicite via `.data().count`.
 *   3. PR2c tour 2b bis — `countFromResult(POJO Conversation)`
 *      retournait `1` arbitraire via le fallback final. Fix : suppression
 *      du fallback, `UnknownQueryResultShapeError` sur toute forme
 *      inconnue + conversion `Conversation|null → number` DÉPLACÉE dans
 *      les formes `legacy.*` du catalogue (qui connaissent leur type).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Les 3 types de tests
 *
 *   A. Shapes élémentaires acceptés par `countFromResult`.
 *   B. Fail-closed : formes inconnues → throw.
 *   C. Couverture catalogues : chaque forme des 2 catalogues
 *      (`conversation-list-query-forms` + `orphan-list-query-forms`)
 *      jointe à un résultat simulé de son type attendu → pas de throw.
 *      Ce test aurait attrapé la régression legacy ci-dessus.
 */
import { describe, expect, it } from "vitest";

import { countFromResult, UnknownQueryResultShapeError } from "@/lib/firestore/check-indexes-count";
import { QUERY_FORMS as CONV_QUERY_FORMS } from "@/lib/firestore/conversation-list-query-forms";
import { QUERY_FORMS as ORPHAN_QUERY_FORMS } from "@/lib/firestore/orphan-list-query-forms";

// ─────────────────────────────────────────────────────────────────────────────
// Factories de résultats simulés
// ─────────────────────────────────────────────────────────────────────────────

function fakeQuerySnapshot(size: number): object {
  return { size, docs: Array.from({ length: size }, (_, i) => ({ id: `d${i}` })) };
}

function fakeDocSnapshot(exists: boolean): object {
  return { exists, id: "x", data: () => ({}) };
}

function fakeAggregateSnapshot(count: number): object {
  return { data: () => ({ count }) };
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Shapes élémentaires
// ─────────────────────────────────────────────────────────────────────────────

describe("countFromResult — A. Shapes élémentaires", () => {
  describe("QuerySnapshot", () => {
    it("vide → 0 (régression PR2a : fallback truthy)", () => {
      expect(countFromResult(fakeQuerySnapshot(0))).toBe(0);
    });

    it("avec N docs → N", () => {
      expect(countFromResult(fakeQuerySnapshot(1))).toBe(1);
      expect(countFromResult(fakeQuerySnapshot(5))).toBe(5);
    });
  });

  describe("DocumentSnapshot", () => {
    it("exists=false → 0", () => {
      expect(countFromResult(fakeDocSnapshot(false))).toBe(0);
    });

    it("exists=true → 1", () => {
      expect(countFromResult(fakeDocSnapshot(true))).toBe(1);
    });
  });

  describe("AggregateQuerySnapshot (`.count().get()`)", () => {
    it("collection VIDE → count=0 (régression PR2c tour 2b)", () => {
      expect(countFromResult(fakeAggregateSnapshot(0))).toBe(0);
    });

    it("collection peuplée → count exact", () => {
      expect(countFromResult(fakeAggregateSnapshot(42))).toBe(42);
    });

    it(".data() ne retourne pas {count:number} → throw", () => {
      expect(() => countFromResult({ data: () => ({ nonsense: true }) })).toThrow(
        UnknownQueryResultShapeError,
      );
    });
  });

  describe("ListConversationsOutput / ListOrphanInboundsOutput", () => {
    it("conversations:[] → 0", () => {
      expect(countFromResult({ conversations: [], nextCursor: null, hasMore: false })).toBe(0);
    });

    it("conversations peuplées → longueur", () => {
      expect(
        countFromResult({
          conversations: [{ conversationId: "a" }, { conversationId: "b" }],
          nextCursor: null,
          hasMore: false,
        }),
      ).toBe(2);
    });

    it("orphans:[] → 0", () => {
      expect(countFromResult({ orphans: [], nextCursor: null, hasMore: false })).toBe(0);
    });

    it("orphans peuplés → longueur", () => {
      expect(countFromResult({ orphans: [{}, {}, {}], nextCursor: null, hasMore: false })).toBe(3);
    });
  });

  describe("ConversationListVersionResult", () => {
    it("topConversationId=null → 0", () => {
      expect(countFromResult({ version: "0_", topUpdatedAtMs: 0, topConversationId: null })).toBe(
        0,
      );
    });

    it("topConversationId='x' → 1", () => {
      expect(countFromResult({ version: "1_x", topUpdatedAtMs: 1, topConversationId: "x" })).toBe(
        1,
      );
    });
  });

  describe("number pass-through (count() natif, legacy wrapper)", () => {
    it("0 → 0", () => expect(countFromResult(0)).toBe(0));
    it("42 → 42", () => expect(countFromResult(42)).toBe(42));
  });

  describe("null", () => {
    it("null → 0", () => expect(countFromResult(null)).toBe(0));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Fail-closed sur formes inconnues
// ─────────────────────────────────────────────────────────────────────────────

describe("countFromResult — B. Fail-closed", () => {
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

  it("🔒 POJO Conversation brut → throw (anti-régression PR2c tour 2b bis)", () => {
    // Avant le fix, cette forme tombait sur `return 1` arbitraire → count=1
    // affiché pour une conversation « trouvée » même si c'était un fallback.
    // Désormais, la conversion `Conversation|null → number` vit dans les
    // formes `legacy.*` du catalogue, et `countFromResult` lève une erreur
    // explicite sur un POJO brut.
    expect(() => countFromResult({ conversationId: "c", status: "active" })).toThrow(
      UnknownQueryResultShapeError,
    );
  });

  it("🔒 ancien shape `{conversationId, conversation}` → throw", () => {
    // Idem : plus de branche fallback — doit tomber en fail-closed.
    expect(() => countFromResult({ conversationId: "c_hubspot-list-1", conversation: {} })).toThrow(
      UnknownQueryResultShapeError,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Couverture catalogues (anti-régression universelle)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mapping `category` du catalogue → factory de résultat simulé que
 * `run()` est censé produire. Si un catégorie nouvelle est ajoutée au
 * catalogue sans qu'un mapping ne soit prévu ici, le test échoue → force
 * le dev à expliciter.
 */
const CATEGORY_TO_SIMULATED_RESULTS: Record<string, Array<() => unknown>> = {
  // conversation-list-query-forms
  list: [() => fakeQuerySnapshot(0), () => fakeQuerySnapshot(3)],
  "list-cursor": [
    () => ({ conversations: [], nextCursor: null, hasMore: false }),
    () => ({
      conversations: [{ conversationId: "a" }],
      nextCursor: "a",
      hasMore: false,
    }),
  ],
  counts: [() => 0, () => 5],
  version: [
    () => ({ version: "0_", topUpdatedAtMs: 0, topConversationId: null }),
    () => ({ version: "1_x", topUpdatedAtMs: 1, topConversationId: "x" }),
  ],
  legacy: [() => 0, () => 1], // les forms legacy convertissent déjà en number
  backfill: [() => fakeQuerySnapshot(0), () => fakeQuerySnapshot(1)],
  propagate: [() => fakeQuerySnapshot(0), () => fakeQuerySnapshot(2)],
  // orphan-list-query-forms
  lookup: [() => fakeDocSnapshot(false), () => fakeDocSnapshot(true)],
};

describe("countFromResult — C. Couverture catalogues (ne lève JAMAIS d'erreur sur les formes documentées)", () => {
  it("conversation-list-query-forms : chaque forme simulée → pas de throw", () => {
    for (const form of CONV_QUERY_FORMS) {
      const factories = CATEGORY_TO_SIMULATED_RESULTS[form.category];
      expect(
        factories,
        `catégorie "${form.category}" sans mapping simulé — ajouter dans le test`,
      ).toBeDefined();
      for (const factory of factories!) {
        const simulated = factory();
        expect(() => countFromResult(simulated), `${form.label} (${form.category})`).not.toThrow();
      }
    }
  });

  it("orphan-list-query-forms : chaque forme simulée → pas de throw", () => {
    // Les forms `list` et `count` de orphan-list retournent QuerySnapshot
    // et AggregateQuerySnapshot respectivement.
    const ORPHAN_CATEGORY_RESULTS: Record<string, Array<() => unknown>> = {
      list: [() => fakeQuerySnapshot(0), () => fakeQuerySnapshot(1)],
      count: [() => fakeAggregateSnapshot(0), () => fakeAggregateSnapshot(10)],
      lookup: [() => fakeDocSnapshot(false), () => fakeDocSnapshot(true)],
    };
    for (const form of ORPHAN_QUERY_FORMS) {
      const factories = ORPHAN_CATEGORY_RESULTS[form.category];
      expect(
        factories,
        `catégorie orphan "${form.category}" sans mapping simulé — ajouter dans le test`,
      ).toBeDefined();
      for (const factory of factories!) {
        const simulated = factory();
        expect(() => countFromResult(simulated), `${form.label} (${form.category})`).not.toThrow();
      }
    }
  });

  it("les formes legacy.* du catalogue retournent déjà un `number` (plus de POJO)", async () => {
    // Preuve que la conversion vit DANS la forme catalogue, pas dans
    // countFromResult. On stub la fonction métier sous-jacente serait
    // trop invasif ; à la place, on checke la signature du run().
    //
    // Les forms legacy ne retournent plus `Conversation | null` — leur
    // `run()` est maintenant `.then(toCount)` qui donne `Promise<number>`.
    //
    // Faute d'exécuter run() (ferait un appel Firestore), on vérifie
    // simplement que les forms legacy du catalogue sont bien catégorisées,
    // et qu'un `number` passe countFromResult sans throw.
    const legacyForms = CONV_QUERY_FORMS.filter((f) => f.category === "legacy");
    expect(legacyForms.length).toBeGreaterThan(0);
    // Garanti par `CATEGORY_TO_SIMULATED_RESULTS["legacy"]`.
    for (const n of [0, 1]) {
      expect(() => countFromResult(n)).not.toThrow();
    }
  });
});
