/**
 * Lecture + mutations atomiques sur la collection Firestore `conversations/`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * API EXPOSÉE (S6.4 — MVP) :
 *
 *   - `conversationDocId(contactId, campaignId)`
 *         → helper pur, retourne `${contactId}_${campaignId}` (cf. skill
 *           `medere-firestore-schema` l.328).
 *   - `listConversationIdsByContact(contactId)`          (PR-PER-CONTACT)
 *   - `listConversationIdsByContactInTx(tx, contactId)`  (PR-PER-CONTACT)
 *         → docIds de TOUTES les conversations d'un contact (tous statuts,
 *           sans limit) — étage 1 du fan-out qui rend le plafond rate-limit
 *           per-CONTACT au lieu de per-conversation. Cf. leur JSDoc pour
 *           les 3 différences délibérées vs `getActiveConversationByContactId`.
 *   - `getConversation(id)`
 *         → lecture validée (Zod strict, throw ValidationError si corrompu).
 *   - `incrementMessageCount(id, direction)`
 *         → bump messageCount + (outboundCount | inboundCount) + timestamps
 *           de cadence + audit log `sms_sent` | `sms_received` dans la MÊME tx.
 *   - `setHandoff(id, assignedTo, notes)`
 *         → STRICTEMENT non-idempotent : throw `ConflictError` si la
 *           conversation est déjà handed_off (cf. arbitrage Déthié S6.4 Q2).
 *   - `setConversationIntent(id, intent, options?)` (S9.2.2.1)
 *         → update intent + (optionnellement) status pour les branches
 *           INTERESSE/OBJECTION/NEUTRE du pipeline process-reply. STOP
 *           explicitement exclu (passe par `markOptedOut` étendu pour
 *           atomicité contact + conversation).
 *
 * Hors périmètre S6.4 (reportés explicitement) :
 *   - `createConversation`        → S7 (déclenchement campagne)
 *   - `closeConversation`         → S6.5+
 *   - `updateConversationStatus`  → S6.5+
 *   - `acceptHandoff`             → S6.5+ ou S6.6 (Slack interactif)
 *   - `listConversations` paginé  → S9+ (dashboard)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INVARIANTS (CNIL / RGPD) :
 *
 *   1. Toute lecture passe par `ConversationSchema.parse()`. Doc corrompu
 *      → throw `ValidationError` (pas de fallback sur données partielles).
 *
 *   2. Toute mutation est encapsulée dans `runTransaction` + `appendAuditLogTx`
 *      → atomicité conversation ↔ audit log. Si l'audit fail (ex: payload
 *      PII détecté), l'update conversation est rolled back. Pas de trou
 *      forensic possible.
 *
 *   3. `setHandoff` n'est PAS idempotent : 2 commerciaux qui prennent
 *      simultanément le même hand-off → un seul gagne, l'autre reçoit
 *      `ConflictError`. UX correcte côté Slack ("déjà pris par X"),
 *      forensic complet (2 audits = 2 tentatives auditées vs 1 silence
 *      + 1 trou).
 *
 *   4. `incrementMessageCount` audit payload = `{ direction }` UNIQUEMENT.
 *      PAS de messageId (peut être PII-leaky si construit naïvement, et
 *      traçable via la sous-collection messages en S6.5).
 *
 *   5. `setHandoff` audit payload = `{ notesLength: number }`. JAMAIS
 *      `notes` brut (commercial peut écrire "Dr Dupont 06...") même si
 *      le scrubber S6.2 le détecterait. Défense en profondeur.
 */
import {
  type DocumentReference,
  type QueryDocumentSnapshot,
  type QuerySnapshot,
  Timestamp,
  type Transaction,
} from "firebase-admin/firestore";
import { z } from "zod";

