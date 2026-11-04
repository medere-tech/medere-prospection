/**
 * Core du rattrapage `actorTestAccount` top-level sur `audit_log`
 * (PR3 tour 2b bis quater).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Problème adressé
 *
 *   Depuis PR3 tour 2b bis (ter), `appendAuditLog` pose un champ
 *   top-level `actorTestAccount: boolean` sur CHAQUE nouvelle entrée.
 *   Le journal d'un compte réel filtre via
 *   `where("actorTestAccount", "==", false)` (index composite #15).
 *
 *   Toute entrée écrite AVANT ce PR (ou par un rollback de prod
 *   provisoire pointant la même base que les previews) n'a pas ce
 *   champ. Firestore ne matche pas un champ absent à `== false`, donc
 *   ces entrées sont invisibles du journal tant qu'elles ne sont pas
 *   rattrapées.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Compat avec la règle projet « append-only »
 *
 *   La règle projet dit : on N'ÉDITE PAS l'événement (ni action, ni
 *   actorId, ni actorType, ni payload, ni timestamp, ni targetType,
 *   ni targetId). Ici on AJOUTE une donnée DÉRIVÉE :
 *
 *     actorTestAccount := (doc.payload?.actorTestAccount === true)
 *
 *   La valeur est calculable a posteriori à partir du payload (qui,
 *   depuis le site d'écriture historique `revealContactPhone`, portait
 *   déjà `actorTestAccount: boolean` dans le payload). Pour tous les
 *   autres sites, la valeur dérivée est `false` (ni payload bruité, ni
 *   actor humain testaccount). Aucune information de l'événement
 *   d'origine n'est effacée ou modifiée. Le rattrapage est donc un
 *   enrichissement, pas une édition.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Contrat (sans CLI, sans dotenv, sans process.exit)
 *
 *   - `scanBackfillAuditActorTestAccount(db)` → stream lecture seule,
 *     pagination `orderBy("timestamp", "asc")` avec cursor. Pour chaque
 *     doc, émet `{ docId, needsUpdate, derived }`. ZÉRO écriture.
 *   - `applyBackfillAuditActorTestAccount(db, writes)` → batch 400 par
 *     400, pose UNIQUEMENT le champ `actorTestAccount`. Fail-closed si
 *     un doc a entre-temps reçu le champ (relecture dans la tx n'est
 *     pas nécessaire : `update` est idempotent, et au pire on repose
 *     la même valeur).
 *   - `runBackfill(db, { apply, batchSize?, pageSize?, onBatch? })` →
 *     orchestration complète (scan + apply conditionnel), retourne les
 *     décomptes. ZÉRO console.log, ZÉRO exit.
 *
 * Idempotence : les docs qui ont DÉJÀ le champ top-level sont ignorés
 * par le scan (`needsUpdate: false`). Un 2e passage = 0 updates.
 */
import { FieldPath, Firestore, type QueryDocumentSnapshot } from "firebase-admin/firestore";

export const AUDIT_COLLECTION_NAME = "audit_log";

/**
 * Décomptes retournés par le scan et par l'application du rattrapage.
 * Chacun est cumulé au fil des pages pour permettre un suivi en direct.
 */
export interface BackfillStats {
  /** Nombre total de docs LUS pendant le scan. */
  scanned: number;
  /** Nombre de docs qui n'ont PAS `actorTestAccount` top-level. */
  needsUpdate: number;
  /** Nombre de docs effectivement écrits (0 en dry-run). */
  updated: number;
  /** Parmi `needsUpdate`, combien seront posés à `true` (test accounts). */
  testCount: number;
}

/** Un doc identifié par le scan comme à mettre à jour. */
export interface BackfillWritePlan {
  readonly docId: string;
  readonly derivedValue: boolean;
}

export interface BackfillOptions {
  /**
   * `false` par défaut (dry-run). Passer `true` effectue les writes.
   * Le script CLI force la confirmation `projectId` avant d'appliquer.
   */
  readonly apply: boolean;
  /**
   * Taille d'un batch d'écriture. Max Firestore = 500. Défaut 400 pour
   * garder une marge de sécurité.
   */
  readonly batchSize?: number;
  /**
   * Taille d'une page de scan. Défaut 500 (max Firestore sur `.limit`
   * en pratique utile). Pas de corrélation avec `batchSize`.
   */
  readonly pageSize?: number;
  /**
   * Callback optionnel pour reporter la progression (ex. afficher une
   * ligne par batch côté CLI). Appelé APRÈS chaque batch (scan + apply).
   */
  readonly onBatch?: (snapshot: BackfillStats) => void;
}

