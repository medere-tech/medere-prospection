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
 *     `{ ovhMessageId, conversationId, contactId, campaignId, senderType,
 *        senderFingerprint, bodyLength, dryRun, creditsRemoved? }`. Tous
 *     scrubber-safe. Posé par `lib/inngest/functions/send-first-sms` (S8.4,
 *     voie minimaliste Voie 2 — cf. Notion INFRA-DETTE-001) ET
 *     `lib/inngest/functions/send-reply` (S9.4.2).
 *
 *     🔒 FIX-SENDER-PII (dette S9.7 Time2Chat) : depuis que
 *     `OVH_SMS_SENDER` accepte l'E.164 (`+33939070545` Time2Chat), on NE
 *     persiste PLUS `sender` en clair. `RE_E164` du scrubber
 *     `detectPiiInPayload` matcherait la valeur → `AuditPiiError` →
 *     tx rollback → SMS envoyé côté OVH mais aucune trace Firestore (trou
 *     L.34-5 CPCE + rate-limit faussé). On split désormais en :
 *       - `senderType`        : enum fermé `"e164" | "alpha"` (pas PII)
 *       - `senderFingerprint` : djb2 8 hex (pas PII, forensic par
 *                               corrélation avec archive env config à la
 *                               date de l'audit)
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
 * Extensions S9.4.1 (commitDraftToQueued — transition draft→queued) :
 *   - `reply_draft_dropped` — draft rejeté par `preSendCheckWithAuditTx`
 *     DANS la tx `commitDraftToQueued` (re-validation TOUTES les 9 rules
 *     post-génération S9.3, fenêtre temporelle minutes/heures permettant
 *     un consent drift). `targetType: "message"`, `targetId:
 *     draftMessageId`. Payload = `ReplyDraftDroppedPayload` (cf. interface
 *     ci-dessous). 🚨 INVARIANT ANTI-PII : pas de body, pas de phone, pas
 *     d'email — uniquement IDs opaques + rule/code (enums fermés) +
 *     blockedContext (discriminated union FERMÉE de `pre-send-check.ts`
 *     qui exclut les PII par typage compile-time).
 *
 * Extensions S9.9-PR5a (hand-off Slack — branche orphelins) :
 *   - `handoff_unassigned` — lead INTERESSE non routé vers un commercial :
 *     owner HubSpot absent, sans ligne Airtable, inactif, ou service
 *     HubSpot/Airtable indisponible. Posé par la function Inngest
 *     `slack-handoff` (S9.9-PR5b) sur la branche orphelins (canal partagé
 *     `SLACK_ORPHAN_LEADS_CHANNEL_ID`). `targetType: "conversation"`,
 *     `targetId: conversationId`. Payload = `HandoffUnassignedPayload`
 *     (cf. interface ci-dessous). La conv reste `status="in_dialogue"`
 *     avec `intent="INTERESSE"` — réassignable manuellement via UI
 *     dashboard future S10+. 🚨 INVARIANT ANTI-PII : pas de firstName,
 *     speciality, city, body, phone — uniquement IDs opaques + reason
 *     (enum fermé) + Slack IDs (ts + channel).
 *
 * Extensions PR-A-INBOUND-HANDED-OFF (SMS entrant sur conv `handed_off`) :
 *   - `inbound_relayed_to_human` — un SMS entrant est arrivé sur une
 *     conversation déjà en `handed_off`. Léa reste muette (pas de
 *     classification pour générer une réponse, pas d'envoi), le message
 *     est stocké par `addInbound`, le contrôle opt-out s'applique
 *     normalement, et le commercial titulaire (`handoff.assignedTo`)
 *     reçoit un DM Slack avec l'extrait du message. Posé par le pipeline
 *     Inngest `process-reply` sur la branche handed_off AVANT return.
 *     `targetType: "conversation"`, `targetId: conversationId`. Payload =
 *     `InboundRelayedToHumanPayload` (cf. interface ci-dessous).
 *     Discriminant `wasOptOut` : si `true`, le DM a signifié "ne plus
 *     recontacter" et un audit `opt_out` séparé a été posé par
 *     `markOptedOut` dans la même pipeline. Si `false`, c'est un échange
 *     ordinaire que le commercial doit reprendre côté canal humain.
 *     🚨 INVARIANT ANTI-PII : pas de firstName, speciality, city, body,
 *     phone, ovhMessageId — uniquement IDs opaques + Slack IDs (ts +
 *     channel) + booleans + enum fermé `optOutVia` optionnel.
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
  | "reply_draft_dropped"
  | "long_form_opt_out_candidate"
  // ── CONVERSATION lifecycle ─────────────────────────────────────────────
  | "opt_out"
  | "handoff"
  | "handoff_accepted"
  // S9.9-PR5a — lead INTERESSE non routé vers un commercial (owner
  // manquant/inactif ou service HubSpot/Airtable indisponible). Posé par
  // la function Inngest `slack-handoff` (S9.9-PR5b) sur la branche
  // orphelins. `targetType: "conversation"`, `targetId: conversationId`.
  // Payload = `HandoffUnassignedPayload` (cf. interface ci-dessous) avec
  // `reason` discriminant l'origine du fallback.
  | "handoff_unassigned"
  // PR-A-INBOUND-HANDED-OFF — SMS entrant arrivé sur une conv `handed_off`.
  // Posé par `process-reply` sur la branche handed_off AVANT return. Léa
  // reste muette : pas de setConversationIntent, pas de generateReply,
  // pas de dispatch-reply-event. Le commercial titulaire reçoit un DM.
  // `targetType: "conversation"`, `targetId: conversationId`. Payload =
  // `InboundRelayedToHumanPayload` (cf. interface ci-dessous).
  | "inbound_relayed_to_human"
  // PR-NO-DROPPED-SMS — SMS entrant qu'aucun chemin "actif" ne gère : conv
  // closed/opted_out/blocked, handed_off sans assignedTo, aucune conv du
  // tout, contact inconnu, parse webhook en echec, mise en file Inngest
  // en echec, race P6 (opt-out pendant transition closed/blocked). Pose
  // d'un enregistrement forensic qui remplace les anciens
  // `reply_dropped reason:"contact_unknown" | "no_active_conversation" |
  // "conversation_became_terminal"`. `reply_dropped` reste utilise
  // UNIQUEMENT pour les vrais doublons. Payload =
  // `InboundOnInactiveConversationPayload` (cf. interface ci-dessous).
  // `targetType` : "conversation" quand une conv est connue, sinon
  // "contact" (contact connu sans conv) ou "message" (orphan docId).
  | "inbound_on_inactive_conversation"
  // VUE-CONVERSATION PR0 — accès au numéro de téléphone depuis la vue
  // conversation (`/admin/conversations/[id]`). Posé par
  // `POST /api/admin/conversations/[id]/reveal-phone` AVANT de renvoyer
  // la valeur. Payload = `ContactPhoneAccessedPayload` (cf. interface
  // ci-dessous). Discriminant `method` ∈ `"display"|"copy"|"call"`.
  // Un audit par clic, trois méthodes distinctes.
  | "contact_phone_accessed"
  // ── CAMPAIGN / ADMIN ───────────────────────────────────────────────────
  | "manual_override"
  | "prompt_changed"
  | "campaign_started"
  | "campaign_paused"
  // S10.1.3 — mirror campaign_started pour clôture forensic seed/campagne
  | "campaign_completed"
  // S10.1.4.c — admin déclenche l'envoi du 1er SMS via POST /api/admin/send-first-sms.
  // Audit posé AVANT inngest.send (queue). Forensic AI Act + L.34-5 CPCE :
  // trace l'initiation HUMAINE (vs system) du dispatch, payload sans PII
  // (contactId opaque + campaignId regex-conforme + smsCharCount).
  | "sms_send_initiated_by_admin"
  // ── DATA ───────────────────────────────────────────────────────────────
  | "bloctel_imported"
  | "contact_deleted"
  | "contact_anonymized"
  // S10.1.3 — seed HubSpot → Firestore (traçabilité forensic RGPD origine)
  | "contact_imported_from_hubspot"
  | "contact_created"
  | "contact_import_skipped"
  // ── AUTH ───────────────────────────────────────────────────────────────
  | "login"
  | "role_changed"
  // ── TRANSVERSE ─────────────────────────────────────────────────────────
  | "compliance_check"
  | "status_changed"
  // ── PR2a — dénormalisation liste `/admin/conversations` ───────────────
  // Posé par `propagateContactDenormToConversations` quand un contact
  // modifie `firstName`/`lastName`/`civilite`/`speciality`/`city` et que
  // la copie sur conversations devient obsolète. Payload = `{ contactId,
  // fieldsUpdated: string[] }` — scrubber-safe (noms de champs seulement).
  | "conversation_denorm_propagated"
  // Posé par `scripts/backfill-conversation-list-fields.mjs` pour chaque
  // conversation touchée par le backfill PR2a. Payload = `{ fieldsPosed:
  // string[] }` — scrubber-safe.
  | "backfill_conversation_list_fields"
  // ── PR2c tour 2a — transitions SMS orphelins ─────────────────────────
  // Un admin rattache un orphan `inbound_messages_orphans/{oih_...}` à
  // une conversation EXISTANTE. Le SMS est posé via `addInboundIdempotent`
  // sur la conv ciblée avec `attachedFromOrphan`. Léa n'est pas déclenchée.
  // `targetType: "conversation"`, `targetId: conversationId` (la conv qui
  // reçoit le message). Payload = `OrphanAttachedToConversationPayload`.
  | "orphan_attached_to_conversation"
  // Un admin ferme un orphan sans rattachement (`motif` dans enum fermé).
  // `targetType: "message"`, `targetId: orphanDocId`.
  // Payload = `OrphanDismissedPayload`.
  | "orphan_dismissed"
  // Un admin remet un orphan en file après l'avoir marqué traité par
  // erreur. Transition `dismissed → pending` uniquement.
  // `targetType: "message"`, `targetId: orphanDocId`.
  // Payload = `OrphanReopenedPayload`.
  | "orphan_reopened";

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
 * Payload type pour action `reply_draft_dropped` (S9.4.1).
 *
 * **Cible** : `targetType: "message"`, `targetId: draftMessageId`
 * (Firestore auto-ID `[A-Za-z0-9]{20}`, scrubber-safe par construction).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 INVARIANT ANTI-PII — body / phone / email / ovhMessageId INTERDITS.
 *
 * Posé HORS tx en best-effort par `commitDraftToQueued` après rollback de
 * la tx (le draft reste `status="draft"`, aucun envoi OVH n'a eu lieu).
 * Le body du draft existe toujours dans `messages/{draftMessageId}` — pas
 * besoin de le dupliquer ici (forensic L.34-5 CPCE intact par cohabitation
 * `reply_generated` (création draft) + `reply_draft_dropped` (rejet draft)).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Champs scrubber-safe par construction
 *
 *   - `contactId`/`conversationId`/`draftMessageId` : IDs opaques internes.
 *   - `blockedRule`                                 : enum FERMÉ aligné
 *                                                     `ComplianceRule` S5.
 *   - `blockedCode`                                 : enum FERMÉ aligné
 *                                                     `ComplianceFailCode` S5.
 *   - `blockedContext`                              : discriminated union
 *                                                     FERMÉE de `pre-send-
 *                                                     check.ts` qui exclut
 *                                                     les PII par typage
 *                                                     compile-time (clés
 *                                                     autorisées : count,
 *                                                     hour, minute, weekday,
 *                                                     isoDate, year,
 *                                                     maxAllowed, etc.).
 */
export interface ReplyDraftDroppedPayload {
  /** hubspotId opaque. */
  contactId: string;
  /** docId composite `${contactId}_${campaignId}`. */
  conversationId: string;
  /** Firestore auto-ID `[A-Za-z0-9]{20}` du draft rejeté. */
  draftMessageId: string;
  /** Nom de la rule compliance qui a refusé (aligné `ComplianceRule` S5). */
  blockedRule:
    | "opt_out"
    | "ai_disclosure"
    | "stop_present"
    | "advertiser_identification"
    | "rate_limit"
    | "reply_volume"
    | "hours"
    | "bloctel"
    | "legitimate_interest"
    | "phone_validity";
  /**
   * Code spécifique du failure (aligné `ComplianceFailCode` S5). Typé
   * `string` ici plutôt que l'union fermée — autonomie du type audit vs
   * l'enum compliance (évite couplage `types/audit-log.ts` →
   * `lib/compliance/pre-send-check.ts`). La cohérence est assurée au
   * site d'écriture par le caller `commitDraftToQueued` qui passe la
   * valeur typée `ComplianceFailCode`.
   */
  blockedCode: string;
  /**
   * Contexte structuré du failure tel que renvoyé par `preSendCheck`.
   * Anti-PII par typage S5 (discriminated union FERMÉE, clés autorisées :
   * solicitationCount, totalOutboundCount, replyCount, maxAllowed,
   * windowDays, windowHours, hour, minute, weekday, isoDate, year,
   * maxVerified, daysSinceCheck, documentedLength, minLength). Aucune
   * de ces clés n'est PII par construction.
   */
  blockedContext: Record<string, unknown>;
  // Index signature pour assignation `AuditLogInput.payload` (cf. pattern
  // miroir `ReplyGeneratedPayload` + JSDoc ci-dessus).
  readonly [k: string]: unknown;
}

/**
 * Raisons discriminantes pour `handoff_unassigned` (S9.9-PR5a).
 *
 * Enum FERMÉ — toute nouvelle cause de fallback orphelins DOIT étendre
 * cette union explicitement (compile-time safety). Aligné avec la
 * discrimination du step `decide-route` de la function Inngest
 * `slack-handoff` (S9.9-PR5b) :
 *
 *   - `"no_owner"`               : contact HubSpot sans `hubspot_owner_id`
 *                                  assigné (rare mais possible sur import).
 *   - `"commercial_not_found"`   : owner_id présent mais aucune ligne
 *                                  correspondante dans Airtable Commerciaux
 *                                  (owner parti, table pas encore mise à jour).
 *   - `"commercial_inactive"`    : ligne Airtable trouvée mais `Statut ≠ "Actif"`
 *                                  (commercial en congé, quitté, etc.).
 *   - `"hubspot_unavailable"`    : appel HubSpot a throw (5xx / network /
 *                                  timeout). Fallback immédiat orphelins pour
 *                                  ne pas retenir un lead chaud.
 *   - `"airtable_unavailable"`   : appel Airtable a throw (5xx / network /
 *                                  timeout). Idem — orphelins immédiat.
 */
export type HandoffUnassignedReason =
  | "no_owner"
  | "commercial_not_found"
  | "commercial_inactive"
  | "hubspot_unavailable"
  | "airtable_unavailable";

/**
 * Payload type pour action `handoff_unassigned` (S9.9-PR5a).
 *
 * **Cible** : `targetType: "conversation"`, `targetId: conversationId`
 * (la conv est l'entité qui aurait dû transitionner en `handed_off` — sur
 * la branche orphelins elle reste `in_dialogue` avec `intent: "INTERESSE"`,
 * réassignable manuellement par le commercial team).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 INVARIANT ANTI-PII — INTERDITS EN PAYLOAD
 *
 * Interdits (compile-time via cette signature stricte + defense-in-depth
 * scrubber runtime `detectPiiInPayload`) :
 *   - `firstName`, `lastName`, `civilite` — prénom/nom du PS
 *   - `speciality`, `city`, `postalCode` — contexte métier du PS
 *   - `body`, `lastInboundBody` — contenu SMS
 *   - `phone`, `email`, `hubspotOwnerId` — coordonnées / identifiants CRM
 *
 * Ces champs vivent dans le doc `contacts/{contactId}` (accessible via
 * dashboard Clerk-protected) et dans les blocks Slack de la notification
 * elle-même (fenêtre courte, pas persistée en audit). Le forensic
 * L.34-5 CPCE est complet par cohabitation :
 *   - contenu notifié → dashboard + logs Slack workspace
 *   - événement audité → doc `audit_log/{id}` sans contenu
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Champs scrubber-safe par construction
 *
 *   - `contactId`/`conversationId`/`draftMessageId` : IDs opaques internes.
 *   - `reason`                                     : enum FERMÉ (5 valeurs),
 *                                                    pas PII.
 *   - `slackTs`                                    : timestamp Slack (`"1234.5678"`),
 *                                                    identifiant technique.
 *   - `slackChannel`                               : Slack channel ID (`C…`) OU
 *                                                    DM channel ID (`D…`), ID
 *                                                    opaque interne workspace.
 */
export interface HandoffUnassignedPayload {
  /** hubspotId opaque. */
  contactId: string;
  /** docId composite `${contactId}_${campaignId}`. */
  conversationId: string;
  /**
   * Firestore auto-ID `[A-Za-z0-9]{20}` du draft SMS auto envoyé au PS
   * (step 8d process-reply S9.4.3). Permet la corrélation forensique
   * `handoff_unassigned → reply_generated → sms_provider_dispatched`.
   */
  draftMessageId: string;
  /** Cause discriminante du fallback orphelins. Cf. `HandoffUnassignedReason`. */
  reason: HandoffUnassignedReason;
  /**
   * Timestamp Slack du message posté dans le canal orphelins par
   * `chat.postMessage` (format `"1234567890.123456"`). Permet de rebondir
   * en thread depuis le dashboard ou de retrouver la notif dans l'historique
   * Slack. Pas PII (identifiant technique).
   */
  slackTs: string;
  /**
   * Slack channel ID retourné par `chat.postMessage`. Pour la branche
   * orphelins, c'est le channel ID du canal partagé
   * (`SLACK_ORPHAN_LEADS_CHANNEL_ID`). Pas PII (ID interne workspace).
   */
  slackChannel: string;
  // Index signature explicite : permet l'assignation à
  // `AuditLogInput.payload: Record<string, unknown>` sans cast (cf. pattern
  // miroir `ReplyGeneratedPayload` — TS-level uniquement, no-op runtime).
  readonly [k: string]: unknown;
}

/**
 * Discriminant du chemin d'opt-out emprunté sur une branche `handed_off`
 * (PR-A-INBOUND-HANDED-OFF). Enum fermé — toute nouvelle voie d'opt-out
 * détectée DOIT étendre explicitement cette union (compile-time safety).
 *
 *   - `"short_form"`             : `isOptOut(body)` match déterministe
 *                                  (STOP, ARRET, DESINSCRIPTION, <= 50 chars).
 *   - `"classifier_long_form"`   : classifier Claude a retourné `intent:"STOP"`
 *                                  sur un body > 50 chars sans mot-clé
 *                                  déterministe (ferme GUARD-001 pour
 *                                  handed_off aussi).
 */
export type InboundRelayedOptOutVia = "short_form" | "classifier_long_form";

/**
 * Payload type pour action `inbound_relayed_to_human` (PR-A-INBOUND-HANDED-OFF).
 *
 * **Cible** : `targetType: "conversation"`, `targetId: conversationId`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 INVARIANT ANTI-PII — INTERDITS EN PAYLOAD
 *
 * Interdits (compile-time via cette signature stricte + defense-in-depth
 * scrubber runtime `detectPiiInPayload`) :
 *   - `firstName`, `lastName`, `civilite` — identité du PS
 *   - `speciality`, `city`, `postalCode` — contexte métier du PS
 *   - `body`, `lastInboundBody` — contenu SMS entrant
 *   - `phone`, `email`, `ovhMessageId` — coordonnées / IDs semi-sensibles
 *
 * Ces champs vivent dans :
 *   - le doc `messages/{messageId}` (body + externalReceiver phone), posé
 *     par `addInbound` dans la MÊME exécution — forensic L.34-5 CPCE.
 *   - le doc `contacts/{contactId}` (identité, spé, ville) accessible via
 *     dashboard Clerk-protected.
 *   - les blocks Slack de la notification elle-même (fenêtre courte, pas
 *     persistée en audit).
 *
 * Le forensic complet est obtenu par cohabitation :
 *   contenu notifié    → `messages/{id}` + logs Slack workspace
 *   événement audité   → doc `audit_log/{id}` sans contenu
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Champs scrubber-safe par construction
 *
 *   - `contactId`/`conversationId`/`messageId` : IDs opaques internes.
 *   - `assignedTo`                            : Slack user ID (`U…`),
 *                                               ID technique workspace,
 *                                               pas PII personnelle.
 *   - `slackTs`                               : timestamp Slack
 *                                               (`"1234567890.123456"`).
 *   - `slackChannel`                          : Slack channel ID — pour un
 *                                               DM, c'est un DM channel ID
 *                                               (`D…`), ID interne workspace.
 *   - `wasOptOut`                             : boolean. Discriminant du
 *                                               chemin (true → DM "ne plus
 *                                               recontacter", `opt_out`
 *                                               audit posé en parallèle
 *                                               par `markOptedOut`).
 *   - `optOutVia`                             : enum fermé OPTIONNEL
 *                                               (`short_form` /
 *                                               `classifier_long_form`),
 *                                               présent SSI `wasOptOut`
 *                                               vaut `true`.
 */
export interface InboundRelayedToHumanPayload {
  /** hubspotId opaque. */
  contactId: string;
  /** docId composite `${contactId}_${campaignId}`. */
  conversationId: string;
  /** Firestore auto-ID `[A-Za-z0-9]{20}` du doc inbound posé par `addInbound`. */
  messageId: string;
  /**
   * Slack user ID (`U…`) du commercial titulaire — valeur miroir de
   * `conversation.handoff.assignedTo`. Pas PII personnelle (identifiant
   * technique workspace).
   */
  assignedTo: string;
  /**
   * Timestamp Slack retourné par `chat.postMessage` (format
   * `"1234567890.123456"`). Permet de rebondir en thread Slack et de
   * corréler la trace audit avec l'historique Slack workspace.
   */
  slackTs: string;
  /**
   * Slack channel ID retourné par `chat.postMessage`. Pour un DM, c'est
   * un DM channel ID (`D…`) scopé workspace.
   */
  slackChannel: string;
  /**
   * `true` si le message entrant a déclenché l'opt-out (court-forme OU
   * long-forme). Dans ce cas un audit `opt_out` séparé est posé par
   * `markOptedOut` dans la MÊME exécution du pipeline.
   */
  wasOptOut: boolean;
  /**
   * Présent UNIQUEMENT si `wasOptOut === true`. Discriminant du chemin
   * de détection (court-forme déterministe vs long-forme classifier).
   */
  optOutVia?: InboundRelayedOptOutVia;
  // Index signature explicite : permet l'assignation à
  // `AuditLogInput.payload: Record<string, unknown>` sans cast (cf. pattern
  // miroir `HandoffUnassignedPayload` — TS-level uniquement, no-op runtime).
  readonly [k: string]: unknown;
}

/**
 * Enum ferme des raisons pour `inbound_on_inactive_conversation`.
 * Toute nouvelle branche d'abandon DOIT etendre explicitement cette union
 * (compile-time safety contre le "drop silencieux").
 *
 *   - `"closed"`                  : conv la plus recente du contact est en
 *                                   `closed` — PS reecrit apres fermeture
 *                                   legitime (RDV, abandon, etc.).
 *   - `"opted_out"`               : conv la plus recente est `opted_out` —
 *                                   PS reecrit apres s'etre desabonne.
 *                                   Confirmation DM "ne plus recontacter".
 *   - `"blocked"`                 : conv la plus recente est `blocked`
 *                                   (Bloctel / plafond / autre guard).
 *   - `"handed_off_no_assignee"`  : conv `handed_off` sans
 *                                   `handoff.assignedTo` (invariant soft
 *                                   brise cote donnee). Alerte canal
 *                                   orphelins + Sentry error.
 *   - `"no_conversation"`         : contact connu mais aucune conv ne lui
 *                                   est attachee (bug amont ou donnee
 *                                   corrompue). Stocke en orphelins avec
 *                                   contactId renseigne.
 *   - `"unknown_contact"`         : numero emetteur ne matche aucun
 *                                   contact. Stocke en orphelins avec
 *                                   `phoneHash` seul.
 *   - `"parse_failed"`            : webhook OVH token-valide mais payload
 *                                   illisible (JSON / formData / Zod).
 *                                   Stocke en orphelins avec hash du
 *                                   payload brut (docId `oih_...`).
 *   - `"enqueue_failed"`          : webhook OVH token-valide, payload
 *                                   parse, mais `inngest.send` echoue.
 *                                   Stocke en orphelins best-effort.
 *   - `"conversation_became_terminal"` : race P6 — conv passee a
 *                                   closed/blocked entre resolve-conv et
 *                                   markOptedOut dans la branche
 *                                   handed_off. Message stocke, DM "verifier
 *                                   la fiche" envoye, Sentry critique.
 */
export type InboundOnInactiveConversationReason =
  | "closed"
  | "opted_out"
  | "blocked"
  | "handed_off_no_assignee"
  | "no_conversation"
  | "unknown_contact"
  | "parse_failed"
  | "enqueue_failed"
  | "conversation_became_terminal";

/**
 * Payload type pour action `inbound_on_inactive_conversation` (PR-NO-DROPPED-SMS).
 *
 * **Cible** : `targetType` depend du cas :
 *   - `"conversation"` + `targetId: conversationId` quand la conv est connue.
 *   - `"contact"` + `targetId: contactId` quand contact connu sans conv.
 *   - `"message"` + `targetId: orphanDocId` quand contact ET conv absents
 *     (ou pour parse_failed / enqueue_failed).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 INVARIANT ANTI-PII — INTERDITS EN PAYLOAD
 *
 * Interdits (compile-time via cette signature stricte + defense-in-depth
 * scrubber runtime `detectPiiInPayload`) :
 *   - `firstName`, `lastName`, `civilite`, `speciality`, `city`, `postalCode`
 *   - `body`, `lastInboundBody` — contenu SMS entrant
 *   - `phone`, `email`, `ovhMessageId` — coordonnees / IDs semi-sensibles
 *
 * Ces champs vivent AILLEURS (doc message / doc orphan / doc contact /
 * blocks Slack). Le forensic complet est obtenu par cohabitation.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Champs scrubber-safe par construction
 *
 *   - `reason`         : enum ferme (ci-dessus).
 *   - `wasOptOut`      : boolean (opt-out detecte dans le body entrant).
 *   - `contactId`      : hubspotId opaque, optionnel (absent si inconnu).
 *   - `conversationId` : docId composite, optionnel (absent si aucune).
 *   - `messageId`      : docId Firestore 20 chars, optionnel (absent si
 *                        le message n'a pas pu etre stocke sur une conv).
 *   - `orphanDocId`    : docId `oih_...` (`inbound_messages_orphans`),
 *                        optionnel (present SSI stocke en orphelins).
 *   - `phoneHash`      : hash HMAC `hph_...` (prefix safePhoneHash),
 *                        optionnel. Pas PII.
 *   - `assignedTo`     : Slack user ID (`U...`), optionnel (DM titulaire).
 *   - `slackChannel`   : Slack channel ID retourne par chat.postMessage
 *                        (DM `D...` OU canal orphelins `C.../G...`),
 *                        optionnel (absent si notif a echoue).
 *   - `slackTs`        : timestamp Slack, optionnel.
 *   - `notifiedVia`    : enum ferme partage avec le webhook route.
 *                        Cf. `InboundOnInactiveNotifiedVia`. `"digest"` quand
 *                        l'alerte individuelle a ete regroupee par le plafond
 *                        anti-inondation (MED-1).
 */
export interface InboundOnInactiveConversationPayload {
  reason: InboundOnInactiveConversationReason;
  wasOptOut: boolean;
  contactId?: string;
  conversationId?: string;
  messageId?: string;
  orphanDocId?: string;
  phoneHash?: string;
  assignedTo?: string;
  slackChannel?: string;
  slackTs?: string;
  notifiedVia?: InboundOnInactiveNotifiedVia;
  // Index signature explicite : permet l'assignation a
  // `AuditLogInput.payload: Record<string, unknown>` sans cast (cf. pattern
  // miroir `InboundRelayedToHumanPayload` — TS-level uniquement, no-op runtime).
  readonly [k: string]: unknown;
}

/**
 * Enum ferme partage entre `process-reply` (pipeline Inngest) et
 * `/api/webhooks/ovh-sms` (route Next.js). Toute branche qui pose un audit
 * `inbound_on_inactive_conversation` DOIT utiliser une des 5 valeurs.
 *
 *   - `"dm"`            : DM Slack au titulaire (`handoff.assignedTo`).
 *   - `"orphan_channel"`: alerte individuelle envoyee au canal partage
 *                         `SLACK_ORPHAN_LEADS_CHANNEL_ID`.
 *   - `"digest"`        : alerte INDIVIDUELLE REGROUPEE dans un digest
 *                         par le plafond anti-inondation (MED-1
 *                         compliance-auditor). UN digest par minute par
 *                         reason remplace les alertes 21+ dans la
 *                         fenetre. wasOptOut=true ne tombe JAMAIS en
 *                         "digest" (plafond court-circuite).
 *   - `"suppressed"`    : 21e alerte+ ET digest de la minute deja emis.
 *                         Rien envoye a Slack. Audit pose malgre tout
 *                         (forensic L.34-5 CPCE preserve), Sentry
 *                         warning signale l'anomalie.
 *   - `"notify_failed"` : erreur SDK Slack au moment du post (ex: 500).
 *                         Audit pose malgre tout, Sentry error signale.
 */
export type InboundOnInactiveNotifiedVia =
  | "dm"
  | "orphan_channel"
  | "digest"
  | "suppressed"
  | "notify_failed";

/**
 * Methode d'acces au numero de telephone pour `contact_phone_accessed`
 * (VUE-CONVERSATION PR0). Enum FERME — toute nouvelle methode detectee
 * DOIT etendre explicitement cette union (compile-time safety).
 *
 *   - `"display"` : clic sur « Afficher le numero ».
 *   - `"copy"`    : clic sur « Copier » (navigator.clipboard).
 *   - `"call"`    : clic sur « Appeler » (href `tel:`).
 */
export type ContactPhoneAccessMethod = "display" | "copy" | "call";

/**
 * Payload type pour action `contact_phone_accessed` (VUE-CONVERSATION PR0).
 *
 * **Cible** : `targetType: "contact"`, `targetId: contactId` (hubspotId
 * opaque). La conversation d'origine est documentee dans le payload pour
 * forensic (traçabilite de l'origine du clic).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 INVARIANT ANTI-PII — INTERDITS EN PAYLOAD
 *
 *   - `e164`, `phone`, `phoneRaw` — le numero NE DOIT JAMAIS figurer dans
 *     le payload audit. Le numero est renvoye uniquement dans la reponse
 *     HTTP de l'endpoint audite, et JAMAIS persiste cote audit log.
 *   - `firstName`, `lastName`, `email` — identite du PS.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Champs scrubber-safe par construction
 *
 *   - `method`         : enum ferme (3 valeurs), pas PII.
 *   - `conversationId` : docId composite `${contactId}_${campaignId}`.
 *   - `contactId`      : hubspotId opaque (deja dans `targetId`, duplique
 *                        ici pour requete rapide payload-only).
 */
export interface ContactPhoneAccessedPayload {
  /** Methode d'acces : `display` (afficher) | `copy` (copier) | `call` (appeler). */
  method: ContactPhoneAccessMethod;
  /** docId composite `${contactId}_${campaignId}` — origine du clic. */
  conversationId: string;
  /** hubspotId opaque (duplique avec `targetId` pour requete payload). */
  contactId: string;
  // Index signature explicite : permet l'assignation a
  // `AuditLogInput.payload: Record<string, unknown>` sans cast (cf. pattern
  // miroir `HandoffUnassignedPayload` — TS-level uniquement, no-op runtime).
  readonly [k: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payloads orphelins — PR2c tour 2a (transitions `pending → attached/dismissed`
// et `dismissed → pending`). Tous les champs sont scrubber-safe par
// construction (IDs opaques + enums fermés). JAMAIS de body, phone, email.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Motif figé pour `orphan_dismissed`. Enum fermé pour empêcher du texte
 * libre dans le payload audit (anti-leak + anti-divergence UX).
 */
export type OrphanDismissReason =
  | "unrelated_or_spam"
  | "already_handled_elsewhere"
  | "sender_not_identifiable";

/**
 * Résultat de la comparaison `phoneHash` de l'orphan vs hash du numéro
 * du contact ciblé par l'attach. Enum fermé pour forensic :
 *   - `"match"`          : les hash concordent (sanity majeure).
 *   - `"mismatch"`       : les hash diffèrent — l'admin rattache quand
 *                          même (ex. parse_failed sans phoneHash, ou
 *                          numéro contact changé entre temps).
 *   - `"not_computable"` : l'orphan n'a pas de phoneHash OU le contact
 *                          n'a pas de phone.e164 (parse_failed typique).
 */
export type OrphanPhoneMatch = "match" | "mismatch" | "not_computable";

/**
 * Payload pour `orphan_attached_to_conversation`.
 *
 * **Cible** : `targetType: "conversation"`, `targetId: conversationId`
 * (la conv qui reçoit le message rattaché).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 INVARIANT ANTI-PII — INTERDITS
 *   - `body`, `phone`, `email`, `firstName`, `phoneHash`
 *
 * Champs scrubber-safe :
 *   - `orphanDocId`     : docId `oih_...` (hash HMAC).
 *   - `contactId`       : hubspotId opaque.
 *   - `conversationId`  : docId composite `${contactId}_${campaignId}`.
 *   - `messageId`       : Firestore auto-ID 20 chars du doc inbound créé.
 *   - `reason`          : enum fermé OrphanInboundReason (4 valeurs).
 *   - `phoneMatch`      : enum fermé OrphanPhoneMatch (3 valeurs).
 *   - `wasOptOut`       : boolean (opt-out détecté sur le body rattaché).
 *   - `isTestFixture`   : boolean (orphan posé par seed e2e vs réel).
 */
export interface OrphanAttachedToConversationPayload {
  orphanDocId: string;
  contactId: string;
  conversationId: string;
  messageId: string;
  reason: "no_conversation" | "unknown_contact" | "parse_failed" | "enqueue_failed";
  phoneMatch: OrphanPhoneMatch;
  wasOptOut: boolean;
  isTestFixture: boolean;
  readonly [k: string]: unknown;
}

/**
 * Payload pour `orphan_dismissed`.
 *
 * **Cible** : `targetType: "message"`, `targetId: orphanDocId`.
 *
 * 🚨 INVARIANT ANTI-PII — pas de body/phone/motif texte libre. Le motif
 * est contraint à l'enum fermé `OrphanDismissReason`.
 */
export interface OrphanDismissedPayload {
  orphanDocId: string;
  reason: "no_conversation" | "unknown_contact" | "parse_failed" | "enqueue_failed";
  dismissReason: OrphanDismissReason;
  isTestFixture: boolean;
  readonly [k: string]: unknown;
}

/**
 * Payload pour `orphan_reopened`.
 *
 * **Cible** : `targetType: "message"`, `targetId: orphanDocId`.
 */
export interface OrphanReopenedPayload {
  orphanDocId: string;
  reason: "no_conversation" | "unknown_contact" | "parse_failed" | "enqueue_failed";
  isTestFixture: boolean;
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
