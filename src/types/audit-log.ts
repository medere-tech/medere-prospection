/**
 * Types pour la collection Firestore `audit_log` — journal append-only
 * des actions sensibles du système.
 *
 * Source de vérité : skill `medere-firestore-schema`, section 4.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Règles invariantes (CNIL / RGPD) :
 *
 *   1. **Append-only**. Aucun update, aucun delete (sauf purge légale
 *      à 5 ans). Forfait : si on doit corriger une entrée, on écrit une
 *      nouvelle entrée `manual_override` qui la pointe — JAMAIS modifier.
 *
 *   2. **Pas de PII en clair dans `payload`**. Téléphone (E.164 ou FR),
 *      email, nom complet sont INTERDITS. Pour téléphone : utiliser
 *      `safePhoneHash()` (PAS `hashPii` brut — collision scrubber ~0.3%,
 *      cf. warning JSDoc `hashPii` + HIGH-1 S9.2.1). Pour autre identifiant
 *      traçable : `hashPii()` direct convient si la valeur ne risque pas
 *      de matcher `RE_FR_NATIONAL` / `RE_E164` / `RE_EMAIL` du scrubber.
 *      Sinon : utiliser un docId Firestore. Le module
 *      `lib/firestore/audit-log.ts` (S6.2) throw `AuditPiiError` à
 *      l'écriture si la règle est violée → garantie technique.
 *
 *   3. **Écriture exclusive via Admin SDK** côté serveur. Les rules
 *      Firestore refusent toute écriture client (`allow write: if false`).
 */
import { type Timestamp } from "firebase-admin/firestore";

