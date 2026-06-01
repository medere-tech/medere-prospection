/**
 * Primitives transactionnelles Firestore pour la composition d'opérations
 * atomiques cross-collections (S6.6 — GUARD-002).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * API EXPOSÉE (S6.6 — MVP) :
 *
 *   - `withContactLock<T>(contactId, fn)`
 *         → ouvre une `runTransaction` Firestore, lit + valide le contact
 *           en DEBUT de tx (acquisition du lock optimiste sur le doc
 *           `contacts/{id}`), puis appelle `fn(tx, contact)`. Le `fn`
 *           peut faire d'autres `tx.get`/`tx.update`/`tx.create` sur
 *           n'importe quel doc — tout reste atomique avec le lock contact.
 *
 * Hors périmètre S6.6 (reportés explicitement) :
 *   - `withConversationLock`           → si besoin en S7
 *   - Composition `sendOutboundWithLock(args)` (preSendCheck +
 *      withContactLock + addOutbound atomique)  → S7 (Inngest)
 *   - Refactor `addOutboundInTx(tx, ...)` extrait de `addOutbound`
 *      (S6.5) pour permettre l'écriture message dans une tx parente →
 *      S7 (cf. dette ouverte ouverte dans le commit S6.6).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * MODÈLE DE CONCURRENCE FIRESTORE (rappel essentiel)
 *
 *   Firestore Admin SDK utilise **optimistic concurrency** :
 *
 *   1. `tx.get(ref)` lit le doc et "marque" sa version (revision).
 *   2. Si un autre process modifie `ref` AVANT le commit de notre tx,
 *      le commit est rejeté côté serveur.
 *   3. Le SDK retry automatiquement la transaction (jusqu'à 5 fois par
 *      défaut). Le `fn` est ré-exécuté de zéro avec une nouvelle lecture.
 *
 *   Pour le cas N=2 jobs Inngest concurrents qui tentent un 3e SMS au
 *   MÊME contact (CF. `concurrency.test.ts`) :
 *
 *     - Les 2 jobs entrent dans leur `withContactLock`, font chacun
 *       `tx.get(contactRef)` → tous les 2 lisent l'état initial.
 *     - Les 2 jobs font chacun leur `fn` (re-lecture historique +
 *       re-check rate-limit + write message si OK).
 *     - Les 2 jobs commit. UN SEUL gagne (le 1er à atteindre le
 *       serveur). L'autre voit sa commit rejetée.
 *     - Le perdant retry → re-exec `fn` → re-lecture historique
 *       (maintenant 3 messages dans la fenêtre 30j) → re-check
 *       rate-limit → `canSendMessage` répond `allowed: false` →
 *       le `fn` throw une erreur applicative → tx rollback → throw
 *       propagé au caller.
 *
 *   ⚠️  Le re-check rate-limit DANS `fn` est de la responsabilité
 *   du caller, PAS de `withContactLock`. Cette primitive ne sait pas
 *   ce que le caller veut faire — elle pose juste le lock contact.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * RESPONSABILITÉS DU CALLER `fn` :
 *
 *   1. **PURE Firestore** : le `fn` ne doit faire AUCUN I/O externe
 *      (OVH SMS, Anthropic, Slack webhook, HubSpot REST). Si la tx
 *      retry après un I/O externe, on aurait un effet de bord
 *      dupliqué non-rollbackable. Les I/O externes vont HORS tx :
 *
 *        const result = await preSendCheckWithAudit(args)   // hors tx
 *        if (!result.ok) return
 *        await withContactLock(contactId, async (tx, contact) => {
 *          // PURE Firestore ici
 *        })
 *        await ovhSendSms(...)                              // hors tx
 *
 *   2. **Pas de transaction imbriquée** : impossible de `runTransaction`
 *      à l'intérieur d'un `fn`. Le SDK throw si on essaie. Toute
 *      sous-écriture passe par `tx.create`/`tx.update`/`tx.delete`
 *      avec la `tx` reçue en argument.
 *
 *   3. **Re-vérifier les invariants critiques DANS la tx** : si le
 *      caller a déjà checked un état AVANT la tx (ex: rate-limit avec
 *      historique lu via `listRecentOutbound` S6.5), il DOIT re-checker
 *      DANS la tx en re-lisant via `tx.get(query)`. Sinon : race
 *      condition non couverte.
 *
 *   4. **Throw pour rollback** : si le re-check fail, le `fn` throw
 *      une erreur applicative (ex: `ComplianceConcurrencyError`). La
 *      tx rollback automatiquement et l'erreur est propagée. Le caller
 *      catch et log un audit `send_blocked` (S7).
 */
