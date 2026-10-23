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
  computeContactDisplayName,
  normalizeContactNameSearch,
} from "@/lib/firestore/conversation-list-fields";

// ─────────────────────────────────────────────────────────────────────────────
// Query helpers — point unique utilisé par `computeBackfillUpdatesForConversation`
// (ci-dessous) ET par `scripts/check-conversation-list-indexes.mjs` via
// `conversation-list-query-forms.ts`. Interdit de recopier ces requêtes
// ailleurs : la règle est "même fonction partout" pour qu'un drift
// (ex: ajout d'un filtre dans l'une mais pas l'autre) casse le build.
// ─────────────────────────────────────────────────────────────────────────────

/** `db.collection("conversations").doc(convId).collection("messages").orderBy("createdAt","desc").limit(1).get()`. */
export function queryBackfillLastMessage(
  db: FirebaseFirestore.Firestore,
  convId: string,
): Promise<FirebaseFirestore.QuerySnapshot> {
  return db
    .collection("conversations")
    .doc(convId)
    .collection("messages")
    .orderBy("createdAt", "desc")
    .limit(1)
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
    .limit(1)
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
        if (!conv.contactDisplayName) {
          const dn = computeContactDisplayName({
            civilite: typeof raw.civilite === "string" ? raw.civilite : undefined,
            firstName: typeof raw.firstName === "string" ? raw.firstName : "",
            lastName: typeof raw.lastName === "string" ? raw.lastName : "",
          });
          if (dn.length > 0) {
            updates.contactDisplayName = dn;
            posed.push("contactDisplayName");
          }
        }
        if (!conv.contactNameSearch) {
          const ns = normalizeContactNameSearch(`${raw.firstName ?? ""} ${raw.lastName ?? ""}`);
          if (ns.length > 0) {
            updates.contactNameSearch = ns;
            posed.push("contactNameSearch");
          }
        }
        if (
          !conv.contactSpecialty &&
          typeof raw.speciality === "string" &&
          raw.speciality.length > 0
        ) {
          updates.contactSpecialty = raw.speciality;
          posed.push("contactSpecialty");
        }
        if (!conv.contactCity && typeof raw.city === "string" && raw.city.length > 0) {
          updates.contactCity = raw.city;
          posed.push("contactCity");
        }
      }
    } catch (e) {
      readErrors.push(
        `contact: ${(e as Error)?.message ?? String(e)}`.split("\n")[0]!.slice(0, 180),
      );
    }
  }

  // ── Dernier message (preview) — SKIP si une lecture précédente a échoué ──
  if (readErrors.length === 0 && !conv.lastMessagePreview) {
    try {
      const lastMsgSnap = await queryBackfillLastMessage(db, convId);
      if (!lastMsgSnap.empty) {
        const m = lastMsgSnap.docs[0]!.data();
        const direction = m.direction === "outbound" ? "outbound" : "inbound";
        const authorKind =
          direction === "inbound" ? "contact" : m.generatedBy === "human" ? "human" : "ai";
        if (typeof m.body === "string") {
          updates.lastMessagePreview = buildLastMessagePreview({
            direction,
            authorKind,
            text: m.body,
            at: m.createdAt instanceof Timestamp ? m.createdAt : Timestamp.now(),
          });
          posed.push("lastMessagePreview");
        }
      }
    } catch (e) {
      readErrors.push(
        `messages.last: ${(e as Error)?.message ?? String(e)}`.split("\n")[0]!.slice(0, 180),
      );
    }
  }

  // ── Dernier outbound humain — SKIP si une lecture précédente a échoué ──
  if (readErrors.length === 0 && !conv.lastHumanOutboundAt) {
    try {
      const lastHumanSnap = await queryBackfillLastHumanOutbound(db, convId);
      if (!lastHumanSnap.empty) {
        const t = lastHumanSnap.docs[0]!.data().createdAt;
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
