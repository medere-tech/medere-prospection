/**
 * Wrapper observabilité Médéré — Sentry + Pino dual-output (S9.4.4).
 *
 * Première intégration Sentry programmatique du projet. Pattern wrapper
 * custom (vs `Sentry.captureMessage` direct) pour :
 *   - Testabilité : mock le wrapper dans tests unitaires (pas le SDK Sentry)
 *   - Anti-PII discipline : typage strict des `extra` (scrubber-safe par
 *     construction côté caller)
 *   - Dual-output : log Pino warn TOUJOURS posé en parallèle (visible
 *     Vercel logs même si Sentry non initialisé)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 ATTENTION SENTRY INIT — STATUT ACTUEL DU PROJET
 *
 * À ce jour (S9.4.4 livraison), Sentry SDK n'est PAS initialisé runtime :
 *   - `@sentry/nextjs` 10.54.0 est installé (package.json)
 *   - `SENTRY_DSN` + `NEXT_PUBLIC_SENTRY_DSN` documentés dans `.env.example`
 *   - CSP `next.config.ts:30-34` autorise les domaines Sentry EU
 *   - **MAIS aucun `instrumentation.ts` / `sentry.server.config.ts` créé**
 *
 * Conséquence runtime : `Sentry.captureMessage(...)` est appelable mais
 * **no-op silencieux** côté SDK (l'event n'est pas envoyé au serveur
 * Sentry car le client n'est pas init). Aucun crash, aucune erreur — juste
 * pas d'alerte côté dashboard Sentry EU.
 *
 * **Le fallback log Pino warn** assure que l'alerte est visible côté
 * Vercel logs même sans Sentry init (dégradation gracieuse). C'est
 * acceptable en MVP 200 contacts mais PAS pour scale prod.
 *
 * 🔒 Follow-up bloquant avant scale > 500 contacts :
 *     `S9.4.4-FOLLOWUP-SENTRY-INIT-001`
 *
 * À fermer en ajoutant :
 *   - `instrumentation.ts` (Next.js convention, racine projet)
 *   - `sentry.server.config.ts` (runtime Node.js — utile pour Inngest cron)
 *   - `sentry.edge.config.ts` (runtime Edge — optionnel pour Médéré MVP)
 *   - Validation manuelle dashboard Sentry EU (DSN région Allemagne)
 *   - Smoke test : capture événement test via ce wrapper, vérifier
 *     apparition dans dashboard Sentry EU < 30s
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INVARIANTS ANTI-PII (CNIL / RGPD)
 *
 * 1. **Type `ObservabilityExtra` STRICT** : `Record<string, string | number
 *    | boolean | null>`. Le caller ne peut PAS passer d'objets imbriqués
 *    (qui pourraient contenir des PII profondes). Le scrubber Sentry par
 *    défaut couvrirait les PII connues côté browser SDK, mais on ne fait
 *    pas confiance — la discipline vient du typage compile-time.
 *
 * 2. **JAMAIS `body` / `phone` / `email` dans les `extra`** :
 *    - Le typage `string | number | boolean | null` accepte techniquement
 *      `extra.phone: "+33612345678"` (string), donc on DOIT discipliner
 *      côté caller. Le scrubber Sentry serveur (à activer en
 *      `S9.4.4-FOLLOWUP-SENTRY-INIT-001`) attrapera en filet runtime.
 *    - Les sentinelles tests des callers (monitor-orphan-messages.test.ts
 *      S9.4.4.1) vérifient via `JSON.stringify(extra)` qu'aucun pattern
 *      E.164/FR/email n'apparaît dans le payload.
 *
 * 3. **`messageKey` = identifiant STABLE de l'alerte** (ex:
 *    `"orphan_messages_detected"`). PAS un message brut avec interpolation
 *    de données. Permet d'agréger côté Sentry et grouper les
 *    occurrences avec `fingerprint`.
 *
 * 4. **Dual-output OBLIGATOIRE** : `logger.warn` Pino TOUJOURS posé en
 *    parallèle de `Sentry.captureMessage`. Sentry no-op silencieux ne
 *    laisse PAS de trace si SDK non init — le log Pino est le filet.
 */
import * as Sentry from "@sentry/nextjs";

import { logger } from "@/lib/utils/logger";

