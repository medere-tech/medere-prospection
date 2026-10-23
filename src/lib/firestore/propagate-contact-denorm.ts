/**
 * PR2a — propagation d'un changement de contact vers ses conversations.
 *
 * Les conversations stockent une copie dénormalisée de 4 champs contact :
 *   - `contactDisplayName`
 *   - `contactNameSearch`
 *   - `contactSpecialty`
 *   - `contactCity`
 *
 * Dès qu'un de ces 4 champs change sur un `contacts/{contactId}`, les
 * copies présentes sur `conversations/*` deviennent incorrectes. Ce
 * module expose UN helper qui propage les 4 valeurs à TOUTES les
 * conversations du contact, par batch de 500 écritures (limite Firestore).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Où doit-il être appelé ?
 *
 *   Tout point d'écriture sur `contacts/{id}` qui modifie `firstName`,
 *   `lastName`, `civilite`, `speciality` ou `city`. À l'heure PR2a,
 *   AUCUN point du backend ne modifie ces champs (`createContact` est
 *   write-once, `markOptedOut`/`updateContactStatus` touchent uniquement
 *   consent/status/assignedTo). Le helper est donc un contrat prêt à
 *   l'emploi pour les futurs chemins (resync HubSpot, édition admin).
 *
 *   Points d'écriture contact RECENSÉS en PR2a (chaque ligne doit
 *   confirmer l'absence de besoin OU appeler le helper) :
 *
 *     - `src/lib/firestore/contacts.ts:538` — `markOptedOut` : touche
 *       `consent.optedOut*` + `status`. Zéro impact dénorm → aucun appel
 *       requis.
 *     - `src/lib/firestore/contacts.ts:666` — `updateContactStatus` :
 *       `Pick<Contact, "status" | "assignedTo">` au typage. Zéro impact
 *       dénorm → aucun appel requis.
 *     - `src/lib/firestore/contacts.ts:1020` — `createContact` :
 *       création write-once. Les conversations n'existent pas encore à
 *       ce moment (`getOrCreateInitialConversation` lira le doc contact
 *       frais au moment de créer la 1re conversation) → aucun appel
 *       requis.
 *
 *   Toute nouvelle fonction qui écrit un des 4 champs ci-dessus DOIT
 *   finir sa transaction par un appel asynchrone à ce helper.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Semantique
 *
 *   - Idempotent : chaque conv n'est touchée que si une des 4 valeurs
 *     diffère. Pas d'écriture inutile.
 *   - Pose aussi `updatedAt = now` pour que `/version` reflète la
 *     propagation (le polling UI PR2b doit détecter le refresh).
 *   - Audit log : 1 entrée `conversation_denorm_propagated` par conv
 *     touchée (payload = nom des champs mis à jour, pas les valeurs).
 *   - Jamais de suppression.
 *   - Ne lève que si Firestore refuse — propagation best-effort côté
 *     caller qui veut découpler la mutation contact de la propagation.
 */
import { Timestamp } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firestore/admin";
import { appendAuditLogTx } from "@/lib/firestore/audit-log";
import type { ConversationContactSnapshot } from "@/lib/firestore/conversation-list-fields";

const CONVERSATIONS_COLLECTION = "conversations";

/**
 * Firestore limite une transaction à 500 writes. On réserve 2 writes/doc
 * (update conv + audit) → 250 docs par transaction.
 */
const DOCS_PER_TX = 250;

export interface PropagateContactDenormResult {
  /** Conversations examinées. */
  scanned: number;
  /** Conversations qui ont effectivement été écrites (au moins 1 champ différent). */
  updated: number;
}

/**
 * Propage les 4 champs dénormalisés aux conversations du contact.
 * À appeler APRÈS que la mutation `contacts/{id}` a été commitée.
 *
 * @throws si Firestore refuse une query ou un batch (propagé au caller).
 */
export async function propagateContactDenormToConversations(
  contactId: string,
  snapshot: ConversationContactSnapshot,
): Promise<PropagateContactDenormResult> {
  const db = getAdminDb();
  const snap = await db
    .collection(CONVERSATIONS_COLLECTION)
    .where("contactId", "==", contactId)
    .get();

  let updated = 0;

  // Chunking par transaction : 2 writes/doc (update conv + audit) × 250 docs
  // = 500 writes/tx, pile sous le plafond Firestore. On passe par
  // `runTransaction` (pas `batch`) pour pouvoir utiliser `appendAuditLogTx`
  // qui applique Zod + scrubber PII — pipeline canonique de l'audit.
  for (let i = 0; i < snap.docs.length; i += DOCS_PER_TX) {
    const chunk = snap.docs.slice(i, i + DOCS_PER_TX);
    const chunkUpdates = chunk
      .map((d) => {
        const data = d.data() ?? {};
        const diff: Record<string, unknown> = {};
        if (data.contactDisplayName !== snapshot.contactDisplayName) {
          diff.contactDisplayName = snapshot.contactDisplayName;
        }
        if (data.contactNameSearch !== snapshot.contactNameSearch) {
          diff.contactNameSearch = snapshot.contactNameSearch;
        }
        if (data.contactSpecialty !== snapshot.contactSpecialty) {
          diff.contactSpecialty = snapshot.contactSpecialty;
        }
        if (data.contactCity !== snapshot.contactCity) {
          diff.contactCity = snapshot.contactCity;
        }
        return { doc: d, diff };
      })
      .filter((u) => Object.keys(u.diff).length > 0);

    if (chunkUpdates.length === 0) continue;

    await db.runTransaction(async (tx) => {
      const now = Timestamp.now();
      for (const { doc, diff } of chunkUpdates) {
        tx.update(doc.ref, { ...diff, updatedAt: now });
        appendAuditLogTx(tx, {
          actorId: "system",
          actorType: "system",
          action: "conversation_denorm_propagated",
          targetType: "conversation",
          targetId: doc.id,
          // Payload scrubber-safe : contactId (opaque) + noms de champs
          // modifiés (pas les valeurs). Zéro PII.
          payload: {
            contactId,
            fieldsUpdated: Object.keys(diff),
          },
        });
      }
    });
    updated += chunkUpdates.length;
  }

  return { scanned: snap.docs.length, updated };
}
