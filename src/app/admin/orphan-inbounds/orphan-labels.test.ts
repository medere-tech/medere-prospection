/**
 * Sentinelle PR2c tour 2b bloc B — libellés FR exhaustifs.
 *
 *   - Aucune valeur de libellé ne doit ressembler à du snake_case
 *     (`[a-z0-9]+_[a-z0-9_]+`). Un identifiant technique qui a fuité
 *     jusqu'à l'UI casse le test immédiatement.
 *   - Chaque enum (reason / state / dismiss / phoneMatch) est COUVERT
 *     (type-check Record<K, …> + runtime : nombre d'entrées correspond).
 */
import { describe, expect, it } from "vitest";

import {
  ORPHAN_DISMISS_EXPLANATIONS,
  ORPHAN_DISMISS_LABELS,
  ORPHAN_PHONE_MATCH_EXPLANATIONS,
  ORPHAN_PHONE_MATCH_LABELS,
  ORPHAN_REASON_EXPLANATIONS,
  ORPHAN_REASON_LABELS,
  ORPHAN_STATE_LABELS,
  ORPHAN_TAB_LABELS,
  ORPHAN_TOASTS,
} from "./orphan-labels";

const SNAKE_CASE = /\b[a-z0-9]+_[a-z0-9_]+\b/;

const TABLES: Record<string, Record<string, string>> = {
  ORPHAN_REASON_LABELS,
  ORPHAN_REASON_EXPLANATIONS,
  ORPHAN_TAB_LABELS,
  ORPHAN_STATE_LABELS,
  ORPHAN_DISMISS_LABELS,
  ORPHAN_DISMISS_EXPLANATIONS,
  ORPHAN_PHONE_MATCH_LABELS,
  ORPHAN_PHONE_MATCH_EXPLANATIONS,
  ORPHAN_TOASTS,
};

describe("Tables de libellés — sentinelle anti snake_case", () => {
  for (const [name, table] of Object.entries(TABLES)) {
    for (const [key, value] of Object.entries(table)) {
      it(`${name}[${key}] ne contient pas de snake_case`, () => {
        expect(value).not.toMatch(SNAKE_CASE);
      });
      it(`${name}[${key}] n'est pas vide`, () => {
        expect(value.length).toBeGreaterThan(0);
      });
    }
  }

  it("ORPHAN_REASON_LABELS couvre exactement les 4 raisons", () => {
    expect(Object.keys(ORPHAN_REASON_LABELS).sort()).toEqual(
      ["enqueue_failed", "no_conversation", "parse_failed", "unknown_contact"].sort(),
    );
  });

  it("ORPHAN_STATE_LABELS couvre exactement les 3 états", () => {
    expect(Object.keys(ORPHAN_STATE_LABELS).sort()).toEqual(
      ["attached", "dismissed", "pending"].sort(),
    );
  });

  it("ORPHAN_TAB_LABELS couvre les 3 états + 'all'", () => {
    expect(Object.keys(ORPHAN_TAB_LABELS).sort()).toEqual(
      ["all", "attached", "dismissed", "pending"].sort(),
    );
  });

  it("ORPHAN_DISMISS_LABELS couvre exactement les 3 motifs figés", () => {
    expect(Object.keys(ORPHAN_DISMISS_LABELS).sort()).toEqual(
      ["already_handled_elsewhere", "sender_not_identifiable", "unrelated_or_spam"].sort(),
    );
  });

  it("ORPHAN_PHONE_MATCH_LABELS couvre les 3 valeurs d'enum", () => {
    expect(Object.keys(ORPHAN_PHONE_MATCH_LABELS).sort()).toEqual(
      ["match", "mismatch", "not_computable"].sort(),
    );
  });
});
