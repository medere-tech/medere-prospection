/**
 * Compte le nombre de documents retournés par UNE forme de requête d'un
 * catalogue (`conversation-list-query-forms.ts`, `orphan-list-query-forms.ts`),
 * selon son type Firestore.
 *
 * ⚠️ Jamais afficher le contenu — les scripts `check-*-indexes.mjs`
 * utilisent uniquement ce count pour tracer qu'une requête a réussi.
 *
 * Historique :
 *   - PR2a : extrait du script après observation d'un bug subtil où un
 *     `QuerySnapshot` VIDE retournait `count=1` (le fallback `r ? 1 : 0`
 *     traitait l'objet comme truthy, pas ses docs comme vides).
 *   - PR2c tour 2b : second bug analogue — un `AggregateQuerySnapshot`
 *     (retour de `.count().get()`) tombait sur le fallback final
 *     `return 1`, affichant `count=1` sur une collection VIDE. Fix :
 *     détection explicite via `.data().count` et fallback final FAIL-CLOSED
 *     (throw) au lieu de deviner.
 */

/**
 * Erreur levée quand `countFromResult` reçoit une forme non reconnue.
 * Fait planter le script `check-*-indexes.mjs` plutôt que d'afficher un
 * count arbitraire (invariant : le script est utilisé comme sentinelle
 * de déploiement d'index, un count faux l'invalide).
 */
export class UnknownQueryResultShapeError extends Error {
  constructor(hint: string) {
    super(`countFromResult: unknown Firestore result shape (${hint})`);
    this.name = "UnknownQueryResultShapeError";
  }
}

export function countFromResult(r: unknown): number {
  if (typeof r === "number") return r;
  if (r === null) return 0;
  if (r === undefined) {
    throw new UnknownQueryResultShapeError("undefined");
  }
  if (typeof r !== "object") {
    throw new UnknownQueryResultShapeError(`typeof=${typeof r}`);
  }
  const rec = r as Record<string, unknown>;

  // AggregateQuerySnapshot (retour `.count().get()`) — a `.data()` qui
  // retourne `{count: number}` ou similaire. Détection via la présence
  // de la méthode `data` ET l'absence des champs QuerySnapshot (size/docs).
  // On appelle `.data()` et on lit `count`.
  if (
    typeof rec.data === "function" &&
    rec.size === undefined &&
    rec.docs === undefined &&
    rec.exists === undefined
  ) {
    const d = (rec.data as () => unknown)();
    if (d !== null && typeof d === "object") {
      const dRec = d as Record<string, unknown>;
      if (typeof dRec.count === "number") return dRec.count;
    }
    throw new UnknownQueryResultShapeError("aggregate .data() did not return {count: number}");
  }

  // QuerySnapshot — a `.size` + `.docs: QueryDocumentSnapshot[]`.
  if (typeof rec.size === "number" && Array.isArray(rec.docs as unknown[])) {
    return rec.size;
  }
  // DocumentSnapshot — a `.exists: boolean`.
  if (typeof rec.exists === "boolean") {
    return rec.exists ? 1 : 0;
  }
  // ListConversationsOutput — `.conversations: array`.
  if (Array.isArray(rec.conversations)) {
    return (rec.conversations as unknown[]).length;
  }
  // ListOrphanInboundsOutput — `.orphans: array` (PR2c tour 2b).
  if (Array.isArray(rec.orphans)) {
    return (rec.orphans as unknown[]).length;
  }
  // ConversationListVersionResult — `.topConversationId: string|null`.
  if ("topConversationId" in rec) {
    return rec.topConversationId ? 1 : 0;
  }
  // Legacy lookup `getActiveConversationByContactId` → `{ conversationId,
  // conversation }` (object truthy) OR `null` (déjà géré ci-dessus).
  if (typeof rec.conversationId === "string" && "conversation" in rec) {
    return 1;
  }
  // Fail-closed : forme inconnue → throw explicite plutôt que fallback
  // arbitraire. Un script `check-*-indexes.mjs` qui tombe sur une forme
  // inattendue DOIT alerter l'opérateur, pas afficher un count bidon.
  const knownKeys = Object.keys(rec).slice(0, 5).join(",");
  throw new UnknownQueryResultShapeError(`keys=[${knownKeys}]`);
}
