/**
 * Variante TX-AWARE de `preSendCheckWithAudit` (S9.4.1) — re-validation
 * des 9 rules compliance DANS une transaction Firestore.
 *
 * S9.4.1 — `commitDraftToQueued` (`src/lib/firestore/send-reply.ts`)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * RAISON D'ÊTRE — fenêtre temporelle S9.3 → S9.4
 *
 * Entre la génération d'un draft IA (S9.3.3b, step 8b `addOutboundDraft`)
 * et l'envoi effectif (S9.4 `commitDraftToQueued` + dispatch OVH S9.4.2),
 * la fenêtre temporelle peut être **minutes à heures** (event Inngest
 * `medere/sms.reply.send-requested` posté en file, retry transient,
 * concurrence consumer). Pendant cette fenêtre :
 *
 *   - Le PS peut avoir opted-out via un autre canal (autre SMS, dashboard
 *     commercial, webhook Bloctel) → rule `opt_out` peut basculer.
 *   - L'heure courante peut sortir de la plage L-V 10-13h / 14-20h → rule
 *     `hours` peut basculer (le draft a été généré à 19h59, on commit
 *     à 20h05).
 *   - Un autre SMS peut avoir été envoyé entre-temps → rule `rate_limit`
 *     peut basculer (le draft a été généré à 2/3, on commit à 3/3).
 *   - Le contact peut avoir été marqué `phone_invalid` ou `phone_voip` par
 *     un lookup Twilio ultérieur → rule `phone_validity` peut basculer.
 *
 * Contrairement au pattern S6 (`sendOutboundWithLock`) qui re-vérifie
 * UNIQUEMENT `rate_limit` (seule rule sujette à la race millisecondes en
 * S6), S9.4 doit re-vérifier les **9 rules** car la fenêtre est plus
 * large et les rules contexte (opt_out, hours, bloctel, phone) peuvent
 * toutes drifter.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 ASYMÉTRIE BRANCHE allowed VS blocked (arbitrage Déthié S9.4.1)
 *
 *   - **`allowed`** → pose audit `compliance_check (allowed)` DANS la tx
 *     via `appendAuditLogTx`. Atomicité avec le `sms_sent` qui sera posé
 *     ensuite par `commitDraftToQueued` dans la MÊME tx — si la tx commit,
 *     les 2 audits sont visibles ; si elle rollback, les 2 disparaissent.
 *     Retourne `{ ok: true }`.
 *
 *   - **`blocked`** → throw `ComplianceFailureError(failure)`. NE POSE
 *     AUCUN AUDIT DANS LA TX. La tx rollback automatiquement (aucun audit
 *     `allowed` ne sera commit, aucune transition `draft→queued` ne sera
 *     commit). L'appelant (`commitDraftToQueued`) catch l'erreur HORS
 *     `withContactLock` et pose 2 audits best-effort HORS tx :
 *       (1) `compliance_check (blocked)` — cohérence S6.6 GUARD-002 (audit
 *           dans les 2 branches du wrapper compliance).
 *       (2) `reply_draft_dropped` — S9.4.1 nouveau, forensic L.34-5 CPCE
 *           du draft rejeté avec rule/code/context.
 *
 * Pourquoi cette asymétrie :
 *   - DANS la tx, on ne peut pas poser un audit `compliance_check (blocked)`
 *     car la tx va rollback (l'audit serait perdu de toute façon).
 *   - HORS tx en best-effort, on garantit la traçabilité forensique du
 *     rejet même si la tx a rollback. Trou forensique acceptable si
 *     `appendAuditLog` lui-même fail (cohérent S6 pattern MED-1 sur
 *     `send_blocked`) — la correctness compliance reste préservée car
 *     le draft reste `status="draft"` et n'est pas envoyé au PS.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INVARIANTS (CNIL / AI Act / RGPD)
 *
 *   1. **Le wrapper N'ALTÈRE JAMAIS la logique S5**. Le `preSendCheck`
 *      pur est appelé tel quel sur les inputs fournis. Différence avec
 *      `preSendCheckWithAudit` : on ne renvoie PAS de
 *      `PreSendCheckResult` au caller en branche blocked — on throw.
 *      Cette divergence d'API est explicite (signature `Promise<{ ok:
 *      true }>` au lieu de `Promise<PreSendCheckResult>`).
 *
 *   2. **`targetId = contact.hubspotId`** (PAS phone, PAS email). Identique
 *      `preSendCheckWithAudit` invariant 4 (S6.6).
 *
 *   3. **Payload `{ result: "allowed" }` UNIQUEMENT en branche allowed**.
 *      Aucun champ code/rule/context (qui n'existent qu'en branche
 *      blocked, traités côté caller HORS tx).
 *
 *   4. **`ComplianceFailureError.context`** porte `{rule, code,
 *      failureContext}` — donne au caller toute l'information nécessaire
 *      pour construire le payload `reply_draft_dropped` HORS tx sans
 *      ré-évaluation de `preSendCheck`.
 *
 *   5. **PRE-REQUIS CALLER** : les inputs (`contact`, `conversation`,
 *      `recentOutboundMessages`) DOIVENT avoir été lus DANS la même tx
 *      via `tx.get(...)` AVANT l'appel à cette fonction. Si lus HORS tx,
 *      le re-check ne ferme PAS la race window.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * RELATION VS S6 `preSendCheckWithAudit`
 *
 * Le wrapper standalone `preSendCheckWithAudit` (S6.6 GUARD-002) reste
 * actif et utilisé par `send-first-sms.ts` step 2 (avant tx S6). Il pose
 * le `compliance_check` HORS tx via `appendAuditLog`.
 *
 * `preSendCheckWithAuditTx` est un SECOND chemin tx-aware utilisé
 * uniquement quand on a besoin d'atomicité Firestore avec la décision
 * compliance (= toutes les écritures suivantes en cas d'allowed doivent
 * rollback si une rule fail entre temps). C'est le cas en S9.4
 * (commitDraftToQueued) mais pas en S6 (premier SMS where pre-check
 * HORS tx + dispatch + tx record est le pattern).
 *
 * Pas de divergence de logique : les 2 wrappers appellent le MÊME
 * `preSendCheck` pur (S5) sur les MÊMES `PreSendCheckArgs`. Différence :
 * où l'audit est écrit (tx vs hors tx) et comment la branche blocked
 * est signalée au caller (throw vs return).
 */
