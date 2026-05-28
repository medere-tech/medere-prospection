/**
 * Règle 4 (skill `medere-sms-compliance`) — Plages horaires d'envoi.
 *
 *   Lundi à vendredi : 10h00-13h00 et 14h00-20h00 (heure de Paris)
 *   Samedi           : 10h00-13h00
 *   Dimanche         : JAMAIS
 *   Jours fériés FR  : JAMAIS (l'emporte sur samedi 10-13h)
 *
 * BORNES (décision restrictive S4, validée par Déthié) :
 *   - 10h00 INCLUS, 13h00 EXCLU (13h00 pile = pause, refusé)
 *   - 14h00 INCLUS, 20h00 EXCLU (20h00 pile = trop tard, refusé)
 *   - Message à J-30 PILE compté dans la fenêtre 30j (cf. `rate-limits`)
 *
 * TIMEZONE : `Europe/Paris` via `Intl.DateTimeFormat` (built-in Node,
 * gère les transitions été/hiver automatiquement, pas de dépendance
 * `date-fns-tz`).
 *
 * JOURS FÉRIÉS : hardcodés 2026 + 2027 dans une `Set<string>` au format
 * `YYYY-MM-DD`. Calcul automatique (Computus, etc.) délibérément refusé
 * — trop de footguns dans les libs JS, liste statique auditable préférée.
 * À étendre AVANT chaque nouvelle année (chore annuel, à inscrire dans
 * le runbook).
 *
 * Sanction CNIL : jusqu'à 20 M€ ou 4 % du CA mondial.
 */
import type { ComplianceCheckResult } from "./rate-limits";

/**
 * Dernière année pour laquelle la liste `FRENCH_HOLIDAYS` ci-dessous a été
 * vérifiée et étendue. Au-delà, `isAllowedSendTime` refuse TOUT envoi par
 * fail-safe (refus explicite vaut mieux qu'un envoi un jour férié non
 * répertorié — sanction CNIL probable cf. audit S4 ÉLEVÉ #2).
 *
 * CHORE ANNUEL : avant chaque nouvelle année, étendre `FRENCH_HOLIDAYS` ET
 * incrémenter cette constante. Inscrire dans le runbook compliance, deadline
 * 1er octobre de l'année N-1.
 */
export const MAX_VERIFIED_HOLIDAYS_YEAR = 2027;

/**
 * Jours fériés FR (heure de Paris) au format `YYYY-MM-DD`. À étendre
 * avant chaque nouvelle année, en même temps que `MAX_VERIFIED_HOLIDAYS_YEAR`.
 */
const FRENCH_HOLIDAYS: ReadonlySet<string> = new Set([
  // ── 2026 ──
  "2026-01-01", // Jour de l'An
  "2026-04-06", // Lundi de Pâques
  "2026-05-01", // Fête du Travail
  "2026-05-08", // Victoire 1945
  "2026-05-14", // Ascension
  "2026-05-25", // Lundi de Pentecôte
  "2026-07-14", // Fête nationale
  "2026-08-15", // Assomption (tombe un samedi en 2026 — férié l'emporte)
  "2026-11-01", // Toussaint
  "2026-11-11", // Armistice 1918
  "2026-12-25", // Noël
  // ── 2027 ──
  "2027-01-01",
  "2027-03-29", // Lundi de Pâques
  "2027-05-01",
  "2027-05-06", // Ascension
  "2027-05-08",
  "2027-05-17", // Lundi de Pentecôte
  "2027-07-14",
  "2027-08-15",
  "2027-11-01",
  "2027-11-11",
  "2027-12-25",
]);

/**
 * Formatter `Intl.DateTimeFormat` configuré sur Europe/Paris. Cache
 * module-level pour éviter la re-création à chaque appel (perf).
 * Locale `sv-SE` (suédoise) → format ISO `YYYY-MM-DD HH:MM` propre à parser.
 */
const PARIS_FORMATTER = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Paris",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

interface ParisTime {
  /** YYYY-MM-DD du wallclock Paris. */
  isoDate: string;
  /** Année (utilisée pour le fail-safe `MAX_VERIFIED_HOLIDAYS_YEAR`). */
  year: number;
  /** 0 = dimanche, 1 = lundi, …, 6 = samedi. */
  weekday: number;
  hour: number;
  minute: number;
}