/**
 * Actions auditables. Aligné skill `medere-firestore-schema`.
 *
 * Extensions ajoutées au-delà de la skill pour Phase 1 :
 *   - `compliance_check` — chaque appel à `preSendCheckWithAudit` (S6.6,
 *     GUARD-002). Logue les deux branches (allowed/blocked).
 *   - `long_form_opt_out_candidate` — signal de surveillance manuel
 *     (S7, GUARD-001). Logge un message entrant > 50 chars contenant un
 *     signal négatif (`stop`, `refuse`, etc.) pour suivi quantitatif.
 *   - `sms_provider_dispatched` — acquittement du provider SMS (OVH)
 *     APRÈS appel API réussi. Distinct de `sms_sent` (posé par
 *     `addOutbound` lors de l'enqueue Firestore status="queued") pour
 *     permettre un forensic distinct enqueue-vs-dispatch + corréler
 *     `messageId` Firestore ↔ `ovhMessageId` provider. Payload =
 *     `{ ovhMessageId, conversationId, contactId, campaignId, sender,
 *        bodyLength, dryRun, creditsRemoved? }`. Tous scrubber-safe.
 *     Posé par `lib/inngest/functions/send-first-sms` (S8.4, voie
 *     minimaliste Voie 2 — cf. Notion INFRA-DETTE-001).
 *
 * Extensions S9.1 (pipeline process-reply) :
 *   - `intent_classified` — décision du classifier Claude après chaque
 *     `classifyReply` (S7a.2). Payload = `{ intent, confidence, fallback,
 *      promptVersion, model }`. Tous scrubber-safe (intent ∈ enum fermé,
 *     pas de reasoning ni de body).
 *   - `reply_generated` — réponse Claude Sonnet générée et stockée comme
 *     draft Firestore (S9.3.3a). Payload = `ReplyGeneratedPayload` (cf.
 *     interface ci-dessous). `targetType: "message"`, `targetId:
 *     draftMessageId`. 🚨 INVARIANT ANTI-PII : le `body` draft est
 *     INTERDIT dans le payload audit — il est stocké UNIQUEMENT dans
 *     `messages/{draftMessageId}` (forensic L.34-5 CPCE par doc Message,
 *     historisation événement par audit_log SANS contenu). Cf. compliance-
 *     auditor LOW-4 S9.3.2.
 *   - `reply_processed` — pipeline `process-reply` terminé avec succès
 *     post-store-inbound sur une branche non-drop. Posé en step 8 final
 *     (S9.2.3) UNIQUEMENT pour les branches `opt_out_short_form`,
 *     `opt_out_classifier_long_form`, et `classified`. PAS posé sur les
 *     drops — `reply_dropped` suffit. `targetType: "conversation"`,
 *     `targetId: conversationId` (la conv est l'entité qui a transitionné
 *     d'état). Payload =
 *     `{ contactId, conversationId, messageId, intent (STOP|INTERESSE|
 *        OBJECTION|NEUTRE), branchTaken (opt_out_short_form|
 *        opt_out_classifier_long_form|classified), finalConversationStatus
 *        (opted_out|in_dialogue), classifierFallback? (présent ssi
 *        branche passée par classifier), pipelineDurationMs }`. Tous
 *     scrubber-safe (IDs opaques + enums fermés + number). PAS de
 *     body/phone/ovhMessageId/reasoning (defense-in-depth).
 *   - `reply_dropped` — pipeline `process-reply` court-circuité (PS
 *     inconnu, dédup webhook, body invalide). Payload = `{ reason,
 *      ovhMessageIdHash? }`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ORGANISATION VISUELLE (S9.1) — sections par cycle de vie
 *
 * L'ordre des valeurs est SÉMANTIQUE (pas alphabétique). Si tu ajoutes
 * une action, place-la dans la section adéquate :
 *
 *   - SMS OUTBOUND  : envoi côté nous (sortant)
 *   - SMS INBOUND   : réception côté nous (entrant, process-reply S9)
 *   - CONVERSATION  : cycle de vie d'une conversation (handoff, opt-out)
 *   - CAMPAIGN/ADMIN: gestion campagnes + override manuels
 *   - DATA          : import / suppression / anonymisation
 *   - AUTH          : login / rôle
 *   - TRANSVERSE    : compliance check, status changes
 *
 * Tout ajout DOIT être miroré dans `src/lib/firestore/audit-log.ts::ACTIONS`
 * — sentinelle anti-drift dans `audit-log.test.ts` qui force l'égalité
 * ensembliste entre ce type TS et la whitelist runtime.
 */
export type AuditAction =
  // ── SMS OUTBOUND ───────────────────────────────────────────────────────
  | "sms_sent"
  | "sms_failed"
  | "sms_provider_dispatched"
  | "send_blocked"
  // ── SMS INBOUND (S9.1 — process-reply) ─────────────────────────────────
  | "sms_received"
  | "intent_classified"
  | "reply_generated"
  | "reply_processed"
  | "reply_dropped"
  | "long_form_opt_out_candidate"
  // ── CONVERSATION lifecycle ─────────────────────────────────────────────
  | "opt_out"
  | "handoff"
  | "handoff_accepted"
  // ── CAMPAIGN / ADMIN ───────────────────────────────────────────────────
  | "manual_override"
  | "prompt_changed"
  | "campaign_started"
  | "campaign_paused"
  // ── DATA ───────────────────────────────────────────────────────────────
  | "bloctel_imported"
  | "contact_deleted"
  | "contact_anonymized"
  // ── AUTH ───────────────────────────────────────────────────────────────
  | "login"
  | "role_changed"
  // ── TRANSVERSE ─────────────────────────────────────────────────────────
  | "compliance_check"
  | "status_changed";

export type AuditActorType = "system" | "ai" | "human";

export type AuditTargetType =
  | "contact"
  | "conversation"
  | "message"
  | "campaign"
  | "user"
  | "prompt";

