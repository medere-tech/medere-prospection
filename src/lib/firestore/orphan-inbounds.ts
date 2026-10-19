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

import { confirmAlreadyExistsByReread, isAlreadyExistsError } from "@/lib/firestore/_idempotent";
import { getAdminDb } from "@/lib/firestore/admin";
import { ValidationError } from "@/lib/utils/errors";
import { safeExternalIdHash } from "@/lib/utils/pii-detector";
import type { InboundOnInactiveConversationReason } from "@/types/audit-log";

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
 * Shape complete d'un doc `inbound_messages_orphans/`. `receivedAt` est
 * `FieldValue.serverTimestamp()` a l'ecriture mais Firestore le re-materialise
 * en `Timestamp` a la lecture — on tient la forme lue pour les tests
 * emulator.
 */
export interface OrphanInboundDoc {
  reason: InboundOnInactiveConversationReason;
  body: string;
  idempotencyKey: string;
  source: OrphanInboundSource;
  phoneHash?: string;
  contactId?: string;
  conversationId?: string;
  wasOptOut?: boolean;
  receivedAt: Timestamp;
}

/**
 * Shape d'entree de `addOrphanInboundIdempotent`.
 *
 * `idempotencyKey` est OBLIGATOIRE : c'est elle qui derive le docId
 * (`safeExternalIdHash(idempotencyKey)`, prefixe `oih_` + chunking).
 * Les callers fournissent :
 *   - l'`ovhMessageId` quand il est lisible ;
 *   - un fallback deterministe (hash du payload brut) pour `parse_failed`.
 */
export interface AddOrphanInboundInput {
  reason: InboundOnInactiveConversationReason;
  body: string;
  idempotencyKey: string;
  source: OrphanInboundSource;
  phoneHash?: string;
  contactId?: string;
  conversationId?: string;
  wasOptOut?: boolean;
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
 *   - `reason`  : enum fermé aligné `InboundOnInactiveConversationReason`.
 *                 Omis → tous les motifs.
 *   - `source`  : discriminant process-reply vs webhook. Omis → les deux.
 */
export interface ListOrphanInboundsFilters {
  reason?: InboundOnInactiveConversationReason;
  source?: OrphanInboundSource;
}

/** Input typé du caller. Tous les champs sont optionnels. */
export interface ListOrphanInboundsInput {
  filters?: ListOrphanInboundsFilters;
  limit?: number;
  /** docId `oih_...` du dernier doc de la page précédente. */
  cursor?: string;
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

  if (filters?.reason !== undefined) {
    q = q.where("reason", "==", filters.reason);
  }
  if (filters?.source !== undefined) {
    q = q.where("source", "==", filters.source);
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

/** @internal exposition pour tests sentinelles. */
export const __ORPHAN_BODY_MAX_LENGTH_FOR_TESTS = ORPHAN_BODY_MAX_LENGTH;
