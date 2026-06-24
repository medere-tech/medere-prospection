/**
 * Mapper HubSpot → Firestore ContactSchema (S10.1.2.b).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rôle métier
 *
 *   Pure function (zéro side effect, zéro I/O) qui transforme un
 *   `HubspotContactRaw` (sortie `contacts.ts::getContact[sInList]`) en
 *   `CreateContactInput` directement consommable par
 *   `firestore/contacts.ts::createContact`.
 *
 *   Consommée par :
 *     - Seed S10.1.3 (mass import 200 contacts depuis liste HubSpot SMS)
 *     - Future route admin "Refresh contact depuis HubSpot" (S10.X+)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pureté & idempotence
 *
 *   - Pas de network call, pas de Firestore write, pas de log (sauf
 *     l'inclusion d'une `Timestamp.now()` qui est techniquement non-pure
 *     mais déterministe à seconde près — acceptable car le seed et les
 *     tests injectent un `now` via option pour reproductibilité).
 *
 *   - Idempotence : même `raw` + même `campaignId` + même `now` → même
 *     output. Verrouillé par test sentinelle.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Validation stricte des champs requis
 *
 *   Si une propriété HubSpot critique est absente/vide/mal formée, le
 *   mapper throw `ValidationError` avec un context anti-PII (pas de
 *   firstname/lastname/phone brut dans le message). Le caller (seed)
 *   décide : skip ce contact + log warn, OU abort le seed entier.
 *
 *   Champs REQUIS :
 *     - `firstname` (non vide après trim)
 *     - `lastname`  (non vide après trim)
 *     - `profession` ∈ `CONTACT_SPECIALITY_VALUES` (21 valeurs HubSpot)
 *     - Au moins un de `mobilephone` ou `phone` (priorité mobilephone)
 *       → normalisable en E.164 FR via `toE164`
 *
 *   Champs OPTIONNELS (mappés en `undefined` si absents/vides) :
 *     - `email`, `civilite`, `city`, `zip`
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Anti-fuite PII dans erreurs
 *
 *   Si `profession` HubSpot n'est pas dans les 21 valeurs (drift CRM
 *   Médéré), le ValidationError context contient `professionFingerprint`
 *   (hash court de la valeur) — diagnostic possible sans exposer la
 *   valeur brute dans Sentry/logs.
 *
 *   Les autres champs (firstname, etc.) ne fuitent JAMAIS dans le
 *   context d'erreur (juste leur path).
 */

import { Timestamp } from "firebase-admin/firestore";

import { CONTACT_SPECIALITY_VALUES } from "@/lib/firestore/contacts";
import { ValidationError } from "@/lib/utils/errors";
import { parsePhone, type PhoneType, toE164 } from "@/lib/utils/phone";
import type { Contact, ContactCivilite, ContactSegment, ContactSpeciality } from "@/types/contact";

import type { HubspotContactRaw } from "./contacts";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes mapping (sentinelles)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mapping STRICT civilité HubSpot → ContactSchema Firestore.
 *
 * 🔒 SENTINEL — modification = re-validation Déthié + impact downstream
 * (les enums ContactCivilite côté Firestore + l'affichage UI dans les
 * commerciaux dashboards changeraient).
 *
 * Si HubSpot retourne `null`, `""`, ou une valeur non listée (drift),
 * `civilite` est mappé en `undefined` (la propriété est optionnelle
 * dans `ContactSchema`). Pas de throw — la civilité n'est pas un
 * champ requis pour envoyer un SMS de prospection.
 */
export const HUBSPOT_CIVILITE_MAP: Readonly<Record<string, ContactCivilite>> = {
  Docteur: "Dr",
  Professeur: "Pr",
  Monsieur: "M.",
  Madame: "Mme",
} as const;

/**
 * Texte par défaut documentant l'intérêt légitime RGPD art. 6.1.f pour
 * l'import HubSpot. ≥ 20 chars (invariant `ContactConsentSchema`).
 *
 * 🔒 SENTINEL — modification = re-validation compliance-auditor +
 * doc Notion. Le texte doit refléter la base légale réelle invoquée
 * dans le registre des traitements Médéré.
 */
export const HUBSPOT_DEFAULT_LEGITIMATE_INTEREST =
  "Intérêt légitime: démarchage SMS B2B PS médico-dentaire MVP Médéré DPC v1";

/**
 * Set précalculé pour O(1) check du profession HubSpot contre les 21
 * valeurs autorisées. Évite un `.includes()` O(N) par contact (sur 200
 * contacts × 21 valeurs = ~4200 comparaisons vs 200 lookups Set).
 */
const SPECIALITY_VALUES_SET: ReadonlySet<string> = new Set(CONTACT_SPECIALITY_VALUES);

// ─────────────────────────────────────────────────────────────────────────────
// Types publiques
// ─────────────────────────────────────────────────────────────────────────────

