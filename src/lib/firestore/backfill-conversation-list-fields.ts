/**
 * Logique pure du backfill PR2a — extraite du script `.mjs` pour pouvoir
 * la tester en isolation (fail-closed sur erreur de lecture).
 *
 * Le script `scripts/backfill-conversation-list-fields.mjs` orchestre :
 *   1. Charge toutes les conversations (`db.collection("conversations").get()`)
 *   2. Pour chaque doc, appelle `computeBackfillUpdatesForConversation` ici
 *   3. Si `readErrors.length > 0` → `errors++` + ZÉRO écriture
 *   4. Sinon → `tx.update + appendAuditLogTx` (en mode `--apply`)
 *
 * Les étapes 1, 3 et 4 restent dans le `.mjs` car ils sont I/O
 * orchestration ; l'étape 2 (per-doc) vit ici car c'est la partie où
 * un piège silencieux (erreur de lecture avalée) peut dégrader la
 * couverture du backfill. Testée via mock db → forcer un throw sur
 * CHAQUE source de lecture possible.
 */
import { Timestamp } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firestore/admin";
import {
  buildLastMessagePreview,
  computeContactListFieldsFromRaw,
} from "@/lib/firestore/conversation-list-fields";

// ─────────────────────────────────────────────────────────────────────────────
// Query helpers — point unique utilisé par `computeBackfillUpdatesForConversation`
// (ci-dessous) ET par `scripts/check-conversation-list-indexes.mjs` via
// `conversation-list-query-forms.ts`. Interdit de recopier ces requêtes
// ailleurs : la règle est "même fonction partout" pour qu'un drift
// (ex: ajout d'un filtre dans l'une mais pas l'autre) casse le build.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `db.collection("conversations").doc(convId).collection("messages").orderBy("createdAt","desc").limit(ACTIVE_SCAN_LIMIT).get()`.
 *
 * ⚠ Lit `ACTIVE_SCAN_LIMIT` (10) messages — PAS 1 — pour laisser au caller
 * la possibilité d'ignorer les docs `status: "duplicate"` ou `"abandoned"`
 * (invariant pipeline, cf. `_bumpConversationCountersTx` + cleanups
 * `close-duplicate-inbound-core.mjs` / `close-stale-orphans-core.mjs`).
 *
 * PR2c tour 2b bloc C septies : avant ce fix, `.limit(1)` ramenait un
 * duplicate et `computeBackfillUpdatesForConversation` posait son
 * `createdAt` comme `lastMessageAt` — ce qui annule silencieusement le
 * cleanup qui l'avait exclu.
 */
export const ACTIVE_SCAN_LIMIT = 10;

/**
 * Prédicat partagé — un message est "actif" (pris en compte par
 * `lastMessageAt` / `lastInboundAt` / `lastHumanOutboundAt` / preview /
 * `inboundCount`) ssi son `status` n'est NI `"duplicate"` NI
 * `"abandoned"`.
 *
 * Alignement pipeline :
 *   - `_bumpConversationCountersTx` incrémente les compteurs à chaque
 *     write, sans filtrer par status (status est "received"/"queued"
 *     à la création).
 *   - Les cleanups (`close-duplicate-inbound-core.mjs:122`,
 *     `close-stale-orphans-core.mjs:28`) marquent un message
 *     `duplicate`/`abandoned` ET DÉCRÉMENTENT `inboundCount` /
 *     réassignent `lastInboundAt` au prochain actif.
 *   - Donc après cleanup, `conv.inboundCount` et `conv.lastInboundAt`
 *     n'incluent pas les docs `duplicate`/`abandoned`. Le backfill doit
 *     respecter la même règle pour ne pas annuler le cleanup.
 */
export function isActiveMessageStatus(status: unknown): boolean {
  return status !== "duplicate" && status !== "abandoned";
}

export function queryBackfillLastMessage(
  db: FirebaseFirestore.Firestore,
  convId: string,
): Promise<FirebaseFirestore.QuerySnapshot> {
  return db
    .collection("conversations")
    .doc(convId)
    .collection("messages")
    .orderBy("createdAt", "desc")
    .limit(ACTIVE_SCAN_LIMIT)
    .get();
}

/**
 * `db.collection("conversations").doc(convId).collection("messages").where("direction","==","outbound").where("generatedBy","==","human").orderBy("createdAt","desc").limit(1).get()`.
 *
 * ⚠️ Requiert le composite index `(direction, generatedBy, createdAt desc)`
 * sur la collection `messages` (portée COLLECTION). Vérifié en prod par
 * `scripts/check-conversation-list-indexes.mjs` sous le label
 * `backfill.messages.last-human-outbound`.
 */