// ─────────────────────────────────────────────────────────────────────────────
// Types publics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Forme stricte des `extra` autorisés. Limite les valeurs aux types
 * primitifs scalaires (anti-fuite PII via objets imbriqués).
 *
 * Le caller est responsable de vérifier QUE chaque valeur string ne
 * contient pas de PII (phone E.164, email, body SMS brut). Les
 * sentinelles tests des callers vérifient en assertions runtime.
 */
export type ObservabilityExtra = Record<string, string | number | boolean | null>;

export interface CaptureMonitoringWarningOptions {
  /**
   * Données structurées attachées à l'event Sentry (équivalent
   * `Sentry.captureMessage(msg, { extra })`). TYPE STRICT pour bloquer
   * les objets imbriqués qui pourraient leak PII (cf. invariant 1).
   */
  extra?: ObservabilityExtra;
  /**
   * Tags Sentry pour filtrage dashboard (ex: `{sprint: "S9.4.4",
   * monitoring: "orphan_messages"}`). Valeurs `string` uniquement —
   * cohérent typage Sentry SDK.
   */
  tags?: Record<string, string>;
  /**
   * Fingerprint Sentry pour grouper les events identiques en 1 issue
   * (ex: `["S9.4.4", "orphan_messages"]`). Sans fingerprint, Sentry
   * regroupe par stack trace — pas pertinent pour des messages
   * d'alerte récurrents.
   */
  fingerprint?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// API publique
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capture un événement d'alerte niveau "warning" (anomalie détectée mais
 * pas une erreur critique). Dual-output : Sentry (si init) + Pino warn
 * (toujours).
 *
 * Cas d'usage primaire S9.4.4 : `monitor-orphan-messages` cron Inngest
 * qui détecte des messages en `status="draft"` ou `status="queued"`
 * depuis > 1h (anomalie pipeline aval).
 *
 * Niveau Sentry choisi : `"warning"` (vs `"error"`). Un orphan
 * draft/queued n'est PAS une erreur applicative — c'est un signal
 * opérationnel à investiguer. Réserver `"error"` aux exceptions
 * non-gérées (Sentry SDK auto-capture via `instrumentation.ts` futur).
 *
 * @param messageKey  Identifiant stable de l'alerte (ex:
 *                    `"orphan_messages_detected"`). Apparaît dans
 *                    le dashboard Sentry comme titre de l'issue.
 * @param options     `extra` / `tags` / `fingerprint` Sentry.
 *
 * @returns void — pas de propagation d'erreur Sentry. Si le SDK Sentry
 *          throw (improbable, juste défensif), on log Pino et continue.
 */
export function captureMonitoringWarning(
  messageKey: string,
  options: CaptureMonitoringWarningOptions = {},
): void {
  // ── 1. Log Pino warn (TOUJOURS) ─────────────────────────────────────────
  // Filet de sécurité visible Vercel logs même si Sentry SDK non init
  // (cf. JSDoc — Sentry no-op silencieux sans instrumentation.ts).
  // Pattern Pino : object en 1er, message en 2ème.
  logger.warn(
    {
      ...options.extra,
      tags: options.tags,
      fingerprint: options.fingerprint,
      observability_kind: "monitoring_warning",
    },
    `[observability] ${messageKey}`,
  );

  // ── 2. Sentry.captureMessage (no-op silencieux si SDK non init) ────────
  // Pattern best-effort : on n'attend PAS la résolution Sentry. Si le
  // SDK throw (cas pathologique), on catch et on log — mais on ne
  // propage PAS l'erreur au caller (l'alerte log Pino est déjà posée
  // ligne précédente, l'orchestration métier ne doit pas dépendre de
  // Sentry uptime).
  try {
    Sentry.captureMessage(messageKey, {
      level: "warning",
      extra: options.extra,
      tags: options.tags,
      fingerprint: options.fingerprint,
    });
  } catch (sentryErr) {
    // SDK Sentry pète (très improbable — defense-in-depth). On garde
    // trace côté Pino sans propager au caller.
    logger.error(
      {
        observability_kind: "sentry_capture_failure",
        sentryError: sentryErr instanceof Error ? sentryErr.message : "unknown",
        originalMessageKey: messageKey,
      },
      "[observability] Sentry.captureMessage threw — alert degraded to Pino-only",
    );
  }
}
