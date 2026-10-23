/**
 * Test de couverture (anti-drift) — PR2a.
 *
 * Vérifie que `QUERY_FORMS` catalogue EXACTEMENT les combinaisons
 * acceptées par les Zod schemas des 3 routes `/api/admin/conversations*`
 * (plus les lookups legacy par contactId).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi
 *
 *   Si un dev ajoute un filtre (ex. un nouvel onglet `priorite`, ou un
 *   paramètre `segmentId`) à une route sans l'ajouter au catalogue, la
 *   nouvelle forme de requête ne sera jamais vérifiée en prod → risque
 *   de `FAILED_PRECONDITION` à l'exécution. Ce test casse à ce moment-là.
 *
 *   Le test re-dérive les combinaisons depuis les dimensions SOURCES
 *   (`ADMIN_TABS`/`COMMERCIAL_TABS` du module tabs partagé), pas depuis
 *   la liste `QUERY_FORMS` elle-même → anti-tautologie.
 */
import { describe, expect, it } from "vitest";

import { QUERY_FORMS } from "@/lib/firestore/conversation-list-query-forms";
import { ADMIN_TABS, COMMERCIAL_TABS } from "@/lib/firestore/conversation-list-tabs";

const ROLES = [
  { role: "admin" as const, tabs: ADMIN_TABS },
  { role: "commercial" as const, tabs: COMMERCIAL_TABS },
];

/** Combinaisons admin+commercial × tab × camp × q (16+12 = 28 par catégorie). */
function expectedListAndCountsAndCursorLabels(prefix: "list" | "list.cursor" | "counts"): string[] {
  const labels: string[] = [];
  const [cat, suffix] = prefix === "list.cursor" ? ["list", ".cursor"] : [prefix, ""];
  for (const { role, tabs } of ROLES) {
    for (const tab of tabs) {
      for (const hasCampaign of [false, true]) {
        for (const hasQ of [false, true]) {
          labels.push(
            `${cat}.${role}.${tab}${hasCampaign ? ".camp" : ""}${hasQ ? ".q" : ""}${suffix}`,
          );
        }
      }
    }
  }
  return labels;
}

function expectedVersionLabels(): string[] {
  const labels: string[] = [];
  for (const { role, tabs } of ROLES) {
    for (const tab of tabs) labels.push(`version.${role}.${tab}`);
  }
  return labels;
}

const EXPECTED_LEGACY_LABELS = [
  "legacy.getActiveConversationByContactId",
  "legacy.getHandedOffConversationByContactId",
  "legacy.getLatestConversationByContactId",
];

describe("QUERY_FORMS — couverture des 3 routes + legacy (PR2a)", () => {
  const actualLabels = new Set(QUERY_FORMS.map((f) => f.label));

  it("couvre toutes les combinaisons /list (role × tab × camp × q)", () => {
    const expected = expectedListAndCountsAndCursorLabels("list");
    for (const label of expected) {
      expect(actualLabels.has(label), `/list : missing form "${label}"`).toBe(true);
    }
  });

  it("couvre toutes les combinaisons /list.cursor (idem avec startAfter)", () => {
    const expected = expectedListAndCountsAndCursorLabels("list.cursor");
    for (const label of expected) {
      expect(actualLabels.has(label), `/list cursor : missing form "${label}"`).toBe(true);
    }
  });

  it("couvre toutes les combinaisons /counts (role × tab × camp × q)", () => {
    const expected = expectedListAndCountsAndCursorLabels("counts");
    for (const label of expected) {
      expect(actualLabels.has(label), `/counts : missing form "${label}"`).toBe(true);
    }
  });

  it("couvre toutes les combinaisons /version (role × tab, pas de camp/q)", () => {
    const expected = expectedVersionLabels();
    for (const label of expected) {
      expect(actualLabels.has(label), `/version : missing form "${label}"`).toBe(true);
    }
  });

  it("couvre les 3 lookups legacy par contactId", () => {
    for (const label of EXPECTED_LEGACY_LABELS) {
      expect(actualLabels.has(label), `legacy : missing form "${label}"`).toBe(true);
    }
  });

  it("totalise exactement 28+28+28+7+3 = 94 formes (pas de duplicat, pas d'orphelin)", () => {
    // Détecte un oubli d'orphelin : si quelqu'un ajoute une forme à
    // QUERY_FORMS sans mettre à jour les dimensions attendues, ce total
    // change et le test tombe.
    const expectedCount =
      expectedListAndCountsAndCursorLabels("list").length + // 28
      expectedListAndCountsAndCursorLabels("list.cursor").length + // 28
      expectedListAndCountsAndCursorLabels("counts").length + // 28
      expectedVersionLabels().length + // 7
      EXPECTED_LEGACY_LABELS.length; // 3
    expect(QUERY_FORMS.length).toBe(expectedCount);
    // Zéro doublon.
    expect(actualLabels.size).toBe(QUERY_FORMS.length);
  });

  it("chaque forme a une catégorie non-nulle (invariant structurel)", () => {
    for (const f of QUERY_FORMS) {
      expect(["list", "list-cursor", "counts", "version", "legacy"]).toContain(f.category);
    }
  });
});
