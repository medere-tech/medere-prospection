/**
 * Transition transactionnelle `draft → queued` d'un message outbound
 * généré par Claude au pipeline `process-reply` (S9.3.3b step 8b).
 *
 * S9.4.1 — fermeture de S9.4-DRAFT-TO-QUEUED-001 (cf. messages.ts:1041).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * VUE D'ENSEMBLE
 *
 * Le pipeline `process-reply` (S9.3.3b) génère un draft Claude et le pose
 * en Firestore (`status="draft"`) sans bumper les compteurs conversation
 * ni poser d'audit `sms_sent`. Le draft est ensuite consommé par S9.4
 * pour envoi OVH.
 *
 * `commitDraftToQueued` est l'UNIQUE point de transition autorisé. Elle :
 *   1. Re-valide les 9 rules compliance DANS une transaction Firestore
 *      atomique (`preSendCheckWithAuditTx`, S9.4.1) — re-vérification
 *      complète à cause de la fenêtre temporelle minutes/heures S9.3→S9.4
 *      qui peut faire drifter opt_out, hours, rate_limit, etc.
 *   2. Si OK, mute `status="draft" → status="queued"`, pose `queuedAt`,
 *      bumpe `conversation.outboundCount + lastOutboundAt + lastMessageAt`,
 *      et pose l'audit `sms_sent` rétroactif — TOUT dans la même tx.
 *   3. Si rule fail, throw `ComplianceFailureError` DANS la tx (qui rollback)
 *      puis catch HORS tx pour poser 2 audits best-effort
 *      (`compliance_check (blocked)` + `reply_draft_dropped`) puis retourne
 *      `{ ok: false, failure }` au caller.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 ARBITRAGE CRITIQUE — OPTION B (commit Firestore AVANT dispatch OVH)
 *
 * Décision Déthié S9.4.0 Q-B / S9.4.1 :
 *
 *   - **PAS** d'option A (dispatch OVH d'abord, ovhMessageId connu, puis
 *     commit Firestore). Inacceptable compliance-wise en S9.4 : la fenêtre
 *     temporelle S9.3→S9.4 (minutes/heures) permet un consent drift sur
 *     n'importe laquelle des 9 rules. Si OVH succeed + tx compliance fail
 *     au commit → SMS parti chez OVH MAIS doc reste `status="draft"` →
 *     **le PS a reçu un SMS qu'on a "rejeté"** → violation L.34-5 CPCE +
 *     AI Act + RGPD.
 *
 *   - **Option B retenue** : commit transition `draft→queued` D'ABORD
 *     (sans ovhMessageId), puis dispatch OVH géré par S9.4.2 (handler
 *     send-reply.ts qui consomme l'event `medere/sms.reply.send-requested`).
 *     Après dispatch OVH succeed, S9.4.2 update message `status="sending"`
 *     ou `"sent"` + `externalId=ovhMessageId` + pose audit
 *     `sms_provider_dispatched`. Si OVH fail, status reste `"queued"` →
 *     retry naturel Inngest (ou update manuel à `"failed"`).
 *
 * Conséquence signature : `commitDraftToQueued` ne prend PAS de
 * `dispatchInfo` (pas d'OVH ici). Le caller S9.4.2 a tout ce qu'il faut
 * via le retour `{ok: true, messageId, conversationId, contactId, auditId}`
 * pour ensuite faire `getMessage(messageId)` + `getContact(contactId)` +
 * `sendSms(...)` + `updateMessageStatus(...)`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * PRÉ-FLIGHT `getConversation` HORS TX (arbitrage A5 Déthié)
 *
 * On lit la conversation HORS tx en pré-flight pour extraire `contactId`
 * (nécessaire à `withContactLock`) AVANT d'ouvrir la transaction. Pattern
 * miroir `send-first-sms.ts` step 1 (`get-contact-and-history`).
 *
 * Coût : +10-20ms (1 round-trip Firestore additionnel). Bénéfice : code
 * de catch HORS tx peut référencer `contactId` sans closure mutable
 * depuis l'intérieur de la tx (qui aurait été fragile).
 *
 * La conv est RE-LUE DANS la tx (cohérence atomique pour le bump des
 * compteurs). Le `contactId` du pré-flight DOIT matcher le `convInTx.contactId`
 * (vérifié implicitement via `_parseConversationOrThrow` — si la conv a
 * été supprimée + recréée avec un autre contactId entre les 2 lectures,
 * cas pathologique non couvert mais hors scope MVP).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * COMPOSITION DE LA TX ATOMIQUE
 *
 *   1. `withContactLock(contactId, fn)` ouvre la tx + lock optimiste
 *      `contacts/{contactId}` + parse contact DANS tx.
 *   2. `tx.get(messageRef draftMessageId)` — lecture draft DANS tx.
 *   3. Parse Zod via `_parseMessageOrThrow` → throw `ValidationError`
 *      si corrompu.
 *   4. **4 assertions defense-in-depth** (cf. A3 Déthié S9.4.1) :
 *      - `direction === "outbound"` (un draft inbound serait un nonsense)
 *      - `status === "draft"` (idempotence : si déjà queued/sent/failed,
 *        caller bug — refuse pour faire surface le double-commit)
 *      - `generatedBy === "ai"` (S9.4 ne traite QUE les drafts IA — humain
 *        sera S10+)
 *   5. `tx.get(convRef)` + parse Zod via `_parseConversationOrThrow`.
 *   6. `listRecentOutboundInTx(tx, convId, 30)` — re-read avec lock READ
 *      SET (anti-race `rate_limit`).
 *   7. `preSendCheckWithAuditTx(tx, args)` — re-validation 9 rules. Si
 *      throw `ComplianceFailureError` → tx rollback automatique.
 *   8. `tx.update(messageRef, {status: "queued", queuedAt: now})`.
 *   9. `_bumpConversationCountersTx(tx, convRef, conv, "outbound", now)`.
 *  10. `appendAuditLogTx(tx, "sms_sent", {direction: "outbound",
 *      messageId})` — RÉUTILISATION sms_sent (arbitrage Q-B5 — pas de
 *      nouvelle action `reply_dispatched`). Forensic narratif sur le même
 *      `messageId` : `reply_generated` (S9.3.3b création draft) →
 *      `sms_sent` (S9.4.1 transition queued) → `sms_provider_dispatched`
 *      (S9.4.2 OVH ack).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * BRANCHE BLOCKED — 2 AUDITS BEST-EFFORT HORS TX
 *
 * Si `preSendCheckWithAuditTx` throw `ComplianceFailureError` DANS la tx :
 *
 *   1. La tx rollback automatiquement (aucun audit `compliance_check
 *      (allowed)` n'est commit, aucune transition draft→queued n'est
 *      commit, le draft reste `status="draft"`).
 *
 *   2. HORS tx, on catch l'erreur et on pose 2 audits SÉPARÉMENT (chacun
 *      dans son `try/catch` indépendant — pattern miroir S6 `send_blocked`
 *      MED-1) :
 *
 *      (a) `compliance_check (blocked)` — cohérence S6.6 GUARD-002.
 *      (b) `reply_draft_dropped` — S9.4.1 nouveau, forensic L.34-5 CPCE.
 *
 *   3. Si l'un OU les 2 audits fail (Firestore I/O, AuditPiiError) → log
 *      Pino best-effort + on retourne quand même `{ok: false, failure}`.
 *      Trou forensique acceptable car la **correctness compliance** reste
 *      préservée : le draft reste `status="draft"`, aucun SMS n'est parti
 *      au PS.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ERREURS POSSIBLES (DANS L'ORDRE LOGIQUE)
 *
 *   - `NotFoundError`           : conversation OU draft message absent.
 *                                  Probable caller bug (event Inngest
 *                                  posté sur des IDs périmés / supprimés).
 *                                  `noRetry=true` (un retry ne va pas
 *                                  faire apparaître les docs).
 *   - `ValidationError`         : doc conv/message/contact corrompu (Zod),
 *                                  OU assertions A3 violées (direction !==
 *                                  "outbound", status !== "draft",
 *                                  generatedBy !== "ai"). `noRetry=true`
 *                                  par défaut (caller bug, pas transient).
 *
 *   - Retour `{ok: false, failure}` : un des 9 rules compliance refuse.
 *                                  PAS une exception — c'est le flow
 *                                  attendu pour un draft dropé par
 *                                  consent drift.
 *
 *   - Toute autre erreur Firestore I/O (timeout 5xx) propagée telle quelle
 *     pour permettre au caller (Inngest handler S9.4.2) de retry naturel.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CAS D'USAGE
 *
 *   - **Primaire S9.4.2** : Inngest handler `send-reply.ts` step
 *     `commit-draft-to-queued` — consomme l'event `medere/sms.reply.send-
 *     requested` posté par `process-reply.ts` après step 9.
 *
 *   - **Tests** : seed contact/conv/draft via Admin SDK, appel direct
 *     `commitDraftToQueued`, assertions sur l'état Firestore post-commit
 *     ou post-rollback.
 */
