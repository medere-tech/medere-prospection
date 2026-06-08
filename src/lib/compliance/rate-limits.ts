/**
 * Règle 3 (skill `medere-sms-compliance`) — Plafond 3 SMS / 30 jours par contact.
 *
 * La loi française (L.34-5 CPCE) autorise jusqu'à 4 SMS/30j ; on garde une
 * marge de sécurité à 3 (décision skill). Fenêtre glissante de 30 jours
 * avec borne INCLUSIVE : un message à J-30 PILE est compté (décision
 * restrictive S4, validée par Déthié).
 *
 * AUCUN COUPLAGE FIRESTORE : la fonction prend une liste de records lus en
 * amont par le caller (l'orchestrateur `pre-send-check` de S5 fera la
 * lecture Firestore avant de nous passer l'historique).
 *
 * DÉFENSE TYPE-LEVEL : la signature exige `OutboundMessageRecord[]` (sous-
 * type narrow où `direction === "outbound"` est figé). Un caller qui essaie
 * de passer un message `inbound` voit une erreur TypeScript au COMPILE
 * time. Pas de filtrage runtime silencieux : si quelqu'un bypasse le
 * typage via `as any`, c'est un bug du caller qui doit être visible — pas
 * masqué par une garde silencieuse.
 *
 * Sanction CNIL : jusqu'à 20 M€ ou 4 % du CA mondial.
 */
import { differenceInDays } from "date-fns";

import type { SentMessageRecord } from "@/types/message";

/**
 * Sous-type narrow `SentMessageRecord & { direction: "outbound" }`. Le
 * caller filtre/cast explicitement avant d'appeler `canSendMessage`. Le
 * compilateur TypeScript verrouille — pas de garde runtime.
 */
export type OutboundMessageRecord = SentMessageRecord & {
  direction: "outbound";
};

/**
 * Plafond strict en nombre de messages dans la fenêtre.
 *
 * **Exposée publique** (DEBT-001.5) : les callers transactionnels
 * (typiquement `send-first-sms.ts` step 4 qui appelle
 * `sendOutboundWithLock`) en ont besoin pour calculer
 * `expectedRemainingQuota = RATE_LIMIT_MAX_MESSAGES - recent.length` côté
 * pre-flight et le passer à `sendOutboundWithLock`. Hardcoder en 2
 * endroits = drift garanti à terme — décision Déthié Q-S5.1 DEBT-001.5.
 *
 * ⚠️  Modifier cette valeur impacte la conformité L.34-5 CPCE. La loi
 * autorise jusqu'à 4 SMS/30j ; on garde une marge de sécurité à 3.
 * Toute modification PASSE par compliance-auditor (subagent obligatoire).
 */
export const RATE_LIMIT_MAX_MESSAGES = 3;

/** Largeur de la fenêtre en jours (glissante, calculée vs `now`). */
const RATE_LIMIT_WINDOW_DAYS = 30;

/**
 * Forme standard de résultat d'une vérification compliance. Réutilisée
 * par `hours.ts` et l'orchestrateur `pre-send-check` (S5).
 */
export interface ComplianceCheckResult {
  allowed: boolean;
  /** Raison textuelle (présente si `allowed === false`), exploitable
   * pour `audit_log` et le retour API. */
  reason?: string;
}

/**
 * Convertit un `Timestamp | Date` en `Date`. Le `Timestamp` Firestore
 * expose une méthode `toDate()`. Une instance `Date` est renvoyée
 * directement.
 */
function toDate(value: Date | { toDate(): Date }): Date {
  return value instanceof Date ? value : value.toDate();
}

/**
 * Vrai si on peut envoyer un nouveau SMS au regard du plafond 3/30j.
 *
 * @param outboundMessages Historique des messages sortants du contact.
 *   Le typage `OutboundMessageRecord[]` force le filtrage côté caller.
 * @param now Référence temporelle (défaut `new Date()`). Injectable pour
 *   les tests déterministes.
 */
export function canSendMessage(
  outboundMessages: OutboundMessageRecord[],
  now: Date = new Date(),
): ComplianceCheckResult {
  const inWindow = outboundMessages.filter(
    (m) => differenceInDays(now, toDate(m.sentAt)) <= RATE_LIMIT_WINDOW_DAYS,
  );

  if (inWindow.length >= RATE_LIMIT_MAX_MESSAGES) {
    return {
      allowed: false,
      reason: `Plafond ${RATE_LIMIT_MAX_MESSAGES}/${RATE_LIMIT_WINDOW_DAYS}j atteint (${inWindow.length} envois récents)`,
    };
  }
  return { allowed: true };
}
