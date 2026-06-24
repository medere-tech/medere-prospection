/**
 * Type d'un contact (professionnel de santé prospect) tel que stocké en
 * Firestore et synchronisé avec HubSpot. Aligné sur la skill
 * `medere-firestore-schema` (source de vérité du schéma Firestore).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Convention projet (arbitrée Déthié S6.3) :
 *   - `src/types/**`         : types purs TypeScript, ZÉRO dépendance Zod
 *                              → consommables côté frontend (App Router
 *                                client) sans tirer Zod dans le bundle.
 *   - `src/lib/firestore/**` : schémas Zod + validation runtime
 *                              (ex: `ContactSchema` vit dans
 *                                `lib/firestore/contacts.ts` à partir de S6.3).
 *
 * `Timestamp` est importé en TYPE seulement → erasé à la compilation. Le code
 * client peut importer ces types sans tirer le SDK firebase-admin dans le
 * bundle (les valeurs `Timestamp` viennent du backend ou sont reconstruites
 * via les helpers de `lib/firestore/`).
 */
import type { Timestamp } from "firebase-admin/firestore";

// ─────────────────────────────────────────────────────────────────────────────
// Unions (réutilisées par les écrans dashboard et les wrappers)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 🔒 Source de vérité unique des status. Tuple readonly `as const` — peut
 * être passé directement à `z.enum()` côté serveur ET utilisé comme array
 * itérable côté client (dropdown UI S10.1.5) sans tirer Zod ni Admin SDK
 * dans le bundle browser.
 *
 * Avant S10.1.5-FIX-SEC : la constante vivait dans
 * `src/lib/firestore/contacts.ts` (dérivée de `ContactSchema.shape.status.options`).
 * `status-filter.tsx` (`"use client"`) qui l'importait risquait de tirer
 * `firebase-admin/firestore` dans le bundle browser (defense-in-depth
 * security-reviewer S10.1.5 Phase 7).
 *
 * Re-export depuis `lib/firestore/contacts` préservé pour rétrocompat —
 * les tests serveur peuvent continuer à importer de là.
 */
export const CONTACT_STATUS_VALUES = [
  "pending", // importé, pas encore enrichi
  "enriched", // enrichi via Lusha, validation Twilio pas encore faite
  "ready", // prêt à être contacté
  "in_conversation", // conversation SMS en cours
  "qualified", // intent positif, hand-off effectué
  "opted_out", // a demandé STOP
  "archived", // inactif, archivé
] as const;

/** État d'un contact dans le pipeline de prospection. */
export type ContactStatus = (typeof CONTACT_STATUS_VALUES)[number];

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

/**
 * Spécialité du PS — alignée 1:1 sur l'enum `profession` HubSpot custom Médéré
 * (S10.1.2.b). Source de vérité unique : `CONTACT_SPECIALITY_VALUES` exportée
 * depuis `src/lib/firestore/contacts.ts`. NE PAS dupliquer ici.
 *
 * On RE-DÉRIVE le type via un import-as-type pour garder ce module
 * (`src/types/`) compatible client (zéro dépendance Zod, cf. convention
 * S6.3 doc l.1-19) — `(typeof CONTACT_SPECIALITY_VALUES)[number]` produit
 * une union string littérale erasée à la compilation.
 */
import type { CONTACT_SPECIALITY_VALUES } from "@/lib/firestore/contacts";
export type ContactSpeciality = (typeof CONTACT_SPECIALITY_VALUES)[number];

/** Type de ligne téléphonique — heuristique pré-Twilio puis confirmé. */
export type ContactPhoneType = "mobile" | "landline" | "voip" | "unknown";

/** Source de l'enrichissement initial. */
export type ContactEnrichmentSource = "lusha" | "hubspot" | "manual";

/** Canal par lequel l'opt-out a été reçu. */
export type ContactOptOutChannel = "sms" | "manual" | "dashboard";

// ─────────────────────────────────────────────────────────────────────────────
// Forme du document Firestore (interface pure, aucune validation runtime)
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
   * précis (cf. validation Zod : 20 chars min, validée par `ContactSchema`
   * dans `lib/firestore/contacts.ts`).
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
