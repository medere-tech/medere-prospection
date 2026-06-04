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
 *      email, nom complet sont INTERDITS. Utiliser `hashPii()` (HMAC-SHA256
 *      avec pepper serveur, cf. lib/utils/pii-detector.ts) si on a besoin
 *      d'un identifiant traçable. Sinon : utiliser un docId Firestore.
 *      Le module `lib/firestore/audit-log.ts` (S6.2) throw `AuditPiiError`
 *      à l'écriture si la règle est violée → garantie technique.
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
 */
export type AuditAction =
  | "sms_sent"
  | "sms_received"
  | "sms_failed"
  | "sms_provider_dispatched"
  | "send_blocked"
  | "opt_out"
  | "handoff"
  | "handoff_accepted"
  | "manual_override"
  | "prompt_changed"
  | "bloctel_imported"
  | "contact_deleted"
  | "contact_anonymized"
  | "campaign_started"
  | "campaign_paused"
  | "login"
  | "role_changed"
  | "compliance_check"
  | "long_form_opt_out_candidate"
  | "status_changed";

export type AuditActorType = "system" | "ai" | "human";

export type AuditTargetType =
  | "contact"
  | "conversation"
  | "message"
  | "campaign"
  | "user"
  | "prompt";

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
   * Contexte minimal. AUCUNE PII en clair. Utiliser des IDs ou des
   * hashes (cf. `hashPii` de `lib/utils/pii-detector.ts`).
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