export function queryBackfillLastHumanOutbound(
  db: FirebaseFirestore.Firestore,
  convId: string,
): Promise<FirebaseFirestore.QuerySnapshot> {
  return db
    .collection("conversations")
    .doc(convId)
    .collection("messages")
    .where("direction", "==", "outbound")
    .where("generatedBy", "==", "human")
    .orderBy("createdAt", "desc")
    .limit(ACTIVE_SCAN_LIMIT)
    .get();
}

/**
 * `db.collection("conversations").doc(convId).collection("messages").where("direction","==","inbound").orderBy("createdAt","desc").limit(1).get()`.
 *
 * ⚠️ Requiert le composite index `(direction, createdAt desc)` sur la
 * collection `messages`. Déjà présent dans `firestore.indexes.json`
 * (bloc 1, lignes 4-10) : utilisé par la query collection-group des
 * messages triés desc par direction, le PRÉDICAT y est identique. Pas
 * d'index additionnel à poser.
 *
 * Vérifié par `scripts/check-conversation-list-indexes.mjs` sous le label
 * `backfill.messages.last-inbound` (cf. `conversation-list-query-forms.ts`).
 */
export function queryBackfillLastInbound(
  db: FirebaseFirestore.Firestore,
  convId: string,
): Promise<FirebaseFirestore.QuerySnapshot> {
  return db
    .collection("conversations")
    .doc(convId)
    .collection("messages")
    .where("direction", "==", "inbound")
    .orderBy("createdAt", "desc")
    .limit(ACTIVE_SCAN_LIMIT)
    .get();
}

/** `db.collection("contacts").doc(contactId).get()`. */
export function queryBackfillContact(
  db: FirebaseFirestore.Firestore,
  contactId: string,
): Promise<FirebaseFirestore.DocumentSnapshot> {
  return db.collection("contacts").doc(contactId).get();
}

/** `db.collection("conversations")` — ref brute, le caller choisit `.get()` ou `.limit(n).get()`. */
export function backfillConversationsRef(
  db: FirebaseFirestore.Firestore,
): FirebaseFirestore.CollectionReference {
  return db.collection("conversations");
}

export interface BackfillConvResult {
  /** Clés de `updates` dans leur ordre de pose. */
  posed: string[];
  /**
   * Champs calculés prêts à écrire. VIDE si `readErrors.length > 0` —
   * fail-closed : on NE calcule PAS avec des données partielles.
   */
  updates: Record<string, unknown>;
  /**
   * Erreurs de lecture rencontrées (chaînes courtes, lignes uniques, pas
   * de stack). Si non vide, le caller DOIT incrémenter `errors` et NE
   * PAS tenter d'écrire.
   */
  readErrors: string[];
}

/**
 * Calcule les champs à poser sur UNE conversation (lecture pure, zéro
 * écriture). Fail-closed : à la 1re lecture qui throw, on marque
 * `readErrors` et on retourne `updates = {}` + `posed = []` — le caller
 * voit zéro proposition de pose pour ce doc.
 *
 * @param convDoc  Document conversation lu (via `.get()`).
 * @param db       Firestore (injecté pour tests). Défaut : `getAdminDb()`.
 */