// ─────────────────────────────────────────────────────────────────────────────
// Payload types — formes typées des `payload` par action (anti-PII compile-time)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Payload type pour action `reply_generated` (S9.3.3a).
 *
 * **Cible** : `targetType: "message"`, `targetId: draftMessageId`
 * (Firestore auto-ID `[A-Za-z0-9]{20}`, scrubber-safe par construction).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 INVARIANT ANTI-PII — LE CHAMP `body` EST INTERDIT.
 *
 * Le body draft généré par Claude est stocké dans
 * `messages/{draftMessageId}` (collection Firestore Messages), PAS dans
 * `audit_log.payload`. Forensic L.34-5 CPCE :
 *
 *   - traçabilité DU CONTENU envoyé        → doc `messages/{id}`
 *   - historisation DE L'ÉVÉNEMENT         → doc `audit_log/{id}` (sans body)
 *
 * Cette séparation respecte le compliance-auditor LOW-4 S9.3.2 :
 * "ne JAMAIS persister `result.text` brut dans l'audit". Le body LLM
 * peut miroirer des fragments PII du message PS (rare mais possible si
 * Claude reformule). Sentinelle test verrouille l'absence du champ
 * `body` dans le payload.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Champs scrubber-safe par construction
 *
 *   - `contactId`/`conversationId`/`draftMessageId` : IDs opaques internes.
 *   - `intent`                                     : enum fermé.
 *   - `promptVersion`/`model`                      : marqueurs forensic.
 *   - `temperature`/`tokensInput`/`tokensOutput`   : observabilité Claude.
 *   - `bodyLength`                                 : LENGTH SEULEMENT, jamais le body.
 *   - `generationDurationMs`                       : observabilité P95.
 */
export interface ReplyGeneratedPayload {
  /** hubspotId opaque. */
  contactId: string;
  /** docId composite `${contactId}_${campaignId}`. */
  conversationId: string;
  /** Firestore auto-ID `[A-Za-z0-9]{20}` du draft créé par `addOutboundDraftInTx`. */
  draftMessageId: string;
  /** Branche du classifier (S7a.2) qui a déclenché la génération. */
  intent: "INTERESSE" | "OBJECTION" | "NEUTRE";
  /** Version semver du prompt utilisé (ex `"1.0.0"`). */
  promptVersion: string;
  /** Modèle Claude (`"claude-sonnet-4-6"` en S9.3). */
  model: string;
  /** Temperature SDK (`0.5` en S9.3). */
  temperature: number;
  /** Tokens input facturés par Claude. */
  tokensInput: number;
  /** Tokens output facturés par Claude. */
  tokensOutput: number;
  /** Longueur du body draft (chars). JAMAIS le body lui-même. */
  bodyLength: number;
  /** Durée wall-clock de l'appel `generate` (ms). */
  generationDurationMs: number;
  // Index signature explicite : permet l'assignation à
  // `AuditLogInput.payload: Record<string, unknown>` sans cast (cf.
  // pattern `ComplianceConcurrencyContext` errors.ts:199-211 — TS
  // limitation structurelle, no-op runtime, TS-level only).
  readonly [k: string]: unknown;
}

/**
 * Forme persistée d'une entrée d'audit (avec `timestamp` posé par le
 * serveur via `Timestamp.now()` à l'écriture, JAMAIS par l'appelant).
 */
export interface AuditLog {
  actorId: string;
  actorType: AuditActorType;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string;
  /**
   * Contexte minimal. AUCUNE PII en clair. Utiliser des IDs Firestore
   * ou des hashes (cf. `safePhoneHash` pour téléphone, PAS `hashPii`
   * brut — voir warning JSDoc `hashPii` de `lib/utils/pii-detector.ts`).
   */
  payload: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  timestamp: Timestamp;
}

/**
 * Forme d'entrée pour `appendAuditLog()` — pas de `timestamp` (posé
 * côté serveur). Validation Zod + scrubber PII appliquée par
 * `lib/firestore/audit-log.ts`.
 */
export type AuditLogInput = Omit<AuditLog, "timestamp">;