/**
 * Convertit un `Date` UTC en wallclock Paris (date + heure + jour de la
 * semaine). Lecture via `formatToParts` puis reconstruction d'un `Date`
 * local pour récupérer le `weekday` via `getDay()` (calendrier indépendant
 * de la timezone du serveur).
 */
function toParisTime(date: Date): ParisTime {
  const parts = PARIS_FORMATTER.formatToParts(date);
  const get = (type: string): string => {
    const v = parts.find((p) => p.type === type)?.value;
    // Filet défensif INATTEIGNABLE avec les options de `PARIS_FORMATTER`
    // ci-dessus (year/month/day/hour/minute sont toutes demandées
    // explicitement). Ignoré du coverage v8 car non testable proprement
    // sans mock de `Intl.DateTimeFormat`.
    /* v8 ignore start */
    if (v === undefined) {
      throw new Error(`Intl part missing: ${type}`);
    }
    /* v8 ignore stop */
    return v;
  };
  const year = Number.parseInt(get("year"), 10);
  const month = Number.parseInt(get("month"), 10);
  const day = Number.parseInt(get("day"), 10);
  const hour = Number.parseInt(get("hour"), 10);
  const minute = Number.parseInt(get("minute"), 10);
  // `new Date(year, month-1, day)` construit un Date à minuit local serveur ;
  // `getDay()` renvoie le jour de la semaine du calendrier (indépendant
  // de la timezone — May 12 2026 est un mardi partout).
  const local = new Date(year, month - 1, day);
  return {
    isoDate: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    year,
    weekday: local.getDay(),
    hour,
    minute,
  };
}

/**
 * Vrai si l'instant `date` tombe dans une plage d'envoi autorisée par
 * la règle 4. Renvoie `{ allowed, reason? }` cohérent avec
 * `canSendMessage` pour exploitation par l'orchestrateur `pre-send-check`
 * (S5) et par les `audit_log` (la `reason` est loggée pour traçabilité).
 *
 * @param date Instant à vérifier (défaut `new Date()`).
 */
export function isAllowedSendTime(date: Date = new Date()): ComplianceCheckResult {
  const paris = toParisTime(date);

  // Priorité 0 : fail-safe — au-delà de l'année vérifiée, refus explicite.
  // Sinon on enverrait un SMS un jour férié non répertorié (ex: 1er janvier
  // 2028 si on déploie sans avoir étendu FRENCH_HOLIDAYS). Cf. audit S4 ÉLEVÉ #2.
  if (paris.year > MAX_VERIFIED_HOLIDAYS_YEAR) {
    return {
      allowed: false,
      reason: `holidays_not_verified_after_${MAX_VERIFIED_HOLIDAYS_YEAR}: update FRENCH_HOLIDAYS in src/lib/compliance/hours.ts`,
    };
  }

  // Priorité 1 : férié l'emporte sur tout (y compris samedi 10-13h).
  if (FRENCH_HOLIDAYS.has(paris.isoDate)) {
    return { allowed: false, reason: `Jour férié FR (${paris.isoDate})` };
  }

  // Priorité 2 : dimanche jamais.
  if (paris.weekday === 0) {
    return { allowed: false, reason: "Dimanche — envoi interdit" };
  }

  // Priorité 3 : samedi limité au créneau du matin.
  if (paris.weekday === 6) {
    if (paris.hour >= 10 && paris.hour < 13) return { allowed: true };
    return {
      allowed: false,
      reason: `Samedi hors plage 10h-13h (il est ${paris.hour}h${String(paris.minute).padStart(2, "0")})`,
    };
  }

  // Lundi-vendredi : matin OU après-midi.
  if (paris.hour >= 10 && paris.hour < 13) return { allowed: true };
  if (paris.hour >= 14 && paris.hour < 20) return { allowed: true };
  return {
    allowed: false,
    reason: `Hors plage L-V 10-13h / 14-20h (il est ${paris.hour}h${String(paris.minute).padStart(2, "0")})`,
  };
}
