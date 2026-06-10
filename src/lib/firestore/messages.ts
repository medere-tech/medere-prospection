/**
 * Lecture + mutations sur la sous-collection Firestore
 * `conversations/{convId}/messages/`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * API EXPOSÉE (S6.5 + DEBT-001.2) :
 *
 *   - `addOutbound(conversationId, input)`                       (S6.5)
 *         → wrapper standalone qui ouvre sa propre `runTransaction`,
 *           lit + parse la conversation, et délègue à `addOutboundInTx`.
 *           Pour callers SANS tx ouverte (follow-ups S9+, scripts).
 *
 *   - `addOutboundInTx(tx, conversationId, conv, input)` (DEBT-001.2)
 *         → version tx-aware d'addOutbound. NE crée PAS sa propre tx —
 *           pose `tx.create message` + `_bumpConversationCountersTx`
 *           + `appendAuditLogTx("sms_sent")` dans la tx fournie. Caller
 *           primaire : `sendOutboundWithLock` (DEBT-001.5) qui compose
 *           l'envoi atomique avec re-check rate-limit DANS la tx.
 *           `conversationId` est EXPLICITE (source de vérité = la doc
 *           location, fournie par le caller). `conv` est l'état validé
 *           lu à cette location DANS la tx.
 *
 *   - `addInbound(conversationId, input)`                        (S6.5)
 *         → crée le doc message (status="received") + bump compteurs
 *           conversation + audit `sms_received` payload `{direction,
 *           messageId}`, le tout en 1 transaction Firestore.
 *
 *   - `listRecentOutbound(conversationId, days?, now?)`          (S6.5)
 *         → retourne les messages outbound de la fenêtre, mappés en
 *           `OutboundMessageRecord[]` consommable par `lib/compliance/
 *           rate-limits` (S4). Conversation absente → `[]`. Query HORS tx
 *           (perf optimale pour le pre-check S5). Pour le pattern
 *           tx-aware avec read lock anti-race, voir `listRecentOutboundInTx`.
 *
 *   - `listRecentOutboundInTx(tx, convId, days?, now?)`   (DEBT-001.2)
 *         → version tx-aware de `listRecentOutbound`. Utilise `tx.get`
 *           au lieu de `.get()` direct → LOCK le READ SET dans la tx
 *           parente. Permet le re-check rate-limit DANS la tx (fix
 *           DETTE-001 race condition rate-limit 3 SMS / 30j).
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
import type { Conversation } from "@/types/conversation";
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
 * Version TRANSACTIONNELLE d'`addOutbound` (DEBT-001.2). NE crée PAS sa
 * propre transaction — opère dans la `tx` fournie par le caller.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CAS D'USAGE PRIMAIRE — `sendOutboundWithLock` (DEBT-001.5)
 *
 * Le caller (`sendOutboundWithLock` dans `lib/firestore/transactions.ts`)
 * compose l'envoi atomique :
 *
 *   await withContactLock(contactId, async (tx, contact) => {
 *     const recentInTx = await listRecentOutboundInTx(tx, conversationId)
 *     if (!canSendMessage(recentInTx).allowed) {
 *       throw new ComplianceConcurrencyError({...})
 *     }
 *     const conv = await tx.get(convRef)
 *       .then(d => _parseConversationOrThrow(d.data(), conversationId))
 *     return addOutboundInTx(tx, conversationId, conv, input)
 *   })
 *
 * Re-check rate-limit DANS la tx + write message + audits = TOUT atomique.
 * Si l'une de ces étapes throw, Firestore rollback tout (pas de message
 * orphelin, pas de compteur incohérent, pas de SMS parti côté OVH —
 * l'ovh-send arrive APRÈS commit de cette tx).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * EFFETS POSÉS DANS LA TX (ordre strict, vérifié par tests sentinelles)
 *
 *   1. `tx.create(messageRef, messageDoc)`                — sous-collection
 *      messages : doc avec `direction="outbound"`, `status="queued"`,
 *      `createdAt=Timestamp.now()`, et les optionnels fournis.
 *   2. `_bumpConversationCountersTx(tx, convRef, conv, "outbound", now)`
 *      — bumpe `messageCount`, `outboundCount`, `lastMessageAt`,
 *      `lastOutboundAt`, et pose `firstMessageAt` si absent.
 *   3. `appendAuditLogTx(tx, action: "sms_sent", payload:
 *      { direction: "outbound", messageId })` — audit forensique.
 *
 * Champs FIGÉS (PAS modifiables via input) : `direction="outbound"`,
 * `status="queued"`, `createdAt=Timestamp.now()` (serveur). Les champs
 * `sentAt`/`deliveredAt`/`error`/`cost` seront posés par
 * `updateMessageStatus()` en S7 à réception du webhook OVH.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * PRÉCONDITIONS CALLER
 *
 *   1. **`conversationId` doit pointer le doc EXISTANT et déjà lu DANS
 *      la tx**. Source de vérité = la doc location fournie par le caller.
 *      Le bump des compteurs se fait sur `conversations/{conversationId}`.
 *
 *   2. **`conv` doit avoir été lu DANS la tx** (via `tx.get(convRef)` puis
 *      `_parseConversationOrThrow`). Si le caller a lu `conv` HORS tx
 *      avant `withContactLock`, le bump des compteurs sera CALCULÉ à
 *      partir de la valeur stale → risque de compteur incohérent si une
 *      autre tx a bumpé entre-temps. Cette fonction NE vérifie PAS cette
 *      précondition — elle assume la responsabilité du caller.
 *
 *   3. **Le contact lié à `conv` doit avoir été locké via
 *      `withContactLock(conv.contactId, ...)`** — sérialise les tx
 *      concurrentes sur le même contact, garantit la cohérence du
 *      re-check rate-limit qui précède l'appel.
 *
 * @param tx              Transaction Firestore ouverte par le caller.
 * @param conversationId  docId composite `${contactId}_${campaignId}`,
 *                        fourni explicitement par le caller (source de
 *                        vérité = la doc location, pas une dérivation).
 * @param conv            `Conversation` déjà lue + parsée DANS `tx` par
 *                        le caller au chemin `conversations/{conversationId}`.
 * @param input           Champs métier du message. Cf. `AddOutboundInput`.
 *
 * @returns L'ID Firestore (auto-généré, 20 chars `[A-Za-z0-9]`) du
 *          message créé. Disponible immédiatement côté caller pour la
 *          composition (ex: audit `sms_provider_dispatched` ultérieur
 *          dans la même tx, avec `targetId = messageId`).
 *
 * @throws ValidationError  si `body` vide ou > `BODY_MAX_LENGTH`. La tx
 *                          rollback automatiquement (aucune écriture
 *                          partielle, Firestore défait les `tx.create`
 *                          déjà queuées si elles n'ont pas encore commit).
 */
