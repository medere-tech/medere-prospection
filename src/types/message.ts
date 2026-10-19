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
  | "received" // message entrant (inbound)
  /**
   * **R5-Point4 PR-NO-DROPPED-SMS** : statut terminal pour les messages
   * stale pré-launch (drafts/queued jamais envoyés OVH, détectés par
   * `monitor-orphan-messages` depuis juillet). Marqué par le script
   * `scripts/close-stale-orphans.mjs` (manuel, --apply, snapshot tmp/,
   * audit `manual_override` avec preuve OVH).
   *
   * Garanties structurelles :
   *   - EXCLU de `RATE_LIMIT_COUNTED_STATUSES` (whitelist) → non compté
   *     contre le plafond rate-limit 3 SMS/30j (`listRecentOutbound` filtre).
   *   - EXCLU de `monitor-orphan-messages` qui ne scanne que
   *     `draft|queued` (`monitor-orphan-messages.ts:247,257`) → plus de
   *     signal répétitif.
   *   - EXCLU de `listRecentMessages` (filtre explicite dans ce fichier
   *     — pas d'historique Claude pour un message qui n'a jamais été
   *     envoyé au PS).
   *   - PAS DE TRANSITION depuis `abandoned` : terminal, immuable. Aucune
   *     fonction du projet ne peut faire `status: "sending"` sur un doc
   *     `abandoned` (le pipeline send-reply/send-first-sms query par
   *     `status: "queued"` avant transition).
   *
   * Champs liés OBLIGATOIRES à l'écriture :
   *   - `abandonedAt`     : Timestamp serveur de la bascule.
   *   - `abandonReason`   : enum fermé `"stale_pre_launch_test_cleanup"`
   *                         (plus de valeurs futures : chaque bascule
   *                         manuelle doit documenter son contexte).
   */
  | "abandoned"
  /**
   * **R5-Point5 PR-NO-DROPPED-SMS** : statut terminal pour les docs
   * inbound dupliqués pré-BUG-DEDUP-RACE fix (PR #48). Marqué par le
   * script `scripts/close-duplicate-inbound.mjs`.
   *
   * Garanties structurelles :
   *   - EXCLU de `listRecentMessages` (filtre explicite).
   *   - EXCLU des calculs intent / reply-volume (reply-volume lit via
   *     `listRecentOutbound` qui ne voit que les outbounds + whitelist
   *     statuts → un inbound `duplicate` n'y entre jamais).
   *   - EXCLU des affichages de conversation (le dashboard filtrera
   *     `status !== "duplicate"` en S10+).
   *
   * Champs liés OBLIGATOIRES à l'écriture :
   *   - `duplicateOf`     : messageId de l'ORIGINAL (createdAt le plus
   *                         ancien avec le même `externalId`). Pointe
   *                         vers le doc qui doit rester lisible.
   *   - `abandonedAt`     : Timestamp bascule (champ partagé avec
   *                         `abandoned` pour un lifecycle terminal unifié).
   */
  | "duplicate";

export type MessageChannel = "sms" | "whatsapp";

/** Auteur du contenu du message. */
export type MessageGeneratedBy = "ai" | "human" | "system";

/**
 * 🔒 Nature d'un message SORTANT au regard du plafond L.34-5 CPCE
 * (PR-OUTBOUNDKIND).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * SÉMANTIQUE
 *
 *   - `"solicitation"` : on prend l'initiative de déranger le PS. Premier
 *     SMS de campagne, relance après silence. **Compte** contre le plafond.
 *
 *   - `"reply"` : réponse à un message que le PS vient de nous envoyer.
 *     Le PS a engagé l'échange, on ne le dérange pas — on lui répond.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 ESTAMPILLÉ À L'ÉCRITURE, JAMAIS DÉRIVÉ À LA LECTURE
 *
 * La valeur est FIGÉE par la fonction d'écriture, qui est la seule à
 * SAVOIR ce qu'elle écrit :
 *   - `addOutboundDraftInTx` → toujours `"reply"` (appelée uniquement par
 *     `process-reply`, donc toujours en réaction à un inbound).
 *   - `addOutboundInTx`      → le caller DOIT trancher (champ requis dans
 *     `AddOutboundInput`) : `send-first-sms` pose `"solicitation"`.
 *
 * Deux alternatives ont été explicitement REJETÉES :
 *
 *   1. **Dériver d'un booléen conversation** (`inboundCount > 0`) :
 *      rétroactif. 3 sollicitations envoyées puis le PS répond → les 3
 *      passeraient "réponses" a posteriori → quota entier rendu. N'importe
 *      quelle réponse du PS effacerait l'historique de sollicitation.
 *
 *   2. **Dériver d'un point de coupure** (`firstInboundAt`) : non
 *      rétroactif, mais troué sur la RELANCE APRÈS SILENCE. Un PS qui
 *      répond une fois puis se tait rendrait toutes les relances
 *      ultérieures "réponses" → relances illimitées.
 *
 * L'estampillage à l'écriture est immunisé contre les deux.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ⚠️ NE CONCERNE QUE LES SORTANTS. Un message `direction: "inbound"` n'a
 * pas de `outboundKind` (le PS ne nous "sollicite" pas au sens L.34-5).
 * Les lectures rate-limit filtrent `direction == "outbound"` en amont, le
 * champ n'est donc jamais consulté sur un inbound.
 */
