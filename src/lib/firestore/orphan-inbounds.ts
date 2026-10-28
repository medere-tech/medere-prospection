/**
 * Collection Firestore `inbound_messages_orphans/` — persistance des SMS
 * entrants qu'aucune branche "active" ne gere (PR-NO-DROPPED-SMS).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi une collection dediee
 *
 * Avant cette PR, plusieurs branches du pipeline `process-reply` et du
 * webhook `/api/webhooks/ovh-sms` abandonnaient silencieusement un SMS
 * entrant :
 *   - contact inconnu (step 1 `resolve-contact`)
 *   - parse Zod/transport failed cote webhook (W3/W4)
 *   - `inngest.send` failed cote webhook (W5/W6)
 *
 * Dans ces cas, le PS n'a NI conv NI message auxquels rattacher le texte.
 * `conversations/{convId}/messages/` ne peut donc pas accueillir ces
 * entrants. On ouvre une collection dediee de niveau racine
 * (`inbound_messages_orphans/`) qui conserve le texte + un hash du numero
 * emetteur + le motif. Un humain examine le canal Slack
 * `SLACK_ORPHAN_LEADS_CHANNEL_ID` alimente en parallele pour decider la
 * suite (creation contact, STOP manuel, etc.).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Shape documentee
 *
 *   - `reason`        : raison d'arrivee en orphelins (enum ferme aligne
 *                       sur `InboundOnInactiveConversationReason`).
 *   - `body`          : texte du SMS tel que recu (truncate 1600 chars
 *                       pour aligner le plafond messages normal, defense
 *                       contre un payload parse_failed pathologique).
 *   - `phoneHash`     : `safePhoneHash(e164, pepper)` (prefixe `hph_`),
 *                       OPTIONNEL. Absent si le numero n'a pas pu etre
 *                       extrait (parse_failed), sinon toujours present.
 *   - `contactId`     : hubspotId OPTIONNEL (present quand on a reussi a
 *                       resoudre un contact mais sans conv a rattacher).
 *   - `conversationId`: docId composite OPTIONNEL. Pour la branche
 *                       "handed_off_no_assignee" ou on persiste bien le
 *                       message sur la conv mais on alerte en parallele
 *                       en orphelins, on garde une trace du conversationId.
 *   - `wasOptOut`     : boolean OPTIONNEL — resultat de la detection
 *                       d'opt-out appliquee cote caller (meme fonction
 *                       deterministe que la branche handed_off de PR-A).
 *   - `source`        : "process-reply" | "webhook-ovh-sms". Discriminant
 *                       pour forensic.
 *   - `receivedAt`    : `FieldValue.serverTimestamp()`. JAMAIS forge cote
 *                       application (invariant forensique miroir
 *                       `ovh_stop_callbacks/`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Idempotence
 *
 * docId deterministe via le primitif partage `_idempotent.ts` :
 *   - `tx.create` atomique.
 *   - Catch `ALREADY_EXISTS` -> retour `{ created: false }` (run perdant).
 *   - Fallback defensif : relire + comparer le champ discriminant
 *     (`idempotencyKey`) pour confirmer un doublon vrai sans avaler une
 *     erreur transiente.
 *
 * `idempotencyKey` est l'`ovhMessageId` lisible quand il existe ; sinon
 * le caller fournit un fallback (hash du payload brut pour `parse_failed`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Securite / RGPD
 *
 *   - Deny-all client via `firestore.rules` (lecture + ecriture admin SDK
 *     uniquement, miroir `audit_log/` et `ovh_stop_callbacks/`). Tests
 *     firestore-rules.
 *   - Jamais logge en clair : les callers passent par `shortFingerprint`
 *     pour les identifiants et par le logger Pino scrubber-safe.
 *   - Conservation : 3 ans max alignee sur la purge contacts inactifs
 *     (backlog `archive-stale` — a tracer dans Notion). Pas d'automatisme
 *     dans cette PR : la collection est bornee par le volume reel (quelques
 *     dizaines d'entrees par mois attendues).
 */
import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { isOptOut } from "@/lib/compliance/opt-out";
import { confirmAlreadyExistsByReread, isAlreadyExistsError } from "@/lib/firestore/_idempotent";
import { getAdminDb } from "@/lib/firestore/admin";
import { appendAuditLogTx } from "@/lib/firestore/audit-log";
import { _parseContactOrThrow, markOptedOutInTx } from "@/lib/firestore/contacts";
import { _parseConversationOrThrow } from "@/lib/firestore/conversations";
import { addInboundInTx } from "@/lib/firestore/messages";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/utils/errors";
import { hashPii, safeExternalIdHash, safePhoneHash } from "@/lib/utils/pii-detector";
import type {
  InboundOnInactiveConversationReason,
  OrphanAttachedToConversationPayload,
  OrphanDismissedPayload,
  OrphanDismissReason,
  OrphanPhoneMatch,
  OrphanReopenedPayload,
} from "@/types/audit-log";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Nom de la collection. Deny-all client via firestore.rules (defense-in-depth
 * miroir `audit_log` et `ovh_stop_callbacks`).
 */
export const ORPHAN_INBOUNDS_COLLECTION = "inbound_messages_orphans";

/**
 * Plafond du champ `body` persiste. Aligne sur le plafond `messages` (1600
 * chars = 10x 160 segments SMS GSM) pour defendre contre un payload
 * parse_failed pathologique (ex: raw body JSON de plusieurs MB).
 */
const ORPHAN_BODY_MAX_LENGTH = 1600;

// ─────────────────────────────────────────────────────────────────────────────
// Shape persiste
// ─────────────────────────────────────────────────────────────────────────────

export type OrphanInboundSource = "process-reply" | "webhook-ovh-sms";

