/**
 * Formes de requêtes `inbound_messages_orphans/` (PR2c tour 2a).
 *
 * Chaque forme émise par les routes `/api/admin/orphan-inbounds*` ou par
 * la lib (`listOrphanInbounds`, `countOrphanInboundsByState`) est
 * représentée ici pour que le script `scripts/check-orphan-indexes.mjs`
 * puisse les sonder en lecture seule contre Firestore prod et prouver
 * que chaque forme a bien son index composite.
 *
 * Modèle miroir `conversation-list-query-forms.ts` (PR2a).
 */
import { getAdminDb } from "@/lib/firestore/admin";

import { ORPHAN_INBOUNDS_COLLECTION } from "./orphan-inbounds";

export interface OrphanQueryForm {
  readonly label: string;
  readonly category: "list" | "count" | "lookup";
  readonly run: () => Promise<unknown>;
}

/**
 * Probe IDs volontairement improbables (`__orphan_probe_*`) — ne risquent
 * pas de match un doc réel. Les `limit(1)` suffisent à provoquer la
 * sélection d'index Firestore sans parcourir la collection.
 */
export const QUERY_FORMS: readonly OrphanQueryForm[] = [
  // ─── isTestFixture=false (vue réelle utilisateur admin) ───
  {
    label: "list — isTestFixture=false, receivedAt desc (onglet « Tous » PR2c tour 2b)",
    category: "list",
    run: () =>
      getAdminDb()
        .collection(ORPHAN_INBOUNDS_COLLECTION)
        .where("isTestFixture", "==", false)
        .orderBy("receivedAt", "desc")
        .limit(1)
        .get(),
  },
  {
    label: "list — isTestFixture=false + processingState='pending', receivedAt desc",
    category: "list",
    run: () =>
      getAdminDb()
        .collection(ORPHAN_INBOUNDS_COLLECTION)
        .where("isTestFixture", "==", false)
        .where("processingState", "==", "pending")
        .orderBy("receivedAt", "desc")
        .limit(1)
        .get(),
  },
  {
    label: "list — isTestFixture=false + processingState='attached', receivedAt desc",
    category: "list",
    run: () =>
      getAdminDb()
        .collection(ORPHAN_INBOUNDS_COLLECTION)
        .where("isTestFixture", "==", false)
        .where("processingState", "==", "attached")
        .orderBy("receivedAt", "desc")
        .limit(1)
        .get(),
  },
  {
    label: "list — isTestFixture=false + processingState='dismissed', receivedAt desc",
    category: "list",
    run: () =>
      getAdminDb()
        .collection(ORPHAN_INBOUNDS_COLLECTION)
        .where("isTestFixture", "==", false)
        .where("processingState", "==", "dismissed")
        .orderBy("receivedAt", "desc")
        .limit(1)
        .get(),
  },
  {
    label:
      "list — isTestFixture=false + processingState='pending' + reason='unknown_contact', receivedAt desc",
    category: "list",
    run: () =>
      getAdminDb()
        .collection(ORPHAN_INBOUNDS_COLLECTION)
        .where("isTestFixture", "==", false)
        .where("processingState", "==", "pending")
        .where("reason", "==", "unknown_contact")
        .orderBy("receivedAt", "desc")
        .limit(1)
        .get(),
  },
  {
    label:
      "list — isTestFixture=false + processingState='pending' + reason='parse_failed', receivedAt desc",
    category: "list",
    run: () =>
      getAdminDb()
        .collection(ORPHAN_INBOUNDS_COLLECTION)
        .where("isTestFixture", "==", false)
        .where("processingState", "==", "pending")
        .where("reason", "==", "parse_failed")
        .orderBy("receivedAt", "desc")
        .limit(1)
        .get(),
  },

  // ─── onglet « Tous » × motif (PR2c tour 2b bloc B — passe 2) ───
  // L'onglet « Tous » omet `processingState` ; combiné à `reason`, la
  // requête devient `isTestFixture + reason + receivedAt desc` → nouvel
  // index composite requis.
  {
    label:
      "list — isTestFixture=false + reason='no_conversation', receivedAt desc (onglet « Tous » × motif)",
    category: "list",
    run: () =>
      getAdminDb()
        .collection(ORPHAN_INBOUNDS_COLLECTION)
        .where("isTestFixture", "==", false)
        .where("reason", "==", "no_conversation")
        .orderBy("receivedAt", "desc")
        .limit(1)
        .get(),
  },

  // ─── count (compteurs par état) ───
  {
    label: "count — isTestFixture=false + processingState='pending'",
    category: "count",
    run: () =>
      getAdminDb()
        .collection(ORPHAN_INBOUNDS_COLLECTION)
        .where("isTestFixture", "==", false)
        .where("processingState", "==", "pending")
        .count()
        .get(),
  },
  {
    label: "count — isTestFixture=false + processingState='attached'",
    category: "count",
    run: () =>
      getAdminDb()
        .collection(ORPHAN_INBOUNDS_COLLECTION)
        .where("isTestFixture", "==", false)
        .where("processingState", "==", "attached")
        .count()
        .get(),
  },
  {
    label: "count — isTestFixture=false + processingState='dismissed'",
    category: "count",
    run: () =>
      getAdminDb()
        .collection(ORPHAN_INBOUNDS_COLLECTION)
        .where("isTestFixture", "==", false)
        .where("processingState", "==", "dismissed")
        .count()
        .get(),
  },

  // ─── isTestFixture=true (vue testAccount preview) ───
  {
    label: "list — isTestFixture=true + processingState='pending', receivedAt desc",
    category: "list",
    run: () =>
      getAdminDb()
        .collection(ORPHAN_INBOUNDS_COLLECTION)
        .where("isTestFixture", "==", true)
        .where("processingState", "==", "pending")
        .orderBy("receivedAt", "desc")
        .limit(1)
        .get(),
  },

  // ─── lookup détail (par docId) ───
  {
    label: "lookup — doc(oih_probe)",
    category: "lookup",
    run: () =>
      getAdminDb()
        .collection(ORPHAN_INBOUNDS_COLLECTION)
        .doc("oih_probe_zzzzzzzz_zzzzzzzz_zzzzzzzz_zzzzzzzz")
        .get(),
  },
];
