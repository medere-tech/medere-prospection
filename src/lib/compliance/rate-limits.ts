/**
 * Règle 3 (skill `medere-sms-compliance`) — Plafond 4 SOLLICITATIONS /
 * 30 jours par contact.
 *
 * La loi française (L.34-5 CPCE) autorise jusqu'à 4 sollicitations/30j —
 * valeur retenue telle quelle depuis PR-FILTRE-SOLLICITATION (avant :
 * 3 SMS, marge de sécurité, mais TOUS les sortants comptaient). Fenêtre
 * glissante de 30 jours avec borne INCLUSIVE : un message à J-30 PILE est
 * compté (décision restrictive S4, validée par Déthié).
 *
 * ⚠️ Ce que le plafond compte a changé : seuls les messages dont
 * `outboundKind === "solicitation"` sont comptabilisés — les réponses à un
 * PS qui a écrit en premier ne le sont pas. Cf. `canSendMessage` et
 * `countsAgainstCap` (`lib/compliance/outbound-kind.ts`).
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

import { countsAgainstCap } from "@/lib/compliance/outbound-kind";
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
 * Plafond strict en nombre de **SOLLICITATIONS** dans la fenêtre.
 *
 * **Exposée publique** (DEBT-001.5) : les callers transactionnels
 * (typiquement `send-first-sms.ts` step 4 qui appelle
 * `sendOutboundWithLock`) en ont besoin pour calculer
 * `expectedRemainingQuota` côté pre-flight et le passer à
 * `sendOutboundWithLock`. Hardcoder en 2 endroits = drift garanti à terme
 * — décision Déthié Q-S5.1 DEBT-001.5.
 *
 * ⚠️  Modifier cette valeur impacte la conformité L.34-5 CPCE. La loi
 * autorise jusqu'à 4 sollicitations / 30 jours, et c'est exactement la
 * valeur retenue depuis PR-FILTRE-SOLLICITATION : **il n'y a plus de
 * marge de sécurité**. Toute imprécision de comptage devient donc un
 * dépassement, et non plus un simple inconfort — c'est pourquoi tous les
 * modes de défaillance du comptage sont fail-closed (cf.
 * `countsAgainstCap`). Toute modification PASSE par compliance-auditor
 * (subagent obligatoire).
 */
export const RATE_LIMIT_MAX_MESSAGES = 4;

/**
 * Largeur de la fenêtre en jours (glissante, calculée vs `now`).
 *
 * **Exposée publique** depuis PR-FILTRE-SOLLICITATION : `pre-send-check`
 * la consomme pour construire le contexte d'audit `rate_limit_exceeded`.
 * Auparavant la valeur y était hardcodée à `30` — drift possible.
 */
export const RATE_LIMIT_WINDOW_DAYS = 30;

/**
 * Décompte des sortants d'un contact dans la fenêtre, séparant ce qui
 * COMPTE (sollicitations) de ce qui a simplement été envoyé.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * RAISON D'ÊTRE — une seule fenêtre, un seul filtre, deux consommateurs
 *
 * `canSendMessage` (la décision) et `preSendCheck` (le contexte d'audit)
 * ont besoin des mêmes chiffres. Les recalculer séparément a déjà produit
 * une incohérence par le passé : le `context.count` de l'audit utilisait
 * la longueur BRUTE du tableau tandis que le `reason` utilisait la
 * longueur filtrée sur 30j — identiques en pratique (les callers
 * pré-filtrent), divergents en droit. Un seul calcul, exporté.
 *
 * @param outboundMessages Historique sortant du contact.
 * @param now              Référence temporelle.
 *
 * @returns `solicitationCount` (ce qui compte contre le plafond) et
 *          `totalOutboundCount` (tous les sortants de la fenêtre, réponses
 *          comprises). L'écart entre les deux EST la preuve L.34-5 :
 *          « 4 sollicitations sur 14 messages échangés ».
 */
export function countSolicitationsInWindow(
  outboundMessages: OutboundMessageRecord[],
  now: Date = new Date(),
): { solicitationCount: number; totalOutboundCount: number } {
  const inWindow = outboundMessages.filter(
    (m) => differenceInDays(now, toDate(m.sentAt)) <= RATE_LIMIT_WINDOW_DAYS,
  );

  return {
    // 🔒 `countsAgainstCap` est le SEUL point de décision « ça compte ou
    // pas ». Ne JAMAIS écrire ici un test de nature à la main : la forme
    // `!== "solicitation"` exclurait les docs legacy du comptage, soit un
    // sous-comptage silencieux du plafond (cf. MAJEUR-1, PR #42).
    solicitationCount: inWindow.filter(countsAgainstCap).length,
    totalOutboundCount: inWindow.length,
  };
}

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
 * Vrai si on peut envoyer un nouveau SMS au regard du plafond
 * 4 SOLLICITATIONS / 30 jours.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 SEULES LES SOLLICITATIONS COMPTENT (PR-FILTRE-SOLLICITATION)
 *
 * L.34-5 CPCE encadre la **prospection** : les messages par lesquels on
 * prend l'initiative de déranger la personne. Répondre à un PS qui vient
 * de nous écrire n'est pas une sollicitation — c'est la suite d'un échange
 * qu'il a lui-même engagé.
 *
 * Conséquence directe et VOULUE : une conversation vivante peut compter
 * 10, 20 réponses sans jamais approcher le plafond, tandis que 4 premiers
 * SMS non répondus le saturent. Le compteur suit le dérangement, pas le
 * volume.
 *
 * La discrimination passe EXCLUSIVEMENT par `countsAgainstCap()` — jamais
 * par un test de nature écrit sur place.
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
  const { solicitationCount, totalOutboundCount } = countSolicitationsInWindow(
    outboundMessages,
    now,
  );

  if (solicitationCount >= RATE_LIMIT_MAX_MESSAGES) {
    return {
      allowed: false,
      reason: `Plafond ${RATE_LIMIT_MAX_MESSAGES}/${RATE_LIMIT_WINDOW_DAYS}j atteint (${solicitationCount} sollicitations sur ${totalOutboundCount} envois récents)`,
    };
  }
  return { allowed: true };
}