import { Timestamp } from "firebase-admin/firestore";

import { preSendCheckWithAuditTx } from "@/lib/compliance/pre-send-check-with-audit-tx";
import { getAdminDb } from "@/lib/firestore/admin";
import { appendAuditLog, appendAuditLogTx } from "@/lib/firestore/audit-log";
import {
  _bumpConversationCountersTx,
  _parseConversationOrThrow,
  getConversation,
} from "@/lib/firestore/conversations";
import { _parseMessageOrThrow, listRecentOutboundInTx } from "@/lib/firestore/messages";
import { withContactLock } from "@/lib/firestore/transactions";
import { ComplianceFailureError, NotFoundError, ValidationError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";
import type { ReplyDraftDroppedPayload } from "@/types/audit-log";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Doit rester aligné avec `__CONVERSATIONS_COLLECTION_FOR_TESTS` de
 * `conversations.ts`. Test sentinel dans `send-reply.test.ts` vérifie
 * l'égalité.
 */
const CONVERSATIONS_COLLECTION = "conversations";

const MESSAGES_SUBCOLLECTION = "messages";

/**
 * Largeur de la fenêtre rate-limit (jours). Aligné `RATE_LIMIT_WINDOW_DAYS`
 * de `lib/compliance/rate-limits.ts` (S4) et `transactions.ts:127` (S6.6).
 */
const RATE_LIMIT_WINDOW_DAYS = 30;

// ─────────────────────────────────────────────────────────────────────────────
// Types publics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Arguments de `commitDraftToQueued`. Objet structuré (pattern miroir
 * `SendOutboundWithLockArgs`) — extensible si futurs paramètres
 * (actorId pour audits manuels en S10+, etc.).
 */
