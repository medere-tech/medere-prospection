/**
 * Lecture + mutations sur la sous-collection Firestore
 * `conversations/{convId}/messages/`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * API EXPOSÉE (S6.5 — MVP) :
 *
 *   - `addOutbound(conversationId, input)`
 *         → crée le doc message (status="queued") + bump compteurs
 *           conversation + audit `sms_sent` payload `{direction, messageId}`,
 *           le tout en 1 transaction Firestore.
 *   - `addInbound(conversationId, input)`
 *         → crée le doc message (status="received") + bump compteurs
 *           conversation + audit `sms_received` payload `{direction,
 *           messageId}`, le tout en 1 transaction Firestore.
 *   - `listRecentOutbound(conversationId, days?, now?)`
 *         → retourne les messages outbound de la fenêtre, mappés en
 *           `OutboundMessageRecord[]` consommable par `lib/compliance/
 *           rate-limits` (S4). Conversation absente → `[]`.
 *
 * Hors périmètre S6.5 (reportés explicitement) :
 *   - `updateMessageStatus` (queued→sending→sent→delivered, failed,
 *      pose `sentAt`/`deliveredAt`, `cost`, `error`) → S7 sur réception
 *      webhook OVH delivery report
 *   - Classification intent (`intent`, `intentConfidence`,
 *      `intentReasoning`) → S7 (`classify-intent`)
 *   - `getMessage(conversationId, messageId)`     → S7+ si besoin
 *   - `listAllMessages(conversationId)` paginé    → S9+ (dashboard)
 *
 * Les fonctions S7+ NE DOIVENT PAS modifier les champs MVP posés ici
 * (`direction`, `body`, `channel`, `generatedBy`, `createdAt` — immuables
 * après création). Seules les transitions de status et l'enrichissement
 * `intent*` / `sentAt` / `deliveredAt` / `error` / `cost` sont attendues.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INVARIANTS (CNIL / RGPD) :
 *
 *   1. **Validation Zod STRICTE à la lecture** (`parseMessageOrThrow`).
 *      Doc corrompu → throw `ValidationError` SANS `cause` (la ZodError
 *      contient `issue.received` qui peut leak le `body` PII en inbound).
 *      Pas de fallback partiel.
 *
 *   2. **Atomicité tx** : `tx.get conversation` → `tx.create message
 *      (sous-collection)` → `_bumpConversationCountersTx` (helper partagé
 *      S6.4/S6.5) → `appendAuditLogTx`. Si UN write fail, TOUT est
 *      rolled back — pas de message orphelin, pas de compteur incohérent,
 *      pas de trou forensic.
 *
 *   3. **Audit payload = `{ direction, messageId }` UNIQUEMENT**. Jamais
 *      `body`, `bodyLength`, `bodyPreview` — le body est PII potentielle
 *      surtout pour les inbound (un PS peut écrire "Mon numéro perso est
 *      06...."). Le `messageId` est un Firestore auto-ID alphanumérique
 *      de 20 chars (regex `/^[A-Za-z0-9]{20}$/`) — pas PII par
 *      construction. Test sentinel dans `messages.test.ts`.
 *
 *   4. **Validation taille body AVANT runTransaction** (`BODY_MAX_LENGTH
 *      = 1600`). Empêche les writes Firestore de 1MB+ qui crasheraient
 *      la tx, et signale un bug applicatif (inbound suspicieux du genre
 *      coller 50KB d'historique copié).
 *
 *   5. **`listRecentOutbound` filtre sur `createdAt` (PAS `sentAt`)** —
 *      cf. JSDoc de la fonction. Conservateur : un message `queued`
 *      compte contre le plafond rate-limit dès sa création, même si OVH
 *      n'a pas encore confirmé l'envoi. Évite la race où 2 SMS partent
 *      simultanément si Inngest n'est pas correctement sérialisé par
 *      contact. Mapping fait dans la fonction : `sentAt = msg.sentAt ??
 *      msg.createdAt` pour préserver la sémantique de
 *      `SentMessageRecord` (S4 inchangé).
 *
 *   6. **Storage body brut** : on stocke `body` brut dans le doc message
 *      (nécessaire pour forensic + analyse intent S7). Le scrubber PII
 *      S6.2 ne traite QUE les payloads `audit_log/`, pas les docs
 *      messages eux-mêmes. C'est l'invariant 3 ci-dessus qui empêche
 *      la fuite via les audits. `firestore.rules` protège l'accès
 *      client (commercial only, lecture seule).
 */
import { type DocumentReference, Timestamp, type Transaction } from "firebase-admin/firestore";
import { z } from "zod";

