/**
 * Plafond anti-inondation des notifications Slack orphelins
 * (MED-1 PR-NO-DROPPED-SMS, fix compliance-auditor Round 2).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Probleme
 *
 * Si un attaquant obtient `OVH_WEBHOOK_SECRET` (fuite logs/env), il peut
 * spammer le webhook avec des bodies hostiles uniques -> amplification
 * DoS : chaque appel pose un doc Firestore + poste un message Slack
 * dans le canal orphelins avec `<!here>`. Le canal se noie, le signal
 * operationnel est perdu, et un STOP legitime passerait inapercu.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Decision scellee (Dethie)
 *
 *   - Au-dela de 20 alertes par minute et par reason : une alerte de
 *     SYNTHESE par minute (compteur). Les suivantes sont supprimees.
 *   - Le stockage orphan dans Firestore n'est JAMAIS limite (preuve
 *     ecrite L.34-5 CPCE preservee).
 *   - Une alerte avec `wasOptOut === true` n'est JAMAIS regroupee ni
 *     supprimee (STOP = signal critique).
 *   - Si le compteur Upstash est indisponible : fail-OPEN (envoyer
 *     l'alerte, jamais perdre un signal).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Implementation
 *
 *   - `countLimiter`  : sliding window 20/min par (reason). Les 20
 *                       premieres alertes par minute consument un slot
 *                       et renvoient `success: true` -> "send". A partir
 *                       de la 21eme, `success: false` -> on consulte
 *                       `digestLimiter`.
 *   - `digestLimiter` : sliding window 1/min par (reason). Le 1er appel
 *                       de la minute reussit -> "send_digest" (alerte
 *                       synthese). Les suivants echouent -> "suppress".
 *
 * Les deux limiters utilisent `failureMode: "open"` : si Upstash est HS,
 * les deux retournent `success: true` -> on envoie TOUJOURS. Jamais de
 * perte de signal sur une panne infra.
 */

import { createRateLimiter, type RateLimiter } from "@/lib/security/rate-limit";
import type { InboundOnInactiveConversationReason } from "@/types/audit-log";

// ─────────────────────────────────────────────────────────────────────────────
// Rate-limiters module-level — lazy init (singleton)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Seuil de l'alerte de synthese. 20 alertes/min/reason = ~1 toutes les 3s,
 * largement au-dessus du trafic legitime OVH (quelques inbounds/min
 * attendus sur le MVP 200 PS, qq dizaines a 26k).
 */
const ORPHAN_ALERT_PER_REASON_LIMIT = 20;

/**
 * Compteur primaire : 20 alertes/min/reason.
 * fail-open pour ne jamais perdre un signal (MED-1 decision scellee).
 */
let _countLimiter: RateLimiter | null = null;
function getCountLimiter(): RateLimiter {
  if (_countLimiter === null) {
    _countLimiter = createRateLimiter({
      limit: ORPHAN_ALERT_PER_REASON_LIMIT,
      window: "1 m",
      prefix: "orphan-alert-count",
      failureMode: "open",
    });
  }
  return _countLimiter;
}

/**
 * Compteur secondaire : 1 digest/min/reason. Appele UNIQUEMENT quand le
 * compteur primaire a bloque (21eme alerte+). SETNX-like via sliding
 * window 1-slot : le 1er appel de la minute reussit, les suivants
 * echouent -> "suppress".
 */
let _digestLimiter: RateLimiter | null = null;
function getDigestLimiter(): RateLimiter {
  if (_digestLimiter === null) {
    _digestLimiter = createRateLimiter({
      limit: 1,
      window: "1 m",
      prefix: "orphan-alert-digest",
      failureMode: "open",
    });
  }
  return _digestLimiter;
}

// ─────────────────────────────────────────────────────────────────────────────
// API publique
// ─────────────────────────────────────────────────────────────────────────────

export type OrphanAlertDecision =
  | { kind: "send" }
  | { kind: "send_digest"; suppressed_in_window: number }
  | { kind: "suppress"; suppressed_in_window: number };

export interface DecideOrphanAlertInput {
  reason: InboundOnInactiveConversationReason;
  wasOptOut: boolean;
}

/**
 * Decide si une alerte orphan doit etre envoyee a Slack, remplacee par
 * un digest, ou supprimee. Jamais throw.
 *
 *   - wasOptOut === true           -> "send" (contournement total).
 *   - count <= 20 dans la minute   -> "send" (consomme un slot).
 *   - count > 20, 1er du quota     -> "send_digest" (1 alerte synthese).
 *   - count > 20, deja digeste     -> "suppress".
 *   - panne Upstash (fail-open)    -> "send".
 *
 * `suppressed_in_window` : nombre total d'alertes dans la fenetre
 * glissante (approximation `limit - remaining`), utile pour le texte du
 * digest ("20+ alertes orphelines parse_failed cette minute").
 */
export async function decideOrphanAlert(
  input: DecideOrphanAlertInput,
  deps: {
    countLimiter?: RateLimiter;
    digestLimiter?: RateLimiter;
  } = {},
): Promise<OrphanAlertDecision> {
  // Bypass total pour les signaux critiques.
  if (input.wasOptOut) {
    return { kind: "send" };
  }

  const _count = deps.countLimiter ?? getCountLimiter();
  const _digest = deps.digestLimiter ?? getDigestLimiter();

  const countKey = `reason:${input.reason}`;
  const countResult = await _count.check(countKey);

  if (countResult.success) {
    return { kind: "send" };
  }

  // Compteur primaire epuise : tenter le digest.
  const digestKey = `reason:${input.reason}`;
  const digestResult = await _digest.check(digestKey);

  // Approximation du nombre d'alertes supprimees dans la minute :
  // consumed = limit - remaining (sliding window).
  const consumed = Math.max(0, ORPHAN_ALERT_PER_REASON_LIMIT - countResult.remaining);

  if (digestResult.success) {
    return { kind: "send_digest", suppressed_in_window: consumed };
  }
  return { kind: "suppress", suppressed_in_window: consumed };
}

/** @internal exposition pour tests. */
export const __ORPHAN_ALERT_PER_REASON_LIMIT_FOR_TESTS = ORPHAN_ALERT_PER_REASON_LIMIT;