export interface CommitDraftToQueuedArgs {
  /** docId composite `${contactId}_${campaignId}` de la conversation parente. */
  conversationId: string;
  /** Firestore auto-ID `[A-Za-z0-9]{20}` du draft à transitionner. */
  draftMessageId: string;
  /** Référence temporelle pour `queuedAt` + bump. Défaut `new Date()`. */
  now?: Date;
}

/**
 * Retour en branche allowed (transition draft→queued réussie). Contient
 * UNIQUEMENT des IDs opaques scrubber-safe (pattern A1 Déthié — pas de
 * body, pas de phoneE164, pas d'externalId).
 *
 * Le caller S9.4.2 utilisera ces IDs pour :
 *   - `getMessage(messageId)` afin de lire `body` + `aiModel` + ...
 *   - `getContact(contactId)` afin de lire `phone.e164` pour OVH dispatch
 *
 * Le `+1 round-trip` Firestore est acceptable (defense-in-depth + pattern
 * miroir S6 `send-first-sms.ts` step 1).
 */
export interface CommitDraftToQueuedSuccess {
  ok: true;
  /** Identique au `draftMessageId` reçu en input (le doc n'a PAS changé d'ID,
   *  seulement de `status`). Exposé pour clarté + uniformité avec le
   *  `sendOutboundWithLock` S6 qui retourne `messageId`. */
  messageId: string;
  conversationId: string;
  /** hubspotId opaque. Dérivé de `conv.contactId` via pré-flight HORS tx. */
  contactId: string;
  /** docId Firestore de l'audit `sms_sent` posé DANS la tx. */
  auditId: string;
}

/**
 * Retour en branche blocked (une rule compliance a refusé DANS la tx,
 * tx rollback automatique). Le `failure` est exposé pour permettre au
 * caller S9.4.2 de logger, alerter, ou décider du flow (ex: en retry
 * ultérieur pour rule `hours` si on est juste hors plage).
 *
 * Note : la branche blocked N'EST PAS une exception (pas de throw au
 * caller). C'est un retour métier attendu pour le pattern "consent drift
 * détecté entre génération et envoi".
 */
