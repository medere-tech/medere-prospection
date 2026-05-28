/**
 * Type d'un contact (professionnel de santé prospect) tel que stocké en
 * Firestore et synchronisé avec HubSpot. Aligné sur la skill
 * `medere-firestore-schema` (source de vérité du schéma Firestore).
 *
 * `Timestamp` est importé en TYPE seulement → erasé à la compilation. Le code
 * client peut importer ces types sans tirer le SDK firebase-admin dans le
 * bundle (les valeurs `Timestamp` viennent du backend ou sont reconstruites
 * via les helpers de `lib/firestore/`).
 */
import type { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Unions (réutilisées par les écrans dashboard et les wrappers)
// ─────────────────────────────────────────────────────────────────────────────

/** État d'un contact dans le pipeline de prospection. */
export type ContactStatus =
  | "pending" // importé, pas encore enrichi
  | "enriched" // enrichi via Lusha, validation Twilio pas encore faite
  | "ready" // prêt à être contacté
  | "in_conversation" // conversation SMS en cours
  | "qualified" // intent positif, hand-off effectué
  | "opted_out" // a demandé STOP
  | "archived"; // inactif, archivé

/**
 * Segmentation B2B/B2C : pilote la vérification Bloctel (obligatoire pour
 * les mobiles persos non-pros).
 */
export type ContactSegment =
  | "b2b_cabinet" // ligne pro de cabinet → intérêt légitime B2B
  | "b2c_mobile_perso" // mobile perso → vérif Bloctel obligatoire
  | "unknown"; // à segmenter après lookup Twilio

/** Civilité affichée dans les SMS et le dashboard (FR, secteur médical). */
export type ContactCivilite = "Dr" | "Pr" | "M." | "Mme";

/** Spécialité du PS — l'enum MVP, à étendre quand on couvrira de nouveaux PS. */
export type ContactSpeciality = "dentiste" | "generaliste" | "ide" | "autre";

/** Type de ligne téléphonique — heuristique pré-Twilio puis confirmé. */
export type ContactPhoneType = "mobile" | "landline" | "voip" | "unknown";

/** Source de l'enrichissement initial. */
export type ContactEnrichmentSource = "lusha" | "hubspot" | "manual";

/** Canal par lequel l'opt-out a été reçu. */
export type ContactOptOutChannel = "sms" | "manual" | "dashboard";

// ─────────────────────────────────────────────────────────────────────────────
// Forme du document Firestore
// ─────────────────────────────────────────────────────────────────────────────

export interface ContactPhone {
  /** E.164 strict (ex: `+33612345678`). */
  e164: string;
  /** Forme originale, pour audit (`06 12 34 56 78`, `+33-6-...`). */
  raw: string;
  type: ContactPhoneType;
  /** Carrier renvoyé par Twilio Lookup, si disponible. */
  carrier?: string;
  valid: boolean;
  /** Timestamp du dernier lookup Twilio. */
  lookupAt: Timestamp;
}

export interface ContactConsent {
  /**
   * Texte documentant l'intérêt légitime (RGPD art. 6.1.f) pour ce contact :
   * d'où vient la donnée, pourquoi on a le droit de le contacter. Doit être
   * précis (cf. validation Zod : 20 chars min).
   */
  legitimateInterest: string;
  optedOut: boolean;
  optedOutAt?: Timestamp;
  optedOutReason?: string;
  optedOutChannel?: ContactOptOutChannel;
}

export interface ContactEnrichment {
  source: ContactEnrichmentSource;
  enrichedAt: Timestamp;
  /** Données brutes Lusha/HubSpot conservées pour audit. */
  raw?: Record<string, unknown>;
}

export interface Contact {
  // Identité
  hubspotId: string;
  firstName: string;
  lastName: string;
  civilite?: ContactCivilite;
  speciality: ContactSpeciality;
  city: string;
  postalCode: string;
  email?: string;

  phone: ContactPhone;

  segment: ContactSegment;
  /** True si la vérification Bloctel a été menée. */
  bloctelChecked: boolean;
  /** True si le numéro est inscrit à Bloctel → envoi refusé. */
  bloctelOptOut: boolean;
  bloctelCheckedAt?: Timestamp;

  consent: ContactConsent;
  enrichment: ContactEnrichment;

  status: ContactStatus;
  campaignId: string;
  /** Slack user ID si attribué à un commercial après hand-off. */
  assignedTo?: string;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schéma Zod pour la validation runtime (entrées API, données lues Firestore)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `z.unknown()` pour les Timestamps : Firestore renvoie un objet `Timestamp`
 * dont la forme est gérée par firebase-admin (instance de classe, pas
 * sérialisable directement en JSON Zod). On valide la PRÉSENCE, pas la forme.
 */
const TimestampLike = z.unknown();

export const ContactPhoneSchema = z.object({
  e164: z.string().regex(/^\+\d{10,15}$/, "Doit être au format E.164"),
  raw: z.string(),
  type: z.enum(["mobile", "landline", "voip", "unknown"]),
  carrier: z.string().optional(),
  valid: z.boolean(),
  lookupAt: TimestampLike,
});

export const ContactConsentSchema = z.object({
  legitimateInterest: z.string().min(20, "Documente précisément l'intérêt légitime (20 chars min)"),
  optedOut: z.boolean(),
  optedOutAt: TimestampLike.optional(),
  optedOutReason: z.string().optional(),
  optedOutChannel: z.enum(["sms", "manual", "dashboard"]).optional(),
});

export const ContactEnrichmentSchema = z.object({
  source: z.enum(["lusha", "hubspot", "manual"]),
  enrichedAt: TimestampLike,
  raw: z.record(z.string(), z.unknown()).optional(),
});

export const ContactSchema = z.object({
  hubspotId: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  civilite: z.enum(["Dr", "Pr", "M.", "Mme"]).optional(),
  speciality: z.enum(["dentiste", "generaliste", "ide", "autre"]),
  city: z.string(),
  postalCode: z.string(),
  email: z.email().optional(),
  phone: ContactPhoneSchema,
  segment: z.enum(["b2b_cabinet", "b2c_mobile_perso", "unknown"]),
  bloctelChecked: z.boolean(),
  bloctelOptOut: z.boolean(),
  bloctelCheckedAt: TimestampLike.optional(),
  consent: ContactConsentSchema,
  enrichment: ContactEnrichmentSchema,
  status: z.enum([
    "pending",
    "enriched",
    "ready",
    "in_conversation",
    "qualified",
    "opted_out",
    "archived",
  ]),
  campaignId: z.string(),
  assignedTo: z.string().optional(),
  createdAt: TimestampLike,
  updatedAt: TimestampLike,
});

/** Type inféré depuis le schéma Zod (à privilégier pour les inputs validés). */
export type ContactValidated = z.infer<typeof ContactSchema>;
