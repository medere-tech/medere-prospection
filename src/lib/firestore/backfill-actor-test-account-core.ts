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
import type { ClerkClient } from "@clerk/backend";
import { FieldPath, Firestore, type QueryDocumentSnapshot } from "firebase-admin/firestore";

export const AUDIT_COLLECTION_NAME = "audit_log";

/**
 * Sous-type STRICT du SDK Clerk réel. On pique précisément
 * `ClerkClient["users"]` depuis `@clerk/backend` et on projette sur la
 * méthode utilisée (`getUserList`). Résultat :
 *
 *   - Le type `getUserList` conserve sa vraie signature
 *     `(params?) => Promise<PaginatedResourceResponse<User[]>>` avec
 *     `{ data: User[]; totalCount: number }` en retour.
 *   - Un faux Clerk qui renvoie un tableau brut (comme l'ancien mock
 *     avant fix) est refusé par le compilateur, pas seulement par le
 *     runtime.
 *   - `User` conserve ses champs `id`, `publicMetadata`, `firstName`,
 *     `lastName` — on peut les lire sans élargir le port.
 *
 * `Pick<..., "getUserList">` protège aussi contre la découverte
 * accidentelle d'autres endpoints via le mock (sentinelle "surface
 * API minimale consommée").
 */
export type ClerkUsersListPort = Pick<ClerkClient["users"], "getUserList">;

/**
 * Récupère tous les `userId` Clerk dont `publicMetadata.testAccount`
 * est strictement `true`. Pagination `limit`/`offset` jusqu'à
 * `totalCount`, miroir exact de ce que font déjà
 * `scripts/setup-e2e-clerk-users.mjs:177-179` et
 * `scripts/cleanup-e2e-clerk-users.mjs:93-94` :
 *
 *   ```js
 *   const list = await clerk.users.getUserList({ emailAddress: [email] });
 *   // L'API Clerk retourne `{ data, totalCount }`.
 *   const users = list.data ?? list;
 *   ```
 *
 * On lit ici le même shape (`data` + `totalCount`) et on continue à
 * paginer tant que `offset + data.length < totalCount`.
 *
 * Fail-fast : propage toute erreur Clerk. Le caller (runBackfill /
 * script CLI) décide si une liste vide ou un throw doit arrêter.
 */
export async function fetchTestAccountUserIds(
  clerk: ClerkUsersListPort,
): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  const pageSize = 100;
  let offset = 0;
  for (;;) {
    const page = await clerk.getUserList({ limit: pageSize, offset });
    // `page.data` est l'array d'users. `page.totalCount` donne la
    // cardinalité globale — on s'en sert comme critère d'arrêt pour
    // les instances Clerk vides ou plus petites qu'une page.
    for (const user of page.data) {
      if (user.publicMetadata["testAccount"] === true) {
        ids.add(user.id);
      }
    }
    const nextOffset = offset + page.data.length;
    if (page.data.length === 0 || nextOffset >= page.totalCount) break;
    offset = nextOffset;
  }
  return ids;
}

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
  /**
   * Ventilation `testCount` par `action` auditable (ex. `orphan_attached_to_conversation`).
   * Permet au CLI d'afficher « 12 clics test réattachement + 3 opt-outs
   * marqués, 0 réels » et de prouver que les actions PR2c des comptes
   * e2e sont bien reclassées.
   */
  testCountByAction: Record<string, number>;
}

/** Un doc identifié par le scan comme à mettre à jour. */
export interface BackfillWritePlan {
  readonly docId: string;
  readonly derivedValue: boolean;
  /** Action auditée du doc, propagée pour `testCountByAction`. */
  readonly action: string;
}