import { getAdminDb } from "@/lib/firestore/admin";
import { appendAuditLogTx } from "@/lib/firestore/audit-log";
import { assertSlackUserId } from "@/lib/slack/slack-user-id";
import { ConflictError, InternalError, NotFoundError, ValidationError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";
import { shortFingerprint } from "@/lib/utils/short-fingerprint";
import type { Conversation, ConversationStatus, Intent } from "@/types/conversation";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes & helper public
// ─────────────────────────────────────────────────────────────────────────────

const CONVERSATIONS_COLLECTION = "conversations";

const HANDOFF_NOTES_MIN_LENGTH = 10;

/**
 * 🔒 Seuil d'ALERTE (pas de troncature) du fan-out conversations d'un
 * contact — `listConversationIdsByContact{,InTx}` (PR-PER-CONTACT).
 *
 * Au-delà de ce nombre de conversations pour un même contact, on log un
 * `warn` : soit le PS a été enrôlé dans un nombre anormal de campagnes,
 * soit un bug d'orchestration crée des conversations en boucle. Dans les
 * deux cas ça mérite un œil humain.
 *
 * ⚠️ CE SEUIL NE TRONQUE RIEN — et ne doit JAMAIS le faire. Un `limit()`
 * sur le fan-out produirait un SOUS-COMPTAGE du plafond L.34-5 CPCE
 * (des sollicitations réelles invisibles au rate-limit) — c'est-à-dire
 * une infraction silencieuse, exactement le contraire de ce que la
 * fonction protège. Le coût d'un fan-out large (quelques queries de plus)
 * est sans commune mesure avec celui d'un 4e SMS non détecté.
 *
 * Sentinelle test : `conversations.test.ts` vérifie qu'à N > seuil les
 * N conversations sont TOUTES retournées ET que le warn est émis.
 */
const CONVERSATION_FANOUT_WARN_THRESHOLD = 10;

/**
 * 🔒 Borne haute du fetch `getHandedOffConversationByContactId` (PR-A).
 *
 * L'invariant soft est 1-2 conv `handed_off` par contact (multi-campagne
 * reprises simultanément — rare). On alloue 10 pour absorber un cas
 * pathologique sans ramener une liste pathologique.
 */
const HANDED_OFF_FETCH_LIMIT = 10;

/**
 * 🔒 Status conversation considérés "terminaux" — refusent toute mutation
 * d'intent via `setConversationIntent` (S9.2.2.1).
 *
 *   - `handed_off` : déjà chez commercial humain. Un re-classify Claude
 *                    n'a pas à modifier l'intent — le commercial est en
 *                    charge.
 *   - `closed`     : conversation terminée explicitement.
 *   - `opted_out`  : STOP déjà appliqué. L'intent est figé à "STOP".
 *                    (Pour ré-appliquer un STOP, utiliser `markOptedOut`
 *                    étendu — pas `setConversationIntent`.)
 *   - `blocked`    : bloquée par compliance.
 *
 * Modifier ce set nécessite arbitrage Déthié + re-validation
 * compliance-auditor (impact direct sur quelles conversations peuvent
 * voir leur intent changer).
 */
const TERMINAL_CONV_STATUSES_FOR_INTENT_CHANGE: readonly ConversationStatus[] = [
  "handed_off",
  "closed",
  "opted_out",
  "blocked",
];

/**
 * 🔒 Status non-terminaux autorisés comme cible de `options.nextStatus`
 * dans `setConversationIntent`. Une transition vers un status terminal
 * (handed_off/closed/opted_out/blocked) DOIT passer par la fonction
 * dédiée (setHandoff / markOptedOut / etc.) — pas par cette voie.
 */
const NON_TERMINAL_NEXT_STATUSES: readonly ConversationStatus[] = [
  "active",
  "awaiting_reply",
  "in_dialogue",
  "qualified",
];

/**
 * 🔒 Intents acceptés par `setConversationIntent`. `STOP` est explicitement
 * EXCLU — l'opt-out passe par `markOptedOut` étendu pour garantir
 * l'atomicité contact ↔ conversation. `unknown` est exclu aussi (état
 * initial, pas une cible de mutation).
 */
const NON_STOP_INTENTS = ["INTERESSE", "OBJECTION", "NEUTRE"] as const;
type NonStopIntent = (typeof NON_STOP_INTENTS)[number];

/**
 * 🔒 SENTINELLE S9.2.1 (Q1 brief Déthié) — set des `status` considérés
 * "actifs" pour `getActiveConversationByContactId`.
 *
 * Inclusion / exclusion documentée :
 *
 *   - `active`          : conv créée, 1er SMS pas encore envoyé. INCLUS
 *                         pour fermer la race condition "inbound arrive
 *                         AVANT que send-first-sms ait mis à jour le
 *                         status à awaiting_reply" (Q1 décision Déthié).
 *   - `awaiting_reply`  : cas nominal — 1er SMS envoyé, on attend.
 *   - `in_dialogue`     : échange IA en cours, peut recevoir n-ième msg.
 *   - `qualified`       : intent positif détecté, hand-off prochain.
 *
 * Exclus :
 *
 *   - `handed_off`      : déjà chez commercial humain. Un follow-up PS
 *                         doit alerter le commercial via Slack S9.4+,
 *                         pas re-rentrer dans le pipeline IA.
 *   - `closed`          : conversation terminée.
 *   - `opted_out`       : STOP déjà reçu. Un re-STOP serait idempotent
 *                         côté markOptedOut mais déjà filtré ici.
 *   - `blocked`         : bloquée par compliance.
 *
 * Modifier ce set nécessite arbitrage Déthié + re-validation
 * compliance-auditor (impact direct sur quelles conversations reçoivent
 * un traitement automatique vs sont droppées).
 */
const ACTIVE_CONVERSATION_STATUSES: readonly ConversationStatus[] = [
  "active",
  "awaiting_reply",
  "in_dialogue",
  "qualified",
];

/**
 * Construit le docId Firestore d'une conversation : `${contactId}_${campaignId}`
 * (skill `medere-firestore-schema` l.328 — unicité contact-campagne).
 *
 * Exemples :
 *   conversationDocId("contact_abc", "campaign_xyz") → "contact_abc_campaign_xyz"
 *   conversationDocId("123456", "dentistes-idf-mai-2026") → "123456_dentistes-idf-mai-2026"
 *
 * Helper exposé pour que les callers (Inngest functions, dashboard) n'aient
 * pas à recopier le template chacun de leur côté — risque de divergence si
 * la convention change un jour.
 */
export function conversationDocId(contactId: string, campaignId: string): string {
  return `${contactId}_${campaignId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schéma Zod (validation runtime à la lecture)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `z.unknown()` pour les Timestamps : Firestore renvoie une instance de
 * classe `Timestamp` (firebase-admin). On valide la PRÉSENCE de la clé,
 * pas la forme exacte — déjà garantie par le SDK côté lecture.
 */
const TimestampLike = z.unknown();

export const ConversationHandoffSchema = z.object({
  assignedTo: z.string().min(1),
  assignedAt: TimestampLike,
  acceptedAt: TimestampLike.optional(),
  acceptedBy: z.string().optional(),
  hubspotDealId: z.string().optional(),
  notes: z.string().min(HANDOFF_NOTES_MIN_LENGTH).optional(),
});

export const ConversationSchema = z.object({
  contactId: z.string().min(1),
  campaignId: z.string().min(1),
  channel: z.enum(["sms", "whatsapp"]),
  status: z.enum([
    "active",
    "awaiting_reply",
    "in_dialogue",
    "qualified",
    "handed_off",
    "closed",
    "opted_out",
    "blocked",
  ]),
  intent: z.enum(["INTERESSE", "NEUTRE", "OBJECTION", "STOP", "unknown"]),
  messageCount: z.number().int().nonnegative(),
  outboundCount: z.number().int().nonnegative(),
  inboundCount: z.number().int().nonnegative(),
  firstMessageAt: TimestampLike.optional(),
  lastMessageAt: TimestampLike.optional(),
  lastOutboundAt: TimestampLike.optional(),
  lastInboundAt: TimestampLike.optional(),
  lastIntentChangeAt: TimestampLike.optional(),
  handoff: ConversationHandoffSchema.optional(),
  /**
   * Dénormalisation `handoff.assignedTo` racine (VUE-CONVERSATION PR0).
   * Permet `where("assignedTo", "==", null)` pour l'onglet « À traiter ».
   * Optional pour tolérer les docs legacy pré-backfill (`scripts/backfill-assigned-to.mjs`).
   * Union `string | null` : `null` explicite = pas de titulaire,
   * `string` = Slack userId, `undefined` = doc legacy à backfill.
   */
  assignedTo: z.union([z.string().min(1), z.null()]).optional(),
  nextActionAt: TimestampLike.optional(),
  nextActionType: z.enum(["followup_3d", "followup_7d", "archive", "none"]).optional(),
  followupCount: z.number().int().nonnegative(),
  summary: z.string().optional(),
  createdAt: TimestampLike,
  updatedAt: TimestampLike,
});

/** Type inféré depuis le schéma Zod. */
export type ConversationValidated = z.infer<typeof ConversationSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers internes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse + cast strict, identique au pattern `parseContactOrThrow` (S6.3).
 * ⚠️  PAS de cause: result.error — la ZodError contient les valeurs reçues
 * (potentiellement PII). Voir env.ts (sanitizeZodError) pour le pattern.
 */
function parseConversationOrThrow(raw: unknown, conversationId: string): Conversation {
  const result = ConversationSchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError({
      message: `Conversation document corrupted (${conversationId}): ${result.error.issues
        .map((i) => `${i.path.join(".")} (${i.code})`)
        .join(", ")}`,
      context: {
        conversationId,
        issues: result.error.issues.map((i) => ({
          path: i.path.join("."),
          code: i.code,
        })),
      },
    });
  }
  return result.data as Conversation;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers transactionnels partagés (S6.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrapper public de `parseConversationOrThrow` pour usage cross-module
 * dans `lib/firestore/`. Identique en sémantique au helper privé — c'est
 * juste un point d'accès stable pour `messages.ts` (et S6.6+) afin d'éviter
 * de dupliquer la logique Zod + ValidationError. NE JAMAIS faire de
 * surcouche ici : toute évolution du parsing doit rester dans
 * `parseConversationOrThrow`.
 *
 * @internal Helper inter-modules `firestore/`. NE PAS appeler depuis du
 *           code applicatif : utiliser `getConversation()` pour une
 *           lecture standalone (avec retour `null` en cas d'absence).
 */
export function _parseConversationOrThrow(raw: unknown, conversationId: string): Conversation {
  return parseConversationOrThrow(raw, conversationId);
}

/**
 * Bumpe atomiquement les compteurs de cadence d'une conversation (sans audit).
 *
 * **Helper transactionnel partagé** extrait en S6.5 pour être réutilisé par
 * `addOutbound` / `addInbound` (`lib/firestore/messages.ts`) — qui posent
 * leur propre audit `sms_sent` / `sms_received` enrichi avec `messageId` —
 * sans dupliquer la logique compteurs.
 *
 * Champs mis à jour (en une seule `tx.update`) :
 *   - `messageCount` : +1
 *   - `outboundCount` ou `inboundCount` selon `direction` : +1
 *   - `lastMessageAt`, `lastOutboundAt` | `lastInboundAt` : `now`
 *   - `firstMessageAt` : posé UNIQUEMENT si absent (cadence stable
 *     pour les jobs de relance followup_3d / followup_7d)
 *   - `updatedAt` : `now`
 *
 * **Préconditions caller (non vérifiées ici) :**
 *   1. La conversation `conv` a été lue dans `tx` et validée par
 *      `parseConversationOrThrow` au préalable.
 *   2. Le caller pose son propre audit log dans la même `tx` (pas posé
 *      ici pour permettre des payloads enrichis selon le contexte —
 *      `incrementMessageCount` posé `{direction}`, `addOutbound` posé
 *      `{direction, messageId}`).
 *
 * @internal Helper inter-modules `firestore/`. NE PAS appeler depuis du
 *           code applicatif (Inngest, API routes) : utiliser
 *           `incrementMessageCount`, `addOutbound` ou `addInbound`.
 */
export function _bumpConversationCountersTx(
  tx: Transaction,
  ref: DocumentReference,
  conv: Conversation,
  direction: "outbound" | "inbound",
  now: Timestamp,
): void {
  const isOutbound = direction === "outbound";
  const updates: Record<string, unknown> = {
    messageCount: conv.messageCount + 1,
    [isOutbound ? "outboundCount" : "inboundCount"]:
      (isOutbound ? conv.outboundCount : conv.inboundCount) + 1,
    lastMessageAt: now,
    [isOutbound ? "lastOutboundAt" : "lastInboundAt"]: now,
    updatedAt: now,
  };
  // `firstMessageAt` posé UNE SEULE FOIS — historique de cadence stable
  // pour les jobs de relance (followup_3d / followup_7d).
  if (!conv.firstMessageAt) {
    updates.firstMessageAt = now;
  }
  tx.update(ref, updates);
}

// ─────────────────────────────────────────────────────────────────────────────
// API publique
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Récupère une conversation par son docId composite.
 *
 *   - Document absent              → `null` (cas légitime, le caller
 *                                     décide si c'est une erreur dans son
 *                                     contexte — cf. arbitrage S6.3).
 *   - Document présent + Zod OK    → `Conversation`.
 *   - Document présent + Zod fail  → `throw ValidationError` (corruption).
 */
export async function getConversation(conversationId: string): Promise<Conversation | null> {
  const doc = await getAdminDb().collection(CONVERSATIONS_COLLECTION).doc(conversationId).get();
  if (!doc.exists) return null;
  return parseConversationOrThrow(doc.data(), conversationId);
}

/**
 * Détecte une erreur ALREADY_EXISTS du SDK firebase-admin sans dépendre
 * d'un import gRPC direct. Pattern identique à `contacts.ts::isAlreadyExistsError`
 * (S10.1.2.c) — gRPC code 6 OU string `"already-exists"` selon la surface API.
 *
 * Duplication assumée (vs partager via un module shared) : 10 lignes, défense
 * en profondeur, scope limité à `contacts.ts` + `conversations.ts`. Toute
 * 3ᵉ utilisation justifierait l'extraction.
 */
function isAlreadyExistsError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 6 || code === "already-exists";
}

/**
 * Récupère OU crée une conversation initiale pour un couple
 * `(contactId, campaignId)`. Idempotent par construction.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rôle métier (S10.1.4.c)
 *
 *   Posé pour la route `POST /api/admin/send-first-sms` (et futur bulk
 *   S10.1.4.d). Le handler Inngest `sendFirstSmsHandler` exige une
 *   conversation existante (`NonRetriableError("Conversation not found")`
 *   si absente, l.220-222 de `send-first-sms.ts`) — ce helper garantit la
 *   précondition avant `inngest.send`.
 *
 *   Idempotent : un re-click admin sur "Envoyer" pour le même contact ne
 *   double pas la conv ; le 2ᵉ appel retourne `created: false` et la même
 *   `conversationId`. Le caller (route) tire l'info pour décider d'auditer
 *   différemment si besoin.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * docId composite — convention projet verrouillée S6.4
 *
 *   `conversationId = conversationDocId(contactId, campaignId)`
 *                   = `${contactId}_${campaignId}`
 *
 *   Pourquoi PAS `conv.id = contactId` simple : `sendFirstSmsHandler`
 *   (Inngest), `getActiveConversationByContactId` (process-reply S9.2.1),
 *   `markOptedOut` étendu (S9.2.2.1) et 4 autres wrappers reposent sur le
 *   composite. Casser cette convention = refactor cross-cutting hors
 *   scope MVP. Cf. arbitrage A1 S10.1.4.c.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pattern atomique `ref.create()` + fallback `get()`
 *
 *   `ref.create(data)` est l'API firebase-admin WRITE-IF-NOT-EXISTS
 *   atomique côté Firestore (pas de race entre check et write). Si une
 *   conv existe déjà au moment du commit → erreur ALREADY_EXISTS, on
 *   fallback sur `getConversation()` pour retourner l'existante.
 *
 *   Race extrême (create=already + get=null = quelqu'un a supprimé entre
 *   les 2 calls) → `InternalError`. Pas un cas métier nominal.
 *
 *   Pas d'audit log posé ici — la conv créée par cette voie sera
 *   immédiatement consommée par `sendFirstSmsHandler` qui pose les audits
 *   forensic via `incrementMessageCount` + `sms_provider_dispatched`. Le
 *   caller (route admin) pose son propre `sms_send_initiated_by_admin`
 *   en amont qui contient déjà `{ contactId, campaignId }`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Valeurs initiales du document (alignées seedConversation tests +
 * `scripts/test-send-sms.mjs`) :
 *
 *   channel:        "sms"           // Phase MVP
 *   status:         "active"        // créée, en attente de 1er SMS
 *   intent:         "unknown"       // pas encore classifié
 *   messageCount:   0
 *   outboundCount:  0
 *   inboundCount:   0
 *   followupCount:  0
 *   createdAt/updatedAt: now
 *
 * @param contactId   ID Firestore du contact (= hubspotId, S6.3). Non vide.
 * @param campaignId  Slug interne de campagne (ex: "hubspot-list-200"). Non vide.
 *
 * @returns `{ conversationId, created }` :
 *           - `conversationId` : `${contactId}_${campaignId}`.
 *           - `created`        : `true` si on a créé, `false` si déjà existait.
 *
 * @throws ValidationError  si `contactId` ou `campaignId` vide.
 * @throws ValidationError  si doc existant est corrompu (Zod fail).
 * @throws InternalError    si race extrême create=ALREADY_EXISTS + get=null.
 */
export async function getOrCreateInitialConversation(
  contactId: string,
  campaignId: string,
): Promise<{ conversationId: string; created: boolean }> {
  if (typeof contactId !== "string" || contactId.length === 0) {
    throw new ValidationError({
      message: "getOrCreateInitialConversation: contactId must be a non-empty string",
      context: { op: "getOrCreateInitialConversation" },
    });
  }
  if (typeof campaignId !== "string" || campaignId.length === 0) {
    throw new ValidationError({
      message: "getOrCreateInitialConversation: campaignId must be a non-empty string",
      context: { op: "getOrCreateInitialConversation" },
    });
  }

  const conversationId = conversationDocId(contactId, campaignId);
  const ref = getAdminDb().collection(CONVERSATIONS_COLLECTION).doc(conversationId);
  const now = Timestamp.now();

  const doc: Conversation = {
    contactId,
    campaignId,
    channel: "sms",
    status: "active",
    intent: "unknown",
    messageCount: 0,
    outboundCount: 0,
    inboundCount: 0,
    followupCount: 0,
    // VUE-CONVERSATION PR0 — dénormalisation. `null` explicite (vs undefined)
    // pour permettre `where("assignedTo", "==", null)` sur l'onglet « À traiter ».
    assignedTo: null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await ref.create(doc);
    return { conversationId, created: true };
  } catch (err) {
    if (isAlreadyExistsError(err)) {
      // Idempotence : conv existe déjà. On re-fetch + valide Zod pour
      // détecter une corruption éventuelle (defense-in-depth — sinon un
      // doc corrompu serait silencieusement accepté).
      const existing = await getConversation(conversationId);
      if (existing === null) {
        // Race extrême : create=ALREADY_EXISTS mais get retourne null.
        // Quelqu'un a supprimé entre les 2 calls (TTL ? admin cleanup ?).
        // Pas un cas nominal — surface en InternalError pour alerter.
        throw new InternalError({
          message:
            "getOrCreateInitialConversation: race detected (create=ALREADY_EXISTS, get=null)",
          context: {
            op: "getOrCreateInitialConversation",
            conversationId,
          },
        });
      }
      return { conversationId, created: false };
    }
    throw err;
  }
}

/**
 * Résout `contactId → conversation active` pour le pipeline `process-reply`
 * (S9.2).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * RAISON D'ÊTRE (S9.2.1 — process-reply)
 *
 * Le webhook OVH (futur S9.6) livre l'inbound avec `{phone, body,
 * ovhMessageId}` sans `campaignId` ni `conversationId`. Après résolution
 * `phone → contactId` (S9.1 `getContactByPhone`), il reste à trouver la
 * conversation ACTIVE de ce contact (status dans
 * `ACTIVE_CONVERSATION_STATUSES`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INVARIANT UNICITÉ — defense-in-depth (Q1 brief Déthié S9.2.0)
 *
 * Invariant business : 1 contact = max 1 conversation ACTIVE à un instant
 * donné (un contact ne participe qu'à 1 campagne à la fois en MVP, et le
 * docId composite `${contactId}_${campaignId}` empêche la dup naïve dans
 * une même campagne).
 *
 * Si la query retourne :
 *
 *   - 0 doc → `null`. Caller (process-reply) drop avec audit
 *     `reply_dropped` `{reason: "no_active_conversation"}` (Q3 brief
 *     Déthié S9.2.0). Cohérent avec `getContactByPhone` qui retourne
 *     `null` pour absence légitime.
 *
 *   - 1 doc → cas nominal. Retour `{ conversationId, conversation }`.
 *
 *   - >1 doc → throw `InternalError` (`isOperational: false`). Drift
 *     d'invariant = bug d'orchestration campagne OU corruption. Le
 *     pipeline doit arrêter et alerter — pas continuer avec un choix
 *     arbitraire qui enverrait la réponse dans la mauvaise conv.
 *     Pattern identique à `getContactByPhone` (S9.1).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INDEX FIRESTORE COMPOSITE REQUIS (S9.2.1)
 *
 * La query combine 1 `where` égalité + 1 `where` IN → Firestore exige
 * un index composite. Déclaré dans `firestore.indexes.json` (S9.2.1) :
 *
 *   { "collectionGroup": "conversations", "queryScope": "COLLECTION",
 *     "fields": [
 *       { "fieldPath": "contactId", "order": "ASCENDING" },
 *       { "fieldPath": "status", "order": "ASCENDING" }
 *     ] }
 *
 * Sans déploiement de cet index, la query throw `FAILED_PRECONDITION`.
 * Cf. `docs/firestore-indexes.md` section "Index 3".
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ⚠️ PII DOWNSTREAM — responsabilité du caller
 *
 * Le retour `{ conversationId, conversation }` ne contient pas de PII
 * directe (pas de phone, pas de email). Mais :
 *
 *   - `conversationId = ${contactId}_${campaignId}` est un identifiant
 *     traçable. Acceptable en logs/audits par construction (scrubber-safe).
 *
 *   - `conversation.summary` peut contenir des éléments quasi-identifiants
 *     (mention de cabinet, ville) si l'IA en a inséré. Le caller NE doit
 *     PAS logger ni inclure `conversation.summary` dans un audit sans
 *     re-validation prompt-engineer (le prompt actuel l'interdit, mais
 *     defense-in-depth).
 *
 *   - `conversation.handoff.notes` peut contenir des notes commerciales
 *     avec PII. Idem, NE PAS logger.
 *
 * @param contactId  ID Firestore du contact (= hubspotId, S6.3). NON vide.
 *
 * @returns `{ conversationId, conversation }` si trouvée, sinon `null`.
 *
 * @throws ValidationError  si `contactId` est vide.
 * @throws InternalError    si >1 conv active trouvée (invariant cassé).
 * @throws ValidationError  si un doc trouvé est corrompu (Zod fail).
 */
export async function getActiveConversationByContactId(
  contactId: string,
): Promise<{ conversationId: string; conversation: Conversation } | null> {
  if (contactId.length === 0) {
    throw new ValidationError({
      message: "getActiveConversationByContactId: contactId is empty",
      context: { op: "getActiveConversationByContactId", inputLength: 0 },
    });
  }

  const snap = await getAdminDb()
    .collection(CONVERSATIONS_COLLECTION)
    .where("contactId", "==", contactId)
    .where("status", "in", ACTIVE_CONVERSATION_STATUSES)
    .limit(2) // limit(2) suffit pour détecter le drift invariant — économie I/O
    .get();

  if (snap.empty) {
    return null;
  }

  if (snap.size > 1) {
    throw new InternalError({
      message:
        "getActiveConversationByContactId: invariant violation — multiple active conversations for same contact",
      context: {
        op: "getActiveConversationByContactId",
        contactId,
        count: snap.size,
      },
    });
  }

  // snap.size === 1 — cas nominal.
  const doc = snap.docs[0]!;
  const conversation = parseConversationOrThrow(doc.data(), doc.id);
  return { conversationId: doc.id, conversation };
}

// ─────────────────────────────────────────────────────────────────────────────
// getHandedOffConversationByContactId (PR-A-INBOUND-HANDED-OFF)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convertit en millisecondes la MEILLEURE preuve de récence d'un doc
 * conversation BRUT (non validé Zod), avec fallback en cascade :
 * `lastInboundAt` → `lastMessageAt` → `createdAt`. Si aucun des trois
 * n'est exploitable, retourne `0` — le doc sera relégué en fin de liste
 * mais JAMAIS exclu.
 *
 * Volontairement tolérant : cette valeur ne sert QU'À ORDONNER la liste
 * dans `getHandedOffConversationByContactId`. Elle n'entre dans AUCUNE
 * décision compliance (le routage DM dépend du doc choisi, pas de sa date).
 */
function conversationRelayTimestampMillis(doc: QueryDocumentSnapshot): number {
  const candidates = [doc.get("lastInboundAt"), doc.get("lastMessageAt"), doc.get("createdAt")];
  for (const value of candidates) {
    if (value instanceof Timestamp) return value.toMillis();
    if (value instanceof Date) return value.getTime();
  }
  return 0;
}

/**
 * Retourne LA conversation `handed_off` du contact — s'il en a une.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * RAISON D'ÊTRE (PR-A-INBOUND-HANDED-OFF)
 *
 * Jusqu'à cette PR, un SMS entrant arrivant sur une conv déjà reprise par
 * un commercial humain était silencieusement droppé par `process-reply`
 * (step 2 `resolve-conversation` ne regardait que `ACTIVE_CONVERSATION_STATUSES`
 * qui exclut `handed_off`). Conséquence : message non stocké, STOP non
 * enregistré, commercial titulaire non prévenu → trou L.34-5 CPCE + fil
 * cassé côté dashboard.
 *
 * Cette fonction fournit le fallback utilisé par le step 2 : si
 * `getActiveConversationByContactId` retourne `null`, on tente une
 * résolution ciblée sur `status: "handed_off"`. Si une conv est trouvée,
 * le pipeline bascule sur la branche "relayed-to-human" :
 *   - stockage inbound (preuve L.34-5 CPCE)
 *   - contrôle opt-out (court-forme + classifier long-forme)
 *   - DM Slack au titulaire (`handoff.assignedTo`)
 *   - PAS de generateReply, PAS de dispatch-reply-event
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ⚠️ DIFFÉRENCES vs `getActiveConversationByContactId`
 *
 *   1. **Status différent** — on cible UNIQUEMENT `handed_off`. Pas
 *      d'union, pas de `.in(...)` : égalité stricte.
 *
 *   2. **N > 1 EST TOLÉRÉ, on NE throw PAS.** Un même contact peut
 *      théoriquement avoir plusieurs conv `handed_off` (multi-campagne,
 *      reprises successives) — rare mais pas interdit par le schéma. Pour
 *      ne pas bloquer le pipeline sur une rareté, on logge un `warn` et
 *      on retourne la plus récente par `lastInboundAt ?? lastMessageAt ??
 *      createdAt`. Compliance d'abord : on continue à stocker le SMS et
 *      à relayer vers un humain plutôt que de drop.
 *
 *   3. **`.limit(10)`** — borne haute défensive pour éviter de rapatrier
 *      une liste pathologique (corruption / backfill). 10 est largement
 *      au-dessus de l'invariant soft (1-2 attendues).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INDEX FIRESTORE COMPOSITE
 *
 * La query utilise l'index composite DÉJÀ déclaré (`contactId ASC, status
 * ASC`) — même index que `getActiveConversationByContactId`. Rien à
 * déployer en plus.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * TRI EN MÉMOIRE (pas `orderBy` Firestore)
 *
 * `where(contactId==).where(status==).orderBy(lastInboundAt desc)` exigerait
 * un index composite 3-champs à déployer. On trie en mémoire sur la petite
 * liste (<= 10) — pas de nouvel index, pas de fenêtre de déploiement.
 *
 * ⚠️ PII DOWNSTREAM — mêmes règles que `getActiveConversationByContactId` :
 * `conversation.summary` et `conversation.handoff.notes` peuvent contenir
 * du quasi-PII, le caller NE doit PAS logger ni auditer ces champs.
 *
 * @param contactId  ID Firestore du contact (= hubspotId). NON vide.
 *
 * @returns `{ conversationId, conversation }` si une conv `handed_off`
 *          est trouvée (la plus récente si plusieurs), sinon `null`.
 *
 * @throws ValidationError  si `contactId` est vide ou un doc est corrompu.
 */
export async function getHandedOffConversationByContactId(
  contactId: string,
): Promise<{ conversationId: string; conversation: Conversation } | null> {
  if (contactId.length === 0) {
    throw new ValidationError({
      message: "getHandedOffConversationByContactId: contactId is empty",
      context: { op: "getHandedOffConversationByContactId", inputLength: 0 },
    });
  }

  const snap = await getAdminDb()
    .collection(CONVERSATIONS_COLLECTION)
    .where("contactId", "==", contactId)
    .where("status", "==", "handed_off")
    .limit(HANDED_OFF_FETCH_LIMIT)
    .get();

  if (snap.empty) {
    return null;
  }

  if (snap.size > 1) {
    // Invariant soft — on continue mais on trace. shortFingerprint pour
    // ne pas leaker un hubspotId numérique au scrubber Pino (cf. JSDoc
    // orderConversationIdsForFanout l.738-748).
    logger.warn(
      {
        op: "getHandedOffConversationByContactId",
        contactIdFingerprint: shortFingerprint(contactId),
        count: snap.size,
      },
      "[conversations] multiple handed_off conversations for same contact — picking most recent (soft invariant)",
    );
  }

  // Tri en mémoire : plus récent d'abord par lastInboundAt, fallback
  // lastMessageAt, fallback createdAt. Déterminisme des tests : départage
  // par docId croissant si les 3 timestamps sont égaux (quasi-impossible
  // en prod mais stable en seed de test).
  const sorted = snap.docs.slice().sort((a, b) => {
    const am = conversationRelayTimestampMillis(a);
    const bm = conversationRelayTimestampMillis(b);
    if (am !== bm) return bm - am;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const doc = sorted[0]!;
  const conversation = parseConversationOrThrow(doc.data(), doc.id);
  return { conversationId: doc.id, conversation };
}

// ─────────────────────────────────────────────────────────────────────────────
// getLatestConversationByContactId (PR-NO-DROPPED-SMS)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Borne haute defensive pour `getLatestConversationByContactId`. En pratique
 * un contact est enrole dans quelques campagnes (<= 10 attendues). On
 * rapatrie max 20 docs pour trier en memoire — pas d'`orderBy` Firestore
 * donc pas d'index composite supplementaire a deployer.
 */
const LATEST_CONV_FETCH_LIMIT = 20;

/**
 * Retourne LA conversation la plus recente d'un contact, QUEL QUE SOIT son
 * statut (y compris `closed`, `opted_out`, `blocked`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * RAISON D'ETRE (PR-NO-DROPPED-SMS, branche P3)
 *
 * Lorsque le pipeline `process-reply` ne trouve ni conv `active`
 * (`getActiveConversationByContactId`) ni conv `handed_off`
 * (`getHandedOffConversationByContactId`), la conv la plus recente du
 * contact est forcement dans un etat non-interagissant : `closed`,
 * `opted_out`, `blocked`. Avant cette PR, le SMS entrant etait silencieusement
 * droppe (`reply_dropped reason:"no_active_conversation"`). Fait prouve
 * en prod le 16/10/2026 16:57 UTC avec un PS deja desabonne (opted_out
 * depuis 16:24) qui a ecrit depuis le MEME numero : perte totale du
 * message, aucun DM, aucun audit stocke pour trace.
 *
 * Cette fonction fournit le point de reroutage : le pipeline stocke le
 * message sur la conv la plus recente via `addInboundIdempotent`
 * (idempotence stricte miroir des autres branches), applique la detection
 * d'opt-out, et notifie le titulaire (DM ou canal orphelins) sans JAMAIS
 * modifier le statut de la conv. Lea reste muette.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * DIFFERENCES vs `getActiveConversationByContactId` / `getHandedOffConversationByContactId`
 *
 *   1. **Tous les statuts** — pas de filtre `where("status", ...)`. L'egalite
 *      sur `contactId` est servie par l'index mono-champ AUTOMATIQUE de
 *      Firestore — aucun index composite a declarer.
 *
 *   2. **N > 1 TOLERE sans warn** — un contact a souvent 1-N conv (une par
 *      campagne), c'est le cas nominal. Tri `lastInboundAt ?? lastMessageAt
 *      ?? createdAt` DESC, meme helper `conversationRelayTimestampMillis`.
 *
 *   3. **`.limit(20)`** — borne defensive. En prod aucun contact n'a 20+
 *      conv, mais une donnee corrompue ou un backfill pathologique pourrait
 *      rapatrier une liste illimitee.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * TRI EN MEMOIRE (pas `orderBy` Firestore)
 *
 * Memes raisons que `getHandedOffConversationByContactId` : eviter de
 * declarer un index composite `(contactId ASC, lastInboundAt DESC)` pour
 * une liste bornee a 20.
 *
 * ⚠️ PII DOWNSTREAM — memes regles : `conversation.summary` et
 * `conversation.handoff.notes` peuvent contenir du quasi-PII, le caller
 * NE doit PAS logger ni auditer ces champs.
 *
 * @param contactId  ID Firestore du contact (= hubspotId). NON vide.
 *
 * @returns `{ conversationId, conversation }` si au moins une conv existe,
 *          sinon `null` (contact connu mais sans conversation — cas P3
 *          deporte sur la branche "no_conversation" en orphelins).
 *
 * @throws ValidationError  si `contactId` est vide ou un doc est corrompu.
 */
export async function getLatestConversationByContactId(
  contactId: string,
): Promise<{ conversationId: string; conversation: Conversation } | null> {
  if (contactId.length === 0) {
    throw new ValidationError({
      message: "getLatestConversationByContactId: contactId is empty",
      context: { op: "getLatestConversationByContactId", inputLength: 0 },
    });
  }

  const snap = await getAdminDb()
    .collection(CONVERSATIONS_COLLECTION)
    .where("contactId", "==", contactId)
    .limit(LATEST_CONV_FETCH_LIMIT)
    .get();

  if (snap.empty) {
    return null;
  }

  const sorted = snap.docs.slice().sort((a, b) => {
    const am = conversationRelayTimestampMillis(a);
    const bm = conversationRelayTimestampMillis(b);
    if (am !== bm) return bm - am;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const doc = sorted[0]!;
  const conversation = parseConversationOrThrow(doc.data(), doc.id);
  return { conversationId: doc.id, conversation };
}

// ─────────────────────────────────────────────────────────────────────────────
// listConversationIdsByContact{,InTx} (PR-PER-CONTACT) — fan-out rate-limit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extrait `lastOutboundAt` d'un doc conversation BRUT (non validé Zod) en
 * millisecondes, ou `null` si absent/inexploitable.
 *
 * Volontairement tolérant : cette valeur ne sert QU'À ORDONNER la liste
 * (confort de lecture + déterminisme des tests). Elle n'entre dans AUCUNE
 * décision compliance. Un doc dont le champ serait corrompu est donc
 * simplement rangé en fin de liste — jamais exclu.
 */
function conversationLastOutboundMillis(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return null;
}

/**
 * Mappe un `QuerySnapshot` de conversations en liste ordonnée de docIds.
 * Factorisé entre la version HORS tx et la version tx-aware pour garantir
 * une sémantique STRICTEMENT identique (sentinelle test d'alignement).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 PAS DE VALIDATION ZOD ICI — dérogation ASSUMÉE à l'invariant maison
 *
 * Toutes les autres lectures de ce module parsent le doc via
 * `parseConversationOrThrow`. Pas ici, et c'est délibéré :
 *
 *   1. On ne consomme AUCUN champ du doc pour une décision métier. Le
 *      `docId` vient de la métadonnée Firestore (`doc.id`), pas du
 *      contenu — il est valide par construction quelle que soit la
 *      santé du document.
 *
 *   2. Parser introduirait un mode de défaillance NET NÉGATIF pour la
 *      compliance : une conversation corrompue ferait throw → l'envoi
 *      entier serait bloqué, alors même que les messages de cette
 *      conversation doivent être COMPTÉS. On perdrait la disponibilité
 *      sans rien gagner en correction.
 *
 *   3. Le filet Zod reste posé là où il compte : `listRecentOutbound{,InTx}`
 *      parse CHAQUE doc message et throw `ValidationError` si corrompu.
 *      Un message illisible fait donc toujours échouer le comptage
 *      (fail-closed) — c'est le bon endroit pour cette garde.
 *
 * 🚨 CONDITION DE CADUCITÉ DE CETTE DÉROGATION — À LIRE AVANT DE MODIFIER
 *
 * Ce qui rend la dérogation sûre, c'est que cette fonction **ne peut
 * structurellement pas RETIRER une conversation du comptage** : le seul
 * champ du payload qu'elle consomme est `lastOutboundAt`, via
 * `conversationLastOutboundMillis` qui retombe sur `null` pour toute
 * valeur inattendue → la conversation est reléguée en fin de liste,
 * JAMAIS exclue. Une donnée corrompue, absente ou hostile ne peut donc
 * pas produire de sous-comptage.
 *
 * Cette garantie tombe à la SECONDE où quelqu'un ajoute ici le moindre
 * filtre, `limit()`, ou déduplication dérivé du CONTENU du doc. Dans ce
 * cas la dérogation devient caduque : remets `parseConversationOrThrow`,
 * ou déplace le filtre dans une fonction qui, elle, parse.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ORDRE — tri EN MÉMOIRE, pas `orderBy` Firestore
 *
 * `where("contactId","==",x).orderBy("lastOutboundAt","desc")` exigerait
 * un index composite `(contactId ASC, lastOutboundAt DESC)` à déployer
 * AVANT le code, sous peine de `FAILED_PRECONDITION` en prod. Or l'égalité
 * seule sur `contactId` est servie par l'index mono-champ AUTOMATIQUE de
 * Firestore — zéro index à déclarer, zéro délai de build, zéro fenêtre de
 * déploiement risquée. Comme on ne tronque JAMAIS, trier côté serveur
 * n'apporte rien : on trie les quelques docs en mémoire.
 *
 * Tri : `lastOutboundAt` DESC, conversations sans `lastOutboundAt` en
 * dernier, départage par `docId` croissant (déterminisme des tests).
 */
function orderConversationIdsForFanout(
  snap: QuerySnapshot,
  contactId: string,
  op: string,
): string[] {
  const entries = snap.docs.map((doc) => ({
    id: doc.id,
    lastOutboundMs: conversationLastOutboundMillis(doc.get("lastOutboundAt")),
  }));

  entries.sort((a, b) => {
    if (a.lastOutboundMs !== b.lastOutboundMs) {
      if (a.lastOutboundMs === null) return 1;
      if (b.lastOutboundMs === null) return -1;
      return b.lastOutboundMs - a.lastOutboundMs;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  if (entries.length > CONVERSATION_FANOUT_WARN_THRESHOLD) {
    // Signal d'anomalie, PAS une troncature (cf. JSDoc du seuil).
    //
    // 🔒 FINGERPRINT et NON `contactId` brut — deux raisons cumulées :
    //   1. Convention maison semi-PII : le hubspotId identifie UN PS
    //      précis côté CRM (cf. `hubspot/contacts.ts` qui logge déjà
    //      `hubspotIdFingerprint`). Le forensic se fait par corrélation
    //      timestamp + fingerprint côté admin.
    //   2. Le hubspotId de prod est une chaîne NUMÉRIQUE : `PHONE_REGEX`
    //      du scrubber Pino (`utils/logger.ts`, ≥ 8 chiffres) le
    //      remplacerait par `[PHONE]` — l'alerte perdrait son
    //      identifiant et deviendrait inexploitable. Vérifié.
    //
    // ⚠️ Ce warn est émis DANS la transaction pour la variante `…InTx`.
    // Le SDK Admin retry jusqu'à 5×, donc un contact en course peut le
    // faire apparaître plusieurs fois. C'est du bruit de log bénin (pas
    // un effet de bord non-rollbackable) — mais si tu branches une alerte
    // monitoring dessus, dédupliquer par `contactIdFingerprint`.
    logger.warn(
      {
        op,
        contactIdFingerprint: shortFingerprint(contactId),
        conversationCount: entries.length,
        threshold: CONVERSATION_FANOUT_WARN_THRESHOLD,
      },
      "[conversations] fan-out rate-limit inhabituellement large (aucune troncature appliquée)",
    );
  }

  return entries.map((e) => e.id);
}

/**
 * Retourne les docIds de TOUTES les conversations d'un contact, tous
 * statuts confondus, ordonnées `lastOutboundAt` DESC.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * RAISON D'ÊTRE (PR-PER-CONTACT)
 *
 * Le plafond L.34-5 CPCE vise la PERSONNE, pas la campagne. Or le docId
 * conversation est composite `${contactId}_${campaignId}` : un contact
 * enrôlé dans 2 campagnes possède 2 conversations, donc 2 sous-collections
 * `messages` distinctes. Compter le rate-limit sur UNE conversation laissait
 * un PS recevoir 2× le plafond.
 *
 * Cette fonction fournit l'étage 1 du fan-out (contact → conversations) ;
 * l'étage 2 (conversation → messages) reste `listRecentOutbound` inchangé.
 * Composé par `listRecentOutboundByContact` (`messages.ts`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ⚠️ DIFFÉRENCES DÉLIBÉRÉES vs `getActiveConversationByContactId`
 *
 *   1. **TOUS LES STATUTS** — surtout PAS `ACTIVE_CONVERSATION_STATUSES`.
 *      Une conversation `closed`, `opted_out`, `handed_off` ou `blocked`
 *      porte des sollicitations RÉELLEMENT ENVOYÉES : elles dérangent le
 *      PS au sens L.34-5 CPCE et comptent donc dans la fenêtre 30j. Filtrer
 *      sur les statuts actifs rouvrirait exactement le trou qu'on ferme.
 *
 *   2. **N > 1 EST NORMAL, on ne throw PAS.** `getActiveConversationByContactId`
 *      throw `InternalError` si >1 car son invariant métier est "1 seule
 *      conversation ACTIVE à la fois". Ici on veut au contraire l'historique
 *      complet multi-campagnes — plusieurs docs sont le cas nominal.
 *
 *   3. **AUCUN `limit()`.** Cf. JSDoc `CONVERSATION_FANOUT_WARN_THRESHOLD` :
 *      tronquer = sous-compter = infraction silencieuse.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INDEX FIRESTORE : AUCUN à déclarer. La query n'a qu'une égalité sur un
 * seul champ (`contactId`) et aucun `orderBy` — servie par l'index
 * mono-champ automatique. Rien à ajouter dans `firestore.indexes.json`,
 * rien à déployer avant le code.
 *
 * @param contactId  ID Firestore du contact (= hubspotId). NON vide.
 * @returns docIds ordonnés. Contact sans aucune conversation → `[]`.
 * @throws ValidationError si `contactId` est vide.
 */
export async function listConversationIdsByContact(contactId: string): Promise<string[]> {
  if (contactId.length === 0) {
    throw new ValidationError({
      message: "listConversationIdsByContact: contactId is empty",
      context: { op: "listConversationIdsByContact", inputLength: 0 },
    });
  }

  const snap = await getAdminDb()
    .collection(CONVERSATIONS_COLLECTION)
    .where("contactId", "==", contactId)
    .get();

  return orderConversationIdsForFanout(snap, contactId, "listConversationIdsByContact");
}

/**
 * Version tx-aware de `listConversationIdsByContact` — utilise
 * `tx.get(query)` au lieu de `.get()`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🔒 POURQUOI `tx.get` EST INDISPENSABLE ICI
 *
 * `tx.get(query)` verrouille le READ SET dans la tx parente. Conséquence
 * directe : si une AUTRE transaction crée une nouvelle conversation pour
 * ce contact (nouvelle campagne) entre notre lecture et notre commit,
 * Firestore détecte le conflit et retry notre tx — qui relit alors la
 * liste complète. Sans ça, une conversation créée en course serait
 * invisible au comptage.
 *
 * C'est exactement la propriété sur laquelle repose déjà
 * `listRecentOutboundInTx` (cf. sa JSDoc). Même mécanique, un étage plus haut.
 *
 * ⚠️ Si quelqu'un refactorait `tx.get(query)` en `.get()` direct ici, la
 * race "nouvelle campagne pendant l'envoi" redeviendrait exploitable.
 *
 * @param tx         Transaction ouverte par le caller (typiquement
 *                   `withContactLock`).
 * @param contactId  ID Firestore du contact (= hubspotId). NON vide.
 * @returns Identique à `listConversationIdsByContact` côté shape ET ordre.
 * @throws ValidationError si `contactId` est vide.
 */
export async function listConversationIdsByContactInTx(
  tx: Transaction,
  contactId: string,
): Promise<string[]> {
  if (contactId.length === 0) {
    throw new ValidationError({
      message: "listConversationIdsByContactInTx: contactId is empty",
      context: { op: "listConversationIdsByContactInTx", inputLength: 0 },
    });
  }

  const query = getAdminDb()
    .collection(CONVERSATIONS_COLLECTION)
    .where("contactId", "==", contactId);

  // ⚠️ `tx.get(query)` — verrouille le READ SET. Cf. JSDoc ci-dessus.
  const snap = await tx.get(query);

  return orderConversationIdsForFanout(snap, contactId, "listConversationIdsByContactInTx");
}

/**
 * Incrémente atomiquement les compteurs de messages d'une conversation et
 * pose les timestamps de cadence pour `lib/compliance/rate-limits` et
 * `lib/compliance/hours`.
 *
 * Champs mis à jour (1 tx) :
 *   - `messageCount` : +1
 *   - `outboundCount` ou `inboundCount` selon `direction` : +1
 *   - `lastMessageAt`, `lastOutboundAt` | `lastInboundAt` : now
 *   - `firstMessageAt` : posé UNIQUEMENT si absent (1er message)
 *   - `updatedAt` : now
 *   - audit_log : 1 entrée `sms_sent` | `sms_received` avec
 *     `payload: { direction }` (rien d'autre — pas de messageId).
 *
 * Volume audit anticipé (à monitorer en prod, cf. arbitrage S6.4 Q1) :
 *   26k contacts × ~3 outbound + ~2 inbound = ~130k audits compteurs
 *   sur la campagne MVP complète. Coût Firestore négligeable (~0.50€).
 *
 * @throws NotFoundError    si la conversation n'existe pas.
 * @throws ValidationError  si le doc est corrompu.
 */
export async function incrementMessageCount(
  conversationId: string,
  direction: "outbound" | "inbound",
): Promise<void> {
  await getAdminDb().runTransaction(async (tx) => {
    const ref = getAdminDb().collection(CONVERSATIONS_COLLECTION).doc(conversationId);
    const doc = await tx.get(ref);
    if (!doc.exists) {
      throw new NotFoundError({
        message: `Conversation not found: ${conversationId}`,
        context: { conversationId },
      });
    }
    const conv = parseConversationOrThrow(doc.data(), conversationId);

    const now = Timestamp.now();
    _bumpConversationCountersTx(tx, ref, conv, direction, now);

    appendAuditLogTx(tx, {
      actorId: "system",
      actorType: "system",
      action: direction === "outbound" ? "sms_sent" : "sms_received",
      targetType: "conversation",
      targetId: conversationId,
      payload: { direction },
    });
  });
}

/**
 * Verrouille une conversation à un commercial humain pour suite manuelle.
 *
 * **NON idempotent** (arbitrage Déthié S6.4 Q2) : si la conversation est
 * déjà `handed_off` (ou possède un sous-objet `handoff`), throw
 * `ConflictError` — y compris si le 2e appel est avec le MÊME `assignedTo`
 * (le caller Inngest est attendu idempotent via `step.run` memoization,
 * pas la fonction Firestore).
 *
 * `notes` est obligatoire, ≥10 chars (forensic). Exemples valides :
 *   - "RDV demain"        (10)
 *   - "demande info"      (12)
 *   - "INTERESSE: RDV"    (15)
 *
 * Audit log : `payload = { notesLength: notes.length }`. JAMAIS `notes`
 * brut — risque PII si le commercial écrit un téléphone/email dedans.
 *
 * Validation `notes` faite AVANT `runTransaction` → pas d'écriture
 * Firestore si l'input est invalide.
 *
 * @throws ValidationError  si `notes.length < 10`.
 * @throws NotFoundError    si la conversation n'existe pas.
 * @throws ConflictError    si la conversation est déjà `handed_off`.
 */
export async function setHandoff(
  conversationId: string,
  assignedTo: string,
  notes: string,
): Promise<void> {
  // Fix LOW security-reviewer PR-A : regex valide le format Slack user ID
  // AVANT write Firestore. Verrou en 2 lignes de defense miroir avec le
  // check dans les senders Slack (defense-in-depth docs legacy).
  // Trade-off : on NE met PAS ce check au parse Zod de ConversationHandoffSchema
  // pour eviter de casser le pipeline sur un doc legacy non-conforme —
  // cf. JSDoc de assertSlackUserId pour le raisonnement complet.
  assertSlackUserId(assignedTo, "setHandoff");

  if (notes.length < HANDOFF_NOTES_MIN_LENGTH) {
    throw new ValidationError({
      message: `setHandoff: notes must be at least ${HANDOFF_NOTES_MIN_LENGTH} characters`,
      context: {
        conversationId,
        actualLength: notes.length,
        minRequired: HANDOFF_NOTES_MIN_LENGTH,
      },
    });
  }

  await getAdminDb().runTransaction(async (tx) => {
    const ref = getAdminDb().collection(CONVERSATIONS_COLLECTION).doc(conversationId);
    const doc = await tx.get(ref);
    if (!doc.exists) {
      throw new NotFoundError({
        message: `Conversation not found: ${conversationId}`,
        context: { conversationId },
      });
    }
    const conv = parseConversationOrThrow(doc.data(), conversationId);

    if (conv.status === "handed_off" || conv.handoff) {
      throw new ConflictError({
        message: "Conversation already handed off",
        context: {
          conversationId,
          currentAssignedTo: conv.handoff?.assignedTo ?? "unknown",
        },
      });
    }

    const now = Timestamp.now();
    tx.update(ref, {
      status: "handed_off",
      "handoff.assignedTo": assignedTo,
      "handoff.assignedAt": now,
      "handoff.notes": notes,
      // VUE-CONVERSATION PR0 — dénormalisation : écrit le champ racine
      // `assignedTo` dans la MÊME transaction que `handoff.assignedTo`.
      // Invariant : les deux valeurs doivent rester cohérentes. Permet
      // `where("assignedTo", "==", slackId)` et `where("assignedTo", "==", null)`
      // pour les onglets de la vue conversation.
      assignedTo: assignedTo,
      updatedAt: now,
    });

    appendAuditLogTx(tx, {
      actorId: assignedTo,
      actorType: "human",
      action: "handoff",
      targetType: "conversation",
      targetId: conversationId,
      // Pas `notes` brut — risque PII. Seulement la longueur comme preuve
      // forensic qu'une note a été fournie. Les notes restent lisibles
      // dans le doc conversation pour audit manuel (skill alignment).
      payload: { notesLength: notes.length },
    });
  });
}

/**
 * Met à jour `intent` (et optionnellement `status`) d'une conversation
 * pour les branches `INTERESSE` / `OBJECTION` / `NEUTRE` du pipeline
 * `process-reply` (S9.2.2).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INVARIANT — `STOP` EXCLU
 *
 * La signature TypeScript exclut `intent: "STOP"` au compile-time
 * (`NonStopIntent` = `"INTERESSE" | "OBJECTION" | "NEUTRE"` uniquement).
 * **Pour appliquer un STOP, utiliser `markOptedOut` étendu** — qui pose
 * atomiquement l'opt-out côté contact ET la synchro intent=STOP +
 * status=opted_out côté conversation dans une seule transaction.
 *
 * Cette voie séparée est volontaire : un STOP est une décision
 * juridiquement irréversible (L.34-5 CPCE) qui doit verrouiller le
 * contact ET la conversation. Une fonction `setConversationIntent` qui
 * accepterait STOP créerait un trou (update conv sans update contact →
 * désynchronisation forensique).
 *
 * Defense-in-depth : un runtime guard vérifie que l'intent reçu N'EST
 * PAS "STOP" (au cas où un caller bypasse le typage TS via `as any`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * MATRICE DE TRANSITIONS
 *
 *   - **Status courant terminal** (`handed_off`/`closed`/`opted_out`/
 *     `blocked`) → throw `ValidationError`. Ces états sont absorbants.
 *
 *   - **`options.nextStatus` fourni** → DOIT être non-terminal
 *     (`active`/`awaiting_reply`/`in_dialogue`/`qualified`). Sinon throw
 *     `ValidationError`. Une transition vers un état terminal doit
 *     passer par sa fonction dédiée (`setHandoff` / `markOptedOut`).
 *
 *   - **`options.nextStatus` omis** → on met à jour `intent` seulement,
 *     `status` reste inchangé.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * PAS D'AUDIT INTERNE
 *
 * Cette fonction NE pose PAS d'audit log elle-même — c'est le pipeline
 * orchestrateur (`process-reply` S9.2.2.2) qui pose l'audit
 * `intent_classified` avec le payload classifier complet (model,
 * promptVersion, fallback, tokens…) AVANT d'appeler cette fonction.
 *
 * Conséquence : si tu utilises cette fonction dans un contexte hors
 * pipeline, tu DOIS poser ton propre audit séparément ou justifier
 * l'absence d'audit dans le commit message.
 *
 * @param conversationId  ID Firestore composite `${contactId}_${campaignId}`.
 * @param intent          `"INTERESSE"` | `"OBJECTION"` | `"NEUTRE"`.
 *                        **PAS `"STOP"`** (compile-time + runtime guards).
 * @param options.nextStatus  Status cible non-terminal optionnel.
 * @param options.now         Référence temporelle injectable pour tests.
 *
 * @throws ValidationError  si `intent === "STOP"` (runtime bypass guard),
 *                          si le status courant est terminal, si
 *                          `nextStatus` est terminal, ou si le doc est
 *                          corrompu.
 * @throws NotFoundError    si la conversation n'existe pas.
 */
export async function setConversationIntent(
  conversationId: string,
  intent: NonStopIntent,
  options?: {
    nextStatus?: ConversationStatus;
    now?: Date;
  },
): Promise<void> {
  // Runtime guard : si quelqu'un bypasse le typage TS (`as any`) avec
  // intent="STOP", on refuse explicitement. Defense-in-depth pour un
  // invariant critique (cf. JSDoc).
  if ((intent as Intent) === "STOP" || (intent as Intent) === "unknown") {
    throw new ValidationError({
      message: `setConversationIntent refuse intent="${intent}". Utiliser markOptedOut pour STOP.`,
      context: { conversationId, intent },
    });
  }

  const nextStatus = options?.nextStatus;
  const now = options?.now;

  // Garde précoce sur nextStatus AVANT d'ouvrir la tx (économie I/O si
  // le caller a fait une erreur évidente).
  if (nextStatus !== undefined && !NON_TERMINAL_NEXT_STATUSES.includes(nextStatus)) {
    throw new ValidationError({
      message: `setConversationIntent refuse nextStatus="${nextStatus}" (status terminal). Utiliser la fonction dédiée (setHandoff/markOptedOut).`,
      context: { conversationId, nextStatus },
    });
  }

  await getAdminDb().runTransaction(async (tx) => {
    const ref = getAdminDb().collection(CONVERSATIONS_COLLECTION).doc(conversationId);
    const doc = await tx.get(ref);
    if (!doc.exists) {
      throw new NotFoundError({
        message: `Conversation not found: ${conversationId}`,
        context: { conversationId },
      });
    }
    const conv = parseConversationOrThrow(doc.data(), conversationId);

    if (TERMINAL_CONV_STATUSES_FOR_INTENT_CHANGE.includes(conv.status)) {
      throw new ValidationError({
        message: `Cannot set intent, conversation in terminal state: ${conv.status}`,
        context: {
          conversationId,
          currentStatus: conv.status,
        },
      });
    }

    const ts = now ? Timestamp.fromDate(now) : Timestamp.now();
    const updates: Record<string, unknown> = {
      intent,
      lastIntentChangeAt: ts,
      updatedAt: ts,
    };
    if (nextStatus !== undefined) {
      updates.status = nextStatus;
    }
    tx.update(ref, updates);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// listConversations* (VUE-CONVERSATION PR0) — pagination cursor + filtres
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Nombre de conversations par page par défaut. 25 lignes = densité
 * TanStack Table ergonomique pour vue conversation (plus dense que
 * `listContacts` qui est à 50 : chaque ligne porte plus d'info).
 */
export const LIST_CONVERSATIONS_DEFAULT_LIMIT = 25;

/**
 * Plafond strict sur `limit`. 100 = aligné `LIST_CONTACTS_MAX_LIMIT`.
 */
export const LIST_CONVERSATIONS_MAX_LIMIT = 100;

/**
 * Filtres passables aux fonctions `listConversations*`. Whitelist stricte :
 *   - `status`  : enum fermé `ConversationStatus`.
 *   - `intent`  : enum fermé `Intent`.
 *
 * Les filtres de plage (dates) sont volontairement OMIS du MVP VUE-CONVERSATION
 * PR0 : la query avec un `.where("lastInboundAt", ">=", ...)` + `orderBy`
 * exige un index composite spécifique par combinaison. On ajoutera à la
 * demande (PR2 UI) quand on saura quelles plages sont effectivement
 * utilisées — minimise la combinatoire d'index.
 */
const ListConversationsFiltersSchema = z.object({
  status: z
    .enum([
      "active",
      "awaiting_reply",
      "in_dialogue",
      "qualified",
      "handed_off",
      "closed",
      "opted_out",
      "blocked",
    ])
    .optional(),
  intent: z.enum(["INTERESSE", "NEUTRE", "OBJECTION", "STOP", "unknown"]).optional(),
});

export type ListConversationsFilters = z.input<typeof ListConversationsFiltersSchema>;

const ListConversationsInputSchema = z.object({
  filters: ListConversationsFiltersSchema.optional(),
  limit: z.number().int().min(1).max(LIST_CONVERSATIONS_MAX_LIMIT).optional(),
  /** docId `${contactId}_${campaignId}` opaque du dernier doc de la page précédente. */
  cursor: z.string().min(1).optional(),
});

export type ListConversationsInput = z.input<typeof ListConversationsInputSchema>;

export interface ListConversationsOutput {
  conversations: Array<Conversation & { conversationId: string }>;
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Helper interne — construit la query Firestore de base avec les filtres
 * optionnels + orderBy + cursor + limit. Factorise les 3 variantes
 * (`listConversations`, `listConversationsByAssignee`,
 * `listUnassignedConversations`).
 *
 * ⚠️ ORDERING — on trie TOUJOURS par `lastInboundAt desc`, NULLS LAST.
 * Firestore ne supporte pas `NULLS LAST` nativement : un doc sans
 * `lastInboundAt` n'apparaît PAS dans le résultat de `.orderBy(...)`. On
 * accepte cette sémantique MVP : les conversations qui n'ont pas encore
 * reçu d'inbound (`lastInboundAt === undefined`) ne figurent pas dans la
 * liste — c'est cohérent avec un dashboard « conversations avec activité ».
 */
async function buildListConversationsQuery(options: {
  filters?: ListConversationsFilters;
  limit: number;
  cursor?: string;
  assigneeFilter?:
    | { kind: "none" }
    | { kind: "specific"; slackUserId: string }
    | { kind: "unassigned" };
}): Promise<FirebaseFirestore.Query> {
  let q: FirebaseFirestore.Query = getAdminDb().collection(CONVERSATIONS_COLLECTION);

  // Filtre assignedTo d'abord (plus sélectif en général).
  const assigneeFilter = options.assigneeFilter ?? { kind: "none" };
  if (assigneeFilter.kind === "specific") {
    q = q.where("assignedTo", "==", assigneeFilter.slackUserId);
  } else if (assigneeFilter.kind === "unassigned") {
    q = q.where("assignedTo", "==", null);
  }

  if (options.filters?.status !== undefined) {
    q = q.where("status", "==", options.filters.status);
  }
  if (options.filters?.intent !== undefined) {
    q = q.where("intent", "==", options.filters.intent);
  }

  q = q.orderBy("lastInboundAt", "desc");

  if (options.cursor !== undefined) {
    const cursorSnap = await getAdminDb()
      .collection(CONVERSATIONS_COLLECTION)
      .doc(options.cursor)
      .get();
    if (!cursorSnap.exists) {
      throw new ValidationError({
        message: "listConversations: cursor refers to a non-existent conversation",
        context: { op: "listConversations", cursorPresent: true },
      });
    }
    q = q.startAfter(cursorSnap);
  }

  return q.limit(options.limit + 1);
}

/**
 * Fonction interne qui exécute la query et parse les résultats. Partagée
 * par les 3 variantes publiques.
 */
async function executeListQuery(
  q: FirebaseFirestore.Query,
  limit: number,
): Promise<ListConversationsOutput> {
  const snap = await q.get();
  const docs = snap.docs;
  const hasMore = docs.length > limit;
  const slice = hasMore ? docs.slice(0, limit) : docs;

  const conversations: Array<Conversation & { conversationId: string }> = slice.map((doc) => {
    const conv = parseConversationOrThrow(doc.data(), doc.id);
    return { ...conv, conversationId: doc.id };
  });

  const nextCursor = hasMore && slice.length > 0 ? (slice[slice.length - 1]?.id ?? null) : null;

  return { conversations, nextCursor, hasMore };
}

/**
 * Liste PAGINÉE des conversations, triées `lastInboundAt desc`. Admin
 * seulement : la vue conversation respecte le RBAC via `requireRole`
 * côté route handler (403 commercial sur onglet « Toutes »).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INDEX FIRESTORE REQUIS
 *
 *   - Query sans filtres : `orderBy("lastInboundAt", "desc")` — single-field
 *     auto.
 *   - Query filtre `status` seul : composite `status + lastInboundAt desc`.
 *   - Query filtre `intent` seul : composite `intent + lastInboundAt desc`.
 *   - Query filtre `status + intent` : composite
 *     `status + intent + lastInboundAt desc`.
 *
 * Ajoutés dans `firestore.indexes.json` (VUE-CONVERSATION PR0). Déployer
 * via `npm run firebase:deploy:indexes` avant runtime Firestore Cloud.
 *
 * @throws ValidationError si input invalide ou cursor inexistant.
 * @throws ValidationError si un doc est corrompu (Zod fail).
 */
export async function listConversations(
  input: ListConversationsInput = {},
): Promise<ListConversationsOutput> {
  const parsed = ListConversationsInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError({
      message: "listConversations: invalid input",
      context: {
        op: "listConversations",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          code: i.code,
        })),
      },
    });
  }

  const { filters, limit: requestedLimit, cursor } = parsed.data;
  const limit = requestedLimit ?? LIST_CONVERSATIONS_DEFAULT_LIMIT;

  const q = await buildListConversationsQuery({ filters, limit, cursor });
  return executeListQuery(q, limit);
}

/**
 * Liste PAGINÉE des conversations assignées à un commercial Slack
 * (`handoff.assignedTo === slackUserId`, dénormalisé racine
 * `assignedTo === slackUserId`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INDEX FIRESTORE REQUIS
 *
 *   - Query filtre `assignedTo` seul : composite
 *     `assignedTo + lastInboundAt desc`.
 *   - Query filtre `assignedTo + status` : composite
 *     `assignedTo + status + lastInboundAt desc`.
 *
 * Ajoutés dans `firestore.indexes.json` (VUE-CONVERSATION PR0).
 *
 * @throws ValidationError si input invalide, slackUserId mal formé,
 *                         ou cursor inexistant.
 */
export async function listConversationsByAssignee(
  slackUserId: string,
  input: ListConversationsInput = {},
): Promise<ListConversationsOutput> {
  assertSlackUserId(slackUserId, "listConversationsByAssignee");

  const parsed = ListConversationsInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError({
      message: "listConversationsByAssignee: invalid input",
      context: {
        op: "listConversationsByAssignee",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          code: i.code,
        })),
      },
    });
  }

  const { filters, limit: requestedLimit, cursor } = parsed.data;
  const limit = requestedLimit ?? LIST_CONVERSATIONS_DEFAULT_LIMIT;

  const q = await buildListConversationsQuery({
    filters,
    limit,
    cursor,
    assigneeFilter: { kind: "specific", slackUserId },
  });
  return executeListQuery(q, limit);
}

/**
 * Liste PAGINÉE des conversations SANS titulaire (`assignedTo === null`).
 * Alimente l'onglet « À traiter » de la vue conversation.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INDEX FIRESTORE REQUIS
 *
 *   Même composite que `listConversationsByAssignee` :
 *   `assignedTo + lastInboundAt desc` (le filtre `== null` utilise le
 *   même index que `== slackUserId`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ⚠️ CONTRAT NULL EXPLICITE
 *
 * Les docs conversation CRÉÉS APRÈS VUE-CONVERSATION PR0 ont
 * `assignedTo: null` à la création (cf. `getOrCreateInitialConversation`).
 * Les docs legacy pré-backfill ont `assignedTo === undefined` → ils
 * n'apparaissent PAS dans cette query. Le script
 * `scripts/backfill-assigned-to.mjs` doit tourner avant la mise en service
 * de l'onglet pour qu'aucun doc ne soit laissé invisible.
 *
 * @throws ValidationError si input invalide ou cursor inexistant.
 */
export async function listUnassignedConversations(
  input: ListConversationsInput = {},
): Promise<ListConversationsOutput> {
  const parsed = ListConversationsInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError({
      message: "listUnassignedConversations: invalid input",
      context: {
        op: "listUnassignedConversations",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          code: i.code,
        })),
      },
    });
  }

  const { filters, limit: requestedLimit, cursor } = parsed.data;
  const limit = requestedLimit ?? LIST_CONVERSATIONS_DEFAULT_LIMIT;

  const q = await buildListConversationsQuery({
    filters,
    limit,
    cursor,
    assigneeFilter: { kind: "unassigned" },
  });
  return executeListQuery(q, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// Exposés pour tests
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export const __CONVERSATIONS_COLLECTION_FOR_TESTS = CONVERSATIONS_COLLECTION;

/** @internal */
export const __HANDOFF_NOTES_MIN_LENGTH_FOR_TESTS = HANDOFF_NOTES_MIN_LENGTH;

/** @internal */
export const __CONVERSATION_FANOUT_WARN_THRESHOLD_FOR_TESTS = CONVERSATION_FANOUT_WARN_THRESHOLD;

/** @internal */
export const __ACTIVE_CONVERSATION_STATUSES_FOR_TESTS = ACTIVE_CONVERSATION_STATUSES;

/** @internal */
export const __TERMINAL_CONV_STATUSES_FOR_INTENT_CHANGE_FOR_TESTS =
  TERMINAL_CONV_STATUSES_FOR_INTENT_CHANGE;

/** @internal */
export const __NON_TERMINAL_NEXT_STATUSES_FOR_TESTS = NON_TERMINAL_NEXT_STATUSES;

/** @internal */
export const __NON_STOP_INTENTS_FOR_TESTS = NON_STOP_INTENTS;
