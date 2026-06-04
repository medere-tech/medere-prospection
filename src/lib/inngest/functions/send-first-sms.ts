/**
 * Inngest function `send-first-sms` — orchestration de l'envoi du premier
 * SMS d'une campagne à un contact (Phase 1 MVP, S8).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ⚠️ DETTE TECHNIQUE INFRA-DETTE-001 — race condition rate-limit
 *
 * Cette implémentation MVP repose sur **Inngest concurrency par
 * `event.data.contactId`** (limit 1) pour sérialiser les envois sur un
 * même contact et ainsi éviter la race condition rate-limit 3 SMS / 30j.
 *
 * Pour scaler en prod >200 contacts simultanés et fermer la race
 * by-construction Firestore-side, PAYER la dette S6.6 AVANT de scaler :
 *
 *   1. Extraire `addOutboundInTx(tx, ...)` de `addOutbound`
 *      (`firestore/messages.ts` actuel = transaction enveloppante figée).
 *   2. Exposer `listRecentOutboundInTx(tx, conversationId)` (variant
 *      tx-aware de `listRecentOutbound`).
 *   3. Exposer `updateMessageStatus(conversationId, messageId, status,
 *      externalId?)` (mentionné `messages.ts:25-26` comme reporté S7).
 *   4. Migrer le pipeline 4 steps actuel vers le pattern 5 steps :
 *
 *        - get-contact-and-history       (HORS tx)
 *        - compliance-pre-send-check     (audit auto, HORS tx)
 *        - reserve-outbound-in-firestore (`withContactLock` PURE :
 *                                          re-check rate-limit + addOutboundInTx
 *                                          `status="queued"`)
 *        - ovh-send                      (HORS tx — DRY_RUN ou réel)
 *        - mark-message-sent             (updateMessageStatus → "sent",
 *                                          pose externalId = ovhMessageIds[0])
 *
 *   5. Retirer la dépendance à `concurrency: { key, limit: 1 }` SI la
 *      transaction Firestore garantit l'exclusion mutuelle (mais
 *      conserver `key` pour rate-limiting global Inngest reste prudent).
 *
 * Cf. Notion `INFRA-DETTE-001` (Backlog technique) pour le plan complet
 * de migration + critères Done.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * GARDE-FOUS S8 (non-négociables — modifier nécessite issue Notion)
 *
 *   [GF1] `concurrency: { key: "event.data.contactId", limit: 1 }`
 *         → sérialise les jobs d'un MÊME contact. C'est CE qui ferme la
 *           race condition rate-limit en l'absence de withContactLock.
 *           Test sentinelle dans `send-first-sms.test.ts` verrouille la
 *           présence de cette config par inspection structurelle.
 *
 *   [GF2] JSDoc INFRA-DETTE-001 (ce bloc) explicite dans le code.
 *
 *   [GF3] Test sentinelle anti-régression (S8.4) — vérifie EXACTEMENT
 *         que `sendFirstSms.opts.concurrency.{key,limit}` ne sont pas
 *         retirés ou modifiés silencieusement.
 *
 *   [GF4] Référence Notion `INFRA-DETTE-001` dans tous les commits S8
 *         qui touchent ce fichier.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * S8.1 — skeleton placeholder
 *
 * Pour S8.1, la function expose uniquement :
 *   - L'ID Inngest stable (`send-first-sms`)
 *   - Le trigger event (string pour S8.1, Zod schema en S8.3)
 *   - La config `concurrency` (GF1)
 *   - Un handler placeholder qui logue + retourne `{ status: "skeleton" }`
 *
 * L'implémentation réelle (4 steps : get-contact-and-history,
 * compliance-pre-send-check, ovh-send, record-outbound) est livrée
 * en S8.4.
 */
import { getInngestClient } from "@/lib/inngest/client";
import { smsSendFirstRequested } from "@/lib/inngest/events";

/**
 * ID Inngest stable de la function. Apparaît dans le dashboard cloud et
 * dans les URLs d'exécution. NE PAS modifier après le premier déploiement
 * — perte d'historique côté Inngest.
 */
const FUNCTION_ID = "send-first-sms";

/**
 * Inngest function — première version skeleton (S8.1).
 *
 * **Trigger** : event `medere/sms.send-first.requested` (cf. `events.ts`
 * S8.3 — payload Zod-validé `{ contactId, campaignId, body }`).
 *
 * **Concurrency** [GF1] : `{ key: "event.data.contactId", limit: 1 }`
 *   - 2 jobs simultanés sur le même `contactId` → 2ème enqueued, exécuté
 *     APRÈS la fin du 1er. Pas de race condition rate-limit possible.
 *   - Jobs sur des `contactId` différents → parallèles (pas de blocage
 *     global). Limit total Inngest = quota plan, hors-scope S8.
 *
 * **Handler** : pour S8.1 = placeholder. Retourne `{ status: "skeleton" }`.
 * Implémentation réelle en S8.4.
 */
export const sendFirstSms = getInngestClient().createFunction(
  {
    id: FUNCTION_ID,
    triggers: [{ event: smsSendFirstRequested }],
    // [GF1] Verrouillé par test sentinelle S8.4 — ne PAS retirer ni
    // modifier sans payer la dette INFRA-DETTE-001 (cf. JSDoc en-tête).
    concurrency: {
      key: "event.data.contactId",
      limit: 1,
    },
  },
  async ({ event, logger }) => {
    logger.info("[send-first-sms] skeleton invoked", {
      eventId: event.id,
      name: event.name,
      // PAS de logging du payload : peut contenir le body SMS = potentiellement
      // PII si quelqu'un mal-utilise (numéro coller). Strict allowlist.
    });
    return {
      status: "skeleton" as const,
      note: "S8.1 skeleton — real implementation in S8.4",
    };
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Exposés pour tests sentinelles
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export const __FUNCTION_ID_FOR_TESTS = FUNCTION_ID;
