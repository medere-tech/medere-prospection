/**
 * Inngest function `process-reply` — STUB (S8.1 / S8.5).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * RAISON D'ÊTRE
 *
 * Cette function représente le hand-off d'un SMS entrant (réponse PS) vers
 * la chaîne : classifier d'intent (S7a.2 ✅ déjà livré, `lib/claude/
 * intent-classifier.ts`) → routage selon intent (INTERESSE → Slack hand-off,
 * STOP → markOptedOut + audit, NEUTRE/OBJECTION → relance différée, etc.).
 *
 * Pour S8 elle est explicitement **stubbée** : retourne un objet
 * `{ status: "not_implemented", reason: "inbound_pending_INFRA_SMS_001" }`
 * sans crash et sans effet de bord. Aucun Firestore write, aucun appel
 * Claude, aucun envoi Slack.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * POURQUOI STUB ET PAS IMPLÉMENTATION COMPLÈTE ?
 *
 * Le câblage réel demande un **webhook OVH inbound** qui transforme les
 * SMS entrants en events Inngest. Ce webhook nécessite :
 *
 *   - Un short code SMS dédié OU un numéro virtuel OVH (location).
 *   - Une décision Harry + Olivier sur le format final
 *     (short code 5 chiffres = ~250€/mois, numéro virtuel = ~5€/mois mais
 *     moins reconnaissable destinataire).
 *   - Configuration côté OVH cloud du webhook URL → notre endpoint
 *     `/api/webhooks/ovh/inbound` (à créer en même temps que cette
 *     function réelle).
 *
 * Estimation déblocage : 2-4 semaines (cf. ticket Notion `INFRA-SMS-001`
 * Backlog technique). Tant que le webhook n'est pas live, ce stub
 * garantit que :
 *
 *   1. Le code Inngest expose les 2 functions attendues côté topologie
 *      (`send-first-sms` + `process-reply`) → `serve()` ne plante pas.
 *   2. Le dashboard Inngest cloud reconnaît la function comme
 *      enregistrée — facilite le câblage S9 (juste flip de stub en
 *      implémentation, pas de migration d'app).
 *   3. Un event de test envoyé manuellement (ex: depuis un script ou un
 *      curl) reçoit une réponse explicite "not_implemented" plutôt qu'une
 *      erreur 500 silencieuse.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * GUARD-001 — câblage classifier d'intent attendu côté caller réel
 *
 * Quand le webhook OVH sera live (S9), cette function devra :
 *
 *   1. Persist le message inbound via `addInbound(conversationId, ...)`.
 *   2. Appeler `classifyIntent(body)` (S7a.2 ✅).
 *   3. Si intent = STOP → `markOptedOut(contactId, "user_request_sms")`
 *      + audit `opted_out_recorded` + auto-reply confirmation OPTIONNEL
 *      (filet OVH "STOP au …" fait déjà le travail légal côté inbound,
 *      cf. `compliance/opt-out.ts`).
 *   4. Si intent = INTERESSE → handoff Slack (S7b à venir) + update
 *      conversation `handoff: { status: "pending", …}`.
 *   5. Si intent = OBJECTION / NEUTRE → schedule followup différé
 *      (S9 — `schedule-followup` Inngest function).
 *
 * Le fail-safe du classifier (intent="STOP" + isFailSafe=true si erreur
 * Claude) est déjà testé bout-en-bout dans S7a.2 — on s'appuie dessus.
 */
import { getInngestClient } from "@/lib/inngest/client";
import { smsReplyReceived } from "@/lib/inngest/events";

/**
 * ID Inngest stable de la function. NE PAS modifier après le premier
 * déploiement (perte d'historique côté cloud).
 */
const FUNCTION_ID = "process-reply";

/**
 * Code de blocage stable. Référence Notion `INFRA-SMS-001` (Backlog
 * technique) — décision sender SMS (short code vs numéro virtuel) en
 * attente Harry + Olivier. Permet aux tests d'asserter par constante
 * plutôt que par chaîne magique.
 */
const NOT_IMPLEMENTED_REASON = "inbound_pending_INFRA_SMS_001";

/**
 * Résultat du stub. Type discriminant `"not_implemented"` réservé à cette
 * fonction tant que l'implémentation réelle (S9) n'est pas livrée.
 *
 * Quand la vraie implémentation arrivera, le type retour deviendra
 * discriminé sur `intent` (`INTERESSE | NEUTRE | OBJECTION | STOP`) +
 * actions effectuées (`handoff_created`, `opt_out_recorded`, etc.).
 */
export interface ProcessReplyStubResult {
  status: "not_implemented";
  reason: typeof NOT_IMPLEMENTED_REASON;
  note: string;
}

/**
 * Forme minimale du contexte Inngest reçu par le handler. Sert au
 * typage de `processReplyHandler` exporté et à la fabrication d'un
 * fake context en tests.
 */
export interface ProcessReplyHandlerContext {
  event: {
    id?: string;
    name: string;
    data: {
      phone: string;
      body: string;
      ovhMessageId: string;
    };
  };
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
  };
}

/**
 * Handler stub du job `process-reply`. Extrait en fonction nommée pour
 * faciliter les tests (peut être invoqué avec un fake context).
 *
 * **Comportement actuel** : log structuré (sans le body, anti-PII) +
 * retour explicite `{ status: "not_implemented", reason }`. PAS de throw,
 * PAS de retry — un retry serait inutile (la cause n'est pas transitoire,
 * c'est une feature non livrée — cf. INFRA-SMS-001).
 *
 * **Effets de bord** : aucun (pas de Firestore, pas de Claude, pas de
 * Slack, pas d'OVH).
 */
export async function processReplyHandler(
  ctx: ProcessReplyHandlerContext,
): Promise<ProcessReplyStubResult> {
  ctx.logger.info("[process-reply] stub invoked", {
    eventId: ctx.event.id,
    name: ctx.event.name,
    // PAS de logging du body, du phone ni du ovhMessageId (PII inbound /
    // identifiants externes — cf. JSDoc `firestore/messages.ts:36-54`
    // invariants + règle CLAUDE.md "Logs sans PII").
  });
  return {
    status: "not_implemented",
    reason: NOT_IMPLEMENTED_REASON,
    note: "Stub Inngest function — real implementation blocked on OVH inbound webhook (see Notion INFRA-SMS-001). Classifier wiring will follow S7a.2 contract (GUARD-001).",
  };
}

/**
 * Inngest function — STUB jusqu'à S9 (webhook OVH inbound live).
 */
export const processReply = getInngestClient().createFunction(
  {
    id: FUNCTION_ID,
    triggers: [{ event: smsReplyReceived }],
    // Retry désactivé : le stub ne deviendra pas implémenté en réessayant.
    // Quand l'implémentation réelle arrivera (S9), retirer cette ligne →
    // retour à la policy retry Inngest par défaut (4 tentatives).
    retries: 0,
  },
  processReplyHandler,
);

// ─────────────────────────────────────────────────────────────────────────────
// Exposés pour tests sentinelles
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export const __FUNCTION_ID_FOR_TESTS = FUNCTION_ID;
/** @internal */
export const __NOT_IMPLEMENTED_REASON_FOR_TESTS = NOT_IMPLEMENTED_REASON;
