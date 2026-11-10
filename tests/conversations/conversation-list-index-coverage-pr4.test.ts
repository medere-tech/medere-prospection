/**
 * Sentinelle `firestore.indexes.json` ↔ onglets PR4 `a_traiter` /
 * `contactees` (point 7).
 *
 * Mutation : retire un index parmi les 10 ci-dessous → le test tombe.
 *
 * Les 10 index attendus couvrent les variantes role × camp × q × version
 * pour les onglets PR4 (filtre composite `status + handoffContacted`).
 * Chaque forme suit la règle Firestore : équalités dans l'ordre des
 * `.where()`, orderBy en dernier (DESCENDING sur `lastMessageAt` pour
 * list/counts, sur `updatedAt` pour version).
 *
 * Ne vérifie PAS les index antérieurs à PR4 (déjà prouvés par leurs
 * propres tests + la base en prod).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

interface IndexField {
  readonly fieldPath: string;
  readonly order: "ASCENDING" | "DESCENDING";
}
interface FirestoreIndex {
  readonly collectionGroup: string;
  readonly fields: readonly IndexField[];
}

function loadConvIndexes(): readonly FirestoreIndex[] {
  const raw = readFileSync(path.resolve(__dirname, "../../firestore.indexes.json"), "utf-8");
  const parsed = JSON.parse(raw) as { indexes: readonly FirestoreIndex[] };
  return parsed.indexes.filter((idx) => idx.collectionGroup === "conversations");
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

const ASC = "ASCENDING" as const;
const DESC = "DESCENDING" as const;

/** 10 index attendus — introduits par PR4 pour a_traiter/contactees. */
const EXPECTED_PR4_INDEXES: ReadonlyArray<{ label: string; fields: readonly IndexField[] }> = [
  {
    label: "admin a_traiter/contactees — list no camp no q",
    fields: [
      { fieldPath: "status", order: ASC },
      { fieldPath: "handoffContacted", order: ASC },
      { fieldPath: "lastMessageAt", order: DESC },
    ],
  },
  {
    label: "admin — list no camp q",
    fields: [
      { fieldPath: "status", order: ASC },
      { fieldPath: "handoffContacted", order: ASC },
      { fieldPath: "contactNameSearch", order: ASC },
      { fieldPath: "lastMessageAt", order: DESC },
    ],
  },
  {
    label: "admin — list camp no q",
    fields: [
      { fieldPath: "campaignId", order: ASC },
      { fieldPath: "status", order: ASC },
      { fieldPath: "handoffContacted", order: ASC },
      { fieldPath: "lastMessageAt", order: DESC },
    ],
  },
  {
    label: "admin — list camp q",
    fields: [
      { fieldPath: "campaignId", order: ASC },
      { fieldPath: "status", order: ASC },
      { fieldPath: "handoffContacted", order: ASC },
      { fieldPath: "contactNameSearch", order: ASC },
      { fieldPath: "lastMessageAt", order: DESC },
    ],
  },
  {
    label: "commercial — list no camp no q",
    fields: [
      { fieldPath: "assignedTo", order: ASC },
      { fieldPath: "status", order: ASC },
      { fieldPath: "handoffContacted", order: ASC },
      { fieldPath: "lastMessageAt", order: DESC },
    ],
  },
  {
    label: "commercial — list no camp q",
    fields: [
      { fieldPath: "assignedTo", order: ASC },
      { fieldPath: "status", order: ASC },
      { fieldPath: "handoffContacted", order: ASC },
      { fieldPath: "contactNameSearch", order: ASC },
      { fieldPath: "lastMessageAt", order: DESC },
    ],
  },
  {
    label: "commercial — list camp no q",
    fields: [
      { fieldPath: "assignedTo", order: ASC },
      { fieldPath: "campaignId", order: ASC },
      { fieldPath: "status", order: ASC },
      { fieldPath: "handoffContacted", order: ASC },
      { fieldPath: "lastMessageAt", order: DESC },
    ],
  },
  {
    label: "commercial — list camp q",
    fields: [
      { fieldPath: "assignedTo", order: ASC },
      { fieldPath: "campaignId", order: ASC },
      { fieldPath: "status", order: ASC },
      { fieldPath: "handoffContacted", order: ASC },
      { fieldPath: "contactNameSearch", order: ASC },
      { fieldPath: "lastMessageAt", order: DESC },
    ],
  },
  {
    label: "admin — version",
    fields: [
      { fieldPath: "status", order: ASC },
      { fieldPath: "handoffContacted", order: ASC },
      { fieldPath: "updatedAt", order: DESC },
    ],
  },
  {
    label: "commercial — version",
    fields: [
      { fieldPath: "assignedTo", order: ASC },
      { fieldPath: "status", order: ASC },
      { fieldPath: "handoffContacted", order: ASC },
      { fieldPath: "updatedAt", order: DESC },
    ],
  },
];

describe("firestore.indexes.json — couverture PR4 a_traiter/contactees (point 7)", () => {
  const indexes = loadConvIndexes();

  it("au moins 27 index composites sur `conversations` (17 pré-PR4 + 10 PR4)", () => {
    expect(indexes.length).toBeGreaterThanOrEqual(27);
  });

  for (const { label, fields } of EXPECTED_PR4_INDEXES) {
    it(`${label} — index [${fields.map((f) => f.fieldPath).join(", ")}] présent`, () => {
      const covered = indexes.some((idx) => fieldsEqual(idx.fields, fields));
      expect(covered, `Index PR4 manquant : ${label}. Attendu : ${JSON.stringify(fields)}.`).toBe(
        true,
      );
    });
  }
});
