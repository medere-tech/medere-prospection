/**
 * Type d'un message SMS (entrant ou sortant), sous-collection de
 * `conversations/{convId}/messages/`. Aligné sur la skill
 * `medere-firestore-schema`.
 *
 * Schéma Zod runtime ajouté en S6 (lecture Firestore + parsing webhook OVH).
 * Ici on définit uniquement la forme TypeScript pour que `lib/compliance/`
 * puisse typer l'historique consommé par `rate-limits` et `pre-send-check`.
 */
import type { Timestamp } from "firebase-admin/firestore";

import type { Intent } from "./conversation";

// ─────────────────────────────────────────────────────────────────────────────
// Unions
// ─────────────────────────────────────────────────────────────────────────────

export type MessageDirection = "outbound" | "inbound";

export type MessageStatus =
  /**
   * "draft" — Message outbound généré par l'IA (S9.3) mais pas encore
   * envoyé OVH. Stocké via `addOutboundDraftInTx` (S9.3.3a).
   *
   * **N'EST PAS COMPTÉ par le rate-limit 3 SMS/30j** : `listRecentOutbound`
   * exclut les drafts via la whitelist `RATE_LIMIT_COUNTED_STATUSES`
   * (S9.3.3a-INVARIANT-RATE-LIMIT). Un draft non envoyé n'est pas un
   * envoi tenté au sens L.34-5 CPCE.
   *
   * **NE BUMP PAS les compteurs conversation** (`outboundCount`,
   * `lastOutboundAt`) — la fonction `addOutboundDraftInTx` les laisse
   * intacts. Le bump aura lieu lors de la transition `draft → queued`
   * via `commitDraftToQueued()` en S9.4 (cf. S9.4-DRAFT-TO-QUEUED-001).
   */
  | "draft"
  | "queued" // créé en Firestore, en attente d'envoi via OVH
  | "sending" // remis à OVH, en attente d'accusé
  | "sent" // accusé OVH (job accepté)
  | "delivered" // OVH a confirmé la délivrance au destinataire
  | "failed" // échec d'envoi (erreur OVH / numéro invalide)
  | "received"; // message entrant (inbound)

export type MessageChannel = "sms" | "whatsapp";

/** Auteur du contenu du message. */
export type MessageGeneratedBy = "ai" | "human" | "system";

// ─────────────────────────────────────────────────────────────────────────────
// Sous-objets
// ─────────────────────────────────────────────────────────────────────────────

export interface MessageAITokens {
  input: number;
  output: number;
}

export interface MessageError {
  code: string;
  message: string;
  retryCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Document Firestore (sous-collection)
// ─────────────────────────────────────────────────────────────────────────────

export interface Message {
  direction: MessageDirection;
  /** Contenu exact du SMS (PII potentielle — redacté par le logger). */
  body: string;
  status: MessageStatus;
  channel: MessageChannel;

  /** ID OVH (jobId) ou Twilio, selon le fournisseur. */
  externalId?: string;
  /** E.164 destinataire (outbound) ou expéditeur (inbound). */
  externalReceiver?: string;

  // Génération IA
  generatedBy: MessageGeneratedBy;
  /** Ex: `claude-sonnet-4-6`. Présent si `generatedBy === 'ai'`. */
  aiModel?: string;
  /** Ex: `first-sms-v1.0.0`. Lien vers `prompts/{id}_{version}`. */
  aiPromptVersion?: string;
  aiTemperature?: number;
  aiTokens?: MessageAITokens;

  // Classification (pour les messages inbound)
  intent?: Intent;
  intentConfidence?: number;
  intentReasoning?: string;

  /** Coût d'envoi en centimes EUR (OVH bill). */
  cost?: number;

  // Timestamps (selon le cycle de vie)
  createdAt: Timestamp;
  queuedAt?: Timestamp;
  sentAt?: Timestamp;
  deliveredAt?: Timestamp;
  receivedAt?: Timestamp;

  error?: MessageError;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vue minimale pour `lib/compliance/rate-limits`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sous-ensemble d'un `Message` strictement nécessaire au calcul du plafond
 * 3 SMS / 30 jours. Permet à `compliance/rate-limits.ts` de typer son input
 * sans coupler la fonction à la forme Firestore complète (et donc à
 * `firebase-admin`).
 */
export interface SentMessageRecord {
  direction: MessageDirection;
  /** Le calcul du plafond se base sur `sentAt` (envois effectifs), pas
   * `createdAt` ni `queuedAt`. */
  sentAt: Timestamp | Date;
}