export async function addOutboundInTx(
  tx: Transaction,
  conversationId: string,
  conv: Conversation,
  input: AddOutboundInput,
): Promise<string> {
  validateBodyOrThrow(input.body, conversationId);

  const convRef = getAdminDb().collection(CONVERSATIONS_COLLECTION).doc(conversationId);
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
}

/**
 * Crée un message sortant dans la sous-collection
 * `conversations/{conversationId}/messages/`, bumpe les compteurs de la
 * conversation, et pose un audit `sms_sent`. Atomique (1 transaction).
 *
 * **Wrapper standalone de `addOutboundInTx` (DEBT-001.2)** : ouvre une
 * `runTransaction`, lit + parse la conversation DANS la tx, puis délègue
 * la composition message + bump + audit à `addOutboundInTx`. Toute la
 * logique métier vit dans `addOutboundInTx` (single source of truth).
 *
 * Pour les callers qui ont DÉJÀ une tx ouverte (typiquement
 * `sendOutboundWithLock` qui re-check rate-limit DANS la tx) : appeler
 * `addOutboundInTx` directement, PAS `addOutbound` (qui ouvrirait une
 * tx imbriquée — refusé par Firestore Admin SDK).
 *
 * Champs FIGÉS par la fonction (PAS modifiables via input) :
 *   - `direction = "outbound"`
 *   - `status = "queued"`
 *   - `createdAt = Timestamp.now()` (serveur)
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
  // Pre-flight validation HORS tx → fail-fast sans ouvrir de tx si body
  // invalide. `addOutboundInTx` re-valide en défense en profondeur pour
  // les callers directs (sendOutboundWithLock).
  validateBodyOrThrow(input.body, conversationId);

  return await getAdminDb().runTransaction(async (tx) => {
    const convRef = getAdminDb().collection(CONVERSATIONS_COLLECTION).doc(conversationId);
    const conv = await readConversationInTxOrThrow(tx, convRef, conversationId);
    return addOutboundInTx(tx, conversationId, conv, input);
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
 * **Query HORS tx (`.get()` direct)** — perf optimale pour le pre-check
 * S5 qui s'exécute HORS toute transaction (orchestration Inngest). Pour
 * le pattern tx-aware avec read lock anti-race (re-check rate-limit
 * DANS une tx parente), voir `listRecentOutboundInTx` (DEBT-001.2).
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

/**
 * Recherche un message INBOUND par son `externalId` (= `ovhMessageId` du
 * webhook OVH) dans la sous-collection d'une conversation. Sert à la
 * dédup webhook côté pipeline `process-reply` (S9.2).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * RAISON D'ÊTRE (S9.1 — pré-requis process-reply)
 *
 * OVH peut double-livrer un webhook inbound (retry après timeout réseau,
 * incident provider, etc.). Sans dédup, le pipeline `process-reply`
 * traiterait 2× le même SMS PS → 2 appels classifier Claude + 2 audits
 * `reply_processed` + potentiellement 2 réponses générées au PS.
 *
 * `externalId` est posé comme idempotency key sur chaque doc message
 * inbound par `addInbound` (cf. `AddInboundInput.externalId` REQUIS,
 * l.237). Querier `direction == "inbound" AND externalId == X` permet
 * de détecter le doublon AVANT `addInbound`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INDEX FIRESTORE COMPOSITE REQUIS (S9.1)
 *
 * La query combine 2 `where` égalité (`direction` + `externalId`) →
 * Firestore exige un index composite. Déclaré dans
 * `firestore.indexes.json` (S9.1) :
 *
 *   { "collectionGroup": "messages", "queryScope": "COLLECTION",
 *     "fields": [
 *       { "fieldPath": "direction", "order": "ASCENDING" },
 *       { "fieldPath": "externalId", "order": "ASCENDING" }
 *     ] }
 *
 * Sans déploiement de cet index, la query throw `FAILED_PRECONDITION` —
 * cf. `docs/firestore-indexes.md` section "Index 2".
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * SÉMANTIQUE Q2 brief Déthié S9.1 — retour `Message | null`
 *
 *   - Pas de doublon trouvé → `null`. Le caller process-reply peut
 *     procéder à `addInbound` normalement.
 *
 *   - 1 doublon trouvé → retourne le `Message` complet. Le caller peut :
 *     - audit `reply_dropped` avec `{reason: "dedup_webhook"}` (l'audit
 *       NE doit PAS contenir le messageId du doublon — cf. anti-PII
 *       audit_log invariant : pas d'identifiant Firestore semi-sensible
 *       en clair sans nécessité).
 *     - logger côté serveur pour forensic.
 *
 *   - Si 2+ docs match (cas anormal — webhook OVH livré 3+ fois ET
 *     `addInbound` n'a pas verrouillé entre 2 retries), on retourne le
 *     premier doc trouvé. Pas de défense-in-depth strict ici (≠
 *     `getContactByPhone`) car la sémantique métier est "y a-t-il déjà
 *     un doublon ?" → présence d'au moins 1 suffit pour court-circuiter.
 *     L'invariant unicité externalId par conversation reste à surveiller
 *     manuellement (pas business-critical au sens compliance — la dédup
 *     fonctionne quand même).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ⚠️ PII DOWNSTREAM — `body` brut dans le retour
 *
 * Le `Message` retourné contient **`body` brut** (PII potentielle —
 * un PS peut écrire "Mon numéro perso est 06..." dans son SMS de
 * réponse). Le caller `process-reply` (S9.2) est responsable de :
 *
 *   1. **NE JAMAIS logger `msg.body`** via Pino/Sentry/console. Le
 *      logger Pino S1 a un filet de redaction multicouche mais on ne
 *      compte PAS dessus en défense-en-profondeur.
 *
 *   2. **NE JAMAIS inclure `body` ni `messageId` ni `externalId` dans
 *      le payload audit `reply_dropped`**. Seul `{ reason:
 *      "dedup_webhook" }` est acceptable (le scrubber `detectPiiInPayload`
 *      attraperait le body et throw `AuditPiiError` → tx rollback,
 *      mais autant être explicite côté contrat). Pour forensic
 *      dédup côté admin, utiliser `targetId = conversationId` (opaque,
 *      pas PII par construction).
 *
 *   3. **NE JAMAIS renvoyer le Message côté client / webhook réponse**
 *      sans filtrage explicite des champs sensibles.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * GESTION INPUT
 *
 * Conversation absente → `[]` au snap (cohérent avec `listRecentOutbound`,
 * lecture tolérante) → fonction retourne `null`. PAS `NotFoundError` —
 * c'est une recherche, pas une mutation.
 *
 * `externalId` vide → `ValidationError` (signal d'un bug d'orchestration
 * côté caller — l'event Inngest `SmsReplyReceivedDataSchema` valide
 * `ovhMessageId: z.string().min(1)` AVANT le handler, donc on n'arrive
 * jamais ici avec vide en flow normal).
 *
 * Doc trouvé mais Zod fail → throw `ValidationError` au parse (filet en
 * lecture identique aux autres `listX`).
 *
 * @param conversationId  docId composite `${contactId}_${campaignId}`.
 * @param externalId      ID OVH du message inbound. NON vide.
 *
 * @returns Le `Message` trouvé, ou `null` si aucun match.
 *
 * @throws ValidationError  si `externalId` est vide ou si un doc trouvé
 *                          est corrompu (Zod fail).
 */