import { type Transaction } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firestore/admin";
import { _parseContactOrThrow } from "@/lib/firestore/contacts";
import { NotFoundError } from "@/lib/utils/errors";
import type { Contact } from "@/types/contact";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Doit rester aligné avec `__CONTACTS_COLLECTION_FOR_TESTS` de
 * `contacts.ts`. Test sentinel dans `transactions.test.ts` vérifie
 * l'égalité.
 */
const CONTACTS_COLLECTION = "contacts";

// ─────────────────────────────────────────────────────────────────────────────
// API publique
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Acquiert un lock optimiste sur `contacts/{contactId}` et exécute `fn`
 * dans la même transaction Firestore.
 *
 * **Flow** :
 *   1. Démarre `runTransaction`.
 *   2. `tx.get(contacts/{contactId})` → lecture + marque revision (lock).
 *   3. Si doc absent → throw `NotFoundError` (la tx rollback, rien posé).
 *   4. Parse Zod stricte via `_parseContactOrThrow` (S6.6 export S6.3).
 *      Doc corrompu → throw `ValidationError` (tx rollback).
 *   5. Appelle `fn(tx, contact)` avec le `Contact` validé.
 *   6. Le `fn` peut faire `tx.get`/`tx.update`/`tx.create`/`tx.delete`
 *      sur N'IMPORTE QUEL doc — tout reste atomique avec le lock.
 *   7. Si le commit Firestore détecte un conflit (autre tx a modifié
 *      le contact entre-temps) → retry interne SDK. Le `fn` est
 *      ré-exécuté de zéro avec une nouvelle lecture (cf. JSDoc en
 *      tête de fichier pour le pattern N=2 jobs concurrents).
 *
 * **Concurrence** :
 *   - 2 jobs simultanés qui appellent `withContactLock` sur le même
 *     `contactId` sont sérialisés par Firestore. Un seul commit
 *     réussit. L'autre retry. Le test `concurrency.test.ts` prouve
 *     cette propriété sur 10 itérations consécutives.
 *
 * **Contrat caller** (cf. JSDoc en tête de fichier, sections détaillées) :
 *   - `fn` doit être PURE Firestore (aucun I/O externe).
 *   - `fn` ne doit pas démarrer une autre transaction.
 *   - `fn` doit re-vérifier les invariants critiques DANS la tx.
 *   - `fn` throw pour rollback.
 *
 * @typeParam T   Type de retour du `fn`, propagé en retour.
 * @param contactId  ID Firestore du contact (= hubspotId, source de vérité).
 * @param fn         Callback exécutée dans la tx avec le contact validé.
 *
 * @returns Ce que retourne `fn` (typage `T` propagé).
 *
 * @throws NotFoundError    si le contact n'existe pas.
 * @throws ValidationError  si le doc contact est corrompu.
 * @throws *                toute erreur thrown par `fn` (propagée).
 */
export async function withContactLock<T>(
  contactId: string,
  fn: (tx: Transaction, contact: Contact) => Promise<T>,
): Promise<T> {
  return getAdminDb().runTransaction(async (tx) => {
    const ref = getAdminDb().collection(CONTACTS_COLLECTION).doc(contactId);
    const doc = await tx.get(ref);
    if (!doc.exists) {
      throw new NotFoundError({
        message: `Contact not found: ${contactId}`,
        context: { contactId },
      });
    }
    const contact = _parseContactOrThrow(doc.data(), contactId);
    return fn(tx, contact);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Exposés pour tests
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export const __TRANSACTIONS_CONTACTS_COLLECTION_FOR_TESTS = CONTACTS_COLLECTION;