import { type OutboundMessageRecord } from "@/lib/compliance/rate-limits";
import { getAdminDb } from "@/lib/firestore/admin";
import { appendAuditLogTx } from "@/lib/firestore/audit-log";
import {
  _bumpConversationCountersTx,
  _parseConversationOrThrow,
} from "@/lib/firestore/conversations";
import { NotFoundError, ValidationError } from "@/lib/utils/errors";
import type { Message, MessageAITokens, MessageChannel, MessageGeneratedBy } from "@/types/message";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Doit rester aligné avec `__CONVERSATIONS_COLLECTION_FOR_TESTS` de
 * `conversations.ts`. Test sentinel dans `messages.test.ts` vérifie
 * l'égalité — si quelqu'un renomme côté conversations.ts, le test casse.
 */
const CONVERSATIONS_COLLECTION = "conversations";

const MESSAGES_SUBCOLLECTION = "messages";

/**
 * Plafond strict de la taille du `body` (validation AVANT tx).
 * Calcul :
 *   SMS classique GSM-7  : 160 chars
 *   SMS multipart 10 segments : 153 × 10 = 1530 chars
 *   Marge sécurité       : 1600 chars
 * Au-delà : refuse l'écriture. Signal d'un bug applicatif (PS qui colle
 * 50KB d'historique copié dans son SMS, prompt LLM mal généré, etc.).
 */
const BODY_MAX_LENGTH = 1600;

/** Largeur par défaut de la fenêtre `listRecentOutbound` (alignement S4). */
const DEFAULT_LIST_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Schéma Zod (validation runtime à la lecture)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `z.unknown()` pour les Timestamps : Firestore renvoie une instance de
 * classe `Timestamp` (firebase-admin). On valide la PRÉSENCE de la clé,
 * pas la forme exacte. Pattern identique S6.3/S6.4.
 */
const TimestampLike = z.unknown();

export const MessageAITokensSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
});

export const MessageErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryCount: z.number().int().nonnegative(),
});

export const MessageSchema = z.object({
  direction: z.enum(["outbound", "inbound"]),
  body: z.string().min(1).max(BODY_MAX_LENGTH),
  status: z.enum(["queued", "sending", "sent", "delivered", "failed", "received"]),
  channel: z.enum(["sms", "whatsapp"]),
  externalId: z.string().optional(),
  externalReceiver: z.string().optional(),
  generatedBy: z.enum(["ai", "human", "system"]),
  aiModel: z.string().optional(),
  aiPromptVersion: z.string().optional(),
  aiTemperature: z.number().optional(),
  aiTokens: MessageAITokensSchema.optional(),
  intent: z.enum(["INTERESSE", "NEUTRE", "OBJECTION", "STOP", "unknown"]).optional(),
  intentConfidence: z.number().min(0).max(1).optional(),
  intentReasoning: z.string().optional(),
  cost: z.number().nonnegative().optional(),
  createdAt: TimestampLike,
  queuedAt: TimestampLike.optional(),
  sentAt: TimestampLike.optional(),
  deliveredAt: TimestampLike.optional(),
  receivedAt: TimestampLike.optional(),
  error: MessageErrorSchema.optional(),
});

/** Type inféré depuis le schéma Zod. */
export type MessageValidated = z.infer<typeof MessageSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Types d'input narrow (le compilateur empêche d'écrire les champs figés)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input pour `addOutbound`. Les champs `direction` (="outbound"),
 * `status` (="queued"), `createdAt` (=now serveur) sont FIGÉS par la
 * fonction et NE PEUVENT PAS être fournis par le caller. Test
 * `@ts-expect-error` dans `messages.test.ts` verrouille ça au compile-time.
 *
 * `generatedBy` est REQUIS : un message outbound peut être généré par
 * une IA (Claude première relance / relance), un humain (commercial qui
 * répond manuellement), ou le système (auto-reply STOP).
 *
 * Les champs `sentAt`, `deliveredAt`, `error`, `cost`, `intent*` sont
 * INTENTIONNELLEMENT absents — posés plus tard par `updateMessageStatus()`
 * et `classify-intent` en S7.
 */
export interface AddOutboundInput {
  body: string;
  channel: MessageChannel;
  generatedBy: MessageGeneratedBy;
  /** E.164 du destinataire (PS). Recommandé pour traçabilité OVH. */
  externalReceiver?: string;
  aiModel?: string;
  aiPromptVersion?: string;
  aiTemperature?: number;
  aiTokens?: MessageAITokens;
}

