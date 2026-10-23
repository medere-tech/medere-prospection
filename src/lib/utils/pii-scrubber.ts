/**
 * Nettoyeur PII (téléphone + email) partagé.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * SOURCE UNIQUE DE VÉRITÉ POUR LES REGEX PII
 *
 * Historiquement, le logger (`src/lib/utils/logger.ts`) a été le PREMIER
 * à introduire une regex `PHONE_REGEX` + `EMAIL_REGEX` + une normalisation
 * des séparateurs inter-chiffres pour détecter un numéro FR même quand il
 * est écrit sous la forme `06-12-34-56-78` ou `06.12.34.56.78`.
 *
 * PR2a (liste `/admin/conversations`) a introduit un deuxième besoin :
 * stocker un extrait du dernier message (`conversation.lastMessagePreview.
 * text`) sans PII. Au lieu de dupliquer les regex, on les extrait ici et
 * logger.ts + conversation-list-fields.ts + la route liste importent de
 * ce module. Un seul endroit à amender quand on découvre un nouveau
 * format de numéro.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Ce que ce module ne fait PAS
 *
 *   - Ne définit PAS la logique de "bypass par clé technique" (contactId,
 *     messageId...). Celle-ci reste dans `logger.ts` car elle est
 *     spécifique à la couche logs (clé/valeur), pas au scrub d'un simple
 *     texte libre.
 *   - Ne fait PAS de truncation. Les callers qui ont besoin d'un extrait
 *     court (preview UI) composent avec un simple `slice`.
 */

/** Placeholder utilisé pour masquer un numéro détecté. */
export const PHONE_PLACEHOLDER = "[PHONE]";

/** Placeholder utilisé pour masquer un email détecté. */
export const EMAIL_PLACEHOLDER = "[EMAIL]";

/**
 * Détecte un numéro de téléphone international ou national FR avec les
 * séparateurs réels rencontrés en prod : espaces, points, tirets, parenthèses.
 *   +33612345678 / +33 6 12 34 56 78 / +33-6-12-34-56-78 / +33.6.12.34.56.78
 *   +33(0)612345678 / 0612345678 (national sans +33)
 *
 * Compromis assumé (hérité du logger PR0) : possibles faux positifs sur
 * des suites de chiffres purement décoratives > 9 chiffres avec
 * séparateurs. On préfère sur-scrubber qu'oublier un numéro réel.
 */
export const PHONE_REGEX = /\+?\d[\d\s.\-()]{6,18}\d/g;

/** RFC 5322 simplifié — suffisant pour la détection courante. */
export const EMAIL_REGEX = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}/g;

/**
 * Match un numéro FR N'IMPORTE OÙ dans une valeur normalisée (après
 * suppression des séparateurs inter-chiffres), délimité par des
 * non-chiffres ou début/fin de chaîne.
 *
 * Les trois alternances ciblent le national FR (10 digits), l'E.164
 * sans + (11 digits) et le préfixe 00+33 (13 digits).
 */
export const FRENCH_PHONE_ANYWHERE_REGEX = /(^|\D)(0[1-9]\d{8}|33[1-9]\d{8}|0033[1-9]\d{8})(\D|$)/;

/**
 * Supprime UNIQUEMENT les séparateurs situés ENTRE DEUX CHIFFRES.
 * Capte les formats courants d'un numéro FR formaté :
 *   `06-12-34-56-78`, `06.12.34.56.78`, `06 12 34 56 78`, `06:12:34:56:78`.
 *
 * Préserve les séparateurs structurels :
 *   - `hubspotId_campaignId` : `_` entre chiffre et lettre → reste.
 *   - `sms.reply.oih_abcd`   : `.` et `_` entre lettres → restent.
 *   - `1792422107.910000`    : `.` entre deux chiffres → supprimé, mais
 *     la concaténation `1792422107910000` ne match aucun pattern FR
 *     (commence par `1`, pas `0`/`33`/`0033`).
 */
export function normalizeInterDigitSeparators(value: string): string {
  return value.replace(/(?<=\d)[-_.: ](?=\d)/g, "");
}

/**
 * `true` si la valeur, après normalisation, contient un numéro FR
 * (national, E.164 sans +, ou préfixe 00+33) délimité par des non-chiffres.
 * Utilisé comme sentinelle de sortie (ex: route `/api/admin/conversations`)
 * pour prouver qu'une payload ne porte aucun numéro.
 */
export function containsFrenchPhoneNumber(value: string): boolean {
  const normalized = normalizeInterDigitSeparators(value);
  return FRENCH_PHONE_ANYWHERE_REGEX.test(normalized);
}

/**
 * `true` si la valeur contient un email RFC-5322 simplifié. Partage la
 * regex avec `scrubPiiFromText` (via `EMAIL_REGEX`). Utilisé par la
 * sentinelle de sortie `no-phone-in-payload.test.ts`.
 *
 * Note : `EMAIL_REGEX` est global (`/g`), on recrée un match pour
 * éviter le piège `lastIndex` sur appels successifs.
 */
export function containsEmail(value: string): boolean {
  return new RegExp(EMAIL_REGEX.source, EMAIL_REGEX.flags.replace("g", "")).test(value);
}

/**
 * Scrub par VALEUR sur une string : email scruber appliqué en premier
 * (un email peut contenir des chiffres dans le local part — on évite
 * que la regex phone le mange), puis phone.
 *
 * `scrubPhoneAndEmail("texte 06 12 34 56 78 end")` → `"texte [PHONE] end"`.
 */
export function scrubPiiFromText(value: string): string {
  return value.replace(EMAIL_REGEX, EMAIL_PLACEHOLDER).replace(PHONE_REGEX, PHONE_PLACEHOLDER);
}