export type MessageOutboundKind = "solicitation" | "reply";

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

  /**
   * Nature de la sollicitation (SORTANTS uniquement) — cf.
   * `MessageOutboundKind` pour la sémantique et les alternatives rejetées.
   *
   * **Optionnel, et il le reste À LA LECTURE.** Deux raisons distinctes :
   *   1. les docs LEGACY écrits avant PR-OUTBOUNDKIND n'ont pas le champ ;
   *   2. les messages `inbound` ne le portent pas du tout.
   *
   * 🚨 `MessageSchema` applique bien un défaut `"solicitation"` au parse,
   * mais `_parseMessageOrThrow` fait `result.data as Message` : le cast
   * **efface cette garantie au niveau du type**. Côté lecteur, la valeur
   * est donc bel et bien `MessageOutboundKind | undefined`.
   *
   * ⚠️ NE PAS écrire son propre test de nature — la forme
   * `!== "solicitation"` exclurait tous les docs legacy du comptage, soit
   * un sous-comptage silencieux du plafond L.34-5 CPCE. Utiliser
   * `countsAgainstCap()` de `lib/compliance/outbound-kind.ts`, seul
   * endroit où le défaut fail-closed est appliqué à la lecture.
   *
   * Aucun backfill n'est nécessaire : la fenêtre rate-limit étant glissante
   * sur 30 jours, 30 jours après le déploiement plus aucun doc comptabilisé
   * n'est legacy.
   */
  outboundKind?: MessageOutboundKind;

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

  /**
   * R5-Point4+5 PR-NO-DROPPED-SMS : timestamp de bascule vers un statut
   * terminal manuel (`abandoned` ou `duplicate`). Posé via
   * `FieldValue.serverTimestamp()` par les scripts
   * `close-stale-orphans.mjs` et `close-duplicate-inbound.mjs`.
   * Immuable après écriture.
   */
  abandonedAt?: Timestamp;

  /**
   * R5-Point4 PR-NO-DROPPED-SMS : enum fermé des raisons autorisées pour
   * `status: "abandoned"`. Toute nouvelle raison exige une extension
   * explicite ici — pas de valeur libre pour éviter les abus de la bascule.
   */
  abandonReason?: "stale_pre_launch_test_cleanup";

  /**
   * R5-Point5 PR-NO-DROPPED-SMS : messageId de l'ORIGINAL quand ce doc
   * est marqué `status: "duplicate"`. Pointe vers le `conversations/{convId}/
   * messages/{originalId}` qui conserve la preuve forensic. Même conv
   * forcément (le dédup se fait intra-conversation).
   */
  duplicateOf?: string;

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
  /**
   * Nature du sortant — **transportée verbatim**, jamais interprétée ici.
   *
   * Reste `undefined` si le doc source ne portait pas le champ (legacy).
   * C'est VOULU : le défaut fail-closed est appliqué en UN SEUL endroit,
   * `countsAgainstCap()` (`lib/compliance/outbound-kind.ts`). Si les
   * mappers appliquaient eux-mêmes le défaut, il existerait deux sources
   * de vérité pour « qu'est-ce qui compte ».
   */
  outboundKind?: MessageOutboundKind;
}
