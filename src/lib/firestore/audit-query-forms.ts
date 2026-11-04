/**
 * Formes de requêtes `audit_log/` (PR3 tour 2b bis quater) — catalogue
 * contrôlé en lecture seule par `scripts/check-audit-indexes.mjs`.
 *
 * Chaque forme reflète une requête réellement émise par le code produit :
 *   - `#12` compat test — lecture simple d'un targetType/targetId trié
 *     par timestamp (consommé par `listAuditLogByTarget`).
 *   - `#15` journal réel — filtre `actorTestAccount == false` (consommé
 *     par `fetchJournalEntriesRealOnly` pour un viewer réel).
 *
 * Le script `check-audit-indexes.mjs` sonde chaque forme en lecture
 * seule (`limit(1)`) contre la vraie base. Si l'index composite manque,
 * Firestore throw `FAILED_PRECONDITION` avec un lien de création dans
 * le message — le script l'extrait.
 *
 * Modèle miroir `src/lib/firestore/orphan-list-query-forms.ts`.
 *
 * Les probe IDs (`__audit_probe_*`) sont volontairement improbables.
 * `limit(1)` suffit à provoquer la sélection d'index Firestore sans
 * parcourir la collection.
 */
import { getAdminDb } from "@/lib/firestore/admin";

export const AUDIT_COLLECTION_FOR_PROBES = "audit_log";

export interface AuditQueryForm {
  readonly label: string;
  readonly category: "list";
  /**
   * Identifiant stable de la forme, utilisé par le test de couverture
   * `tests/conversations/audit-index-coverage.test.ts` qui projette
   * cet ID sur une entrée de `firestore.indexes.json`. Unique dans le
   * catalogue.
   */
  readonly indexKey:
    | "audit_log/targetType+targetId+timestamp"
    | "audit_log/targetType+targetId+actorTestAccount+timestamp";
  readonly run: () => Promise<unknown>;
}

const PROBE_CONV = "__audit_probe_conv_id_unlikely_to_match";
const PROBE_CONTACT = "__audit_probe_contact_id_unlikely_to_match";

export const QUERY_FORMS: readonly AuditQueryForm[] = [
  // ─── #12 — lecture simple `listAuditLogByTarget` (viewer testAccount) ───
  {
    label: "list — targetType=conversation + targetId=<probe>, timestamp desc (viewer testAccount)",
    category: "list",
    indexKey: "audit_log/targetType+targetId+timestamp",
    run: () =>
      getAdminDb()
        .collection(AUDIT_COLLECTION_FOR_PROBES)
        .where("targetType", "==", "conversation")
        .where("targetId", "==", PROBE_CONV)
        .orderBy("timestamp", "desc")
        .limit(1)
        .get(),
  },
  {
    label: "list — targetType=contact + targetId=<probe>, timestamp desc (viewer testAccount)",
    category: "list",
    indexKey: "audit_log/targetType+targetId+timestamp",
    run: () =>
      getAdminDb()
        .collection(AUDIT_COLLECTION_FOR_PROBES)
        .where("targetType", "==", "contact")
        .where("targetId", "==", PROBE_CONTACT)
        .orderBy("timestamp", "desc")
        .limit(1)
        .get(),
  },

  // ─── #15 — journal d'un compte réel (actorTestAccount == false) ───
  {
    label:
      "list — targetType=conversation + targetId=<probe> + actorTestAccount=false, timestamp desc (journal viewer réel)",
    category: "list",
    indexKey: "audit_log/targetType+targetId+actorTestAccount+timestamp",
    run: () =>
      getAdminDb()
        .collection(AUDIT_COLLECTION_FOR_PROBES)
        .where("targetType", "==", "conversation")
        .where("targetId", "==", PROBE_CONV)
        .where("actorTestAccount", "==", false)
        .orderBy("timestamp", "desc")
        .limit(1)
        .get(),
  },
  {
    label:
      "list — targetType=contact + targetId=<probe> + actorTestAccount=false, timestamp desc (journal viewer réel)",
    category: "list",
    indexKey: "audit_log/targetType+targetId+actorTestAccount+timestamp",
    run: () =>
      getAdminDb()
        .collection(AUDIT_COLLECTION_FOR_PROBES)
        .where("targetType", "==", "contact")
        .where("targetId", "==", PROBE_CONTACT)
        .where("actorTestAccount", "==", false)
        .orderBy("timestamp", "desc")
        .limit(1)
        .get(),
  },
];

/**
 * Signature d'un index composite déclaré dans `firestore.indexes.json`.
 * Projection stable utilisée par le test de couverture ci-dessous.
 */
export interface IndexSignature {
  readonly collectionGroup: string;
  readonly fields: ReadonlyArray<{ fieldPath: string; order: "ASCENDING" | "DESCENDING" }>;
}

/** Projette une `IndexSignature` sur l'`indexKey` utilisé par ce catalogue. */
export function indexKeyFromSignature(sig: IndexSignature): string {
  if (sig.collectionGroup !== AUDIT_COLLECTION_FOR_PROBES) return "";
  return `${sig.collectionGroup}/${sig.fields.map((f) => f.fieldPath).join("+")}`;
}