export interface CommitDraftToQueuedBlocked {
  ok: false;
  failure: {
    /** Nom de la rule (aligné `ComplianceRule` S5). */
    rule: string;
    /** Code spécifique (aligné `ComplianceFailCode` S5). */
    code: string;
    /** Contexte structuré du failure (discriminated union FERMÉE S5,
     *  exclut PII par typage). */
    context: Record<string, unknown>;
  };
}

export type CommitDraftToQueuedResult = CommitDraftToQueuedSuccess | CommitDraftToQueuedBlocked;

// ─────────────────────────────────────────────────────────────────────────────
// API publique
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Transition transactionnelle `draft → queued` d'un message outbound IA.
 *
 * Cf. JSDoc en tête de fichier pour vue d'ensemble + invariants + cas
 * d'erreur. Cf. arbitrages S9.4.1 (Q-B / A1-A7) pour le pourquoi des
 * choix d'API.
 *
 * @param args  Cf. `CommitDraftToQueuedArgs`.
 *
 * @returns `CommitDraftToQueuedSuccess` si compliance OK + commit réussi,
 *          `CommitDraftToQueuedBlocked` si une rule refuse DANS la tx
 *          (tx rollback, draft reste `status="draft"`).
 *
 * @throws {NotFoundError}   conv ou draft absent (probable caller bug —
 *                           event Inngest sur IDs périmés).
 * @throws {ValidationError} doc corrompu (Zod fail) OU assertions A3
 *                           violées (direction/status/generatedBy hors
 *                           valeurs attendues).
 */