export interface MapHubSpotContactInput {
  /** Donnée brute HubSpot (retour `getContact[sInList]`). */
  raw: HubspotContactRaw;
  /** Campaign ID Firestore — `hubspot-list-${listId}` côté seed. */
  campaignId: string;
  /** Now injectable pour tests reproductibles. Default `Timestamp.now()`. */
  now?: Timestamp;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers internes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalise une string HubSpot : trim + traite `null`/`""` comme `undefined`.
 */
function normalizeString(v: string | null | undefined): string | undefined {
  if (v === null || v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Hash court (8 chars hex) d'une string — diagnostic forensic dans
 * ValidationError context sans fuite de la valeur brute. djb2 hash
 * suffisant pour fingerprint diag (pas de garantie crypto).
 */
function shortFingerprint(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) & 0xffffffff;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Dérive le segment Bloctel depuis le type de ligne téléphonique heuristique
 * (S10.1.9 BLOCTEL-001).
 *
 *   - mobile   → "b2c_mobile_perso" (vérif Bloctel obligatoire L.34-5 CPCE)
 *   - landline → "b2b_cabinet"      (ligne pro exemptée Bloctel)
 *   - voip     → "b2b_cabinet"      (standard téléphonique pro type 3CX /
 *                                    RingCentral, contexte cabinet dentaire)
 *   - unknown  → "unknown"          (préservé pour TRACER l'incertitude — ne
 *                                    pas masquer derrière b2b_cabinet par
 *                                    défaut, sinon un mobile perso mal-détecté
 *                                    par libphonenumber-js comme
 *                                    FIXED_LINE_OR_MOBILE échapperait
 *                                    silencieusement au check Bloctel)
 *
 * Avant S10.1.9 : `segment` était hardcodé à `"unknown"` pour 100% des
 * contacts seedés, ce qui court-circuitait systématiquement la règle Bloctel
 * (`canSendB2C` autorise tout segment ≠ `b2c_mobile_perso`). Risque CNIL
 * 75 000 € par PS portant un mobile perso inscrit Bloctel.
 *
 * 🔒 Verrouillé par tests exhaustifs dans `mapper.test.ts` (section
 *    "Segment derivation from phone.type"). Le switch exhaustif TS interdit
 *    qu'un nouveau `PhoneType` soit ajouté sans mise à jour de cette
 *    fonction (compile error).
 */
function deriveSegmentFromPhoneType(phoneType: PhoneType): ContactSegment {
  switch (phoneType) {
    case "mobile":
      return "b2c_mobile_perso";
    case "landline":
    case "voip":
      return "b2b_cabinet";
    case "unknown":
      return "unknown";
  }
}

/**
 * Extrait les flags opt-out HubSpot depuis le `properties` raw d'un contact
 * (S10.1.9 OPTOUT-FILTER-001).
 *
 *   - `hs_email_optout` : standard HubSpot, bool natif côté CRM.
 *   - `sms_opted_out`   : custom Médéré (créée par Déthié S10.1.9), bool
 *                          natif côté CRM.
 *
 * L'API HubSpot v3 retourne les bool comme STRINGS `"true"`/`"false"` dans
 * `properties{}` (sérialisation SDK `@hubspot/api-client`). Defense-in-depth :
 * on accepte aussi le bool natif `true` au cas où une future version du SDK
 * changerait ce comportement (probabilité faible mais coût nul à protéger).
 *
 * Toute autre valeur (`null`, `"false"`, chaîne vide, propriété absente,
 * `undefined`) → `false` (interprétation conservatrice : on considère qu'il
 * n'y a PAS d'opt-out tant qu'on n'a pas explicitement `"true"` ou `true`).
 *
 * Le caller (`seed-runner.ts` étape A.0) reste responsable de la décision
 * skip/proceed et de l'audit log forensique.
 *
 * 🔒 Verrouillé par tests `extractOptOutFlags` dans `mapper.test.ts`.
 */
export function extractOptOutFlags(raw: HubspotContactRaw): {
  emailOptout: boolean;
  smsOptout: boolean;
} {
  // Cast via `unknown` car `HubspotContactRaw.properties` est typé
  // `Record<string, string | null>` côté projet — l'égalité `=== true`
  // serait dead-code au compile-time sans ce cast. Le cast est volontaire,
  // c'est précisément l'esprit defense-in-depth (cf. JSDoc ci-dessus).
  const props = raw.properties as Record<string, unknown>;
  const isTrueish = (v: unknown): boolean => v === "true" || v === true;
  return {
    emailOptout: isTrueish(props.hs_email_optout),
    smsOptout: isTrueish(props.sms_opted_out),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// mapHubSpotContactToFirestoreContact
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map un contact HubSpot brut vers le shape `Contact` Firestore directement
 * consommable par `firestore/contacts.ts::createContact`.
 *
 * @throws ValidationError si `firstname`, `lastname`, `profession` ou
 *                         `phone`/`mobilephone` sont manquants/invalides.
 *                         Le context d'erreur n'expose JAMAIS les valeurs
 *                         brutes (anti-PII).
 */
export function mapHubSpotContactToFirestoreContact(input: MapHubSpotContactInput): Contact {
  const { raw, campaignId } = input;
  const now = input.now ?? Timestamp.now();
  const props = raw.properties;

  // ── Identifiants ────────────────────────────────────────────────────────
  const hubspotId = raw.id;
  if (typeof hubspotId !== "string" || hubspotId.trim() === "") {
    throw new ValidationError({
      message: "mapHubSpotContactToFirestoreContact: raw.id is missing",
      context: { op: "mapHubSpotContact" },
    });
  }

  if (typeof campaignId !== "string" || campaignId.trim() === "") {
    throw new ValidationError({
      message: "mapHubSpotContactToFirestoreContact: campaignId is missing",
      context: { op: "mapHubSpotContact", hubspotId },
    });
  }

  // ── Identité (requis) ───────────────────────────────────────────────────
  const firstName = normalizeString(props.firstname);
  if (firstName === undefined) {
    throw new ValidationError({
      message: "mapHubSpotContactToFirestoreContact: firstname is missing",
      context: { op: "mapHubSpotContact", hubspotId, missingField: "firstname" },
    });
  }

  const lastName = normalizeString(props.lastname);
  if (lastName === undefined) {
    throw new ValidationError({
      message: "mapHubSpotContactToFirestoreContact: lastname is missing",
      context: { op: "mapHubSpotContact", hubspotId, missingField: "lastname" },
    });
  }

  // ── Civilité (optionnelle, undefined si non mappable) ───────────────────
  const civiliteRaw = normalizeString(props.civilite);
  const civilite: ContactCivilite | undefined =
    civiliteRaw !== undefined ? HUBSPOT_CIVILITE_MAP[civiliteRaw] : undefined;

  // ── Speciality (requise, strict enum 21 valeurs) ────────────────────────
  const professionRaw = normalizeString(props.profession);
  if (professionRaw === undefined) {
    throw new ValidationError({
      message: "mapHubSpotContactToFirestoreContact: profession is missing",
      context: { op: "mapHubSpotContact", hubspotId, missingField: "profession" },
    });
  }
  if (!SPECIALITY_VALUES_SET.has(professionRaw)) {
    throw new ValidationError({
      message: "mapHubSpotContactToFirestoreContact: profession not in CONTACT_SPECIALITY_VALUES",
      context: {
        op: "mapHubSpotContact",
        hubspotId,
        invalidField: "profession",
        // Fingerprint = hash court, pas la valeur brute (anti-PII et
        // anti-data-leak HubSpot enum drift).
        professionFingerprint: shortFingerprint(professionRaw),
      },
    });
  }
  // SET check OK → cast safe.
  const speciality = professionRaw as ContactSpeciality;

  // ── Phone (requise — priorité mobilephone, fallback phone) ──────────────
  const phoneRawSource = normalizeString(props.mobilephone) ?? normalizeString(props.phone);
  if (phoneRawSource === undefined) {
    throw new ValidationError({
      message: "mapHubSpotContactToFirestoreContact: no phone (mobilephone nor phone)",
      context: { op: "mapHubSpotContact", hubspotId, missingField: "phone|mobilephone" },
    });
  }

  const e164 = toE164(phoneRawSource, "FR");
  if (e164 === null) {
    throw new ValidationError({
      message: "mapHubSpotContactToFirestoreContact: phone is not normalizable to E.164 FR",
      context: {
        op: "mapHubSpotContact",
        hubspotId,
        invalidField: "phone",
        // Pas de phoneRawSource dans context — PII.
      },
    });
  }

  const parsed = parsePhone(phoneRawSource, "FR");
  const phoneType = parsed?.type ?? "unknown";
  const phoneValid = parsed?.valid ?? false;

  // ── Champs optionnels (string) ──────────────────────────────────────────
  const email = normalizeString(props.email);
  // city/postalCode sont REQUIS par ContactSchema (z.string() sans .min(1))
  // mais peuvent être vides — on les pose à "" si absents pour passer le parse.
  const city = normalizeString(props.city) ?? "";
  const postalCode = normalizeString(props.zip) ?? "";

  // ── Assemblage final (shape ContactSchema strict) ───────────────────────
  const contact: Contact = {
    hubspotId,
    firstName,
    lastName,
    ...(civilite !== undefined && { civilite }),
    speciality,
    city,
    postalCode,
    ...(email !== undefined && { email }),
    phone: {
      e164,
      raw: phoneRawSource,
      type: phoneType,
      valid: phoneValid,
      lookupAt: now,
    },
    segment: deriveSegmentFromPhoneType(phoneType),
    bloctelChecked: false,
    bloctelOptOut: false,
    consent: {
      legitimateInterest: HUBSPOT_DEFAULT_LEGITIMATE_INTEREST,
      optedOut: false,
    },
    enrichment: {
      source: "hubspot",
      enrichedAt: now,
    },
    status: "ready",
    campaignId,
    createdAt: now,
    updatedAt: now,
  };

  return contact;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exposés pour tests (S10.1.9 BLOCTEL-001 — switch exhaustif testé en
// isolation, indépendamment du parsing libphonenumber-js dont les fixtures
// peuvent évoluer entre versions de metadata).
// ─────────────────────────────────────────────────────────────────────────────

export { deriveSegmentFromPhoneType as __deriveSegmentFromPhoneType_FOR_TESTS };