/**
 * Enum fermé des 4 raisons qui créent EFFECTIVEMENT un document orphelin
 * (PR2c tour 1 bis — preuve par relecture code). Les 5 autres valeurs de
 * `InboundOnInactiveConversationReason` (`closed`, `opted_out`, `blocked`,
 * `handed_off_no_assignee`, `conversation_became_terminal`) ne créent
 * JAMAIS d'orphan : le SMS est stocké sur la conv terminale via
 * `_addInboundIdempotent` et l'audit `inbound_on_inactive_conversation`
 * suffit au forensic.
 *
 * On restreint le type ici pour qu'écrire une autre raison dans un doc
 * `inbound_messages_orphans/` ne compile PLUS (ancre compile-time).
 * L'enum large reste intacte dans `audit-log.ts` pour les payloads audit
 * (où les 9 raisons sont posées).
 *
 * 🔒 SENTINELLE — toute évolution de cette union doit être croisée avec
 * les sites d'appel réels de `addOrphanInboundIdempotent` prouvés en
 * tour 1 bis (4 call sites).
 */
export type OrphanInboundReason = Extract<
  InboundOnInactiveConversationReason,
  "no_conversation" | "unknown_contact" | "parse_failed" | "enqueue_failed"
>;

/**
 * Phase du doc orphan dans le workflow admin (PR2c tour 2a). Posé par
 * UNIQUEMENT par la fonction d'écriture, jamais côté caller.
 *
 *   - `"pending"`   : état initial à la création. Visible dans la file.
 *   - `"attached"`  : un admin a rattaché l'orphan à une conversation
 *                     existante. Le SMS vit maintenant dans
 *                     `conversations/{convId}/messages/{msgId}` ET l'orphan
 *                     reste APPEND-ONLY (pas de suppression — forensic
 *                     L.34-5 CPCE).
 *   - `"dismissed"` : un admin a fermé l'orphan sans rattachement
 *                     (ex. spam, expéditeur non identifiable). Peut être
 *                     remis en `"pending"` via `reopenOrphan`.
 */
export type OrphanProcessingState = "pending" | "attached" | "dismissed";

/**
 * Shape complete d'un doc `inbound_messages_orphans/`. `receivedAt` est
 * `FieldValue.serverTimestamp()` a l'ecriture mais Firestore le re-materialise
 * en `Timestamp` a la lecture — on tient la forme lue pour les tests
 * emulator.
 */
export interface OrphanInboundDoc {
  reason: OrphanInboundReason;
  body: string;
  idempotencyKey: string;
  source: OrphanInboundSource;
  phoneHash?: string;
  contactId?: string;
  conversationId?: string;
  wasOptOut?: boolean;
  receivedAt: Timestamp;
  /**
   * État de workflow — défaut `"pending"` posé par l'unique fonction
   * d'écriture `addOrphanInboundIdempotent`. Jamais modifié directement
   * par les callers : passer par les transitions `attachOrphanToConversation`,
   * `dismissOrphan`, `reopenOrphan` (toutes trois `tx.update` atomiques).
   */
  processingState: OrphanProcessingState;
  /**
   * `true` ssi le doc a été posé par `scripts/seed-e2e-orphans.mjs`.
   * Posé par l'unique fonction d'écriture quand l'input l'exige. Côté
   * API lecture : fail-closed — seuls les comptes `testAccount` voient
   * ces docs, jamais un utilisateur réel.
   */
  isTestFixture: boolean;
  /**
   * Posé par `attachOrphanToConversation` DANS la tx — trace la cible
   * du rattachement (append-only, le doc orphan reste pour forensic).
   */
  attachment?: {
    conversationId: string;
    messageId: string;
    phoneMatch: "match" | "mismatch" | "not_computable";
    attachedAt: Timestamp;
    attachedBy: string;
  };
  /**
   * Posé par `dismissOrphan` DANS la tx — motif figé par enum
   * `OrphanDismissReason` (jamais texte libre).
   */
  dismissal?: {
    reason: "unrelated_or_spam" | "already_handled_elsewhere" | "sender_not_identifiable";
    dismissedAt: Timestamp;
    dismissedBy: string;
  };
}

/**
 * Shape d'entree de `addOrphanInboundIdempotent`.
 *
 * `idempotencyKey` est OBLIGATOIRE : c'est elle qui derive le docId
 * (`safeExternalIdHash(idempotencyKey)`, prefixe `oih_` + chunking).
 * Les callers fournissent :
 *   - l'`ovhMessageId` quand il est lisible ;
 *   - un fallback deterministe (hash du payload brut) pour `parse_failed`.
 *
 * ⚠️ PR2c tour 2a — `reason` restreint aux 4 valeurs réelles via
 * `OrphanInboundReason`. Impossible de compiler un caller qui tenterait
 * d'écrire un doc avec `reason: "closed"` par exemple.
 */
