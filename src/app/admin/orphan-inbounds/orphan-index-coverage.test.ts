/**
 * Sentinelle `firestore.indexes.json` ↔ combinaisons UI
 * (PR2c tour 2b bloc B — passe 2 post review, point 8).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Objectif
 *
 *   La page `/admin/orphan-inbounds` combine 4 onglets × (sans motif +
 *   4 motifs) × 2 vues `isTestFixture` = 40 combinaisons. Chaque
 *   combinaison produit UNE requête Firestore spécifique. Ce test
 *   DÉRIVE toutes ces combinaisons à partir des MÊMES constantes que
 *   la page (`ORPHAN_TAB_ORDER`, `ORPHAN_REASON_VALUES`) et vérifie
 *   que `firestore.indexes.json` contient un index composite qui
 *   couvre chacune.
 *
 *   Mutation sentinelle : si on retire un index, ou si on ajoute une
 *   5e raison dans `ORPHAN_REASON_VALUES` sans index correspondant,
 *   ce test échoue immédiatement.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Discipline de forme
 *
 *   Pour la requête `where("isTestFixture", "==", X) [× where("processingState",
 *   "==", Y)] [× where("reason", "==", Z)] .orderBy("receivedAt", "desc")`,
 *   Firestore exige un index composite qui :
 *     1. Contient tous les `fieldPath` d'équalité + le `fieldPath` d'orderBy.
 *     2. Pose le `fieldPath` d'orderBy EN DERNIER avec `order: "DESCENDING"`.
 *     3. Pose les `fieldPath` d'équalité avec `order: "ASCENDING"`.
 *
 *   On exige en plus un ORDRE DÉTERMINISTE côté index (isTestFixture,
 *   puis processingState, puis reason, puis receivedAt) — c'est celui
 *   qu'applique naturellement `listOrphanInbounds` dans l'ordre des
 *   `.where()`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_ORPHAN_TAB,
  ORPHAN_REASON_VALUES,
  ORPHAN_TAB_ORDER,
  type OrphanReason,
  type OrphanTab,
} from "@/app/admin/orphan-inbounds/orphan-filter-constants";

interface IndexField {
  readonly fieldPath: string;
  readonly order: "ASCENDING" | "DESCENDING";
}
interface FirestoreIndex {
  readonly collectionGroup: string;
  readonly fields: readonly IndexField[];
}

function loadIndexes(): readonly FirestoreIndex[] {
  // `__dirname` ici est `src/app/admin/orphan-inbounds/` → remonter 4
  // niveaux pour atteindre la racine qui contient `firestore.indexes.json`.
  const raw = readFileSync(path.resolve(__dirname, "../../../../firestore.indexes.json"), "utf-8");
  const parsed = JSON.parse(raw) as { indexes: readonly FirestoreIndex[] };
  return parsed.indexes.filter((idx) => idx.collectionGroup === "inbound_messages_orphans");
}

/**
 * Dérive la LISTE DE CHAMPS attendus pour une combinaison UI.
 * Reproduit la logique de `listOrphanInbounds` dans
 * `src/lib/firestore/orphan-inbounds.ts:473-491` :
 *   1. isTestFixture (toujours, car `includeTestFixtures !== true` par défaut)
 *   2. processingState (si tab !== "all")
 *   3. reason (si motif sélectionné)
 *   4. receivedAt DESC (orderBy)
 */
function expectedFieldsForCombination(input: {
  tab: OrphanTab;
  reason: OrphanReason | null;
}): readonly IndexField[] {
  const fields: IndexField[] = [{ fieldPath: "isTestFixture", order: "ASCENDING" }];
  if (input.tab !== "all") {
    fields.push({ fieldPath: "processingState", order: "ASCENDING" });
  }
  if (input.reason !== null) {
    fields.push({ fieldPath: "reason", order: "ASCENDING" });
  }
  fields.push({ fieldPath: "receivedAt", order: "DESCENDING" });
  return fields;
}

function fieldsEqual(a: readonly IndexField[], b: readonly IndexField[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    if (!ai || !bi) return false;
    if (ai.fieldPath !== bi.fieldPath) return false;
    if (ai.order !== bi.order) return false;
  }
  return true;
}

/**
 * Spécial case : un orderBy seul (un seul `where("isTestFixture", "==", ...)`
 * + `orderBy("receivedAt", "desc")`) est en fait couvert par un index
 * composite 2 champs. On vérifie son existence.
 */
describe("firestore.indexes.json — couverture `inbound_messages_orphans` (PR2c tour 2b passe 2)", () => {
  const indexes = loadIndexes();

  // Pré-sanity : au moins un index existe pour la collection.
  it("existe au moins 1 index composite sur `inbound_messages_orphans`", () => {
    expect(indexes.length).toBeGreaterThan(0);
  });

  // Pré-sanity : les constantes dérivées ne sont pas vides (défense
  // contre une mutation qui vide `ORPHAN_TAB_ORDER` ou `ORPHAN_REASON_VALUES`).
  it("ORPHAN_TAB_ORDER contient les 4 onglets attendus", () => {
    expect(ORPHAN_TAB_ORDER).toEqual(["pending", "attached", "dismissed", "all"]);
    expect(ORPHAN_TAB_ORDER).toContain(DEFAULT_ORPHAN_TAB);
  });
  it("ORPHAN_REASON_VALUES contient les 4 raisons attendues", () => {
    expect(ORPHAN_REASON_VALUES.length).toBe(4);
  });

  // ─── Dérivation dynamique des 4 × 5 × 2 = 40 combinaisons UI ────────
  const COMBINATIONS: Array<{ tab: OrphanTab; reason: OrphanReason | null }> = [];
  for (const tab of ORPHAN_TAB_ORDER) {
    COMBINATIONS.push({ tab, reason: null });
    for (const reason of ORPHAN_REASON_VALUES) {
      COMBINATIONS.push({ tab, reason });
    }
  }
  // Les 2 valeurs d'`isTestFixture` ne changent PAS la forme de l'index
  // (le composite est `isTestFixture + ...` quel que soit le booléen).
  // On a donc 20 formes uniques couvrant les 40 combinaisons UI.

  for (const combo of COMBINATIONS) {
    const expected = expectedFieldsForCombination(combo);
    const label = `tab="${combo.tab}" + reason=${combo.reason ?? "null"}`;
    it(`${label} → index couvrant [${expected.map((f) => f.fieldPath).join(", ")}] existe`, () => {
      const covered = indexes.some((idx) => fieldsEqual(idx.fields, expected));
      expect(
        covered,
        `Aucun index composite ne couvre la combinaison UI « ${label} ». ` +
          `Fields attendus : ${JSON.stringify(expected)}. ` +
          `Ajoute l'index dans firestore.indexes.json ET la forme ` +
          `dans src/lib/firestore/orphan-list-query-forms.ts.`,
      ).toBe(true);
    });
  }
});
