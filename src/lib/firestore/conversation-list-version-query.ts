/**
 * Query partagée de `/api/admin/conversations/version` (PR2a).
 *
 * Même code utilisé par le route handler ET par le script
 * `scripts/check-conversation-list-indexes.mjs` (vérification que chaque
 * forme de requête du /version a un index composite en prod).
 *
 * ⚠️ Pas de scrub/sentinelle PII ici — c'est l'affaire du caller
 * (route handler) qui applique `assertNoPhoneInPayload` sur la payload
 * sérialisée.
 */
import type { Timestamp } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firestore/admin";
import type { ConversationStatus } from "@/types/conversation";

const CONVERSATIONS_COLLECTION = "conversations";

export interface ConversationListVersionResult {
  version: string;
  topUpdatedAtMs: number;
  topConversationId: string | null;
}

/**
 * Construit la query filtrée par rôle+onglet, trie `updatedAt desc`,
 * lit 1 doc. Retourne un hash `version` + le timestamp + l'id pour
 * permettre au client (polling 60 s) de détecter un changement sans
 * refetcher la liste complète.
 */
export async function queryConversationListVersion(options: {
  statusIn?: ConversationStatus[];
  assignedTo?: string | null;
}): Promise<ConversationListVersionResult> {
  let q: FirebaseFirestore.Query = getAdminDb().collection(CONVERSATIONS_COLLECTION);
  if (options.assignedTo) q = q.where("assignedTo", "==", options.assignedTo);
  if (options.statusIn && options.statusIn.length === 1) {
    q = q.where("status", "==", options.statusIn[0]!);
  } else if (options.statusIn && options.statusIn.length > 1) {
    q = q.where("status", "in", options.statusIn);
  }
  q = q.orderBy("updatedAt", "desc").limit(1);

  const snap = await q.get();
  const top = snap.docs[0];
  const topMs = top && top.data().updatedAt ? (top.data().updatedAt as Timestamp).toMillis() : 0;
  const topId = top ? top.id : "";
  return {
    version: `${topMs}_${topId}`,
    topUpdatedAtMs: topMs,
    topConversationId: topId || null,
  };
}
