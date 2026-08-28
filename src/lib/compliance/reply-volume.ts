/**
 * BARRIÈRE 2 — plafond de VOLUME des réponses automatiques.
 * **10 réponses / 24 heures glissantes / CONTACT.**
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 CE N'EST PAS UN PLAFOND LÉGAL — LIRE AVANT DE MODIFIER
 *
 * À ne pas confondre avec `rate-limits.ts` (4 SOLLICITATIONS / 30 jours),
 * qui est la transposition directe de L.34-5 CPCE. Les deux plafonds
 * coexistent, sont INDÉPENDANTS, et n'ont ni le même sujet, ni la même
 * fenêtre, ni la même nature :
 *
 *   | Plafond          | Sujet          | Fenêtre | Nature   | Sanction  |
 *   |------------------|----------------|---------|----------|-----------|
 *   | rate-limits.ts   | sollicitations | 30 j    | LÉGALE   | CNIL 20M€ |
 *   | reply-volume.ts  | réponses       | 24 h    | SÉCURITÉ | réputation|
 *
 * Ce module est un DISJONCTEUR. Il existe parce qu'en excluant les
 * réponses du comptage légal (PR-FILTRE-SOLLICITATION), on a retiré le
 * dernier plafond de volume sortant vers une personne : le pipeline
 * `process-reply` répond automatiquement à tout entrant sauf STOP, donc un
 * standard médical avec accusé de réception automatique pouvait déclencher
 * un ping-pong non borné.
 *
 * Juridiquement, ces échanges ne sont pas des sollicitations. Mais 30 SMS
 * en 48 h vers un même professionnel se plaide comme du harcèlement
 * indépendamment de la qualification L.34-5, et abîme la marque dans le
 * médical bien avant qu'une amende n'arrive.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ⚠️ AVERTISSEMENT INVERSÉ vs `rate-limits.ts`
 *
 * Modifier `RATE_LIMIT_MAX_MESSAGES` a une implication CNIL directe.
 * Modifier `REPLY_VOLUME_MAX` n'en a AUCUNE — mais a une implication
 * EXPÉRIENCE PS, et elle est asymétrique :
 *
 *   - trop BAS  → on fait taire des conversations réelles. Un PS engagé
 *                 écrit et ne reçoit plus rien, sans que personne ne s'en
 *                 aperçoive. C'est le risque principal de ce module.
 *   - trop HAUT → le disjoncteur ne disjoncte pas, on revient au
 *                 comportement d'avant (ping-pong possible).
 *
 * Le seuil de 10 est calibré large exprès : une conversation humaine
 * saine dépasse rarement 3-4 allers-retours par jour. À 10, on ne coupe
 * qu'un emballement manifeste.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * COÛT NUL EN LECTURE
 *
 * Les 3 call sites compliance chargent déjà 30 jours d'historique
 * per-contact (`listRecentOutboundByContact{,InTx}`). La fenêtre 24 h
 * étant un SOUS-ENSEMBLE de 30 jours, le filtrage se fait EN MÉMOIRE sur
 * les données déjà en main : zéro query Firestore supplémentaire, zéro
 * index, zéro modification du verrouillage transactionnel.
 *
 * ⚠️ Ne JAMAIS « optimiser » en rechargeant l'historique avec `days: 1` —
 * ça déclencherait un second fan-out N+1 (une query par conversation du
 * contact) pour une donnée déjà disponible.
 */
import { differenceInHours } from "date-fns";

import { countsAsReply } from "@/lib/compliance/outbound-kind";
import type { ComplianceCheckResult, OutboundMessageRecord } from "@/lib/compliance/rate-limits";

/**
 * Plafond de réponses dans la fenêtre. Cf. avertissement INVERSÉ en tête
 * de module : pas d'implication CNIL, mais implication expérience PS.
 */
export const REPLY_VOLUME_MAX = 10;

