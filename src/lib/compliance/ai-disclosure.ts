/**
 * Règle 1 (skill `medere-sms-compliance`) — Annonce IA dans le 1er SMS.
 *
 * AI Act Article 50 (applicable 2 août 2026) : tout système d'IA en
 * interaction avec un humain doit s'annoncer clairement. Pour Médéré, on
 * valide CÔTÉ CODE qu'un message contient une mention IA explicite avant
 * de remettre le SMS à OVH. La validation est appliquée par
 * `pre-send-check` (S5) uniquement au PREMIER SMS d'une conversation.
 *
 * Sanction AI Act : jusqu'à 15 M€ ou 3 % du CA mondial.
 *
 * SOURCE DE VÉRITÉ : la skill `medere-sms-compliance`. Les patterns
 * ci-dessous sont copiés TELS QUELS — pas d'ajout, pas de retrait sans
 * validation juridique. Les prompts Claude (`first-sms` en Phase 3) sont
 * calibrés sur ces patterns ; toute évolution doit repasser par
 * `compliance-auditor`.
 */

/**
 * Patterns regex constituant une annonce IA valide. Logique OR : un seul
 * match suffit. Flag `/i` pour insensibilité à la casse.
 */
const AI_DISCLOSURE_PATTERNS: readonly RegExp[] = [
  /assistant(e)?\s+(virtuel(le)?|IA|intelligence\s+artificielle)/i,
  /(je suis|c'est)\s+Léa/i,
  /assistant(e)?\s+automatisé(e)?/i,
  /agent\s+(virtuel|IA)/i,
];

/**
 * Vrai si le message contient une annonce IA au sens de l'AI Act art. 50.
 * À utiliser AVANT envoi d'un premier SMS.
 *
 * Réservé aux messages SORTANTS générés (par Claude ou humain). Ne pas
 * utiliser pour analyser un message entrant.
 */
export function hasAIDisclosure(message: string): boolean {
  return AI_DISCLOSURE_PATTERNS.some((p) => p.test(message));
}
