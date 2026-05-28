/**
 * Règle 5 (skill `medere-sms-compliance`) — Bloctel pour mobiles persos B2C.
 *
 * Loi française : vérification obligatoire de la liste Bloctel avant
 * démarchage d'un numéro mobile personnel non-pro. La vérif a une durée
 * de validité de 30 jours.
 *
 * BORNES (décision restrictive Déthié S5) :
 *   - Vérif faite à J reste valide jusqu'à J+30 INCLUS.
 *   - Refus à partir de J+31 (`daysSince >= 31`).
 *
 * FAIL-SAFE (décision Déthié S5) : si `bloctelChecked === true` mais
 * `bloctelCheckedAt === undefined` (incohérence data), on REFUSE avec
 * `BLOCTEL_REASONS.missingTimestamp`. JAMAIS autoriser sans timestamp.
 *
 * SCOPE : ne concerne que `segment === 'b2c_mobile_perso'`. Tout autre
 * segment (B2B cabinet, unknown) court-circuite à `{ allowed: true }`.
 *
 * SOURCE DE VÉRITÉ : la skill `medere-sms-compliance` règle 5. Fonction
 * PURE — aucun I/O. Le caller (`pre-send-check`) lit Firestore et injecte
 * le `Contact` ; cette fonction ne fait que de la logique.
 *
 * Sanction Bloctel : jusqu'à 75 000 € (personne physique) /
 * 375 000 € (personne morale) pour démarchage abusif.
 */
import { differenceInDays } from "date-fns";

import type { Contact } from "@/types/contact";

import type { ComplianceCheckResult } from "./rate-limits";

/**
 * Reasons exportées comme constantes pour permettre à l'orchestrateur
 * `pre-send-check.ts` de matcher proprement sur le code (sans parsing
 * fragile de strings). Si tu modifies ces littéraux, mets à jour aussi
 * `pre-send-check.ts` ET ses tests.
 */
export const BLOCTEL_REASONS = {
  notChecked: "Bloctel non vérifié",
  optedOut: "Inscrit Bloctel",
  missingTimestamp:
    "Date de vérification Bloctel manquante (anomalie data : bloctelChecked=true mais bloctelCheckedAt=undefined)",
  /** Préfixe utilisé pour `startsWith` côté orchestrateur ; le suffixe
   *  contient le nombre de jours, à extraire via `context`. */
  expiredPrefix: "Vérification Bloctel expirée",
} as const;

/** Largeur de la fenêtre de validité Bloctel en jours (J+30 inclusif). */
const BLOCTEL_VALIDITY_DAYS = 30;

/**
 * Convertit un `Timestamp | Date` en `Date`. `Timestamp` Firestore expose
 * une méthode `toDate()`. Une instance `Date` est renvoyée directement.
 */
function toDate(value: Date | { toDate(): Date }): Date {
  return value instanceof Date ? value : value.toDate();
}

/**
 * Vrai si on peut envoyer un SMS à ce contact au regard de la règle Bloctel.
 *
 * Cours-circuite à `allowed: true` pour tout segment non `b2c_mobile_perso`
 * (B2B et unknown ne sont pas concernés par Bloctel).
 *
 * @param contact Contact Firestore (lecture amont par caller).
 * @param now     Référence temporelle (défaut `new Date()`). Injection tests.
 */
export function canSendB2C(contact: Contact, now: Date = new Date()): ComplianceCheckResult {
  // Segment non concerné par Bloctel → court-circuit.
  if (contact.segment !== "b2c_mobile_perso") {
    return { allowed: true };
  }

  if (!contact.bloctelChecked) {
    return { allowed: false, reason: BLOCTEL_REASONS.notChecked };
  }

  if (contact.bloctelOptOut) {
    return { allowed: false, reason: BLOCTEL_REASONS.optedOut };
  }

  // Fail-safe : checked=true mais pas de timestamp → anomalie data, refus.
  if (!contact.bloctelCheckedAt) {
    return { allowed: false, reason: BLOCTEL_REASONS.missingTimestamp };
  }

  const checkDate = toDate(contact.bloctelCheckedAt);
  const daysSince = differenceInDays(now, checkDate);

  // Borne restrictive : refus à partir de J+31 (>= 31).
  if (daysSince >= BLOCTEL_VALIDITY_DAYS + 1) {
    return {
      allowed: false,
      reason: `${BLOCTEL_REASONS.expiredPrefix} (${daysSince}j depuis la vérification)`,
    };
  }

  return { allowed: true };
}
