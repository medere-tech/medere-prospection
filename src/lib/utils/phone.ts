/**
 * Normalisation et masquage des numéros de téléphone (format E.164).
 *
 * On utilise le bundle `libphonenumber-js/max` (et non le défaut `min`) : seul
 * `/max` embarque les metadata permettant à `getType()` de distinguer mobile /
 * fixe / VoIP pour la France. Cette distinction pilote la segmentation B2C
 * (mobile perso → vérif Bloctel obligatoire), elle doit être fiable.
 *
 * Le type renvoyé ici reste une heuristique : la source de vérité (carrier,
 * type confirmé) est Twilio Lookup, appelé en Phase 2.
 */
import type { CountryCode } from "libphonenumber-js";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";

export type PhoneType = "mobile" | "landline" | "voip" | "unknown";

/** Pays par défaut quand le numéro est en format national (sans indicatif). */
const DEFAULT_COUNTRY: CountryCode = "FR";

/** Résultat d'un parsing best-effort. */
export interface ParsedPhone {
  /** Numéro au format E.164 (ex: +33612345678). */
  e164: string;
  /** true si le numéro est un numéro valide pour son pays. */
  valid: boolean;
  /** Type heuristique (à confirmer via Twilio Lookup). */
  type: PhoneType;
}

function mapType(libType: string | undefined): PhoneType {
  switch (libType) {
    case "MOBILE":
      return "mobile";
    case "FIXED_LINE":
      return "landline";
    case "VOIP":
      return "voip";
    // FIXED_LINE_OR_MOBILE, PREMIUM_RATE, TOLL_FREE, etc. → on ne tranche pas.
    default:
      return "unknown";
  }
}

/**
 * Parse un numéro (national ou international) en best-effort.
 * Renvoie `null` si la chaîne n'est pas interprétable comme un numéro.
 */
export function parsePhone(
  raw: string,
  defaultCountry: CountryCode = DEFAULT_COUNTRY,
): ParsedPhone | null {
  const parsed = parsePhoneNumberFromString(raw, defaultCountry);
  if (!parsed) return null;
  return {
    e164: parsed.number,
    valid: parsed.isValid(),
    type: mapType(parsed.getType()),
  };
}

/**
 * Convertit un numéro en E.164 **uniquement s'il est valide**.
 * Renvoie `null` sinon. À utiliser avant tout envoi SMS (on n'envoie jamais
 * vers un numéro non valide).
 */
export function toE164(raw: string, defaultCountry: CountryCode = DEFAULT_COUNTRY): string | null {
  const parsed = parsePhone(raw, defaultCountry);
  return parsed && parsed.valid ? parsed.e164 : null;
}

/**
 * Vérifie qu'une chaîne est déjà un numéro E.164 valide (commence par `+`,
 * indicatif inclus). N'applique aucun pays par défaut.
 */
export function isValidE164(value: string): boolean {
  const parsed = parsePhoneNumberFromString(value);
  return Boolean(parsed && parsed.isValid() && parsed.number === value);
}

/**
 * Type heuristique d'un numéro. Renvoie `'unknown'` si non interprétable ou
 * si le type ne peut être déterminé sans ambiguïté.
 */
export function inferPhoneType(
  raw: string,
  defaultCountry: CountryCode = DEFAULT_COUNTRY,
): PhoneType {
  return parsePhone(raw, defaultCountry)?.type ?? "unknown";
}

/**
 * Masque un numéro pour les logs : conserve l'indicatif et les 2 derniers
 * chiffres, masque le reste. Ne jamais logger un numéro complet (règle PII).
 * Ex: `+33612345678` → `+33*******78`.
 */
export function maskPhone(value: string): string {
  if (value.length <= 6) return "*".repeat(value.length);
  const head = value.slice(0, 3);
  const tail = value.slice(-2);
  return head + "*".repeat(value.length - 5) + tail;
}