export interface AddOrphanInboundInput {
  reason: OrphanInboundReason;
  body: string;
  idempotencyKey: string;
  source: OrphanInboundSource;
  phoneHash?: string;
  contactId?: string;
  conversationId?: string;
  wasOptOut?: boolean;
  /**
   * `true` ssi le caller est le seed e2e (`scripts/seed-e2e-orphans.mjs`).
   * Défaut : `false`. Les écritures prod (process-reply / webhook) ne
   * passent JAMAIS ce flag — défense en profondeur contre un leak
   * accidentel de fixture.
   */
  isTestFixture?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

function validateInputOrThrow(input: AddOrphanInboundInput): void {
  if (input.idempotencyKey.length === 0) {
    throw new ValidationError({
      message: "addOrphanInboundIdempotent: idempotencyKey must be non-empty",
      context: { op: "addOrphanInboundIdempotent", reason: input.reason },
    });
  }
  if (input.body.length === 0) {
    // Un body vide est accepte seulement pour `enqueue_failed` ou
    // `parse_failed` (le payload brut peut etre vide dans certains cas de
    // transport corrompu). On throw pour tout autre reason.
    const allowEmptyBody = input.reason === "enqueue_failed" || input.reason === "parse_failed";
    if (!allowEmptyBody) {
      throw new ValidationError({
        message: "addOrphanInboundIdempotent: body must be non-empty for this reason",
        context: {
          op: "addOrphanInboundIdempotent",
          reason: input.reason,
        },
      });
    }
  }
}

/**
 * Tronque le body au plafond `ORPHAN_BODY_MAX_LENGTH` (defense anti-write
 * pathologique). Les cas normaux (SMS) ont un body <= 1600 chars par
 * construction OVH, donc aucune troncature observable. Les cas parse_failed
 * recoivent un payload brut potentiellement enorme (JSON) qu'on borne pour
 * eviter d'exploser Firestore.
 */
function truncateBody(body: string): string {
  if (body.length <= ORPHAN_BODY_MAX_LENGTH) return body;
  return body.slice(0, ORPHAN_BODY_MAX_LENGTH);
}

// ─────────────────────────────────────────────────────────────────────────────
// API publique
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persiste un SMS entrant orphelin de maniere idempotente.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Comportement sur duplicate
 *
 *   Si le doc existe deja (= 2e run concurrent, OU retry Inngest apres un
 *   succes commit) :
 *     1. La tx throw `ALREADY_EXISTS` (code gRPC 6 OU string "already-exists").
 *     2. On relit le doc pour obtenir le docId (= docId deterministe).
 *     3. On retourne `{ docId, created: false }`.
 *     4. AUCUN effet de bord additionnel : le caller aiguillera vers une
 *        branche "already notified" sans re-poster de notif Slack.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pas d'audit pose ici
 *
 * Le pipeline caller pose son audit `inbound_on_inactive_conversation`
 * SEPAREMENT via `appendAuditLogTx` (meme tx si possible). Cette fonction
 * ne gere QUE la persistance du contenu orphelin — forensic L.34-5 CPCE
 * + anti-perte stricte.
 *
 * @returns `{ docId, created }` ou `created=false` signifie que le doc
 *          existait deja (run perdant d'une race ou retry apres commit).
 *
 * @throws ValidationError  si `idempotencyKey` vide ou `body` vide
 *                          (sauf parse_failed / enqueue_failed).
 */
export async function addOrphanInboundIdempotent(
  input: AddOrphanInboundInput,
): Promise<{ docId: string; created: boolean }> {
  validateInputOrThrow(input);

  const docId = safeExternalIdHash(input.idempotencyKey);
  const docRef = getAdminDb().collection(ORPHAN_INBOUNDS_COLLECTION).doc(docId);

  // Shape stricte : on NE met pas de champ `undefined` dans Firestore
  // (ca ferait un merge comportemental inattendu avec `merge: true` futur).
  const data: Record<string, unknown> = {
    reason: input.reason,
    body: truncateBody(input.body),
    idempotencyKey: input.idempotencyKey,
    source: input.source,
    receivedAt: FieldValue.serverTimestamp(),
    // PR2c tour 2a — défauts posés par CETTE fonction uniquement.
    processingState: "pending" as const,
    isTestFixture: input.isTestFixture === true,
  };
  if (input.phoneHash !== undefined) data.phoneHash = input.phoneHash;
  if (input.contactId !== undefined) data.contactId = input.contactId;
  if (input.conversationId !== undefined) data.conversationId = input.conversationId;
  if (input.wasOptOut !== undefined) data.wasOptOut = input.wasOptOut;

  try {
    await getAdminDb().runTransaction(async (tx) => {
      // ATOMIQUE — Firestore refuse ALREADY_EXISTS si un autre run a deja
      // commit avec ce meme docId.
      tx.create(docRef, data);
    });
    return { docId, created: true as const };
  } catch (err) {
    if (isAlreadyExistsError(err)) {
      return { docId, created: false as const };
    }
    // Fallback defensif (cf. `_idempotent.ts`). Confirme un ALREADY_EXISTS
    // masque par relecture du champ discriminant `idempotencyKey`. Si
    // match -> `created:false` ; sinon re-throw.
    const confirmed = await confirmAlreadyExistsByReread(docRef, {
      expectedField: "idempotencyKey",
      expectedValue: input.idempotencyKey,
    });
    if (confirmed) {
      return { docId, created: false as const };
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// listOrphanInbounds (VUE-CONVERSATION PR0) — pagination cursor + filtre reason
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Nombre d'orphelins par page par défaut (`limit` omis). Aligné sur
 * `LIST_CONTACTS_DEFAULT_LIMIT` : 50 lignes = bonne densité TanStack Table.
 */
export const LIST_ORPHAN_INBOUNDS_DEFAULT_LIMIT = 50;

/**
 * Plafond strict sur `limit` — anti-DoS Firestore quota. Même seuil que
 * `LIST_CONTACTS_MAX_LIMIT` (cf. `contacts.ts:731` pour le raisonnement).
 */
export const LIST_ORPHAN_INBOUNDS_MAX_LIMIT = 100;

/**
 * Filtres passables à `listOrphanInbounds`. Whitelist stricte :
 *   - `reason`           : enum fermé aligné `OrphanInboundReason` (4 vals).
 *                          Omis → tous les motifs.
 *   - `source`           : discriminant process-reply vs webhook. Omis → les deux.
 *   - `processingState`  : filtre sur l'état workflow (PR2c tour 2a).
 *                          Omis → tous les états.
 */
export interface ListOrphanInboundsFilters {
  reason?: OrphanInboundReason;
  source?: OrphanInboundSource;
  processingState?: OrphanProcessingState;
}

/** Input typé du caller. Tous les champs sont optionnels. */
export interface ListOrphanInboundsInput {
  filters?: ListOrphanInboundsFilters;
  limit?: number;
  /** docId `oih_...` du dernier doc de la page précédente. */
  cursor?: string;
  /**
   * PR2c tour 2a — par défaut (false), les docs `isTestFixture: true`
   * sont EXCLUS de la réponse (fail-closed strict). Un caller admin
   * `testAccount` doit passer explicitement `true` pour les inclure.
   */
  includeTestFixtures?: boolean;
}

/** Sortie typée. Même shape que `ListContactsOutput`. */
export interface ListOrphanInboundsOutput {
  orphans: Array<OrphanInboundDoc & { docId: string }>;
  /** `docId` à passer dans `input.cursor` pour la page suivante. `null` si fin. */
  nextCursor: string | null;
  /** True si une page suivante existe. */
  hasMore: boolean;
}

/**
 * Liste les SMS orphelins paginés via cursor, triés `receivedAt desc`
 * (plus récent en haut).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INDEX FIRESTORE REQUIS
 *
 *   Query sans filtres : `orderBy("receivedAt", "desc")` — index single-field
 *   automatique côté Firestore (aucune action requise).
 *
 *   Query avec filtre `reason` ou `source` : composite requis
 *   `reason + receivedAt desc` ou `source + receivedAt desc`. Ajoutés dans
 *   `firestore.indexes.json` (VUE-CONVERSATION PR0) — vérifier le déploiement
 *   via `npm run firebase:deploy:indexes`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CURSOR — pattern `startAfter(DocumentSnapshot)`
 *
 * Le cursor exposé est le `docId` opaque (`oih_...`). Réhydratation
 * server-side via `get(cursorDocId)` :
 *   - Cursor inexistant → `ValidationError` (pas de fall-through silencieux
 *     qui retournerait la page 1).
 *   - Cursor existant → `startAfter(snap)` continue après ce doc.
 *
 * Coût : 1 read supplémentaire par page.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ⚠️ PII — `body` est présent en clair dans chaque doc retourné.
 *
 * `OrphanInboundDoc.body` contient le SMS tel que reçu (texte PS). Les
 * callers UI DOIVENT :
 *   1. Ne JAMAIS logger le body via Pino/Sentry.
 *   2. Ne JAMAIS l'inclure dans un audit log payload.
 *   3. Masquer le téléphone (déjà hashé en `phoneHash` — pas affichable
 *      côté UI, utiliser le flux audité `contact_phone_accessed` si le
 *      contact est résolu).
 *
 * @throws ValidationError si input invalide (limit hors bornes, cursor absent).
 */
export async function listOrphanInbounds(
  input: ListOrphanInboundsInput = {},
): Promise<ListOrphanInboundsOutput> {
  const { filters, limit: requestedLimit, cursor } = input;

  // Validation input manuelle (pas de Zod schema — peu de champs).
  if (
    requestedLimit !== undefined &&
    (!Number.isInteger(requestedLimit) ||
      requestedLimit < 1 ||
      requestedLimit > LIST_ORPHAN_INBOUNDS_MAX_LIMIT)
  ) {
    throw new ValidationError({
      message: `listOrphanInbounds: limit must be in [1, ${LIST_ORPHAN_INBOUNDS_MAX_LIMIT}]`,
      context: { op: "listOrphanInbounds", requestedLimit },
    });
  }
  const limit = requestedLimit ?? LIST_ORPHAN_INBOUNDS_DEFAULT_LIMIT;

  let q: FirebaseFirestore.Query = getAdminDb().collection(ORPHAN_INBOUNDS_COLLECTION);

  if (filters?.processingState !== undefined) {
    q = q.where("processingState", "==", filters.processingState);
  }
  if (filters?.reason !== undefined) {
    q = q.where("reason", "==", filters.reason);
  }
  if (filters?.source !== undefined) {
    q = q.where("source", "==", filters.source);
  }
  // PR2c tour 2a — fail-closed sur isTestFixture : par défaut on EXCLUT
  // les fixtures de la réponse. Les caller admin `testAccount` passent
  // explicitement `includeTestFixtures: true` (API route le dérive du
  // claim JWT, jamais du query param client).
  if (input.includeTestFixtures !== true) {
    q = q.where("isTestFixture", "==", false);
  }
  q = q.orderBy("receivedAt", "desc");

  if (cursor !== undefined) {
    const cursorSnap = await getAdminDb().collection(ORPHAN_INBOUNDS_COLLECTION).doc(cursor).get();
    if (!cursorSnap.exists) {
      throw new ValidationError({
        message: "listOrphanInbounds: cursor refers to a non-existent orphan doc",
        context: { op: "listOrphanInbounds", cursorPresent: true },
      });
    }
    q = q.startAfter(cursorSnap);
  }

  // Fetch limit+1 pour détecter `hasMore` en 1 round-trip (pattern listContacts).
  const snap = await q.limit(limit + 1).get();
  const docs = snap.docs;
  const hasMore = docs.length > limit;
  const slice = hasMore ? docs.slice(0, limit) : docs;

  const orphans: Array<OrphanInboundDoc & { docId: string }> = slice.map((doc) => {
    const data = doc.data() as OrphanInboundDoc;
    return { ...data, docId: doc.id };
  });

  const nextCursor = hasMore && slice.length > 0 ? (slice[slice.length - 1]?.id ?? null) : null;

  return { orphans, nextCursor, hasMore };
}

// ─────────────────────────────────────────────────────────────────────────────
// getOrphanInbound (PR2c tour 2a — détail admin)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vue serveur enrichie du docId. Retournée telle quelle à la lib ; les
 * routes API strippent `phoneHash` et `idempotencyKey` AVANT de renvoyer
 * au client.
 */
export interface OrphanInboundView extends OrphanInboundDoc {
  docId: string;
}

/**
 * Lit un doc orphan par docId. Retourne `null` si inexistant.
 * Fail-closed `isTestFixture` : si le doc est flagué fixture ET
 * `includeTestFixtures !== true`, retourne `null` (comme s'il n'existait pas).
 */
export async function getOrphanInbound(
  docId: string,
  options?: { includeTestFixtures?: boolean },
): Promise<OrphanInboundView | null> {
  if (docId.length === 0) {
    throw new ValidationError({
      message: "getOrphanInbound: docId must be non-empty",
      context: { op: "getOrphanInbound" },
    });
  }
  const snap = await getAdminDb().collection(ORPHAN_INBOUNDS_COLLECTION).doc(docId).get();
  if (!snap.exists) return null;
  const data = snap.data() as OrphanInboundDoc;
  if (data.isTestFixture === true && options?.includeTestFixtures !== true) return null;
  return { ...data, docId: snap.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// countOrphanInboundsByState (PR2c tour 2a — compteurs par état)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clé « tous » (page `/admin/orphan-inbounds`, onglet "Tous" PR2c tour 2b).
 * Agrégat strict `pending + attached + dismissed` — jamais lu depuis une
 * requête Firestore séparée pour garantir qu'il est TOUJOURS cohérent avec
 * la somme des trois états.
 */
export type OrphanCountKey = OrphanProcessingState | "all";

export type OrphanCounts = Record<OrphanCountKey, number>;

/**
 * Compte le nombre d'orphans par `processingState`. Fait 3 count queries
 * Firestore (une par état). Les compteurs sont bornés : Firestore `count()`
 * retourne un entier (pas de surcoût de lecture par doc). Le compteur `all`
 * est l'agrégat strict de ces 3 valeurs (jamais une 4e requête — garantit
 * `all === pending + attached + dismissed` sans drift possible).
 *
 * Fail-closed `isTestFixture` identique à `listOrphanInbounds` : par défaut,
 * les fixtures ne sont PAS comptées. Un caller `testAccount` les inclut.
 */
export async function countOrphanInboundsByState(options?: {
  includeTestFixtures?: boolean;
}): Promise<OrphanCounts> {
  const base = getAdminDb().collection(ORPHAN_INBOUNDS_COLLECTION);
  const states: readonly OrphanProcessingState[] = ["pending", "attached", "dismissed"];
  const perState: Record<OrphanProcessingState, number> = {
    pending: 0,
    attached: 0,
    dismissed: 0,
  };
  await Promise.all(
    states.map(async (state) => {
      let q: FirebaseFirestore.Query = base.where("processingState", "==", state);
      if (options?.includeTestFixtures !== true) {
        q = q.where("isTestFixture", "==", false);
      }
      const snap = await q.count().get();
      perState[state] = snap.data().count;
    }),
  );
  return {
    ...perState,
    all: perState.pending + perState.attached + perState.dismissed,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Transitions `pending → attached | dismissed` et `dismissed → pending`.
// Toutes les trois sont ATOMIQUES via `runTransaction`. Un double-clic ou
// deux admins en concurrence donnent UN SEUL effet (le premier passe, le
// second lève `ConflictError` sans effet de bord).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute phoneMatch entre l'orphan et un contact. Comparaison déterministe
 * `safePhoneHash(contact.phone.e164)` vs `orphan.phoneHash`. Si l'un des
 * deux manque → `"not_computable"`.
 *
 * @internal — exposé pour tests.
 */
export function computePhoneMatch(
  orphanPhoneHash: string | undefined,
  contactPhoneE164: string | undefined,
): OrphanPhoneMatch {
  if (
    orphanPhoneHash === undefined ||
    orphanPhoneHash.length === 0 ||
    contactPhoneE164 === undefined ||
    contactPhoneE164.length === 0
  ) {
    return "not_computable";
  }
  const contactPhoneHash = safePhoneHash(contactPhoneE164, hashPii);
  return contactPhoneHash === orphanPhoneHash ? "match" : "mismatch";
}

/**
 * Erreur spécifique levée quand une transition tente de passer un orphan
 * depuis un état incompatible (ex: `attached → attached`). Le caller
 * (API route) remonte `409 Conflict` pour que le dashboard affiche un
 * message explicite plutôt qu'un échec générique.
 */
export class OrphanProcessingStateConflict extends ConflictError {
  constructor(args: { expectedState: OrphanProcessingState; actualState: OrphanProcessingState }) {
    super({
      message: `orphan processingState transition rejected: expected "${args.expectedState}", got "${args.actualState}"`,
      context: { expectedState: args.expectedState, actualState: args.actualState },
      clientMessage: "Action impossible : cet orphelin est déjà dans un autre état.",
    });
  }
}

/**
 * Garde fail-closed PR2c tour 2b bloc B (post security-reviewer R-1).
 *
 * Les previews et la prod partagent la MÊME base Firestore. Pour éviter
 * qu'un compte réel agisse sur un doc test (ou l'inverse), chaque
 * transition de mutation (`attach` / `dismiss` / `reopen`) exige que
 * `orphan.isTestFixture === actorTestAccount`. Tout mismatch → cette
 * erreur ; rien n'est écrit (la tx throw AVANT tout write).
 *
 * Côté client, elle apparaît comme un 403 avec un message générique
 * (fail-closed : jamais confirmer l'existence d'un doc test à un
 * compte réel).
 */
export class OrphanTestFixtureMismatchError extends ForbiddenError {
  constructor(args: { orphanIsTestFixture: boolean; actorIsTestAccount: boolean }) {
    super({
      message: `orphan isTestFixture=${args.orphanIsTestFixture} does not match actor testAccount=${args.actorIsTestAccount}`,
      context: {
        orphanIsTestFixture: args.orphanIsTestFixture,
        actorIsTestAccount: args.actorIsTestAccount,
      },
      // Message volontairement neutre (pas de confirmation d'existence).
      clientMessage: "Action non autorisée sur cet orphelin.",
    });
  }
}

/**
 * Guard interne — à appeler immédiatement après la lecture de l'orphan
 * dans chaque transaction (`attach` / `dismiss` / `reopen`). Vérifie
 * l'isolation stricte test ↔ réel. Un compte réel n'écrit JAMAIS sur
 * une fixture ; un compte test n'écrit JAMAIS sur un doc réel.
 */
function assertActorMatchesOrphanFixture(
  orphan: OrphanInboundDoc,
  actorTestAccount: boolean,
): void {
  const orphanIsFixture = orphan.isTestFixture === true;
  if (orphanIsFixture !== actorTestAccount) {
    throw new OrphanTestFixtureMismatchError({
      orphanIsTestFixture: orphanIsFixture,
      actorIsTestAccount: actorTestAccount,
    });
  }
}

/**
 * ATTACH — rattache un orphan à une conversation EXISTANTE. Jamais de
 * création de conversation (le caller UI valide d'abord que la conv
 * existe). Léa n'est jamais déclenchée (aucun event Inngest).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Dans la transaction (tout ou rien) :
 *   1. Lire le doc orphan → vérifier `processingState === "pending"`.
 *      Sinon throw `OrphanProcessingStateConflict`.
 *   2. Lire le doc conversation ciblé → vérifier existence.
 *   3. Lire le doc contact ciblé (optionnel pour phoneMatch).
 *   4. Compute `phoneMatch` serveur-side via `safePhoneHash`.
 *   5. Créer `conversations/{convId}/messages/{deterministicMsgId}` avec
 *      `attachedFromOrphan: { orphanId, phoneMatch }`. Idempotence via
 *      docId déterministe dérivé de l'orphan — un double-clic retombe
 *      sur `ALREADY_EXISTS` et sort proprement.
 *   6. Update le doc orphan : `processingState: "attached"` +
 *      `attachment: { conversationId, messageId, phoneMatch, attachedAt,
 *      attachedBy }`.
 *   7. Append audit `orphan_attached_to_conversation` dans la MÊME tx.
 *
 * Hors transaction (best-effort, orchestrés par le caller API) :
 *   - Détection opt-out via `isOptOut` sur le body → markOptedOut (sa
 *     propre transaction).
 *   - Notification Slack du titulaire s'il y en a un + routage testAccount.
 *
 * `body` vide est REFUSÉ : impossible de rattacher un orphan sans texte
 * (`parse_failed` avec payload illisible notamment — l'admin dismiss à la
 * place).
 */
export interface AttachOrphanInput {
  orphanDocId: string;
  conversationId: string;
  attachedBy: string;
  /**
   * PR2c tour 2b — réponse OBLIGATOIRE de l'admin à la question
   * « Ce SMS demande-t-il l'arrêt des sollicitations ? ». Sans valeur
   * par défaut : le body Zod côté route force la présence.
   *
   * Règle serveur (NON négociable) :
   *   - Si `isOptOut(orphan.body)` retourne `true` → opt-out appliqué,
   *     quelle que soit la valeur de `optOutConfirmed`. Un client NE
   *     PEUT JAMAIS annuler un STOP détecté (invariant L.34-5 CPCE).
   *   - Sinon `optOutConfirmed === true` → opt-out appliqué.
   *   - Sinon → pas d'opt-out.
   *
   * `optOutDecision` dans l'audit discrimine `"detector"` / `"admin_yes"` /
   * `"admin_no"`.
   */
  optOutConfirmed: boolean;
  /**
   * PR2c tour 2b bloc B (post R-1) — isolation stricte test ↔ réel.
   * `true` ssi l'acteur Clerk porte le claim `testAccount`. La tx
   * refuse (`OrphanTestFixtureMismatchError`) si `orphan.isTestFixture
   * !== actorTestAccount`. Previews et prod partagent la base — sans
   * cette garde, un admin réel pourrait muter un doc fixture
   * (ou l'inverse). Les routes POST posent la valeur depuis
   * `ctx.testAccount`, jamais depuis le body client.
   */
  actorTestAccount: boolean;
}

export interface AttachOrphanResult {
  messageId: string;
  contactId: string;
  phoneMatch: OrphanPhoneMatch;
  body: string;
  wasOptOut: boolean;
  optOutDecision: "detector" | "admin_yes" | "admin_no";
  isTestFixture: boolean;
  /**
   * Slack user ID du titulaire si `conversation.handoff.assignedTo` défini,
   * sinon `undefined`. L'orchestration de la notif (titulaire vs canal
   * orphelins vs test) vit DANS LE CALLER (route API). Ici on expose
   * juste ce que la tx a lu.
   */
  assignedToSlackUserId: string | undefined;
}

/**
 * Rattache un orphan à une conversation EXISTANTE dans UNE SEULE
 * transaction atomique. TOUT ou RIEN :
 *   - lecture orphan (guard `pending`) + conv + contact
 *   - calcul `phoneMatch` serveur-side
 *   - calcul `isOptOut(orphan.body)` SERVEUR-SIDE (jamais depuis le client)
 *   - création message via `addInboundInTx` (bump conv counters +
 *     lastInboundAt + lastMessageAt + preview + audit `sms_received`)
 *   - update orphan `processingState: "attached"` + `attachment{}`
 *   - si STOP → `markOptedOutInTx` DANS LA MÊME TX
 *   - audit `orphan_attached_to_conversation`
 *
 * Si quoi que ce soit panne entre deux étapes de la tx, Firestore rollback
 * TOUT : impossible de laisser un orphan `attached` sans opt-out appliqué.
 *
 * Léa (Inngest) n'est jamais déclenchée. Double-clic → `ALREADY_EXISTS`
 * sur `tx.create` du message → tx abort → caller sort proprement.
 *
 * `contactId` dérivé de la conv (`conversation.contactId`) — le body de
 * la route API ne porte PAS cette valeur (invariant anti-tamper client).
 */
export async function attachOrphanToConversation(
  input: AttachOrphanInput,
): Promise<AttachOrphanResult> {
  if (input.orphanDocId.length === 0 || input.conversationId.length === 0) {
    throw new ValidationError({
      message: "attachOrphanToConversation: orphanDocId and conversationId must be non-empty",
      context: { op: "attachOrphanToConversation" },
    });
  }
  if (input.attachedBy.length === 0) {
    throw new ValidationError({
      message: "attachOrphanToConversation: attachedBy must be non-empty",
      context: { op: "attachOrphanToConversation" },
    });
  }

  const db = getAdminDb();
  const orphanRef = db.collection(ORPHAN_INBOUNDS_COLLECTION).doc(input.orphanDocId);
  const convRef = db.collection("conversations").doc(input.conversationId);
  // ID déterministe dérivé de l'orphanDocId → idempotence sur double-clic.
  const deterministicMessageId = safeExternalIdHash(input.orphanDocId);

  return await db.runTransaction(async (tx) => {
    // ─── ALL READS FIRST (règle Firestore : reads AVANT writes) ──────
    const orphanSnap = await tx.get(orphanRef);
    if (!orphanSnap.exists) {
      throw new NotFoundError({
        message: "orphan not found",
        context: { orphanDocId: input.orphanDocId },
      });
    }
    const orphan = orphanSnap.data() as OrphanInboundDoc;

    // Garde R-1 : isolation test ↔ réel. On vérifie AVANT la garde
    // d'état pour qu'un compte réel ne découvre pas via le message
    // d'erreur qu'un orphan fixture existe à cet id.
    assertActorMatchesOrphanFixture(orphan, input.actorTestAccount);

    if (orphan.processingState !== "pending") {
      throw new OrphanProcessingStateConflict({
        expectedState: "pending",
        actualState: orphan.processingState,
      });
    }
    if (orphan.body.length === 0) {
      throw new ValidationError({
        message: "attachOrphanToConversation: orphan body is empty",
        context: { orphanDocId: input.orphanDocId, reason: orphan.reason },
        clientMessage:
          "Impossible de rattacher un orphelin sans texte. Marquez-le traité à la place.",
      });
    }

    const convSnap = await tx.get(convRef);
    if (!convSnap.exists) {
      throw new NotFoundError({
        message: "conversation not found",
        context: { conversationId: input.conversationId },
      });
    }
    const conv = _parseConversationOrThrow(convSnap.data(), input.conversationId);
    const contactId = conv.contactId;
    const assignedToSlackUserId = conv.handoff?.assignedTo;

    // PR2c tour 2b correction A2 : refus typé si la conv n'a pas de contact.
    if (contactId.length === 0) {
      throw new ValidationError({
        message: "attachOrphanToConversation: conversation has no contact",
        context: { conversationId: input.conversationId },
        clientMessage:
          "Impossible de rattacher : la conversation ciblée n'a pas de médecin associé.",
      });
    }

    const contactRef = db.collection("contacts").doc(contactId);
    const contactSnap = await tx.get(contactRef);
    if (!contactSnap.exists) {
      throw new ValidationError({
        message: "attachOrphanToConversation: contact missing for conv.contactId",
        context: { conversationId: input.conversationId, contactId },
        clientMessage:
          "Impossible de rattacher : le médecin associé à la conversation est introuvable.",
      });
    }
    const contact = _parseContactOrThrow(contactSnap.data(), contactId);
    const contactE164 = contact.phone?.e164;
    const phoneMatch = computePhoneMatch(orphan.phoneHash, contactE164);

    // PR2c tour 2b correction A1 : opt-out décision mixte.
    //   - détecteur serveur-side (court-forme) prime toujours — un client
    //     NE PEUT JAMAIS annuler un STOP détecté (invariant L.34-5 CPCE).
    //   - sinon, `optOutConfirmed === true` depuis l'admin déclenche.
    //   - sinon pas d'opt-out.
    const detectorSaysOptOut = isOptOut(orphan.body);
    const wasOptOut = detectorSaysOptOut || input.optOutConfirmed === true;
    const optOutDecision: "detector" | "admin_yes" | "admin_no" = detectorSaysOptOut
      ? "detector"
      : input.optOutConfirmed === true
        ? "admin_yes"
        : "admin_no";
    const now = Timestamp.now();

    // ─── ALL WRITES AFTER ─────────────────────────────────────────────
    // 1) Message inbound via la fonction partagée (bump counters + preview + audit sms_received).
    //    On passe `conv` déjà lue → skip read interne.
    const inbound = await addInboundInTx(
      tx,
      input.conversationId,
      {
        body: orphan.body,
        channel: "sms",
        externalId: input.orphanDocId,
        // Omis volontairement : un orphan `parse_failed` n'a pas de numéro
        // émetteur normalisable (cf. remarque M3 security PR2c tour 2a bis).
      },
      { deterministicMessageId, now, conv },
    );

    const messageRef = db
      .collection("conversations")
      .doc(input.conversationId)
      .collection("messages")
      .doc(inbound.messageId);
    tx.update(messageRef, {
      attachedFromOrphan: { orphanId: input.orphanDocId, phoneMatch },
    });

    tx.update(orphanRef, {
      processingState: "attached" as const,
      attachment: {
        conversationId: input.conversationId,
        messageId: inbound.messageId,
        phoneMatch,
        attachedAt: now,
        attachedBy: input.attachedBy,
      },
    });

    const auditPayload: OrphanAttachedToConversationPayload = {
      orphanDocId: input.orphanDocId,
      contactId,
      conversationId: input.conversationId,
      messageId: inbound.messageId,
      reason: orphan.reason,
      phoneMatch,
      wasOptOut,
      optOutDecision,
      isTestFixture: orphan.isTestFixture === true,
    };
    appendAuditLogTx(tx, {
      actorId: input.attachedBy,
      actorType: "human",
      action: "orphan_attached_to_conversation",
      targetType: "conversation",
      targetId: input.conversationId,
      payload: auditPayload,
    });

    // Opt-out ATOMIQUE si STOP détecté. On passe le contact et la conv
    // déjà lus pour éviter un read-after-writes (markOptedOutInTx aurait
    // fait son propre tx.get). Si contact absent (parse_failed pur sans
    // contactId), on skip l'opt-out — l'orphan reste rattaché mais
    // sans flag opt-out puisqu'on n'a pas de contact cible.
    if (wasOptOut && contact !== null) {
      await markOptedOutInTx(tx, contactId, "sms", {
        conversationId: input.conversationId,
        intent: "STOP",
        now: now.toDate(),
        preReadContact: contact,
        preReadConv: conv,
      });
    }

    return {
      messageId: inbound.messageId,
      contactId,
      phoneMatch,
      body: orphan.body,
      wasOptOut,
      optOutDecision,
      isTestFixture: orphan.isTestFixture === true,
      assignedToSlackUserId,
    } satisfies AttachOrphanResult;
  });
}

/**
 * DISMISS — ferme un orphan sans rattachement. Motif figé par enum
 * `OrphanDismissReason` (pas de texte libre côté audit).
 */
export interface DismissOrphanInput {
  orphanDocId: string;
  dismissReason: OrphanDismissReason;
  dismissedBy: string;
  /** Cf. `AttachOrphanInput.actorTestAccount` — isolation stricte R-1. */
  actorTestAccount: boolean;
}

export async function dismissOrphan(input: DismissOrphanInput): Promise<void> {
  if (input.orphanDocId.length === 0 || input.dismissedBy.length === 0) {
    throw new ValidationError({
      message: "dismissOrphan: orphanDocId and dismissedBy must be non-empty",
      context: { op: "dismissOrphan" },
    });
  }

  const db = getAdminDb();
  const orphanRef = db.collection(ORPHAN_INBOUNDS_COLLECTION).doc(input.orphanDocId);

  await db.runTransaction(async (tx) => {
    const orphanSnap = await tx.get(orphanRef);
    if (!orphanSnap.exists) {
      throw new NotFoundError({
        message: "orphan not found",
        context: { orphanDocId: input.orphanDocId },
      });
    }
    const orphan = orphanSnap.data() as OrphanInboundDoc;
    // Garde R-1 : isolation test ↔ réel.
    assertActorMatchesOrphanFixture(orphan, input.actorTestAccount);
    if (orphan.processingState !== "pending") {
      throw new OrphanProcessingStateConflict({
        expectedState: "pending",
        actualState: orphan.processingState,
      });
    }

    const now = Timestamp.now();
    tx.update(orphanRef, {
      processingState: "dismissed" as const,
      dismissal: {
        reason: input.dismissReason,
        dismissedAt: now,
        dismissedBy: input.dismissedBy,
      },
    });

    const auditPayload: OrphanDismissedPayload = {
      orphanDocId: input.orphanDocId,
      reason: orphan.reason,
      dismissReason: input.dismissReason,
      isTestFixture: orphan.isTestFixture === true,
    };
    appendAuditLogTx(tx, {
      actorId: input.dismissedBy,
      actorType: "human",
      action: "orphan_dismissed",
      targetType: "message",
      targetId: input.orphanDocId,
      payload: auditPayload,
    });
  });
}

/**
 * REOPEN — remet un orphan dismissed en pending. Seule transition
 * `dismissed → pending` autorisée (pas de reopen d'un attached).
 */
export interface ReopenOrphanInput {
  orphanDocId: string;
  reopenedBy: string;
  /** Cf. `AttachOrphanInput.actorTestAccount` — isolation stricte R-1. */
  actorTestAccount: boolean;
}

export async function reopenOrphan(input: ReopenOrphanInput): Promise<void> {
  if (input.orphanDocId.length === 0 || input.reopenedBy.length === 0) {
    throw new ValidationError({
      message: "reopenOrphan: orphanDocId and reopenedBy must be non-empty",
      context: { op: "reopenOrphan" },
    });
  }

  const db = getAdminDb();
  const orphanRef = db.collection(ORPHAN_INBOUNDS_COLLECTION).doc(input.orphanDocId);

  await db.runTransaction(async (tx) => {
    const orphanSnap = await tx.get(orphanRef);
    if (!orphanSnap.exists) {
      throw new NotFoundError({
        message: "orphan not found",
        context: { orphanDocId: input.orphanDocId },
      });
    }
    const orphan = orphanSnap.data() as OrphanInboundDoc;
    // Garde R-1 : isolation test ↔ réel.
    assertActorMatchesOrphanFixture(orphan, input.actorTestAccount);
    if (orphan.processingState !== "dismissed") {
      throw new OrphanProcessingStateConflict({
        expectedState: "dismissed",
        actualState: orphan.processingState,
      });
    }

    tx.update(orphanRef, {
      processingState: "pending" as const,
      // On NE supprime PAS `dismissal` : append-only. Lecture ultérieure
      // peut encore voir le motif précédent + l'auteur du dismiss.
    });

    const auditPayload: OrphanReopenedPayload = {
      orphanDocId: input.orphanDocId,
      reason: orphan.reason,
      isTestFixture: orphan.isTestFixture === true,
    };
    appendAuditLogTx(tx, {
      actorId: input.reopenedBy,
      actorType: "human",
      action: "orphan_reopened",
      targetType: "message",
      targetId: input.orphanDocId,
      payload: auditPayload,
    });
  });
}

/** @internal exposition pour tests sentinelles. */
export const __ORPHAN_BODY_MAX_LENGTH_FOR_TESTS = ORPHAN_BODY_MAX_LENGTH;
