/**
 * Compte le nombre de documents retournés par UNE forme de requête du
 * catalogue `conversation-list-query-forms.ts`, selon son type Firestore
 * (QuerySnapshot / DocumentSnapshot / ...).
 *
 * ⚠️ Jamais afficher le contenu — le script `check-conversation-list-indexes.mjs`
 * utilise uniquement ce count pour tracer qu'une requête a réussi.
 *
 * Historique : extrait du script après observation d'un bug subtil où un
 * `QuerySnapshot` VIDE retournait `count=1` (le fallback `r ? 1 : 0`
 * traitait l'objet comme truthy, pas ses docs comme vides). Résultat :
 * `backfill.messages.last-human-outbound (count=1)` affiché malgré une
 * sous-collection vide, ce qui masquait le fait réel que la conversation
 * n'avait aucun outbound humain.
 */
export function countFromResult(r: unknown): number {
  if (typeof r === "number") return r;
  if (!r || typeof r !== "object") return 0;
  const rec = r as Record<string, unknown>;
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
  // ConversationListVersionResult — `.topConversationId: string|null`.
  if ("topConversationId" in rec) {
    return rec.topConversationId ? 1 : 0;
  }
  // POJO `Conversation | null` (legacy get*ByContactId).
  return 1;
}