/**
 * Input pour `addInbound`. Les champs `direction` (="inbound"),
 * `status` (="received"), `generatedBy` (="human"), `createdAt` (=now
 * serveur), `receivedAt` (=now serveur) sont FIGÉS par la fonction.
 *
 * `externalId` est REQUIS (idempotency key du webhook OVH — permet de
 * détecter les doublons via une query future en S7 si OVH double-livre).
 *
 * `externalReceiver` est ici l'EXPÉDITEUR (E.164 du PS qui a répondu).
 * Le nom de champ est conservé du type `Message` pour homogénéité du
 * schéma ; sémantiquement c'est "l'autre bout" de la conversation.
 *
 * Les champs `intent*` sont INTENTIONNELLEMENT absents — posés par
 * `classify-intent` en S7 via `updateMessageStatus()` ou équivalent.
 */
export interface AddInboundInput {
  body: string;
  channel: MessageChannel;
  externalId: string;
  externalReceiver: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers internes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse + cast strict. ⚠️ PAS de `cause: result.error` — la ZodError
 * contient `issue.received` qui peut leak `body` PII en inbound (un PS
 * peut écrire "Mon numéro perso est 06..."). Pattern identique S6.3/S6.4.
 */
function parseMessageOrThrow(raw: unknown, conversationId: string, messageId: string): Message {
  const result = MessageSchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError({
      message: `Message document corrupted (${conversationId}/${messageId}): ${result.error.issues
        .map((i) => `${i.path.join(".")} (${i.code})`)
        .join(", ")}`,
      context: {
        conversationId,
        messageId,
        issues: result.error.issues.map((i) => ({
          path: i.path.join("."),
          code: i.code,
        })),
      },
    });
  }
  return result.data as Message;
}

/**
 * Validation taille body AVANT toute interaction Firestore. Empêche un
 * body de 10MB+ qui crasherait la tx (limite Firestore 1MB par doc) ou
 * coûterait disproportionnellement cher à OVH.
 *
 * Cf. invariant 4 du module. Body vide est aussi refusé (un SMS vide
 * est un bug applicatif, jamais un cas légitime).
 */
function validateBodyOrThrow(body: string, conversationId: string): void {
  if (body.length === 0) {
    throw new ValidationError({
      message: "Message body cannot be empty",
      context: { conversationId },
    });
  }
  if (body.length > BODY_MAX_LENGTH) {
    throw new ValidationError({
      message: `Message body exceeds max length (${body.length}/${BODY_MAX_LENGTH})`,
      context: {
        conversationId,
        bodyLength: body.length,
        maxLength: BODY_MAX_LENGTH,
      },
    });
  }
}

/**
 * Construit la référence Firestore vers la sous-collection messages
 * d'une conversation. Centralisé pour éviter la divergence de chemin.
 */
function messagesSubcollectionRef(conversationId: string) {
  return getAdminDb()
    .collection(CONVERSATIONS_COLLECTION)
    .doc(conversationId)
    .collection(MESSAGES_SUBCOLLECTION);
}

/**
 * Lit + parse la conversation parente dans la transaction. Centralisé
 * pour homogénéiser l'ordre de validation (existence → Zod) entre
 * addOutbound et addInbound.
 *
 * @throws NotFoundError    si la conversation n'existe pas.
 * @throws ValidationError  si le doc est corrompu.
 */
async function readConversationInTxOrThrow(
  tx: Transaction,
  ref: DocumentReference,
  conversationId: string,
) {
  const doc = await tx.get(ref);
  if (!doc.exists) {
    throw new NotFoundError({
      message: `Conversation not found: ${conversationId}`,
      context: { conversationId },
    });
  }
  return _parseConversationOrThrow(doc.data(), conversationId);
}

// ─────────────────────────────────────────────────────────────────────────────
// API publique
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Crée un message sortant dans la sous-collection
 * `conversations/{conversationId}/messages/`, bumpe les compteurs de la
 * conversation, et pose un audit `sms_sent`. Atomique (1 transaction).
 *
 * Champs FIGÉS par la fonction (PAS modifiables via input) :
 *   - `direction = "outbound"`
 *   - `status = "queued"`
 *   - `createdAt = Timestamp.now()` (serveur)
 *
 * Les champs `sentAt`, `deliveredAt`, `error`, `cost` seront posés plus
 * tard par `updateMessageStatus()` (S7) à réception du webhook OVH.
 *
 * Audit payload = `{ direction: "outbound", messageId }`. Jamais `body`,
 * `bodyLength`, ni le contenu. Cf. invariant 3 du module.
 *
 * Si l'audit ou le bump des compteurs throw (ex: corruption détectée
 * trop tard, AuditPiiError sur un payload mal posé futur) → rollback
 * TOTAL : pas de message orphelin, compteurs inchangés.
 *
 * @param conversationId  docId composite `${contactId}_${campaignId}`.
 * @param input           Voir `AddOutboundInput` pour le périmètre.
 *
 * @returns L'ID Firestore (auto-généré) du message créé.
 *
 * @throws ValidationError  si `body` vide ou > `BODY_MAX_LENGTH`, ou si
 *                          la conversation est corrompue.
 * @throws NotFoundError    si la conversation n'existe pas.
 */
