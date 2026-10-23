/**
 * Sentinelle PR1.14 — `ADMIN_NAV_ITEMS.enabled` reste synchrone avec
 * l'existence de `src/app<href>/page.tsx`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi
 *
 *   Décision produit : les items non fonctionnels restent VISIBLES et
 *   grisés dans la barre latérale pour montrer la cible à la direction.
 *   Risque : qu'une page `/admin/conversations/page.tsx` arrive en PR2
 *   SANS que `enabled` passe à `true` → lien grisé alors que la page
 *   répond 200. Risque inverse : `enabled:true` activé par erreur avant
 *   que la page existe → clic qui mène vers une 404.
 *
 *   Cette sentinelle casse le build dans les deux cas.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * État attendu au moment où cette sentinelle est écrite (PR1.14) :
 *
 *   /admin/contacts        enabled:true   → src/app/admin/contacts/page.tsx  EXISTE
 *   /admin/conversations   enabled:false  → src/app/admin/conversations/page.tsx  ABSENT
 *     (sera activé en PR2 avec la page liste)
 *   /admin/campaigns       enabled:false  → src/app/admin/campaigns/page.tsx  ABSENT (aucune PR planifiée)
 *   /admin/audits          enabled:false  → src/app/admin/audits/page.tsx  ABSENT (aucune PR planifiée)
 *   /admin/monitoring      enabled:false  → src/app/admin/monitoring/page.tsx  ABSENT (aucune PR planifiée)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Mutation testing
 *
 *   - swap `enabled` d'un item : le fichier soit existe (test "N'EXISTE
 *     PAS" fail) soit n'existe pas (test "EXISTE" fail).
 *   - vide la liste : la sanity "au moins un enabled + un disabled" fail.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ADMIN_NAV_ITEMS } from "./admin-nav-items";

const SRC_APP = path.resolve(__dirname, "../../app");

function pageTsxPathForHref(href: string): string {
  if (!href.startsWith("/")) {
    throw new Error(`href doit commencer par /, reçu : ${href}`);
  }
  // href = "/admin/contacts" → src/app/admin/contacts/page.tsx
  const rel = href.replace(/^\//, "");
  return path.join(SRC_APP, rel, "page.tsx");
}

describe("ADMIN_NAV_ITEMS — sentinelle enabled ⟷ page.tsx (PR1.14)", () => {
  for (const item of ADMIN_NAV_ITEMS) {
    const pagePath = pageTsxPathForHref(item.href);
    const relPath = path.relative(process.cwd(), pagePath);

    if (item.enabled) {
      it(`enabled:true ⟹ ${relPath} EXISTE (item "${item.label}")`, () => {
        expect(
          existsSync(pagePath),
          `enabled:true pour "${item.label}" mais ${relPath} introuvable. ` +
            `Soit créer la page, soit repasser enabled:false.`,
        ).toBe(true);
      });
    } else {
      it(`enabled:false ⟹ ${relPath} ABSENT (item "${item.label}")`, () => {
        expect(
          existsSync(pagePath),
          `enabled:false pour "${item.label}" mais ${relPath} existe. ` +
            `Activer enabled:true pour exposer le lien.`,
        ).toBe(false);
      });
    }
  }

  it("sanity : la liste contient au moins un item enabled ET un item non-enabled", () => {
    // Garantit qu'une mutation qui vide la liste ou qui bascule tous les
    // items vers un même état échoue — sinon la sentinelle devient
    // tautologique.
    const enabled = ADMIN_NAV_ITEMS.filter((i) => i.enabled);
    const disabled = ADMIN_NAV_ITEMS.filter((i) => !i.enabled);
    expect(enabled.length, "au moins un item enabled attendu").toBeGreaterThan(0);
    expect(disabled.length, "au moins un item non-enabled attendu").toBeGreaterThan(0);
  });

  it("sanity : chaque href commence par /admin/ (évite une faute de frappe de route)", () => {
    for (const item of ADMIN_NAV_ITEMS) {
      expect(item.href.startsWith("/admin/"), `href invalide : ${item.href}`).toBe(true);
    }
  });
});
