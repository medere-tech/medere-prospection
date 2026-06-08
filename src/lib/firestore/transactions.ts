/**
 * Primitives transactionnelles Firestore pour la composition d'opérations
 * atomiques cross-collections (S6.6 — GUARD-002 + DEBT-001.3).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * API EXPOSÉE :
 *
 *   - `withContactLock<T>(contactId, fn)`                        (S6.6)
 *         → ouvre une `runTransaction` Firestore, lit + valide le contact
 *           en DEBUT de tx (acquisition du lock optimiste sur le doc
 *           `contacts/{id}`), puis appelle `fn(tx, contact)`. Le `fn`
 *           peut faire d'autres `tx.get`/`tx.update`/`tx.create` sur
 *           n'importe quel doc — tout reste atomique avec le lock contact.
 *
 *   - `sendOutboundWithLock(args)`                        (DEBT-001.3)
 *         → composition tx unique qui ferme DETTE-001 (race rate-limit
 *           3/30j) + DETTE-004 (atomicité audit). Acquiert lock contact,
 *           re-check rate-limit DANS la tx via `listRecentOutboundInTx`
 *           (lock READ SET), throw `ComplianceConcurrencyError` si race,
 *           sinon `addOutboundInTx` + `appendAuditLogTx("sms_provider_
 *           dispatched")` DANS la même tx → tout commit ou tout rollback.
 *
 * Hors périmètre S6.6+ (reportés explicitement) :
 *   - `withConversationLock`           → si besoin en S9+
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

import { canSendMessage } from "@/lib/compliance/rate-limits";
import { getAdminDb } from "@/lib/firestore/admin";
import { _parseContactOrThrow } from "@/lib/firestore/contacts";
import { _parseConversationOrThrow } from "@/lib/firestore/conversations";
import {
  type AddOutboundInput,
  addOutboundInTx,
  listRecentOutboundInTx,
} from "@/lib/firestore/messages";
import { ComplianceConcurrencyError, NotFoundError, ValidationError } from "@/lib/utils/errors";
import type { Contact } from "@/types/contact";

import { appendAuditLogTx } from "./audit-log";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Doit rester aligné avec `__CONTACTS_COLLECTION_FOR_TESTS` de
 * `contacts.ts`. Test sentinel dans `transactions.test.ts` vérifie
 * l'égalité.
 */
const CONTACTS_COLLECTION = "contacts";

/**
 * Doit rester aligné avec `__CONVERSATIONS_COLLECTION_FOR_TESTS` de
 * `conversations.ts`. Test sentinel dans `transactions.test.ts` vérifie
 * l'égalité.
 */
const CONVERSATIONS_COLLECTION = "conversations";

/**
 * Largeur de la fenêtre rate-limit (jours). Aligné sur la constante
 * privée `RATE_LIMIT_WINDOW_DAYS` de `lib/compliance/rate-limits.ts`.
 * Définie localement pour ne pas exporter la constante de S4 (couplage).
 * Test sentinel pourrait être ajouté en DEBT-001.6 si dérive constatée.
 */
const RATE_LIMIT_WINDOW_DAYS = 30;

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
// sendOutboundWithLock (DEBT-001.3) — composition tx unique
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Arguments de `sendOutboundWithLock`.
 *
 *   - `contactId`              : sert au lock optimiste sur
 *                                `contacts/{contactId}` via `withContactLock`.
 *                                Doit matcher `conv.contactId` (vérifié
 *                                en défense en profondeur DANS la tx).
 *   - `campaignId`             : audit payload `sms_provider_dispatched`.
 *   - `conversationId`         : doc location explicite
 *                                `${contactId}_${campaignId}` (source de
 *                                vérité — pas dérivé en interne, cf.
 *                                arbitrage DEBT-001.2).
 *   - `input`                  : champs métier du message (`AddOutboundInput`).
 *   - `dispatch`               : facts OVH bruts à enregistrer dans
 *                                l'audit forensique. Les IDs
 *                                {conversationId, contactId, campaignId}
 *                                sont ajoutés par la fonction depuis les
 *                                top-level args — single source of truth.
 *   - `expectedRemainingQuota` : quota restant lu HORS tx par
 *                                `pre-send-check` (= `MAX - recent.length`
 *                                côté pre-flight). Hydratera
 *                                `ComplianceConcurrencyError.context` si
 *                                la tx détecte une race. Sémantique :
 *                                "ce que le caller pensait avoir
 *                                disponible juste avant d'entrer dans la
 *                                tx" (Option a Q-S3 DEBT-001.3).
 */