export async function addOutbound(
  conversationId: string,
  input: AddOutboundInput,
): Promise<string> {
  validateBodyOrThrow(input.body, conversationId);

  return await getAdminDb().runTransaction(async (tx) => {
    const convRef = getAdminDb().collection(CONVERSATIONS_COLLECTION).doc(conversationId);
    const conv = await readConversationInTxOrThrow(tx, convRef, conversationId);

    const messageRef = messagesSubcollectionRef(conversationId).doc(); // auto-ID
    const now = Timestamp.now();

    // Construction explicite : NE PAS spreader `input` brut — risque
    // qu'un champ inattendu (introduit côté caller via `as any`) passe.
    // Les undefined optionnels sont volontairement absents de l'objet
    // (Firestore n'a PAS `ignoreUndefinedProperties` activé côté admin.ts).
    const messageDoc: Message = {
      direction: "outbound",
      body: input.body,
      status: "queued",
      channel: input.channel,
      generatedBy: input.generatedBy,
      createdAt: now,
      ...(input.externalReceiver !== undefined && {
        externalReceiver: input.externalReceiver,
      }),
      ...(input.aiModel !== undefined && { aiModel: input.aiModel }),
      ...(input.aiPromptVersion !== undefined && {
        aiPromptVersion: input.aiPromptVersion,
      }),
      ...(input.aiTemperature !== undefined && {
        aiTemperature: input.aiTemperature,
      }),
      ...(input.aiTokens !== undefined && { aiTokens: input.aiTokens }),
    };
    tx.create(messageRef, messageDoc);

    _bumpConversationCountersTx(tx, convRef, conv, "outbound", now);

    appendAuditLogTx(tx, {
      actorId: "system",
      actorType: "system",
      action: "sms_sent",
      targetType: "message",
      targetId: messageRef.id,
      // `direction` + `messageId` UNIQUEMENT. Le messageId est un
      // Firestore auto-ID alphanumérique de 20 chars → pas PII (test
      // sentinel dans messages.test.ts vérifie le pattern).
      payload: { direction: "outbound", messageId: messageRef.id },
    });

    return messageRef.id;
  });
}

/**
 * Crée un message entrant dans la sous-collection
 * `conversations/{conversationId}/messages/`, bumpe les compteurs, et
 * pose un audit `sms_received`. Atomique (1 transaction).
 *
 * Champs FIGÉS par la fonction (PAS modifiables via input) :
 *   - `direction = "inbound"`
 *   - `status = "received"`
 *   - `generatedBy = "human"` (le PS, donc un humain par construction)
 *   - `createdAt = receivedAt = Timestamp.now()` (serveur)
 *
 * `externalId` (l'ID OVH du webhook) est REQUIS — idempotency key qui
 * permettra en S7 de détecter un double-livrage OVH via query simple.
 *
 * `externalReceiver` est ici l'EXPÉDITEUR (E.164 du PS). Nom de champ
 * conservé du type pour homogénéité ; sémantiquement c'est "l'autre
 * bout" de la conversation.
 *
 * Les champs `intent`, `intentConfidence`, `intentReasoning` seront
 * posés par `classify-intent` (S7) après lecture du body par Claude.
 *
 * Audit payload = `{ direction: "inbound", messageId }`. Jamais `body`.
 *
 * @returns L'ID Firestore (auto-généré) du message créé.
 *
 * @throws ValidationError  si `body` vide ou > `BODY_MAX_LENGTH`, ou si
 *                          la conversation est corrompue.
 * @throws NotFoundError    si la conversation n'existe pas.
 */
