/**
 * Règle 6 (skill `medere-sms-compliance`) — Identification de l'annonceur "Médéré".
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * FONDEMENT JURIDIQUE PRINCIPAL — Article L.34-5 alinéa 5 du Code des postes
 * et des communications électroniques (CPCE), version en vigueur depuis le
 * 26 juillet 2020 (LOI n°2020-901 du 24 juillet 2020). Texte exact :
 *
 *   « Il est également interdit de dissimuler l'identité de la personne
 *    pour le compte de laquelle la communication est émise et de mentionner
 *    un objet sans rapport avec la prestation ou le service proposé. »
 *
 * DOCTRINE CONSOLIDÉE — CNIL, fiche « La prospection commerciale par
 * SMS-MMS » : « Chaque message électronique doit obligatoirement préciser
 * l'identité de l'annonceur. »
 *
 * PRÉCÉDENT — sanction CNIL SOLOCAL MARKETING SERVICES du 15 mai 2025,
 * amende de 900 000 €, prononcée notamment pour démarchage SMS sans
 * consentement valide et défaut d'identification claire de l'annonceur.
 * Le contrôle CNIL impose désormais aux routeurs/annonceurs un dispositif
 * d'audit autonome de la traçabilité du consentement ET de l'identification.
 *
 * CONTEXTE POLITIQUE (motivation du timing, PAS du fondement) — la loi
 * n° 2025-594 du 30 juin 2025 contre toutes les fraudes aux aides publiques
 * (article 13) bascule le démarchage téléphonique VOIX B2C vers l'opt-in
 * au 11 août 2026 et supprime Bloctel. Elle modifie L.223-1 du Code de la
 * consommation, PAS L.34-5 CPCE — elle n'est donc pas le fondement de la
 * présente règle. Mais elle illustre le durcissement général du contrôle
 * CNIL sur la prospection commerciale, ce qui motive la mise en conformité
 * Médéré anticipée (deadline interne 1er juillet 2026 < deadline politique
 * 11 août 2026).
 *
 * CHAMP D'APPLICATION : B2C ET B2B. En B2B, l'intérêt légitime remplace
 * l'opt-in préalable, mais l'identification de l'annonceur reste obligatoire
 * dans CHAQUE SMS sortant (la loi ne dispense personne d'identifier
 * l'émetteur).
 *
 * SANCTIONS — L.34-5 alinéa 8 CPCE :
 *   - Personne physique : jusqu'à 75 000 €
 *   - Personne morale   : jusqu'à 375 000 €
 *   - Cumul RGPD possible : jusqu'à 20 M€ ou 4 % du CA mondial (CNIL).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * USAGE — fonction PURE, aucun I/O. À utiliser AVANT envoi sur tout SMS
 * SORTANT (généré par Claude ou rédigé manuellement). Ne PAS utiliser pour
 * analyser un message entrant (`isOptOut` couvre l'inbound).
 *
 * La règle est appelée par l'orchestrateur `pre-send-check.ts` en position
 * 4 (après `stop_present`, avant `rate_limit`) — groupée avec les autres
 * vérifications de contenu du body (O(1) regex) avant les vérifications
 * de contexte d'envoi (O(n) historiques, dates, etc.).
 *
 * SOURCE DE VÉRITÉ : la skill `medere-sms-compliance`. Le pattern ci-dessous
 * est figé — pas d'élargissement ni de retrait sans validation
 * compliance-auditor.
 */

/**
 * Pattern regex constituant une identification valide de l'annonceur
 * "Médéré" dans un SMS sortant. Tolère :
 *
 *   - les variantes d'accents : `é` et `e` interchangeables sur chacune
 *     des 3 voyelles (les routeurs SMS strippent parfois les accents en
 *     encodage GSM-7, et les prompts Claude peuvent varier) ;
 *
 *   - la casse libre via le flag `/i` (les prompts capitalisent
 *     différemment selon le contexte rédactionnel).
 *
 * La règle n'impose PAS de position dans le body : L.34-5 alinéa 5 CPCE
 * exige seulement que l'identité ne soit pas dissimulée. Le match
 * fonctionne donc en début, milieu OU fin de message.
 *
 * Variantes ACCEPTÉES (toutes combinaisons {é,e}³ × casse) : "Médéré",
 * "Medere", "MEDERE", "médéré", "Médere", "medéré", "MédéRé", etc.
 *
 * Variantes REJETÉES (anti-typosquatting) : "Mederro", "Medera", "Médéro",
 * "Médecin", "Modere", "Méduse". Le 6e caractère doit être `é` ou `e`,
 * ce qui ferme la porte aux substitutions sur la voyelle finale.
 *
 * 🔒 **SENTINEL GUARD-003** — exporté pour permettre au test sentinelle de
 * `advertiser-identification.test.ts` de verrouiller la valeur. Toute
 * modification (élargissement ou restriction du pattern) cassera le build
 * — c'est volontaire. Si tu dois modifier : (a) parle à Déthié, (b)
 * re-passe par compliance-auditor, (c) mets à jour GUARD-003 dans Notion.
 */
export const ADVERTISER_PATTERN: RegExp = /m[ée]d[ée]r[ée]/i;

/**
 * Vrai si le message SORTANT contient une identification de l'annonceur
 * "Médéré" au sens de L.34-5 alinéa 5 CPCE. À utiliser AVANT envoi pour
 * valider qu'on n'a pas dissimulé l'identité de l'annonceur.
 *
 * Réservé aux messages SORTANTS (générés par Claude ou rédigés manuellement).
 * Ne pas utiliser pour analyser un message entrant.
 */
export function hasAdvertiserIdentification(message: string): boolean {
  return ADVERTISER_PATTERN.test(message);
}
