/**
 * Inngest cron `monitor-orphan-messages` — détection orphan drafts/queued
 * (S9.4.4 — fermeture sprint 9.4).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * VUE D'ENSEMBLE
 *
 * Sprint S9.4 a livré le pipeline complet draft IA → SMS au PS :
 *   - S9.3.3b : génération draft + audit reply_generated
 *   - S9.4.3  : émission event jumeau dispatch-reply-event
 *   - S9.4.2  : handler send-reply.ts consomme event + dispatch OVH
 *   - S9.4.1  : commitDraftToQueued transitionne draft → queued atomique
 *
 * Reste un FILET DE SÉCURITÉ critique pour détecter les anomalies aval :
 *   - Orphan drafts : `status="draft"` depuis > 1h. Symptôme : handler
 *     send-reply.ts n'a jamais consommé l'event (Inngest DLQ saturé,
 *     bug, ou commitDraftToQueued rejeté sans alerte).
 *   - Orphan queued : `status="queued"` depuis > 1h. Symptôme : OVH 5xx
 *     persistants au-delà des 4 retries Inngest naturels, OU bug post-
 *     commit empêchant la transition queued → sent/delivered/failed.
 *
 * Cron hourly UTC qui :
 *   1. Query collection group `messages` pour drafts stale > 1h
 *   2. Query collection group `messages` pour queued stale > 1h
 *   3. Si count > 0 sur l'un OU l'autre : émet alerte observabilité via
 *      `captureMonitoringWarning` (Sentry + Pino dual-output)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 ALERT-ONLY EN MVP (arbitrage Q-D5 Déthié S9.4.4.0)
 *
 * Aucune remédiation automatique (pas de drop, pas de retry forcé, pas
 * de transition vers `failed`). Le cron est uniquement diagnostic.
 *
 * Justifications :
 *   - Remédiation auto sur état pathologique = risque d'amplifier l'incident
 *   - L'investigation manuelle (Déthié + Sentry + Vercel logs) est requise
 *     pour décider du fix
 *   - Une policy de remédiation (drop > 24h, retry forcé > 1h) sera décidée
 *     en S10+ après observation des patterns réels en prod
 *
 * Trace follow-up : `S10-ORPHAN-REMEDIATION-POLICY`
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 SEUILS S9.4.4 — 1h POUR DRAFTS ET QUEUED
 *
 * Arbitrage Q-D4 Déthié : 1h pour les deux en MVP (simplicité).
 *
 *   - Draft : créé en S9.3.3b step 8b. Event jumeau émis ~10 ms après.
 *     Handler send-reply.ts consomme en < 5 s en happy path. Si > 1h sans
 *     consommation → anomalie grave (Inngest DLQ, function down, ...).
 *
 *   - Queued : créé en S9.4.1 commitDraftToQueued. Dispatch OVH suit
 *     immédiatement (steps 2-3 du handler send-reply.ts). Inngest retry
 *     naturel jusqu'à ~30 min sur 5xx. Si > 1h en queued → retry épuisés
 *     ou bug ailleurs.
 *
 * Si observation prod montre que queued à 30-50 min est commun (OVH 5xx
 * passagers), tuner queued seul à 2h via constante dédiée. Pas changé
 * en MVP.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * GARDE-FOUS
 *
 *   [GF1] `concurrency: { limit: 1 }` — singleton anti-overlap. Si un
 *         run > 1h (improbable en MVP, query légère), le prochain
 *         cron est sérialisé. Évite 2 alertes Sentry simultanées
 *         identiques + protège ressources Firestore.
 *
 *   [GF2] `retries: 0` — monitoring read-only. Si query Firestore fail
 *         (5xx transient), OK de skip cette heure (anomalies persistantes
 *         seront catchées au run suivant). Pas de bruit Sentry inutile.
 *
 *   [GF3] Anti-PII strict :
 *         - payload Sentry/log = counts/ages UNIQUEMENT (numbers)
 *         - JAMAIS body / phone / conversationId / messageId individuels
 *         - Si on veut investiguer un orphan spécifique, lire les logs
 *           pino structurés (kibana-like) qui contiennent les IDs opaques
 *
 *   [GF4] Limit query 100 (`STALE_MESSAGES_DEFAULT_LIMIT`) — anti-DoS
 *         Firestore. Si > 100 orphans, on logge `truncated: true` pour
 *         signaler l'incident massif sans charger toute la collection.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INDEX FIRESTORE REQUIS (S9.4.4)
 *
 *   {
 *     "collectionGroup": "messages",
 *     "queryScope": "COLLECTION_GROUP",
 *     "fields": [
 *       { "fieldPath": "direction", "order": "ASCENDING" },
 *       { "fieldPath": "status", "order": "ASCENDING" },
 *       { "fieldPath": "createdAt", "order": "ASCENDING" }
 *     ]
 *   }
 *
 * Cf. `firestore.indexes.json` + procédure `npm run firebase:deploy:indexes`.
 * Sans déploiement, `listStaleMessages` throw `FAILED_PRECONDITION`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * RETOUR HANDLER (discrimé sur `status`)
 *
 *   - `"healthy"` : aucun orphan détecté. Pas d'alerte Sentry posée.
 *   - `"orphans_detected"` : au moins 1 orphan draft OU queued. Alerte
 *     Sentry posée via captureMonitoringWarning.
 */