export async function addInbound(conversationId: string, input: AddInboundInput): Promise<string> {
  validateBodyOrThrow(input.body, conversationId);

  return await getAdminDb().runTransaction(async (tx) => {
    const convRef = getAdminDb().collection(CONVERSATIONS_COLLECTION).doc(conversationId);
    const conv = await readConversationInTxOrThrow(tx, convRef, conversationId);

    const messageRef = messagesSubcollectionRef(conversationId).doc(); // auto-ID
    const now = Timestamp.now();

    const messageDoc: Message = {
      direction: "inbound",
      body: input.body,
      status: "received",
      channel: input.channel,
      externalId: input.externalId,
      externalReceiver: input.externalReceiver,
      generatedBy: "human",
      createdAt: now,
      receivedAt: now,
    };
    tx.create(messageRef, messageDoc);

    _bumpConversationCountersTx(tx, convRef, conv, "inbound", now);

    appendAuditLogTx(tx, {
      actorId: "system",
      actorType: "system",
      action: "sms_received",
      targetType: "message",
      targetId: messageRef.id,
      payload: { direction: "inbound", messageId: messageRef.id },
    });

    return messageRef.id;
  });
}

/**
 * Retourne les messages outbound de la conversation dans la fenêtre
 * temporelle (par défaut 30 jours), mappés en `OutboundMessageRecord[]`
 * consommable directement par `canSendMessage()` (S4, `rate-limits.ts`).
 *
 * **IMPORTANT — filtrage `createdAt` (PAS `sentAt`)** :
 *
 * La query Firestore filtre sur `createdAt`, pas `sentAt`. Justification :
 * un message `queued` mais pas encore envoyé OVH DOIT compter contre
 * le plafond rate-limit. Sinon, race possible : pre-send-check d'un SMS
 * B juste après la création (status `queued`) de SMS A → A non visible
 * dans la query (car `sentAt` pas encore posé) → 4ème SMS possible si
 * Inngest n'est pas correctement sérialisé par contact. Conservateur >
 * exploitable.
 *
 * Mapping de sortie : `sentAt = msg.sentAt ?? msg.createdAt`. Préserve
 * la sémantique du type `OutboundMessageRecord` (S4, `rate-limits.ts`)
 * sans toucher au champ Firestore — un message `queued` voit son
 * `createdAt` exposé en tant que `sentAt` pour le calcul rate-limit.
 *
 * **Conversation absente → `[]`** (pas `NotFoundError`). Cohérent avec
 * la sémantique "combien d'envois récents ? réponse : 0". Le caller
 * (`pre-send-check` S5) recevra `[]` et calculera 0 outbound dans la
 * fenêtre, ce qui est correct. Le pattern `NotFoundError` est réservé
 * aux mutations (markOptedOut, setHandoff, addOutbound, addInbound) où
 * agir sur un ID inexistant est forcément un bug d'orchestration.
 *
 * **Index composite requis** (déclaré dans `firestore.indexes.json`) :
 *   collection: messages (scope COLLECTION)
 *   direction ASC, createdAt DESC
 *
 * @param conversationId  docId composite `${contactId}_${campaignId}`.
 * @param days            Largeur de fenêtre en jours. Défaut 30 (S4).
 * @param now             Référence temporelle. Défaut `new Date()`.
 *                        Injectable pour les tests déterministes.
 *
 * @returns Liste ordonnée DESC par `createdAt`. Mapping `sentAt` ci-dessus.
 */
export async function listRecentOutbound(
  conversationId: string,
  days: number = DEFAULT_LIST_DAYS,
  now: Date = new Date(),
): Promise<OutboundMessageRecord[]> {
  const fromTs = Timestamp.fromDate(new Date(now.getTime() - days * MS_PER_DAY));

  const snap = await messagesSubcollectionRef(conversationId)
    .where("direction", "==", "outbound")
    .where("createdAt", ">=", fromTs)
    .orderBy("createdAt", "desc")
    .get();

  return snap.docs.map((doc) => {
    const msg = parseMessageOrThrow(doc.data(), conversationId, doc.id);
    // Mapping cf. JSDoc : `sentAt` exposé = `msg.sentAt ?? msg.createdAt`.
    // Le cast `Timestamp` est sûr car les 2 viennent du SDK Firestore.
    const sentAt = (msg.sentAt ?? msg.createdAt) as OutboundMessageRecord["sentAt"];
    return {
      direction: "outbound",
      sentAt,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Exposés pour tests
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export const __MESSAGES_PARENT_COLLECTION_FOR_TESTS = CONVERSATIONS_COLLECTION;

/** @internal */
export const __MESSAGES_SUBCOLLECTION_FOR_TESTS = MESSAGES_SUBCOLLECTION;

/** @internal */
export const __BODY_MAX_LENGTH_FOR_TESTS = BODY_MAX_LENGTH;

/** @internal */
export const __DEFAULT_LIST_DAYS_FOR_TESTS = DEFAULT_LIST_DAYS;
