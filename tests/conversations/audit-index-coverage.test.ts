/**
 * Sentinelle anti-dérive : chaque forme du catalogue
 * `src/lib/firestore/audit-query-forms.ts` doit être couverte par un
 * index composite déclaré dans `firestore.indexes.json`.
 *
 * Mécanique :
 *   - On lit `firestore.indexes.json` à la racine du repo.
 *   - Pour chaque entrée `audit_log` dont le scope est COLLECTION, on
 *     calcule son `indexKey` via `indexKeyFromSignature`.
 *   - On vérifie que l'ensemble des `indexKey` du catalogue est inclus
 *     dans l'ensemble des `indexKey` déclarés.
 *
 * Si un futur dev ajoute une forme au catalogue (new `indexKey`) sans
 * déclarer l'index correspondant dans `firestore.indexes.json`, ce
 * test tombe immédiatement AVANT merge — le script
 * `check-audit-indexes.mjs` sinon tomberait seulement contre la base
 * réelle au moment du dry-run (trop tard).
 *
 * Miroir de `check-orphan-indexes.mjs` et de l'approche
 * `check-indexes-count.test.ts` pour les catalogues existants.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AUDIT_COLLECTION_FOR_PROBES,
  indexKeyFromSignature,
  type IndexSignature,
  QUERY_FORMS,
} from "@/lib/firestore/audit-query-forms";

interface FirestoreIndexesJson {
  readonly indexes?: ReadonlyArray<{
    readonly collectionGroup?: string;
    readonly queryScope?: string;
    readonly fields?: ReadonlyArray<{
      readonly fieldPath?: string;
      readonly order?: string;
    }>;
  }>;
}

function loadDeclaredAuditIndexes(): ReadonlyArray<IndexSignature> {
  const json = JSON.parse(
    readFileSync(resolve(process.cwd(), "firestore.indexes.json"), "utf-8"),
  ) as FirestoreIndexesJson;
  return (json.indexes ?? [])
    .filter(
      (idx) =>
        idx.collectionGroup === AUDIT_COLLECTION_FOR_PROBES && idx.queryScope === "COLLECTION",
    )
    .map((idx) => ({
      collectionGroup: idx.collectionGroup!,
      fields: (idx.fields ?? []).map((f) => ({
        fieldPath: f.fieldPath!,
        order: (f.order === "DESCENDING" ? "DESCENDING" : "ASCENDING") as
          | "ASCENDING"
          | "DESCENDING",
      })),
    }));
}

describe("audit-query-forms — chaque forme couverte par un index déclaré", () => {
  it("toutes les `indexKey` du catalogue sont dans firestore.indexes.json", () => {
    const declared = new Set(loadDeclaredAuditIndexes().map((sig) => indexKeyFromSignature(sig)));
    const expected = new Set(QUERY_FORMS.map((f) => f.indexKey));

    const missing = [...expected].filter((k) => !declared.has(k));
    expect(
      missing,
      `formes du catalogue sans index déclaré dans firestore.indexes.json : ${missing.join(", ") || "∅"}. Ajoutez l'index dans firestore.indexes.json puis déployez via npm run firebase:deploy:indexes.`,
    ).toEqual([]);
  });

  it("le catalogue déclare au moins les 2 formes PR3 (viewer test + viewer réel)", () => {
    // Sentinelle anti-régression : si quelqu'un retire une des 2 formes
    // en pensant « doublon », le script `check-audit-indexes.mjs` ne
    // contrôlerait plus la query correspondante contre la vraie base.
    const keys = new Set(QUERY_FORMS.map((f) => f.indexKey));
    expect(keys.has("audit_log/targetType+targetId+timestamp")).toBe(true);
    expect(keys.has("audit_log/targetType+targetId+actorTestAccount+timestamp")).toBe(true);
  });

  it("tous les probes passent en lecture seule par `limit(1)` sans requérir d'écriture", () => {
    // Sanity : les labels incluent tous « limit(1) » implicitement via la
    // catégorie `list`. On ne lance pas `run()` (hors emulator), mais on
    // vérifie que chaque forme a bien un `run` callable.
    for (const form of QUERY_FORMS) {
      expect(typeof form.run).toBe("function");
      expect(form.category).toBe("list");
    }
  });
});