export interface BackfillOptions {
  /**
   * `false` par défaut (dry-run). Passer `true` effectue les writes.
   * Le script CLI force la confirmation `projectId` avant d'appliquer.
   */
  readonly apply: boolean;
  /**
   * Ensemble des `userId` Clerk dont `publicMetadata.testAccount === true`.
   * Source de vérité : Clerk (lue au DÉMARRAGE par
   * `fetchTestAccountUserIds`), JAMAIS une liste recopiée en dur.
   *
   * Fail-closed : `runBackfill` throw AVANT toute écriture si cet
   * ensemble est VIDE (soit Clerk a échoué, soit la métadonnée n'est
   * pas provisionnée). Cette garde évite de poser `false` par défaut
   * sur toutes les actions des comptes e2e qui n'avaient pas le flag
   * dans le payload (ex. tous les `orphan_attached_to_conversation` du
   * harnais PR2c).
   */
  readonly testUserIds: ReadonlySet<string>;
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

/**
 * Erreur levée par `runBackfill` quand `testUserIds` est vide. Fait
 * échouer explicitement le dry-run ET l'apply — le CLI doit vérifier
 * son wiring Clerk avant de relancer.
 */
export class EmptyTestUserSetError extends Error {
  constructor(hint: string) {
    super(`runBackfill: testUserIds is empty (${hint})`);
    this.name = "EmptyTestUserSetError";
  }
}

const DEFAULT_BATCH_SIZE = 400;
const DEFAULT_PAGE_SIZE = 500;

/**
 * Dérive la valeur à poser.
 *
 * RÈGLES (OR logique, strict) :
 *   1. `payload.actorTestAccount === true` (valeur stricte, pas truthy) —
 *      couvre `revealContactPhone` historique qui posait déjà le flag
 *      dans le payload.
 *   2. `actorId ∈ testUserIds` — couvre les actions PR2c des comptes e2e
 *      (`orphan_attached_to_conversation`, `orphan_dismissed`,
 *      `orphan_reopened`) qui NE POSAIENT PAS de `actorTestAccount` dans
 *      leur payload. `testUserIds` vient de Clerk au démarrage du
 *      backfill (jamais hardcodé).
 *
 * Pour toutes les autres valeurs (payload absent, false, string, number,
 * null, objet) ET quand `actorId` n'est pas dans l'ensemble, on pose
 * `false`. Cohérent avec `validateAndScrub` qui normalise la valeur
 * d'entrée pour les acteurs `system`/`ai`.
 */
export function deriveActorTestAccount(
  payload: Record<string, unknown> | undefined,
  actorId: string,
  testUserIds: ReadonlySet<string>,
): boolean {
  if (payload?.["actorTestAccount"] === true) return true;
  if (typeof actorId === "string" && actorId.length > 0 && testUserIds.has(actorId)) {
    return true;
  }
  return false;
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
  testUserIds: ReadonlySet<string>,
  pageSize: number = DEFAULT_PAGE_SIZE,
): AsyncGenerator<{ plans: BackfillWritePlan[]; stats: BackfillStats }> {
  const stats: BackfillStats = {
    scanned: 0,
    needsUpdate: 0,
    updated: 0,
    testCount: 0,
    testCountByAction: {},
  };
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
        const payload = data["payload"] as Record<string, unknown> | undefined;
        const actorId = typeof data["actorId"] === "string" ? (data["actorId"] as string) : "";
        const action = typeof data["action"] === "string" ? (data["action"] as string) : "unknown";
        const derived = deriveActorTestAccount(payload, actorId, testUserIds);
        plans.push({ docId: doc.id, derivedValue: derived, action });
        stats.needsUpdate += 1;
        if (derived) {
          stats.testCount += 1;
          stats.testCountByAction[action] = (stats.testCountByAction[action] ?? 0) + 1;
        }
      }
    }

    yield {
      plans,
      stats: { ...stats, testCountByAction: { ...stats.testCountByAction } },
    };

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
  // Fail-closed (PR3 tour 2b bis sexies) : si l'ensemble des comptes test
  // Clerk est vide (lookup failed ou metadata non seedée), on refuse
  // AVANT toute écriture. Sinon on marquerait `false` toutes les actions
  // des comptes e2e qui n'ont pas `payload.actorTestAccount` — exactement
  // la pathologie à éviter (clics PR2c pollueraient le journal réel).
  if (options.testUserIds.size === 0) {
    throw new EmptyTestUserSetError(
      "lookup Clerk a échoué OU aucun user avec publicMetadata.testAccount === true n'a été trouvé",
    );
  }

  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const final: BackfillStats = {
    scanned: 0,
    needsUpdate: 0,
    updated: 0,
    testCount: 0,
    testCountByAction: {},
  };

  for await (const { plans, stats } of scanBackfillAuditActorTestAccount(
    db,
    options.testUserIds,
    pageSize,
  )) {
    // Stats scan cumulées jusqu'ici.
    final.scanned = stats.scanned;
    final.needsUpdate = stats.needsUpdate;
    final.testCount = stats.testCount;
    final.testCountByAction = { ...stats.testCountByAction };

    if (options.apply && plans.length > 0) {
      const written = await applyBackfillBatch(db, plans, batchSize);
      final.updated += written;
    }
    options.onBatch?.({ ...final, testCountByAction: { ...final.testCountByAction } });
  }
  return final;
}
