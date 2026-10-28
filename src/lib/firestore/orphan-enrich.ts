/**
 * Enrichissement serveur des orphelins avec le résumé pro du médecin
 * (PR2c tour 2b bloc B).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rôle
 *
 *   Les routes `/api/admin/orphan-inbounds` et `/api/admin/orphan-inbounds/
 *   [id]` doivent exposer le nom pro du médecin (quand il est connu) pour
 *   que la table et le tiroir du dashboard affichent « Dr Dupont, dentiste,
 *   Paris » plutôt qu'un `contactId` opaque. Cette fonction fait les
 *   lectures contact nécessaires et passe le résultat à
 *   `sanitizeOrphanInboundForClient` (qui construit la shape finale).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Volume & coût
 *
 *   Volume cible : ~quelques dizaines d'orphans/mois (cf. commentaire tête
 *   `orphan-inbounds.ts`). Chaque page cappe à `LIST_ORPHAN_INBOUNDS_MAX_LIMIT`
 *   (= 100). On déduplique les `contactId` en amont — plusieurs orphans d'un
 *   même PS tapent le même contact une seule fois. Puis `Promise.all` sur
 *   `getContact`. Au pire 100 reads, en pratique < 20.
 *
 *   Pas de batch `getAll` : garder le parsing Zod strict de `getContact`
 *   plutôt qu'un parse manuel qui pourrait divergier (une mutation du schema
 *   contact silencieusement acceptée côté orphans = régression).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Fail-closed
 *
 *   Un `getContact` qui throw (contact corrompu Zod) propage l'erreur →
 *   la route `.catch` et renvoie 500 propre. Un `getContact` qui retourne
 *   `null` (contact absent, supprimé) → `sanitizeOrphanInboundForClient`
 *   reçoit `null` → `contact: null` côté UI → libellé « Expéditeur non
 *   identifié ». La vue client NE PORTE JAMAIS `contactId` (data
 *   minimization RGPD, cf. `OrphanContactSummary`) — aucun identifiant
 *   HubSpot opaque ne quitte le serveur.
 */
import { resolveAdminNamesBatch } from "@/lib/auth/resolve-admin-name";
import { getContact } from "@/lib/firestore/contacts";
import type { OrphanInboundView } from "@/lib/firestore/orphan-inbounds";
import {
  type OrphanInboundClientView,
  sanitizeOrphanInboundForClient,
} from "@/lib/firestore/orphan-inbounds-sanitize";
import type { Contact } from "@/types/contact";

/**
 * Enrichit une liste d'orphans serveur en vues client avec résumé pro
 * résolu. Dédoublonne les `contactId` pour minimiser les reads Firestore.
 */
/**
 * Collecte les `Clerk userId` à résoudre pour une liste d'orphans :
 * `attachment.attachedBy` et `dismissal.dismissedBy`. Dédupliqué.
 */
function collectAdminUserIds(orphans: readonly OrphanInboundView[]): string[] {
  const ids = new Set<string>();
  for (const o of orphans) {
    if (o.attachment?.attachedBy && o.attachment.attachedBy.length > 0) {
      ids.add(o.attachment.attachedBy);
    }
    if (o.dismissal?.dismissedBy && o.dismissal.dismissedBy.length > 0) {
      ids.add(o.dismissal.dismissedBy);
    }
  }
  return Array.from(ids);
}

export async function enrichOrphansWithContacts(
  orphans: readonly OrphanInboundView[],
): Promise<OrphanInboundClientView[]> {
  const uniqueIds = new Set<string>();
  for (const o of orphans) {
    if (o.contactId !== undefined && o.contactId.length > 0) uniqueIds.add(o.contactId);
  }
  const idList = Array.from(uniqueIds);
  const contactsById = new Map<string, Contact | null>();
  if (idList.length > 0) {
    const results = await Promise.all(idList.map((id) => getContact(id)));
    idList.forEach((id, i) => {
      const c = results[i];
      contactsById.set(id, c ?? null);
    });
  }
  // Résolution admin Clerk : batch dédupliqué, cache module-level 5 min
  // (cf. `resolve-admin-name.ts`). Fail-closed : chaque id manquant
  // retombe sur `null` → UI « Admin inconnu ».
  const adminNamesById = await resolveAdminNamesBatch(collectAdminUserIds(orphans));
  const resolveAdminName = (userId: string): string | null => adminNamesById.get(userId) ?? null;

  return orphans.map((o) => {
    const resolved = o.contactId !== undefined ? (contactsById.get(o.contactId) ?? null) : null;
    return sanitizeOrphanInboundForClient(o, resolved, resolveAdminName);
  });
}

/** Variante single-doc. */
export async function enrichOrphanWithContact(
  orphan: OrphanInboundView,
): Promise<OrphanInboundClientView> {
  const resolved =
    orphan.contactId !== undefined && orphan.contactId.length > 0
      ? await getContact(orphan.contactId)
      : null;
  const adminNamesById = await resolveAdminNamesBatch(collectAdminUserIds([orphan]));
  const resolveAdminName = (userId: string): string | null => adminNamesById.get(userId) ?? null;
  return sanitizeOrphanInboundForClient(orphan, resolved, resolveAdminName);
}