export interface SendOutboundWithLockArgs {
  contactId: string;
  campaignId: string;
  conversationId: string;
  input: AddOutboundInput;
  dispatch: {
    ovhMessageId: string;
    sender: string;
    bodyLength: number;
    creditsRemoved: number;
    dryRun: boolean;
  };
  expectedRemainingQuota: number;
}

/**
 * Résultat de `sendOutboundWithLock`.
 *
 *   - `messageId` : Firestore auto-ID (`[A-Za-z0-9]{20}`) du doc message
 *                   créé dans `conversations/{convId}/messages/`. Source
 *                   de corrélation avec OVH (via `dispatch.ovhMessageId`
 *                   loggé dans l'audit) et avec les audits internes
 *                   `sms_sent` (posé par `addOutboundInTx`).
 *   - `auditId`   : docId Firestore de l'audit `sms_provider_dispatched`
 *                   posé par cette fonction (PAS l'audit `sms_sent`
 *                   interne, qui est l'audit "Firestore write"). Disponible
 *                   pour le caller (logging Inngest, debugging).
 */
export interface SendOutboundWithLockResult {
  messageId: string;
  auditId: string;
}

/**
 * Composition transactionnelle UNIQUE qui ferme DETTE-001 (race rate-limit
 * 3 SMS / 30j) ET DETTE-004 (atomicité audit `sms_provider_dispatched`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * RAISON D'ÊTRE
 *
 *   - **DETTE-001 — race rate-limit** : la pré-vérif HORS tx (`pre-send-
 *     check` S5) lit l'historique outbound 30j via `listRecentOutbound`
 *     (`.get()`). Si 2 events Inngest concurrents arrivent sur le même
 *     contact, ils lisent en parallèle (état "2/3 envois récents"),
 *     passent tous les deux, et créent CHACUN un 3e SMS → 4 SMS total →
 *     sanction CNIL jusqu'à 20 M€ ou 4 % CA. Cette fonction re-check
 *     `canSendMessage` DANS la tx avec l'historique relu via
 *     `listRecentOutboundInTx` (`tx.get`, lock READ SET) — Firestore
 *     optimistic concurrency détecte le conflit au commit et retry
 *     automatiquement (jusqu'à 5x, cf. transactions.ts JSDoc).
 *
 *   - **DETTE-004 — atomicité audit `sms_provider_dispatched`** :
 *     l'implémentation Phase 1 S8 posait l'audit HORS tx via
 *     `appendAuditLog` autonome APRÈS `addOutbound`. Si Inngest retry
 *     entre les 2 appels (process kill, network), on a un doc message
 *     créé MAIS pas d'audit dispatch → trou forensique impossible à
 *     reconstruire. Cette fonction pose `sms_provider_dispatched` via
 *     `appendAuditLogTx` DANS la même tx que `addOutboundInTx` → tout
 *     atomique : commit OR rollback complet.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * COMPOSITION INTERNE (ordre strict — vérifié par tests sentinelles)
 *
 *   1. `withContactLock(args.contactId, ...)`               — lock contact
 *   2. `tx.get(conversations/{conversationId})`             — lecture conv
 *      → throw `NotFoundError` si absente, `ValidationError` si corrompue
 *   3. **Sentinelle conv.contactId === args.contactId**     — défense en
 *      profondeur. Si le caller passe un convId qui n'appartient PAS au
 *      contact locké, le lock est inutile → throw `ValidationError`.
 *   4. `listRecentOutboundInTx(tx, conversationId, 30)`     — re-read
 *      historique outbound DANS la tx (lock READ SET)
 *   5. `canSendMessage(recentOutbound)`                     — re-check
 *      rate-limit 3/30j sur l'historique relu
 *   6. **Si `!allowed`** → throw `ComplianceConcurrencyError`             ←
 *      tx rollback automatique. Contexte forensique 5 champs hydraté
 *      (contactId, ruleName, attemptedAt, expectedRemainingQuota,
 *      observedRemainingQuota=0 par construction).
 *   7. `addOutboundInTx(tx, conversationId, conv, args.input)`            ←
 *      crée doc message (status="queued") + bump compteurs +
 *      audit `sms_sent` interne (payload {direction, messageId}).
 *   8. `appendAuditLogTx(tx, "sms_provider_dispatched", payload)`         ←
 *      audit forensique OVH dispatch. Payload = `dispatch` brut + IDs
 *      forensiques top-level (conversationId, contactId, campaignId).
 *   9. Retourne `{messageId, auditId}`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * GARANTIES ATOMICITÉ
 *
 *   Toute exception thrown entre les étapes 1-8 → tx rollback automatique :
 *   - Aucun doc message créé
 *   - Aucun bump compteur conversation
 *   - Aucun audit `sms_sent` interne
 *   - Aucun audit `sms_provider_dispatched`
 *
 *   Inversement, si le commit Firestore réussit → les 5 effets (message,
 *   compteurs, 2 audits) sont TOUS visibles atomiquement. Pas de fenêtre
 *   de visibilité partielle. Test sentinelle `concurrency.test.ts`
 *   (DEBT-001.6) valide la propriété sur 10 itérations 0 flaky.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * PRÉCONDITIONS CALLER
 *
 *   1. **`preSendCheckWithAudit` (S6.6) DOIT avoir validé l'envoi HORS tx**
 *      AVANT cet appel. Cette fonction NE vérifie PAS les 7 autres règles
 *      compliance (opt-out, AI disclosure, STOP présent, hours, Bloctel,
 *      legitimate interest, phone validity) — seulement `rate_limit` qui
 *      est sujet à la race. Si pre-send-check fail HORS tx, le caller
 *      n'arrive PAS ici (early return avec audit `compliance_check
 *      blocked` déjà posé).
 *
 *   2. **`args.contactId` DOIT matcher `args.conversationId`'s contact** :
 *      `conv.contactId === args.contactId`. Vérifié DANS la tx (défense
 *      en profondeur). Si mismatch → `ValidationError`, le lock contact
 *      serait inutile sinon.
 *
 *   3. **`args.expectedRemainingQuota` DOIT être ≥ 1**. Si le caller passe
 *      0 ou négatif, le pre-send-check HORS tx aurait dû déjà bloquer.
 *      Pas vérifié runtime (sémantique caller — toute valeur ≥ 0 acceptée).
 *
 *   4. **L'envoi OVH (`sendSms`) DOIT avoir été effectué AVANT cet appel**
 *      (cf. `send-first-sms.ts` step 3 pré-DEBT-001.5). Cette fonction
 *      pose `sms_provider_dispatched` qui ENREGISTRE l'envoi déjà fait —
 *      elle ne le déclenche pas. Si OVH a fail, le caller ne doit PAS
 *      arriver ici (early return avec `NonRetriableError` ou retry).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ERREURS POSSIBLES (DANS L'ORDRE LOGIQUE)
 *
 *   - `NotFoundError`                : contact (`args.contactId`) absent
 *                                       OU conversation (`args.conversationId`)
 *                                       absente. Tx rollback automatique.
 *   - `ValidationError`              : doc contact/conv corrompu (Zod fail)
 *                                       OU conv.contactId mismatch avec
 *                                       args.contactId OU body invalide
 *                                       (vide ou > BODY_MAX_LENGTH 1600).
 *   - `ComplianceConcurrencyError`   : race rate-limit détectée DANS la tx.
 *                                       Retry-friendly (`noRetry=false`),
 *                                       Inngest layer propage tel quel pour
 *                                       déclencher retry naturel.
 *   - `AuditPiiError`                : payload audit corrompu (filet S6.2).
 *                                       NonRetriable.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CAS D'USAGE
 *
 *   - **Primaire** : `send-first-sms.ts` step 4 (DEBT-001.5) — remplace
 *     la composition `addOutbound + appendAuditLog` HORS tx actuelle.
 *
 *   - **Futur** : `send-followup-sms.ts` (Phase 2) — même contrat,
 *     même garanties. La fonction est agnostique du type de SMS
 *     (first, followup, relance) — c'est `addOutboundInTx` qui gère
 *     les champs métier via `AddOutboundInput.generatedBy` et `aiPromptVersion`.
 *
 * @param args  Cf. `SendOutboundWithLockArgs`.
 * @returns     `{ messageId, auditId }` (cf. `SendOutboundWithLockResult`).
 */
