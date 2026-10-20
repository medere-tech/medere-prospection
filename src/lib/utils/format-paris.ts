/**
 * Formateurs de date en timezone Europe/Paris (VUE-CONVERSATION PR1).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi ce module
 *
 *   Les timestamps Firestore sont stockés en UTC. L'UI dashboard Médéré
 *   s'adresse à des utilisateurs FR : on affiche TOUT en `Europe/Paris`
 *   via `Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris" })`.
 *
 *   Pas de dep `date-fns-tz` ajoutée — `Intl` natif suffit. Même approche
 *   que `src/lib/compliance/hours.ts` qui utilise déjà `Intl.DateTimeFormat`
 *   pour les contrôles horaires compliance.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi normaliser l'input en `Date`
 *
 *   Firestore Admin retourne des `Timestamp` ; côté client (après
 *   sérialisation RSC Next.js), on reçoit souvent des `Date` ou des
 *   chaînes ISO. On accepte les 3 formes et on refuse explicitement les
 *   autres (defense : pas de rendu silencieux "Invalid Date").
 */

const PARIS_TZ = "Europe/Paris";

/**
 * Normalise un `Date | string | Timestamp-like` en `Date | null`.
 *
 *   - `Date` → tel quel.
 *   - `string` ISO 8601 → `new Date(iso)` (validation `isNaN`).
 *   - Objet `{seconds, nanoseconds}` ou `{toDate()}` (Firestore
 *     Timestamp dé-sérialisé par Next.js RSC) → bascule en `Date`.
 *   - Autre → `null`.
 *
 *  Objectif : accepter les 3 shapes sans crasher sur un input inattendu.
 */
export function toDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "object" && value !== null) {
    const o = value as { toDate?: () => Date; seconds?: number; _seconds?: number };
    if (typeof o.toDate === "function") {
      try {
        const d = o.toDate();
        return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
      } catch {
        return null;
      }
    }
    const seconds = typeof o.seconds === "number" ? o.seconds : o._seconds;
    if (typeof seconds === "number" && Number.isFinite(seconds)) {
      return new Date(seconds * 1000);
    }
  }
  return null;
}

/** Formatte une heure courte `HH:mm` en Europe/Paris. Ex: `12:03`. */
export function formatHourParis(value: unknown): string {
  const d = toDateOrNull(value);
  if (d === null) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: PARIS_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/** Formatte une date courte `jj/mm/aaaa` en Europe/Paris. Ex: `19/10/2026`. */
export function formatDateParis(value: unknown): string {
  const d = toDateOrNull(value);
  if (d === null) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: PARIS_TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

/**
 * Formatte une date longue naturelle `lundi 19 octobre 2026` en
 * Europe/Paris. Utilisé pour les séparateurs de jour dans le fil des
 * messages (vue conversation).
 */
export function formatDayLongParis(value: unknown): string {
  const d = toDateOrNull(value);
  if (d === null) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: PARIS_TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);
}

/**
 * Formatte une date complète `jj/mm/aaaa à HH:mm` en Europe/Paris. Utilisé
 * pour les timestamps de bandeaux de statut.
 */
export function formatDateTimeParis(value: unknown): string {
  const d = toDateOrNull(value);
  if (d === null) return "—";
  const date = formatDateParis(d);
  const time = formatHourParis(d);
  return `${date} à ${time}`;
}

/**
 * Retourne la "clé jour" `YYYY-MM-DD` d'une date dans la timezone
 * Europe/Paris, utilisée pour grouper les messages par jour dans le fil.
 * Préserve la cohérence entre 2 messages à 23:50 et 00:10 heure Paris
 * (quand UTC les sépare en 2 jours).
 */
export function parisDayKey(value: unknown): string {
  const d = toDateOrNull(value);
  if (d === null) return "unknown";
  // `en-CA` donne nativement le format ISO court `YYYY-MM-DD`.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: PARIS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}
