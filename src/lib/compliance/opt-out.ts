/**
 * Règle 2 (skill `medere-sms-compliance`) — Opt-out STOP.
 *
 * Deux fonctions distinctes pour deux contextes :
 *
 *   - `hasOptOut(outboundMessage)` : valide qu'un message SORTANT (généré
 *     par Claude ou rédigé manuellement) contient bien "STOP" pour offrir
 *     au PS le moyen de refuser. Word boundary `\b` pour éviter le match
 *     accidentel dans "STOPPER", "STOPPAGE", etc.
 *
 *   - `isOptOut(incomingMessage)` : détecte qu'un message ENTRANT du PS
 *     est un opt-out. Plus permissif : on inclut les variantes "STOPP",
 *     "ARRET", "DESINSCRIPTION", "UNSUB" et on accepte les accents via
 *     normalisation Unicode NFD + strip diacritiques. PRÉCAUTION
 *     JURIDIQUE : on préfère un faux positif (couper la conversation
 *     d'un PS qui dit "STOPPER" en discussion) à un faux négatif (rater
 *     un vrai opt-out → sanction CNIL).
 *
 * SOURCE DE VÉRITÉ : la skill `medere-sms-compliance`. La liste
 * `OPT_OUT_KEYWORDS` est copiée TELLE QUELLE — pas d'ajout sans validation
 * juridique (REFUSE, DESABONNER, NEPASCONTACTER explicitement écartés pour
 * S4).
 *
 * Sanction CNIL : jusqu'à 20 M€ ou 4 % du CA mondial.
 */

/**
 * Mots-clés d'opt-out stockés SANS accent et en MAJUSCULES. On normalise
 * le message ENTRANT (NFD + strip diacritiques + uppercase) avant d'y
 * chercher ces mots-clés. NE PAS ajouter d'accents ici, NE PAS ajouter de
 * nouveaux mots sans repasser par `compliance-auditor`.
 */
const OPT_OUT_KEYWORDS: readonly string[] = ["STOP", "STOPP", "ARRET", "DESINSCRIPTION", "UNSUB"];

/**
 * Seuil au-delà duquel un message entrant n'est PLUS interprété comme
 * opt-out mais comme conversation (skill = 50 caractères). Évite qu'une
 * phrase longue contenant "stop" par hasard ne déclenche un opt-out.
 */
const OPT_OUT_MAX_INCOMING_LENGTH = 50;

/**
 * Vrai si le message SORTANT contient le mot "STOP" (insensible à la casse,
 * avec word boundaries). À utiliser AVANT envoi pour valider qu'on offre
 * l'opt-out.
 *
 * "STOPPER", "STOPPAGE", etc. ne matchent PAS (boundary `\b` requiert un
 * passage word-char/non-word-char autour de STOP).
 */
export function hasOptOut(outboundMessage: string): boolean {
  return /\bSTOP\b/i.test(outboundMessage);
}

/**
 * Normalise un message entrant : NFD + retire les diacritiques + trim +
 * uppercase. Permet à "Arrêt" de matcher le mot-clé stocké "ARRET".
 */
function normalizeIncoming(raw: string): string {
  // 1. `NFKD` (et non NFD) : décompose aussi les caractères de compatibilité
  //    (ligatures, formes "wide"…) en plus des accents — élimine plus de
  //    surface d'évasion.
  // 2. Classes Unicode (flag `u`) retirées :
  //    - `\p{Mn}` (Mark, Nonspacing) : tous les diacritiques combinants.
  //    - `\p{Cf}` (Format) : caractères invisibles qui pourraient être
  //      glissés au milieu d'un mot-clé pour le contourner — ex. ZWSP
  //      (U+200B), BOM (U+FEFF), Word Joiner (U+2060), Soft Hyphen (U+00AD).
  //      C'est l'attaque "S​TOP" identifiée par security-reviewer S4 (M1).
  //    - `\p{Cc}` (Control) : caractères de contrôle ASCII (tab, LF…) +
  //      C1 controls. Le `.trim()` suivant gère espaces visibles.
  return raw
    .normalize("NFKD")
    .replace(/[\p{Mn}\p{Cf}\p{Cc}]/gu, "")
    .trim()
    .toUpperCase();
}

/**
 * Vrai si le message ENTRANT du PS est interprété comme un opt-out.
 *
 * Algorithme (skill medere-sms-compliance) :
 *   1. Normaliser : NFD + strip diacritiques + trim + uppercase.
 *   2. Si vide ou > 50 chars → considéré comme conversation, pas opt-out.
 *   3. Vérifier si la string contient un des `OPT_OUT_KEYWORDS` via
 *      `String.includes()`.
 *
 * COMPORTEMENT VOLONTAIRE :
 *   - "STOPPER" (contient "STOP") → true (précaution juridique).
 *   - "arrete moi de me contacter" → true (contient "ARRET" après norm).
 *   - Phrase longue avec "stop" perdu dedans → false (>50 chars).
 *
 * Si un PS écrit "Arrête, merci" en 14 chars, c'est un opt-out clair.
 * Si un PS écrit "Je voudrais qu'on arrête cette campagne s'il vous plaît
 * merci pour votre compréhension" en > 50 chars, c'est de la conversation
 * → traité par le classifieur Claude (S7) qui lui détectera STOP via
 * l'intent classifier.
 */
export function isOptOut(incomingMessage: string): boolean {
  const normalized = normalizeIncoming(incomingMessage);
  if (normalized.length === 0) return false;
  if (normalized.length > OPT_OUT_MAX_INCOMING_LENGTH) return false;
  return OPT_OUT_KEYWORDS.some((kw) => normalized.includes(kw));
}