import { type Transaction } from "firebase-admin/firestore";

import { appendAuditLogTx } from "@/lib/firestore/audit-log";
import { ComplianceFailureError } from "@/lib/utils/errors";

import { preSendCheck, type PreSendCheckArgs, type PreSendCheckDeps } from "./pre-send-check";

// ─────────────────────────────────────────────────────────────────────────────
// Types du payload audit (cohérent `preSendCheckWithAudit` S6.6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Forme du `payload` posé dans `audit_log` pour `action: "compliance_check"`
 * en branche `allowed` DANS la tx. Aligné `CompliancePayloadAllowed` du
 * wrapper standalone S6.6 (champ `result` figé).
 *
 * Note : pas d'équivalent `CompliancePayloadBlocked` ici — la branche
 * blocked throw au lieu de poser un audit. Le payload équivalent (avec
 * `code`/`rule`/`context`) sera posé HORS tx par le caller dans
 * `commitDraftToQueued.catch(ComplianceFailureError)`.
 */
export type CompliancePayloadAllowedTx = {
  result: "allowed";
};

// ─────────────────────────────────────────────────────────────────────────────
// API publique
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vérifie les 9 règles compliance via `preSendCheck` (S5). Si allowed,
 * pose un audit `compliance_check (allowed)` DANS la `tx` fournie via
 * `appendAuditLogTx`. Si blocked, throw `ComplianceFailureError` avec
 * le failure complet en `context`.
 *
 * Cf. JSDoc en tête de fichier pour le détail asymétrie + invariants.
 *
 * @param tx    Transaction Firestore ouverte par le caller.
 * @param args  Identiques à `preSendCheck` (contact, message,
 *              conversation, recentOutboundMessages, now?). DOIVENT
 *              avoir été lus DANS la tx (invariant 5).
 * @param deps  Injection optionnelle des règles S4 pour les tests (cf.
 *              `preSendCheck` JSDoc l.59-63). Production : ne pas fournir.
 *
 * @returns `{ ok: true }` UNIQUEMENT en branche allowed. La branche
 *          blocked throw au lieu de retourner — signature `Promise<{ ok:
 *          true }>` (jamais `{ ok: false }`).
 *
 * @throws {ComplianceFailureError} si `preSendCheck` retourne
 *                                  `{ ok: false, failure }`. Le context
 *                                  porte `{rule, code, failureContext}`.
 *                                  `noRetry=true` (refus stable, pas
 *                                  une race retry-friendly).
 * @throws {AuditPiiError} si payload `compliance_check (allowed)` contient
 *                         une PII inattendue (filet S6.2 — théoriquement
 *                         inatteignable car payload statique).
 * @throws {ValidationError} si Zod fail sur le payload audit (défaut
 *                           `appendAuditLogTx`).
 */
export function preSendCheckWithAuditTx(
  tx: Transaction,
  args: PreSendCheckArgs,
  deps?: PreSendCheckDeps,
): { ok: true } {
  const result = preSendCheck(args, deps);

  if (!result.ok) {
    // Branche blocked — throw, NE POSE PAS d'audit. Le caller
    // (commitDraftToQueued) gère le rollback tx puis pose
    // compliance_check (blocked) + reply_draft_dropped HORS tx
    // best-effort. Cf. JSDoc asymétrie en-tête de fichier.
    throw new ComplianceFailureError({
      message: `preSendCheckWithAuditTx blocked: rule=${result.failure.rule} code=${result.failure.code}`,
      context: {
        rule: result.failure.rule,
        code: result.failure.code,
        failureContext: result.failure.context,
      },
    });
  }

  // Branche allowed — pose audit compliance_check DANS la tx.
  // `targetId = contact.hubspotId` (invariant 2, identique S6.6 GUARD-002).
  // Payload `{ result: "allowed" }` minimal — aucun champ code/rule/context
  // (invariant 3).
  const payload: CompliancePayloadAllowedTx = { result: "allowed" };

  appendAuditLogTx(tx, {
    actorId: "system",
    actorType: "system",
    action: "compliance_check",
    targetType: "contact",
    targetId: args.contact.hubspotId,
    payload,
  });

  return { ok: true };
}