/**
 * Largeur de la fenêtre en HEURES (glissante, calculée vs `now`).
 *
 * 🔒 En HEURES et non en jours : `differenceInDays` TRONQUE. Un message
 * envoyé il y a 30 heures donnerait `1`, donc `1 <= 1` → il serait compté
 * dans une prétendue fenêtre « 24 h ». La fenêtre serait en réalité de
 * ~48 h. Cf. `countReplyVolumeInWindow` et sa sentinelle de mutation.
 */
export const REPLY_VOLUME_WINDOW_HOURS = 24;

/**
 * Convertit un `Timestamp | Date` en `Date`. Dupliqué depuis
 * `rate-limits.ts` (helper privé là-bas) plutôt qu'importé : ce module
 * est délibérément SANS dépendance vers le fichier légal, hors les types.
 */
function toDate(value: Date | { toDate(): Date }): Date {
  return value instanceof Date ? value : value.toDate();
}

/**
 * Compte les RÉPONSES d'un contact dans la fenêtre de 24 heures.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * BORNE INCLUSIVE — cohérent avec la convention du projet
 *
 * `differenceInHours(now, sentAt) <= 24` : un message envoyé il y a
 * EXACTEMENT 24 h est COMPTÉ. Même parti pris restrictif que la borne
 * « J-30 PILE est compté » du plafond légal (décision S4 validée par
 * Déthié). `differenceInHours` tronque aussi, mais dans le bon sens ici :
 * 24 h 59 min → `24` → compté ; 25 h 00 → `25` → exclu.
 *
 * @param outboundMessages Historique sortant du contact (30 j chargés en
 *   amont — on filtre le sous-ensemble 24 h en mémoire).
 * @param now Référence temporelle. Injectable pour tests déterministes.
 *
 * @returns `replyCount` (réponses dans la fenêtre 24 h) et
 *          `totalOutboundCount` (tous les sortants de cette même fenêtre,
 *          sollicitations comprises). L'écart documente le contexte de
 *          l'emballement dans l'audit.
 */
export function countReplyVolumeInWindow(
  outboundMessages: OutboundMessageRecord[],
  now: Date = new Date(),
): { replyCount: number; totalOutboundCount: number } {
  const inWindow = outboundMessages.filter(
    (m) => differenceInHours(now, toDate(m.sentAt)) <= REPLY_VOLUME_WINDOW_HOURS,
  );

  return {
    // 🔒 `countsAsReply` (complément de `countsAgainstCap`) est le SEUL
    // point de décision « c'est une réponse ou pas ». Ne JAMAIS écrire ici
    // un `=== "reply"` à la main : les deux plafonds partitionneraient
    // alors les sortants de façon incohérente.
    replyCount: inWindow.filter(countsAsReply).length,
    totalOutboundCount: inWindow.length,
  };
}

/**
 * Vrai si on peut envoyer une RÉPONSE de plus au regard du plafond de
 * volume 10 / 24 h.
 *
 * ⚠️ Fonction PURE et AVEUGLE À LA NATURE du message sortant : elle
 * compte l'historique, elle ne sait pas ce qu'on s'apprête à envoyer.
 * C'est `preSendCheck` (règle 6) qui n'applique son verdict QUE si
 * `outboundKind === "reply"` — une sollicitation n'est JAMAIS bloquée par
 * ce plafond, même sur un contact en plein emballement.
 *
 * @param outboundMessages Historique des messages sortants du contact.
 * @param now Référence temporelle (défaut `new Date()`).
 */
export function canSendReplyVolume(
  outboundMessages: OutboundMessageRecord[],
  now: Date = new Date(),
): ComplianceCheckResult {
  const { replyCount, totalOutboundCount } = countReplyVolumeInWindow(outboundMessages, now);

  if (replyCount >= REPLY_VOLUME_MAX) {
    return {
      allowed: false,
      reason: `Plafond volume ${REPLY_VOLUME_MAX} réponses/${REPLY_VOLUME_WINDOW_HOURS}h atteint (${replyCount} réponses sur ${totalOutboundCount} envois récents)`,
    };
  }
  return { allowed: true };
}
