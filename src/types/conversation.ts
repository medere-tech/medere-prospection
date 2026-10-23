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

/**
 * Qui a écrit le dernier message. PR2a : alimente l'extrait affiché en
 * liste et sert à dériver « Le médecin attend une réponse ».
 *   - `contact` : SMS entrant du PS
 *   - `ai`      : SMS sortant généré par Claude (automatique)
 *   - `human`   : SMS sortant envoyé manuellement par un commercial
 */
export type MessageAuthorKind = "contact" | "ai" | "human";

/**
 * Dénormalisation du dernier message pour l'affichage LISTE
 * (`/admin/conversations`). Jamais de PII numéro — texte passé par le
 * sanitize PR1 + tronqué.
 */
export interface ConversationLastMessagePreview {
  direction: "inbound" | "outbound";
  authorKind: MessageAuthorKind;
  /** Texte tronqué (≤ 140 chars), scrubbé des numéros FR. */
  text: string;
  at: Timestamp;
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

  /**
   * Slack userId du commercial titulaire, OU `null` explicite si aucun
   * titulaire.
   *
   * **Dénormalisation** de `handoff.assignedTo` à la racine du document
   * pour permettre les queries Firestore :
   *   - `where("assignedTo", "==", slackUserId)` — « Mes conversations »
   *   - `where("assignedTo", "==", null)`         — « À traiter » (orphelines)
   *
   * Firestore ne supporte pas de query native sur un champ imbriqué
   * `handoff.assignedTo == null` quand `handoff` lui-même peut être
   * `undefined`. On duplique donc à la racine avec `null` explicite.
   *
   * 🔒 INVARIANT : `assignedTo` et `handoff?.assignedTo` doivent toujours
   * être cohérents (soit égaux, soit `assignedTo === null && handoff === undefined`).
   * `setHandoff` écrit les deux dans la MÊME transaction. Le script
   * `scripts/backfill-assigned-to.mjs` répare les docs legacy qui
   * auraient uniquement `handoff.assignedTo` sans `assignedTo` racine.
   */
  assignedTo?: string | null;

  // Relance automatique
  nextActionAt?: Timestamp;
  nextActionType?: ConversationNextActionType;
  followupCount: number;

  /** Résumé court généré pour le commercial lors du hand-off. */
  summary?: string;

  // ───────────────────────────────────────────────────────────────────────
  // PR2a — dénormalisations pour la liste `/admin/conversations`
  //
  // Toutes OPTIONNELLES → les docs anciens (pré-PR2a) restent valides sans
  // backfill. Le backfill `scripts/backfill-conversation-list-fields.mjs`
  // les pose a posteriori. Les points d'écriture (`createConversation`,
  // `_bumpConversationCountersTx`, `updateContactStatus` propagation)
  // les écrivent dans la même transaction que l'écriture existante — zéro
  // changement de comportement du pipeline SMS.
  // ───────────────────────────────────────────────────────────────────────

  /** `${civilite ?? ""} ${firstName} ${lastName}` trim. Ex: `Dr Dethie Faye`. */
  contactDisplayName?: string;
  /**
   * Nom normalisé pour recherche préfixe (accents retirés, lower, trim).
   * Query PR2b : `where("contactNameSearch", ">=", q).where(... "<=", q + "")`.
   */
  contactNameSearch?: string;
  contactSpecialty?: string;
  contactCity?: string;
  /** Nom lisible de la campagne (HubSpot list name, dénormalisé via cache). */
  campaignName?: string;
  /** Dernier message pour affichage en liste. Scrubbé + tronqué. */
  lastMessagePreview?: ConversationLastMessagePreview;
  /**
   * Timestamp du dernier message outbound envoyé par un HUMAIN (pas par
   * l'IA Claude). Permet de dériver le signal « le médecin attend une
   * réponse » = `lastInboundAt > lastHumanOutboundAt` (le PS a répondu
   * depuis la dernière intervention humaine, ou aucune intervention humaine
   * et un inbound existe).
   */
  lastHumanOutboundAt?: Timestamp;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}