import { listStaleMessages, type StaleMessageEntry } from "@/lib/firestore/messages";
import { getInngestClient } from "@/lib/inngest/client";
import { captureMonitoringWarning } from "@/lib/utils/observability";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ID Inngest stable du cron. NE PAS modifier après le premier déploiement
 * (perte d'historique côté cloud). Verrouillé par sentinelle test.
 */
const FUNCTION_ID = "monitor-orphan-messages";

/**
 * Cron UTC standard (every hour at minute 0). Verrouillé par sentinelle
 * test. À adapter si on observe en prod un besoin de monitoring plus
 * fréquent (15 min) ou moins fréquent (4h). MVP S9.4.4 = 1h.
 */
const CRON_EXPRESSION = "0 * * * *";

/**
 * Seuil orphan en ms. Identique pour drafts et queued en MVP (arbitrage
 * Q-D4 Déthié S9.4.4.0). Si tuning prod nécessaire, séparer en 2 const.
 */
const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1h

/**
 * Limit query Firestore — anti-DoS. Si > 100 orphans, on log un signal
 * "truncated" via Sentry pour alerter d'un incident massif sans charger
 * toute la collection.
 */
const QUERY_LIMIT = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Types de retour du handler
// ─────────────────────────────────────────────────────────────────────────────

export type MonitorOrphanMessagesResult =
  | { status: "healthy"; staleDraftsCount: 0; staleQueuedCount: 0 }
  | {
      status: "orphans_detected";
      staleDraftsCount: number;
      staleQueuedCount: number;
      /** Age du plus ancien draft stale (ms). 0 si aucun draft stale. */
      oldestDraftAgeMs: number;
      /** Age du plus ancien queued stale (ms). 0 si aucun queued stale. */
      oldestQueuedAgeMs: number;
      /** true si la query drafts a atteint la limit (incident massif). */
      draftsTruncated: boolean;
      /** true si la query queued a atteint la limit (incident massif). */
      queuedTruncated: boolean;
    };

// ─────────────────────────────────────────────────────────────────────────────
// Injection de dépendances (pattern S5 / send-reply.ts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deps injectables pour tests unitaires. En production, pas fournis —
 * les vraies impls Firestore + Sentry wrapper sont utilisées.
 *
 * @internal Public uniquement pour testing.
 */
export interface MonitorOrphanMessagesDeps {
  listStaleMessages?: typeof listStaleMessages;
  captureMonitoringWarning?: typeof captureMonitoringWarning;
  /**
   * `now` injectable pour calcul deterministe des ages (oldest*AgeMs).
   * Défaut `new Date()`.
   */
  now?: () => Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Forme du contexte Inngest
// ─────────────────────────────────────────────────────────────────────────────

export interface MonitorOrphanMessagesHandlerContext {
  event?: {
    id?: string;
    name?: string;
  };
  step: {
    run: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  };
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler — exporté pour tests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calcule l'age (ms) du plus ancien message dans une liste de stale
 * entries. La liste est retournée orderBy createdAt ASC (oldest first)
 * par `listStaleMessages`, donc on prend le premier element.
 *
 * Retourne 0 si la liste est vide (cohérent type `MonitorOrphanMessagesResult`
 * variant `"orphans_detected"` où le caller peut interpréter `0` comme
 * "pas de stale pour ce statut").
 */
function computeOldestAgeMs(entries: StaleMessageEntry[], now: Date): number {
  const oldest = entries[0];
  if (oldest === undefined) {
    return 0;
  }
  return now.getTime() - oldest.createdAt.toMillis();
}

/**
 * Handler du cron `monitor-orphan-messages`. Pipeline 3 sub-steps :
 *   1. list-stale-drafts
 *   2. list-stale-queued
 *   3. report-observability (conditionnel)
 *
 * Cf. JSDoc en-tête du fichier pour vue d'ensemble + invariants.
 *
 * @param ctx   Contexte Inngest (event optionnel pour les crons).
 * @param deps  Injection optionnelle pour tests. Production : ne pas fournir.
 *
 * @returns `MonitorOrphanMessagesResult` discrimé sur `status` (healthy
 *          si aucun orphan détecté, orphans_detected sinon).
 */
export async function monitorOrphanMessagesHandler(
  ctx: MonitorOrphanMessagesHandlerContext,
  deps: MonitorOrphanMessagesDeps = {},
): Promise<MonitorOrphanMessagesResult> {
  const _listStaleMessages = deps.listStaleMessages ?? listStaleMessages;
  const _captureMonitoringWarning = deps.captureMonitoringWarning ?? captureMonitoringWarning;
  const _now = deps.now ?? (() => new Date());
  const { step, logger } = ctx;

  // ── Step 1 — list-stale-drafts ─────────────────────────────────────────
  const staleDrafts = await step.run("list-stale-drafts", async () => {
    return _listStaleMessages({
      status: "draft",
      maxAgeMs: STALE_THRESHOLD_MS,
      limit: QUERY_LIMIT,
      now: _now(),
    });
  });

  // ── Step 2 — list-stale-queued ─────────────────────────────────────────
  const staleQueued = await step.run("list-stale-queued", async () => {
    return _listStaleMessages({
      status: "queued",
      maxAgeMs: STALE_THRESHOLD_MS,
      limit: QUERY_LIMIT,
      now: _now(),
    });
  });

  // ── Branche healthy — aucun orphan détecté ─────────────────────────────
  if (staleDrafts.length === 0 && staleQueued.length === 0) {
    logger.info("[monitor-orphan-messages] healthy", {
      staleDraftsCount: 0,
      staleQueuedCount: 0,
    });
    return { status: "healthy", staleDraftsCount: 0, staleQueuedCount: 0 };
  }

  // ── Step 3 — report-observability (conditionnel) ──────────────────────
  const draftsTruncated = staleDrafts.length === QUERY_LIMIT;
  const queuedTruncated = staleQueued.length === QUERY_LIMIT;
  const oldestDraftAgeMs = computeOldestAgeMs(staleDrafts, _now());
  const oldestQueuedAgeMs = computeOldestAgeMs(staleQueued, _now());

  await step.run("report-observability", async () => {
    // 🔒 Payload anti-PII strict : counts/ages/booleans UNIQUEMENT.
    // JAMAIS body, phone, conversationId, messageId individuels.
    // Si investigation nécessaire, les IDs opaques sont disponibles
    // côté logs Pino structurés (Vercel logs) — pas via Sentry payload.
    _captureMonitoringWarning("orphan_messages_detected", {
      extra: {
        staleDraftsCount: staleDrafts.length,
        staleQueuedCount: staleQueued.length,
        oldestDraftAgeMs,
        oldestQueuedAgeMs,
        draftsTruncated,
        queuedTruncated,
        thresholdMs: STALE_THRESHOLD_MS,
        queryLimit: QUERY_LIMIT,
      },
      tags: {
        sprint: "S9.4.4",
        monitoring: "orphan_messages",
      },
      // Fingerprint Sentry — groupe toutes les occurrences en 1 issue
      // pour éviter de spammer le dashboard (hourly run = 24 events/jour).
      fingerprint: ["S9.4.4", "orphan_messages"],
    });

    logger.warn(
      {
        staleDraftsCount: staleDrafts.length,
        staleQueuedCount: staleQueued.length,
        oldestDraftAgeMs,
        oldestQueuedAgeMs,
        draftsTruncated,
        queuedTruncated,
      },
      "[monitor-orphan-messages] orphans detected — investigation required",
    );
  });

  return {
    status: "orphans_detected",
    staleDraftsCount: staleDrafts.length,
    staleQueuedCount: staleQueued.length,
    oldestDraftAgeMs,
    oldestQueuedAgeMs,
    draftsTruncated,
    queuedTruncated,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Inngest function — wrap autour du handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inngest cron `monitor-orphan-messages` (S9.4.4).
 *
 * **Trigger** : cron `0 * * * *` (UTC, hourly).
 * **Concurrency** [GF1] : `{ limit: 1 }` (singleton anti-overlap).
 * **Retries** [GF2] : `0` (monitoring read-only).
 * **Handler** : `monitorOrphanMessagesHandler` (exporté pour tests).
 */
export const monitorOrphanMessages = getInngestClient().createFunction(
  {
    id: FUNCTION_ID,
    triggers: [{ cron: CRON_EXPRESSION }],
    concurrency: { limit: 1 },
    retries: 0,
  },
  monitorOrphanMessagesHandler,
);

// ─────────────────────────────────────────────────────────────────────────────
// Exposés pour tests sentinelles
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export const __FUNCTION_ID_FOR_TESTS = FUNCTION_ID;

/** @internal */
export const __CRON_EXPRESSION_FOR_TESTS = CRON_EXPRESSION;

/** @internal */
export const __STALE_THRESHOLD_MS_FOR_TESTS = STALE_THRESHOLD_MS;

/** @internal */
export const __QUERY_LIMIT_FOR_TESTS = QUERY_LIMIT;