export async function findInboundByExternalId(
  conversationId: string,
  externalId: string,
): Promise<Message | null> {
  if (externalId.length === 0) {
    throw new ValidationError({
      message: "findInboundByExternalId: externalId is empty",
      context: { conversationId, op: "findInboundByExternalId" },
    });
  }

  const snap = await messagesSubcollectionRef(conversationId)
    .where("direction", "==", "inbound")
    .where("externalId", "==", externalId)
    .limit(1)
    .get();

  if (snap.empty) {
    return null;
  }

  // limit(1) garantit snap.docs[0] défini ici.
  const doc = snap.docs[0]!;
  return parseMessageOrThrow(doc.data(), conversationId, doc.id);
}

/**
 * Version TRANSACTIONNELLE de `listRecentOutbound` (DEBT-001.2). Utilise
 * `tx.get(query)` au lieu de `.get()` direct → LOCK le READ SET dans la
 * transaction parente.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * RAISON D'ÊTRE — Fix DETTE-001 race rate-limit
 *
 * `listRecentOutbound` (HORS tx) lit l'historique outbound 30j en query
 * directe `.get()`. Si 2 events Inngest concurrents arrivent sur le même
 * contact, ils lisent EN PARALLÈLE l'historique (état "2/3 SMS dans la
 * fenêtre"), passent tous les deux le pre-check S5, et créent CHACUN un
 * 3e message → 4 SMS au total → sanction CNIL.
 *
 * Cette fonction permet de re-checker rate-limit DANS une tx parente
 * ouverte par `withContactLock`. Firestore optimistic concurrency
 * détecte le conflit au commit : si une autre tx a écrit dans la
 * sous-collection messages entre `tx.get(query)` et le commit, le
 * commit est rejeté et la tx retry. Au retry, la query relit
 * l'historique mis à jour (3/3 → bloqué).
 *
 * Pattern complet (cf. `concurrency.test.ts` qui valide en emulator) :
 *
 *   await withContactLock(contactId, async (tx) => {
 *     const recentInTx = await listRecentOutboundInTx(tx, conversationId)
 *     if (!canSendMessage(recentInTx).allowed) {
 *       throw new ComplianceConcurrencyError({...})
 *     }
 *     // tx.create message + audit DANS la même tx → atomique
 *     return addOutboundInTx(tx, conv, input)
 *   })
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * SÉMANTIQUE IDENTIQUE À `listRecentOutbound`
 *
 *   - Filtre `direction == "outbound" AND createdAt >= now - days`
 *   - Ordre DESC par `createdAt`
 *   - Mapping `sentAt = msg.sentAt ?? msg.createdAt`
 *   - Conversation absente → `[]` (PAS `NotFoundError`)
 *   - Doc corrompu → throw `ValidationError` au parse Zod
 *
 * SEULE différence : `tx.get(query)` au lieu de `.get()`. Pour les tests
 * sentinelles : si quelqu'un remplace `tx.get(query)` par `.get()`
 * direct (régression), la race rate-limit redevient possible.
 *
 * @param tx              Transaction Firestore ouverte par le caller
 *                        (typiquement via `withContactLock`).
 * @param conversationId  docId composite `${contactId}_${campaignId}`.
 * @param days            Largeur de fenêtre en jours. Défaut 30 (S4).
 * @param now             Référence temporelle. Défaut `new Date()`.
 *
 * @returns Liste ordonnée DESC par `createdAt`. Identique à
 *          `listRecentOutbound` côté shape.
 *
 * @throws ValidationError  si un doc message dans le résultat est
 *                          corrompu (Zod fail). La tx rollback.
 */
export async function listRecentOutboundInTx(
  tx: Transaction,
  conversationId: string,
  days: number = DEFAULT_LIST_DAYS,
  now: Date = new Date(),
): Promise<OutboundMessageRecord[]> {
  const fromTs = Timestamp.fromDate(new Date(now.getTime() - days * MS_PER_DAY));

  const query = messagesSubcollectionRef(conversationId)
    .where("direction", "==", "outbound")
    .where("createdAt", ">=", fromTs)
    .orderBy("createdAt", "desc");

  // ⚠️  `tx.get(query)` — verrouille le READ SET dans la tx parente.
  // Si refactor en `.get()` direct, la race rate-limit DETTE-001 revient.
  // Test sentinelle dans `messages.test.ts` mock `tx.get` + assert
  // `query.get` n'est PAS appelé.
  const snap = await tx.get(query);

  return snap.docs.map((doc) => {
    const msg = parseMessageOrThrow(doc.data(), conversationId, doc.id);
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
