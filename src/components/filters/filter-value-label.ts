/**
 * Helper partagé — résolution d'un libellé humain pour un filtre Select
 * dont la valeur est un identifiant technique (Slack userId, HubSpot
 * listId, etc.) — défaut production PR2b-2 P1.
 *
 * Cause racine : Base UI `<Select.Value>` sans render prop `children`
 * affiche la value brute du Select (ex. `U05UVHGBURX`). Fix : passer un
 * `children` qui mappe value → libellé via ce helper.
 *
 * Contrat :
 *   - Si la value est null/vide/sentinelle "all" → retourne `allLabel`
 *     avec `known: true` (ce n'est pas un cas d'inconnu).
 *   - Sinon on cherche dans `items`. Trouvé → `{ display: nameOf(item), known: true }`.
 *   - Non trouvé → `{ display: unknownLabel, known: false }`.
 *
 * Zéro dépendance React — pur TS, testable sans jsdom.
 */

export interface ResolveFilterLabelOptions<T> {
  /** Valeur courante du Select (ex. "U05UVHGBURX", "6081", "__all__", null). */
  readonly value: string | null;
  /** Liste source pour mapper value → item. `null` tolérés (prop indisponible). */
  readonly items: readonly T[] | null;
  /** Extrait la clé technique d'un item (ex. c => c.slackUserId). */
  readonly keyOf: (item: T) => string;
  /** Extrait le libellé humain d'un item (ex. c => c.name). */
  readonly nameOf: (item: T) => string;
  /** Libellé "tout sélectionné" (ex. "Tous les commerciaux"). */
  readonly allLabel: string;
  /** Libellé pour une valeur présente mais inconnue (ex. "Commercial inconnu"). */
  readonly unknownLabel: string;
  /** Sentinelle "tout" (par défaut `"__all__"`). */
  readonly allSentinel?: string;
}

export interface ResolveFilterLabelResult {
  /** Texte à afficher dans le trigger (jamais un identifiant brut). */
  readonly display: string;
  /** `false` si l'identifiant est présent mais introuvable → l'UI doit
   * proposer un lien "Retirer le filtre". `true` dans tous les autres cas
   * (y compris "tout sélectionné"). */
  readonly known: boolean;
}

export function resolveFilterLabel<T>(
  opts: ResolveFilterLabelOptions<T>,
): ResolveFilterLabelResult {
  const { value, items, keyOf, nameOf, allLabel, unknownLabel } = opts;
  const allSentinel = opts.allSentinel ?? "__all__";

  if (value === null || value === "" || value === allSentinel) {
    return { display: allLabel, known: true };
  }

  if (items === null) {
    // Liste indisponible (Airtable down, etc.) : le Select est disabled
    // côté UI (le caller gère ce cas). On ne peut ni affirmer "connu" ni
    // "inconnu" : on affiche `allLabel` (qui porte souvent le message
    // d'indisponibilité) et `known: true` pour éviter l'avis "Retirer le
    // filtre" alors que le composant est de toute façon disabled.
    return { display: allLabel, known: true };
  }

  const match = items.find((it) => keyOf(it) === value);
  if (match === undefined) {
    return { display: unknownLabel, known: false };
  }
  return { display: nameOf(match), known: true };
}