export async function commitDraftToQueued(
  args: CommitDraftToQueuedArgs,
): Promise<CommitDraftToQueuedResult> {
  const { conversationId, draftMessageId } = args;

  // ── Pré-flight HORS tx : lire conversation pour extraire contactId ────
  // Pattern A5 Déthié (arbitrage S9.4.1) — évite la closure mutable
  // depuis l'intérieur de la tx. Coût +10-20ms acceptable. Si la conv
  // n'existe pas, on bail tôt avec NotFoundError (pas la peine d'ouvrir
  // de tx).
  const convPreFlight = await getConversation(conversationId);
  if (!convPreFlight) {
    throw new NotFoundError({
      message: `Conversation not found (pre-flight): ${conversationId}`,
      context: { conversationId, draftMessageId },
    });
  }
  const contactId = convPreFlight.contactId;

  try {
    // ── Tx atomique : lock contact + lire draft + compliance + transition ─
    return await withContactLock(contactId, async (tx, contact) => {
      // ── 1. Lecture + parse draft DANS tx ────────────────────────────────
      const messageRef = getAdminDb()
        .collection(CONVERSATIONS_COLLECTION)
        .doc(conversationId)
        .collection(MESSAGES_SUBCOLLECTION)
        .doc(draftMessageId);
      const messageDoc = await tx.get(messageRef);
      if (!messageDoc.exists) {
        throw new NotFoundError({
          message: `Draft message not found: ${draftMessageId} in conversation ${conversationId}`,
          context: { conversationId, draftMessageId },
        });
      }
      const draft = _parseMessageOrThrow(messageDoc.data(), conversationId, draftMessageId);

      // ── 2. Assertions A3 defense-in-depth ───────────────────────────────
      // Direction outbound : un draft inbound est un nonsense (le pipeline
      // S9.3.3a `addOutboundDraftInTx` figé `direction="outbound"`).
      if (draft.direction !== "outbound") {
        throw new ValidationError({
          message: `Draft has wrong direction (expected "outbound"): direction=${draft.direction}`,
          context: { conversationId, draftMessageId, direction: draft.direction },
        });
      }
      // Status draft : refuse si déjà queued/sent/sending/delivered/failed.
      // C'est le signal d'un double-commit (caller a appelé 2× la fonction
      // pour le même draft, OU le pipeline S9.4.2 a déjà transitionné).
      // L'idempotence Inngest devrait empêcher ça via step.run memoization,
      // mais defense-in-depth on refuse explicitement.
      if (draft.status !== "draft") {
        throw new ValidationError({
          message: `Message is not a draft (idempotence broken): status="${draft.status}" — expected "draft"`,
          context: { conversationId, draftMessageId, status: draft.status },
        });
      }
      // GeneratedBy AI : refuse si humain (commercial qui aurait rédigé un
      // draft manuel). Hors scope MVP S9.4 — reconsidérer en S10+ pour
      // commercial dashboard.
      if (draft.generatedBy !== "ai") {
        throw new ValidationError({
          message: `Draft was not AI-generated (S9.4 expects "ai"): generatedBy=${draft.generatedBy}`,
          context: { conversationId, draftMessageId, generatedBy: draft.generatedBy },
        });
      }

      // ── 3. Re-lecture conversation DANS tx (atomicité bump) ─────────────
      // La conv a déjà été lue HORS tx pour extraire contactId, mais on
      // doit la re-lire DANS la tx pour que `_bumpConversationCountersTx`
      // travaille sur l'état le plus frais (sinon double-bump silencieux si
      // une autre tx a bumpé entre temps).
      const convRef = getAdminDb().collection(CONVERSATIONS_COLLECTION).doc(conversationId);
      const convDocInTx = await tx.get(convRef);
      if (!convDocInTx.exists) {
        // Cas pathologique : conv supprimée entre pré-flight HORS tx et
        // tx.get DANS tx. On bail propre — pas de SMS envoyé.
        throw new NotFoundError({
          message: `Conversation not found in tx (vanished between pre-flight and tx.get): ${conversationId}`,
          context: { conversationId, draftMessageId },
        });
      }
      const convInTx = _parseConversationOrThrow(convDocInTx.data(), conversationId);

      // ── 4. Re-lecture historique outbound DANS tx (lock READ SET) ───────
      // `listRecentOutboundInTx` utilise `tx.get(query)` → verrouille le
      // READ SET dans la tx parente. Si une autre tx commit un nouveau
      // message outbound dans la fenêtre 30j entre notre lecture et notre
      // commit, Firestore détectera le conflit et retry la tx (jusqu'à 5×
      // par défaut côté Admin SDK).
      const recentOutbound = await listRecentOutboundInTx(
        tx,
        conversationId,
        RATE_LIMIT_WINDOW_DAYS,
        args.now,
      );

      // ── 5. preSendCheckWithAuditTx — re-validation 9 rules DANS tx ──────
      // Si une rule fail → throw `ComplianceFailureError` DANS tx, tx
      // rollback automatique (aucun audit allowed posé, aucune transition
      // commit). On catch HORS withContactLock.
      preSendCheckWithAuditTx(tx, {
        contact,
        message: draft.body,
        conversation: convInTx,
        recentOutboundMessages: recentOutbound,
        now: args.now ?? new Date(),
      });

      // ── 6. Transition draft → queued (UPDATE Firestore) ─────────────────
      const now = args.now !== undefined ? Timestamp.fromDate(args.now) : Timestamp.now();
      tx.update(messageRef, { status: "queued", queuedAt: now });

      // ── 7. Bump compteurs conversation (outbound) ───────────────────────
      // `_bumpConversationCountersTx` bumpe `messageCount` + `outboundCount`
      // + `lastMessageAt` + `lastOutboundAt` + pose `firstMessageAt` si
      // absent. Cf. conversations.ts:300 pour le détail.
      _bumpConversationCountersTx(tx, convRef, convInTx, "outbound", now);

      // ── 8. Audit sms_sent (RÉUTILISATION arbitrage Q-B5) ────────────────
      // Forensic narratif sur le même `messageId` :
      //   reply_generated (S9.3.3b) → sms_sent (S9.4.1) → sms_provider_dispatched (S9.4.2)
      // Pas de nouvelle action `reply_dispatched` (cohérent pattern S6/S7).
      // Payload `{direction, messageId}` UNIQUEMENT (jamais body, jamais
      // PII — cf. messages.ts invariant 3).
      const auditId = appendAuditLogTx(tx, {
        actorId: "system",
        actorType: "system",
        action: "sms_sent",
        targetType: "message",
        targetId: draftMessageId,
        payload: { direction: "outbound", messageId: draftMessageId },
      });

      return {
        ok: true as const,
        messageId: draftMessageId,
        conversationId,
        contactId,
        auditId,
      };
    });
  } catch (err) {
    // Branche blocked — la tx a rollback dès le throw DANS withContactLock.
    // On pose 2 audits best-effort HORS tx + on retourne {ok: false} au caller.
    if (err instanceof ComplianceFailureError) {
      const { rule, code, failureContext } = err.context;

      // ── Best-effort audit 1/2 : compliance_check (blocked) ──────────────
      // Cohérence S6.6 GUARD-002 : un check compliance pose un audit dans
      // les 2 branches (allowed via tx step 5, blocked ici via post-tx).
      try {
        await appendAuditLog({
          actorId: "system",
          actorType: "system",
          action: "compliance_check",
          targetType: "contact",
          targetId: contactId,
          payload: {
            result: "blocked",
            code,
            rule,
            // failureContext est une discriminated union fermée S5 →
            // aucune clé PII. Type assertion Record<string, unknown>
            // pour conformité AuditLogInput.payload.
            context: failureContext,
          },
        });
      } catch (auditErr) {
        // Trou forensique acceptable (correctness compliance préservée :
        // le draft reste status="draft"). Pattern miroir S6 MED-1. Pino
        // signature : objet en 1er, message en 2ème (cf. logger.ts l.28-30).
        logger.error(
          {
            conversationId,
            contactId,
            draftMessageId,
            rule,
            code,
            auditError: auditErr instanceof Error ? auditErr.message : "unknown",
          },
          "[commitDraftToQueued] failed compliance_check (blocked) audit",
        );
      }

      // ── Best-effort audit 2/2 : reply_draft_dropped ─────────────────────
      // S9.4.1 nouveau — forensic L.34-5 CPCE du draft rejeté. `targetType:
      // "message"`, `targetId: draftMessageId` (Firestore auto-ID scrubber-
      // safe). Payload typé `ReplyDraftDroppedPayload` (anti-PII compile-time
      // via discriminated union S5 sur blockedContext).
      try {
        const payload: ReplyDraftDroppedPayload = {
          contactId,
          conversationId,
          draftMessageId,
          // Cast safe : `rule` est typé `string` dans ComplianceFailureContext
          // mais en pratique vient toujours d'un `ComplianceRule` S5
          // (l'union des 9 rules) car le throw vient de preSendCheckWithAuditTx
          // qui le copie depuis `result.failure.rule`. La whitelist Zod
          // côté audit-log.ts ne vérifie pas la valeur (seulement la clé
          // payload) — la cohérence vient du typage TS au site d'écriture
          // ici. Si une future ComplianceRule était ajoutée S5 sans miroir
          // ReplyDraftDroppedPayload, le compile cassera ICI (intentionnel).
          blockedRule: rule as ReplyDraftDroppedPayload["blockedRule"],
          blockedCode: code,
          blockedContext: failureContext,
        };
        await appendAuditLog({
          actorId: "system",
          actorType: "system",
          action: "reply_draft_dropped",
          targetType: "message",
          targetId: draftMessageId,
          payload,
        });
      } catch (auditErr) {
        logger.error(
          {
            conversationId,
            contactId,
            draftMessageId,
            rule,
            code,
            auditError: auditErr instanceof Error ? auditErr.message : "unknown",
          },
          "[commitDraftToQueued] failed reply_draft_dropped audit",
        );
      }

      return {
        ok: false,
        failure: { rule, code, context: failureContext },
      };
    }

    // Toute autre erreur (NotFoundError, ValidationError, Firestore I/O 5xx,
    // ComplianceConcurrencyError race rate-limit) → re-throw au caller pour
    // gestion appropriée (Inngest retry vs noRetry selon le type).
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exposés pour tests
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export const __SEND_REPLY_CONVERSATIONS_COLLECTION_FOR_TESTS = CONVERSATIONS_COLLECTION;

/** @internal */
export const __SEND_REPLY_MESSAGES_SUBCOLLECTION_FOR_TESTS = MESSAGES_SUBCOLLECTION;

/** @internal */
export const __SEND_REPLY_RATE_LIMIT_WINDOW_DAYS_FOR_TESTS = RATE_LIMIT_WINDOW_DAYS;
