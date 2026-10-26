// @vitest-environment jsdom

/**
 * Tests `collectVisibleText` — PR2b-2 round 3 R3-P2 fix.
 *
 * Reproduit les 3 cas identifiés par Déthié dans la régression :
 *   1. un `<script>` qui contient un snake_case ne doit PAS être détecté,
 *   2. un SMS dans `[role="log"]` contenant `jean_dupont@…` ne doit PAS
 *      être détecté,
 *   3. un libellé "backfill_conversation_list_fields" VISIBLE hors du
 *      fil DOIT être inclus dans le texte collecté.
 *
 * Mutation testing : retirer la branche `HIDDEN_TAGS.has(el.tagName)` →
 * cas 1 tombe. Retirer la branche `excludeSelectors` → cas 2 tombe.
 * Permuter `return` et `walk(el)` → cas 3 tombe.
 */
import { describe, expect, it } from "vitest";

import { collectVisibleText } from "./visible-text";

function root(html: string): Element {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

describe("collectVisibleText — texte visible du DOM vivant", () => {
  it("ignore <script> contenant du snake_case (cause du faux positif R3-P2)", () => {
    const el = root(`
      <main>
        <script>const x = { form_password_validation_failed: "foo" };</script>
        <h1>Détails</h1>
      </main>
    `);
    const text = collectVisibleText(el);
    expect(text).toContain("Détails");
    expect(text).not.toContain("form_password_validation_failed");
    expect(text).not.toContain("const");
  });

  it("ignore <style>, <noscript>, <template>", () => {
    const el = root(`
      <main>
        <style>.a { color: red; } /* sms_sent */</style>
        <noscript>script_disabled_message</noscript>
        <template>tpl_handoff_accepted</template>
        <p>Message visible</p>
      </main>
    `);
    const text = collectVisibleText(el);
    expect(text).toBe("Message visible");
    expect(text).not.toMatch(/sms_sent|script_disabled|tpl_handoff/);
  });

  it('ignore le sous-arbre [role="log"] (fil des SMS entrants, R3-P2)', () => {
    const el = root(`
      <main>
        <h2>Journal</h2>
        <p>Hand-off vers un commercial</p>
        <section role="log" aria-label="Fil de la conversation">
          <article>Message du médecin : contactez-moi à jean_dupont@example.fr</article>
        </section>
        <footer>Fin de page</footer>
      </main>
    `);
    const text = collectVisibleText(el);
    expect(text).toContain("Hand-off vers un commercial");
    expect(text).toContain("Fin de page");
    expect(text).not.toContain("jean_dupont");
    expect(text).not.toContain("example.fr");
  });

  it("INCLUT un libellé snake_case visible HORS du fil (régression PR2b-2 round 2)", () => {
    const el = root(`
      <main>
        <section aria-label="Détails de la conversation">
          <p>Action enregistrée</p>
          <p>backfill_conversation_list_fields</p>
        </section>
        <section role="log"><p>jean_dupont@foo</p></section>
      </main>
    `);
    const text = collectVisibleText(el);
    expect(text).toContain("backfill_conversation_list_fields");
    expect(text).not.toContain("jean_dupont");
  });

  it("respecte isVisible — un élément caché par le prédicat est ignoré", () => {
    const el = root(`
      <main>
        <div data-hidden="true">masque_me</div>
        <div>reste_visible</div>
      </main>
    `);
    const isVisible = (node: Element) => node.getAttribute("data-hidden") !== "true";
    const text = collectVisibleText(el, { isVisible });
    expect(text).toContain("reste_visible");
    expect(text).not.toContain("masque_me");
  });

  it("plusieurs selectors exclus (ex. fil + bandeau debug)", () => {
    const el = root(`
      <main>
        <aside data-debug="true">debug_dump</aside>
        <section role="log">log_contenu</section>
        <p>Contenu principal</p>
      </main>
    `);
    const text = collectVisibleText(el, {
      excludeSelectors: ['[role="log"]', '[data-debug="true"]'],
    });
    expect(text).toBe("Contenu principal");
  });

  it("conserve les espaces entre blocs (lisibilité pour les regex d'assertion)", () => {
    const el = root(`
      <main>
        <p>Un</p><p>Deux</p>
      </main>
    `);
    const text = collectVisibleText(el);
    expect(text).toBe("Un Deux");
  });
});
