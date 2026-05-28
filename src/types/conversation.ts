/**
 * Type d'une conversation SMS (un PS, une campagne). Aligné sur la skill
 * `medere-firestore-schema`.
 *
 * Document ID en Firestore : `${contactId}_${campaignId}` (unicité
 * contact-campagne — un même PS peut être recontacté dans une campagne
 * ultérieure, mais une seule conversation active par couple).
 *
 * Le schéma Zod runtime sera ajouté en S6 (CRUD Firestore) ; ici on définit
 * uniquement la forme TypeScript pour que `lib/compliance/` puisse typer
 * l'historique sans dépendre de Firestore.
 */
import type { Timestamp } from "firebase-admin/firestore";

// ─────────────────────────────────────────────────────────────────────────────
// Unions partagées (Intent réutilisée par `message.ts` et `lib/claude/`)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Intent classifié par Claude à partir de la dernière réponse du PS.
 * - `INTERESSE` : intérêt clair (questions, demande d'infos, "oui"…).
 * - `NEUTRE` : ambigu / accusé de réception.
 * - `OBJECTION` : doute ou réserve sans refus.
 * - `STOP` : opt-out explicite — toujours absorbé en priorité.
 * - `unknown` : pas encore classifié (avant la 1re réponse PS).
 */
export type Intent = "INTERESSE" | "NEUTRE" | "OBJECTION" | "STOP" | "unknown";

export type ConversationStatus =
  | "active" // créée, en attente de génération 1er SMS
  | "awaiting_reply" // 1er SMS envoyé, on attend la réponse PS
  | "in_dialogue" // échange en cours avec l'IA
  | "qualified" // intent positif détecté → hand-off prochain
  | "handed_off" // transférée à un commercial humain
  | "closed" // conversation terminée (RDV pris, ou abandon)
  | "opted_out" // PS a demandé STOP
  | "blocked"; // bloquée par pre-send-check (Bloctel, plafond…)

/** Canal de la conversation. Phase MVP : SMS uniquement. */
export type ConversationChannel = "sms" | "whatsapp";

/** Type de la prochaine action planifiée (relances, archivage). */
export type ConversationNextActionType = "followup_3d" | "followup_7d" | "archive" | "none";

// ─────────────────────────────────────────────────────────────────────────────
// Sous-objets
// ─────────────────────────────────────────────────────────────────────────────

export interface ConversationHandoff {
  /** Slack user ID du commercial assigné. */
  assignedTo: string;
  assignedAt: Timestamp;
  /** Le commercial a accusé réception (clic « J'ai contacté »). */
  acceptedAt?: Timestamp;
  acceptedBy?: string;
  /** ID du deal HubSpot créé lors du hand-off. */
  hubspotDealId?: string;
  notes?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Document Firestore
// ─────────────────────────────────────────────────────────────────────────────

export interface Conversation {
  contactId: string;
  campaignId: string;
  channel: ConversationChannel;
  status: ConversationStatus;
  intent: Intent;

  // Compteurs (mis à jour en transaction lors des envois/réceptions)
  messageCount: number;
  outboundCount: number;
  inboundCount: number;

  // Timestamps de cadence (alimentent `compliance/rate-limits` et `hours`)
  firstMessageAt?: Timestamp;
  lastMessageAt?: Timestamp;
  lastOutboundAt?: Timestamp;
  lastInboundAt?: Timestamp;
  lastIntentChangeAt?: Timestamp;

  handoff?: ConversationHandoff;

  // Relance automatique
  nextActionAt?: Timestamp;
  nextActionType?: ConversationNextActionType;
  followupCount: number;

  /** Résumé court généré pour le commercial lors du hand-off. */
  summary?: string;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}