export async function computeBackfillUpdatesForConversation(
  convDoc: FirebaseFirestore.DocumentSnapshot | FirebaseFirestore.QueryDocumentSnapshot,
  db: FirebaseFirestore.Firestore = getAdminDb(),
): Promise<BackfillConvResult> {
  const convId = convDoc.id;
  const conv = (convDoc.data() ?? {}) as Record<string, unknown>;
  const posed: string[] = [];
  const updates: Record<string, unknown> = {};
  const readErrors: string[] = [];

  const needContactFields =
    !conv.contactDisplayName ||
    !conv.contactNameSearch ||
    !conv.contactSpecialty ||
    !conv.contactCity;

  // ── Lecture contact ──────────────────────────────────────────────────
  if (needContactFields) {
    try {
      const cSnap = await queryBackfillContact(db, String(conv.contactId));
      if (cSnap.exists) {
        const raw = (cSnap.data() ?? {}) as Record<string, unknown>;
        // PR4 B1 — SOURCE UNIQUE partagée avec `seed-reset-e2e-pr4-core.ts`.
        const fields = computeContactListFieldsFromRaw(raw);
        if (!conv.contactDisplayName && fields.contactDisplayName !== undefined) {
          updates.contactDisplayName = fields.contactDisplayName;
          posed.push("contactDisplayName");
        }
        if (!conv.contactNameSearch && fields.contactNameSearch !== undefined) {
          updates.contactNameSearch = fields.contactNameSearch;
          posed.push("contactNameSearch");
        }
        if (!conv.contactSpecialty && fields.contactSpecialty !== undefined) {
          updates.contactSpecialty = fields.contactSpecialty;
          posed.push("contactSpecialty");
        }
        if (!conv.contactCity && fields.contactCity !== undefined) {
          updates.contactCity = fields.contactCity;
          posed.push("contactCity");
        }
      }
    } catch (e) {
      readErrors.push(
        `contact: ${(e as Error)?.message ?? String(e)}`.split("\n")[0]!.slice(0, 180),
      );
    }
  }

  // ── Dernier message (preview + lastMessageAt) — SKIP si une lecture
  //    précédente a échoué. Une seule query, deux champs posés depuis le
  //    même doc : preview (si body est une chaîne) et lastMessageAt (si
  //    createdAt est un Timestamp exploitable).
  //    « uniquement quand absent » : chaque champ est posé seulement si
  //    `conv.<field>` est falsy — invariant du backfill PR2a.
  //    PR2c tour 2b bloc C : `lastMessageAt` n'était pas reposé avant ce
  //    fix. Un `reset-e2e-orphans` qui l'effaçait laissait la conv sans
  //    `lastMessageAt`, donc hors de la liste admin (orderBy desc). Fix :
  //    quand le champ est absent, on repose à `m.createdAt` SI c'est un
  //    `Timestamp` strict — jamais `Timestamp.now()` pour ce champ,
  //    contrairement au preview où `now()` est un fallback d'affichage.
  if (readErrors.length === 0 && (!conv.lastMessagePreview || !conv.lastMessageAt)) {
    try {
      const lastMsgSnap = await queryBackfillLastMessage(db, convId);
      // PR2c tour 2b bloc C septies — on skip les docs `duplicate` et
      // `abandoned` (invariant pipeline, cf. `isActiveMessageStatus`).
      // Les queries fetchent `ACTIVE_SCAN_LIMIT` docs justement pour avoir
      // la marge nécessaire au skip.
      const firstActive = lastMsgSnap.docs.find((d) => isActiveMessageStatus(d.data().status));
      if (firstActive) {
        const m = firstActive.data();
        const direction = m.direction === "outbound" ? "outbound" : "inbound";
        const authorKind =
          direction === "inbound" ? "contact" : m.generatedBy === "human" ? "human" : "ai";
        if (!conv.lastMessagePreview && typeof m.body === "string") {
          updates.lastMessagePreview = buildLastMessagePreview({
            direction,
            authorKind,
            text: m.body,
            at: m.createdAt instanceof Timestamp ? m.createdAt : Timestamp.now(),
          });
          posed.push("lastMessagePreview");
        }
        if (!conv.lastMessageAt && m.createdAt instanceof Timestamp) {
          updates.lastMessageAt = m.createdAt;
          posed.push("lastMessageAt");
        }
      }
    } catch (e) {
      readErrors.push(
        `messages.last: ${(e as Error)?.message ?? String(e)}`.split("\n")[0]!.slice(0, 180),
      );
    }
  }

  // ── Dernier message entrant (`lastInboundAt`) — PR2c tour 2b bloc C.
  //    Requête dédiée indexée par `(direction, createdAt desc)`. Posé
  //    uniquement quand absent, et seulement si `createdAt` est un
  //    `Timestamp`. SKIP si une lecture précédente a échoué.
  if (readErrors.length === 0 && !conv.lastInboundAt) {
    try {
      const lastInboundSnap = await queryBackfillLastInbound(db, convId);
      const firstActive = lastInboundSnap.docs.find((d) => isActiveMessageStatus(d.data().status));
      if (firstActive) {
        const t = firstActive.data().createdAt;
        if (t instanceof Timestamp) {
          updates.lastInboundAt = t;
          posed.push("lastInboundAt");
        }
      }
    } catch (e) {
      readErrors.push(
        `messages.lastInbound: ${(e as Error)?.message ?? String(e)}`.split("\n")[0]!.slice(0, 180),
      );
    }
  }

  // ── Dernier outbound humain — SKIP si une lecture précédente a échoué ──
  if (readErrors.length === 0 && !conv.lastHumanOutboundAt) {
    try {
      const lastHumanSnap = await queryBackfillLastHumanOutbound(db, convId);
      const firstActive = lastHumanSnap.docs.find((d) => isActiveMessageStatus(d.data().status));
      if (firstActive) {
        const t = firstActive.data().createdAt;
        if (t instanceof Timestamp) {
          updates.lastHumanOutboundAt = t;
          posed.push("lastHumanOutboundAt");
        }
      }
    } catch (e) {
      readErrors.push(
        `messages.lastHuman: ${(e as Error)?.message ?? String(e)}`.split("\n")[0]!.slice(0, 180),
      );
    }
  }

  // Fail-closed : si un read a throw, on JETTE les updates calculés — le
  // caller doit traiter ce doc comme "errors++, zéro écriture". Alternative
  // (garder updates partiels) aurait permis une écriture incohérente.
  if (readErrors.length > 0) {
    return { posed: [], updates: {}, readErrors };
  }

  return { posed, updates, readErrors };
}