const DEFAULT_BATCH_SIZE = 400;
const DEFAULT_PAGE_SIZE = 500;

/**
 * Dérive la valeur à poser : `true` SSI le payload portait déjà
 * `actorTestAccount: true` (valeur stricte, pas truthy). Pour toutes
 * les autres valeurs (absent, false, string, number, null, objet), on
 * pose `false`. C'est cohérent avec `validateAndScrub` qui normalise
 * la valeur d'entrée de la même façon pour les acteurs `system`/`ai`.
 */
export function deriveActorTestAccount(payload: Record<string, unknown> | undefined): boolean {
  if (payload === undefined || payload === null) return false;
  return payload["actorTestAccount"] === true;
}

/**
 * Teste si un doc `audit_log` a besoin du rattrapage. Vrai si et
 * SEULEMENT si le champ top-level `actorTestAccount` n'existe pas.
 * Tout doc qui a déjà le champ (quelle que soit sa valeur) est
 * considéré à jour.
 */
export function needsBackfill(data: Record<string, unknown>): boolean {
  // Firestore représente un champ absent comme `undefined` après
  // `.data()`. On accepte aussi un `null` posé par un backfill antérieur
  // buggé — à traiter comme « manquant » pour auto-correction.
  const v = data["actorTestAccount"];
  return v === undefined || v === null;
}

/**
 * Scan lecture seule paginé de `audit_log`. Yielde chaque batch de
 * docs sous forme de « plan de rattrapage » + stats cumulatives.
 *
 * Utilise `orderBy(FieldPath.documentId())` pour une pagination
 * déterministe SANS exiger d'index composite (le single-field index
 * sur `__name__` est auto). Scanne TOUT l'historique — pas de cutoff.
 */
export async function* scanBackfillAuditActorTestAccount(
  db: Firestore,
  pageSize: number = DEFAULT_PAGE_SIZE,
): AsyncGenerator<{ plans: BackfillWritePlan[]; stats: BackfillStats }> {
  const stats: BackfillStats = { scanned: 0, needsUpdate: 0, updated: 0, testCount: 0 };
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let q = db.collection(AUDIT_COLLECTION_NAME).orderBy(FieldPath.documentId()).limit(pageSize);
    if (cursor !== undefined) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;

    const plans: BackfillWritePlan[] = [];
    for (const doc of snap.docs) {
      stats.scanned += 1;
      const data = doc.data();
      if (needsBackfill(data)) {
        const derived = deriveActorTestAccount(
          data["payload"] as Record<string, unknown> | undefined,
        );
        plans.push({ docId: doc.id, derivedValue: derived });
        stats.needsUpdate += 1;
        if (derived) stats.testCount += 1;
      }
    }

    yield { plans, stats: { ...stats } };

    if (snap.docs.length < pageSize) break;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

/**
 * Applique un plan de rattrapage par batchs. Chaque update ne pose
 * QUE le champ `actorTestAccount`, par définition de `.update(...)`.
 */
export async function applyBackfillBatch(
  db: Firestore,
  plans: readonly BackfillWritePlan[],
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<number> {
  let written = 0;
  for (let i = 0; i < plans.length; i += batchSize) {
    const slice = plans.slice(i, i + batchSize);
    const batch = db.batch();
    for (const plan of slice) {
      const ref = db.collection(AUDIT_COLLECTION_NAME).doc(plan.docId);
      batch.update(ref, { actorTestAccount: plan.derivedValue });
    }
    await batch.commit();
    written += slice.length;
  }
  return written;
}

/**
 * Orchestration complète : scan + (dry-run | apply). Retourne les
 * stats cumulées sur l'ensemble du scan. Pas de console.log, pas de
 * process.exit.
 */
export async function runBackfill(db: Firestore, options: BackfillOptions): Promise<BackfillStats> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const final: BackfillStats = { scanned: 0, needsUpdate: 0, updated: 0, testCount: 0 };

  for await (const { plans, stats } of scanBackfillAuditActorTestAccount(db, pageSize)) {
    // Stats scan cumulées jusqu'ici.
    final.scanned = stats.scanned;
    final.needsUpdate = stats.needsUpdate;
    final.testCount = stats.testCount;

    if (options.apply && plans.length > 0) {
      const written = await applyBackfillBatch(db, plans, batchSize);
      final.updated += written;
    }
    options.onBatch?.({ ...final });
  }
  return final;
}