export async function sendOutboundWithLock(
  args: SendOutboundWithLockArgs,
): Promise<SendOutboundWithLockResult> {
  return withContactLock(args.contactId, async (tx) => {
    // ── 1. Lecture + parse conversation DANS la tx ────────────────────────
    const convRef = getAdminDb().collection(CONVERSATIONS_COLLECTION).doc(args.conversationId);
    const convDoc = await tx.get(convRef);
    if (!convDoc.exists) {
      throw new NotFoundError({
        message: `Conversation not found: ${args.conversationId}`,
        context: { conversationId: args.conversationId },
      });
    }
    const conv = _parseConversationOrThrow(convDoc.data(), args.conversationId);

    // ── 2. Défense en profondeur : conv.contactId === args.contactId ──────
    // Si le caller a fourni un convId qui n'appartient PAS au contact locké,
    // le lock est inutile (autre tx pourrait modifier ce contact en
    // parallèle). On refuse explicitement pour faire surface le bug
    // d'orchestration côté caller.
    if (conv.contactId !== args.contactId) {
      throw new ValidationError({
        message: `Conversation ${args.conversationId} belongs to contact ${conv.contactId}, not ${args.contactId}`,
        context: {
          conversationId: args.conversationId,
          expectedContactId: args.contactId,
          actualContactId: conv.contactId,
        },
      });
    }

    // ── 3. Lecture historique outbound DANS la tx (lock READ SET) ─────────
    const recentOutbound = await listRecentOutboundInTx(
      tx,
      args.conversationId,
      RATE_LIMIT_WINDOW_DAYS,
    );

    // ── 4. Re-check rate-limit DANS la tx ─────────────────────────────────
    const rateLimitCheck = canSendMessage(recentOutbound);
    if (!rateLimitCheck.allowed) {
      // Race détectée : la pré-vérif HORS tx avait dit OK
      // (`args.expectedRemainingQuota` reflète cette valeur), mais une autre
      // tx a commit entre temps et saturé le plafond. Par construction de
      // `canSendMessage` (`allowed === false` ⇔ `inWindow.length >= MAX`),
      // le quota observé restant est 0.
      throw new ComplianceConcurrencyError({
        message: `Rate-limit race detected for contact ${args.contactId} on conversation ${args.conversationId}: ${rateLimitCheck.reason ?? "no_reason"}`,
        context: {
          contactId: args.contactId,
          ruleName: "rate_limit_30d",
          attemptedAt: new Date(),
          expectedRemainingQuota: args.expectedRemainingQuota,
          observedRemainingQuota: 0,
        },
      });
    }

    // ── 5. Write message + audit sms_sent interne (via addOutboundInTx) ───
    const messageId = await addOutboundInTx(tx, args.conversationId, conv, args.input);

    // ── 6. Audit sms_provider_dispatched DANS la même tx ──────────────────
    // Payload = facts OVH bruts + IDs forensiques top-level. Pas de
    // duplication avec args.dispatch (qui ne contient QUE les facts OVH
    // OVHcloud-spécifiques). Sentinelle action = "sms_provider_dispatched"
    // verbatim (test anti-régression dans `transactions.test.ts`).
    const auditId = appendAuditLogTx(tx, {
      actorId: "system",
      actorType: "system",
      action: "sms_provider_dispatched",
      targetType: "message",
      targetId: messageId,
      payload: {
        ovhMessageId: args.dispatch.ovhMessageId,
        sender: args.dispatch.sender,
        bodyLength: args.dispatch.bodyLength,
        creditsRemoved: args.dispatch.creditsRemoved,
        dryRun: args.dispatch.dryRun,
        conversationId: args.conversationId,
        contactId: args.contactId,
        campaignId: args.campaignId,
      },
    });

    return { messageId, auditId };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Exposés pour tests
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export const __TRANSACTIONS_CONTACTS_COLLECTION_FOR_TESTS = CONTACTS_COLLECTION;

/** @internal */
export const __TRANSACTIONS_CONVERSATIONS_COLLECTION_FOR_TESTS = CONVERSATIONS_COLLECTION;

/** @internal */
export const __TRANSACTIONS_RATE_LIMIT_WINDOW_DAYS_FOR_TESTS = RATE_LIMIT_WINDOW_DAYS;
