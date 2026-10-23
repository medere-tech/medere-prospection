/**
 * Tests de `countFromResult` — count display du script
 * `check-conversation-list-indexes.mjs`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Régression documentée
 *
 *   Lors d'un run prod `medere-prospection-mvp`, le script affichait
 *   `backfill.messages.last-human-outbound (count=1)` alors que la
 *   sous-collection probe `messages` est vide. Cause : le fallback
 *   `r ? 1 : 0` traitait un `QuerySnapshot` vide (objet truthy) comme
 *   count=1. Le test `empty QuerySnapshot → count 0` ci-dessous aurait
 *   détecté le bug.
 */
import { describe, expect, it } from "vitest";

import { countFromResult } from "@/lib/firestore/check-indexes-count";

/** Faux `QuerySnapshot` — minimum pour discriminer : `.size` + `.docs`. */
function fakeQuerySnapshot(size: number): object {
  return { size, docs: Array.from({ length: size }, (_, i) => ({ id: `d${i}` })) };
}

/** Faux `DocumentSnapshot` — `.exists: boolean`. */
function fakeDocSnapshot(exists: boolean): object {
  return { exists, id: "x", data: () => ({}) };
}

describe("countFromResult (PR2a — anti-régression check-indexes count)", () => {
  it("QuerySnapshot vide → 0 (régression medere-prospection-mvp)", () => {
    // Avant le fix, cette assertion aurait échoué : le fallback
    // `r ? 1 : 0` retournait 1 sur un objet truthy.
    expect(countFromResult(fakeQuerySnapshot(0))).toBe(0);
  });

  it("QuerySnapshot avec N docs → N", () => {
    expect(countFromResult(fakeQuerySnapshot(1))).toBe(1);
    expect(countFromResult(fakeQuerySnapshot(5))).toBe(5);
  });

  it("DocumentSnapshot existant → 1", () => {
    expect(countFromResult(fakeDocSnapshot(true))).toBe(1);
  });

  it("DocumentSnapshot inexistant → 0", () => {
    expect(countFromResult(fakeDocSnapshot(false))).toBe(0);
  });

  it("ListConversationsOutput → longueur conversations[]", () => {
    expect(countFromResult({ conversations: [], nextCursor: null, hasMore: false })).toBe(0);
    expect(
      countFromResult({
        conversations: [{ conversationId: "a" }, { conversationId: "b" }],
        nextCursor: null,
        hasMore: false,
      }),
    ).toBe(2);
  });

  it("ConversationListVersionResult → 1 si topConversationId non null, 0 sinon", () => {
    expect(countFromResult({ version: "0_", topUpdatedAtMs: 0, topConversationId: null })).toBe(0);
    expect(countFromResult({ version: "1_x", topUpdatedAtMs: 1, topConversationId: "x" })).toBe(1);
  });

  it("count() natif (number) → brut", () => {
    expect(countFromResult(0)).toBe(0);
    expect(countFromResult(42)).toBe(42);
  });

  it("legacy Conversation (POJO) → 1 ; null → 0", () => {
    expect(countFromResult({ conversationId: "c", status: "active" })).toBe(1);
    expect(countFromResult(null)).toBe(0);
  });

  // Mutation testing — si le fix est reverté, ces tests tombent.
  it("mutation : revert du check `size`+`docs` ferait fail-close sur une collection vide", () => {
    // Preuve par contre-exemple : si on retire le branchement
    // `size + docs → size`, un QuerySnapshot vide tomberait dans le
    // fallback POJO qui retournerait 1.
    const snap = fakeQuerySnapshot(0);
    expect(countFromResult(snap)).toBe(0); // ne doit JAMAIS être 1
  });
});
