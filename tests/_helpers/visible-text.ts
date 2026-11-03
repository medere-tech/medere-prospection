/**
 * Utilitaires de lecture du texte VISIBLE d'un DOM — PR2b-2 round 3 R3-P2 fix.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi une fonction dédiée
 *
 *   `node.innerText` sur un nœud DÉTACHÉ (ex. retour d'un
 *   `document.body.cloneNode(true)`) se comporte comme `textContent` : il
 *   inclut `<script>`, `<style>`, les éléments cachés par CSS, et tout
 *   ce qui n'a pas de layout. La sentinelle snake_case
 *   (`assertNoAuditActionCode`) matchait alors du JS compilé Next.js et
 *   des clés i18n Clerk (`form_password_validation_failed`, …) → faux
 *   positif systématique sur toutes les tailles.
 *
 *   La parade : parcourir le DOM VIVANT (jamais cloner), ignorer
 *   `<script>`, `<style>`, `<noscript>`, `<template>`, le sous-arbre
 *   `[role="log"]` (contenu libre des SMS entrants qui peut légitimement
 *   contenir `jean_dupont@…`), et chaque élément non visible selon le
 *   test `isVisible` injectable (`el.checkVisibility()` en Playwright,
 *   simulé en jsdom via `style.display` / `hidden`).
 *
 *   Zéro dépendance Playwright — testable en jsdom.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * PR2c tour 1 — module unique, miroir e2e inclus
 *
 *   `tests/e2e/fixtures.ts::innerTextWithoutMessageThread` injecte le
 *   source de CETTE fonction dans la page Playwright via
 *   `collectVisibleText.toString()` + `new Function(...)` — plus de
 *   duplication (c.f. commit PR2c). CONSÉQUENCE : la fonction doit être
 *   AUTO-SUFFISANTE (pas de closures sur des `const` module-level),
 *   sinon le source stringifié perd ses dépendances dans la page.
 *   Tous les symboles sont déclarés DANS le corps de `collectVisibleText`.
 */

/** Un élément est "exclu" (sauté dans le parcours) s'il est caché OU sous
 * `[role="log"]`. */
export interface CollectVisibleTextOptions {
  /** Prédicat de visibilité runtime. En browser : `(el) => el.checkVisibility()`. */
  readonly isVisible?: (el: Element) => boolean;
  /** Sélecteurs CSS dont les sous-arbres sont exclus. Défaut : `['[role="log"]']`. */
  readonly excludeSelectors?: readonly string[];
}

/**
 * Collecte le texte visible d'un sous-arbre `root`.
 *
 *   - Les sous-arbres `<script>`, `<style>`, `<noscript>`, `<template>`
 *     sont ignorés (jamais rendus à l'écran).
 *   - Chaque sélecteur de `excludeSelectors` (défaut `[role="log"]`) voit
 *     son sous-arbre entier ignoré.
 *   - Un élément dont `isVisible(el)` retourne `false` ET tous ses
 *     descendants sont ignorés.
 *   - Les nœuds texte sont concaténés en préservant les espaces
 *     naturels, en séparant les blocs par `\n`.
 *
 * Retourne un `string` sans surprise (pas de HTML).
 *
 * 🔒 AUTO-SUFFISANCE : HIDDEN_TAGS, excludeSelectors défaut et `walk`
 * sont déclarés DANS le corps — permet à `fixtures.ts` de passer la
 * source stringifiée à `page.evaluate` sans perdre de dépendance.
 */
export function collectVisibleText(root: Element, options?: CollectVisibleTextOptions): string {
  // Déclarées INSIDE pour que `collectVisibleText.toString()` reste
  // auto-portant (pas de closure sur des const module-level).
  const HIDDEN_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

  const isVisible = options?.isVisible ?? (() => true);
  const excludeSelectors = options?.excludeSelectors ?? ['[role="log"]'];

  const parts: string[] = [];

  const walk = (el: Element): void => {
    // Tag jamais rendu.
    if (HIDDEN_TAGS.has(el.tagName)) return;
    // Sous-arbre exclu (ex. role="log").
    for (const sel of excludeSelectors) {
      if (el.matches(sel)) return;
    }
    // Visibilité runtime (CSS + display + hidden).
    if (!isVisible(el)) return;

    // Parcours des enfants.
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3 /* TEXT_NODE */) {
        const text = (node.nodeValue ?? "").replace(/\s+/g, " ");
        if (text.trim().length > 0) parts.push(text);
      } else if (node.nodeType === 1 /* ELEMENT_NODE */) {
        walk(node as Element);
      }
    }
  };

  walk(root);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
