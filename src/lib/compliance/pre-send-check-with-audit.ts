/**
 * Wrapper de `preSendCheck` (S5) qui pose un audit log
 * `action: "compliance_check"` DANS LES DEUX BRANCHES (allowed et blocked).
 *
 * S6.6 — GUARD-002 (ticket Notion ouvert depuis S5, fermé par ce module).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * RAISON D'ÊTRE
 *
 * `preSendCheck` (S5) est PURE par design : aucun I/O, aucun audit, aucun
 * Firestore. C'est ce qui le rend trivialement testable et réutilisable
 * depuis n'importe quel orchestrateur (Inngest, BullMQ, dashboard manuel,
 * job batch). Mais sans audit, on perd la traçabilité forensique exigée
 * par la CNIL et l'AI Act.
 *
 * Ce wrapper FERME ce trou : il appelle `preSendCheck` puis pose
 * INCONDITIONNELLEMENT un audit log. La structure du payload est typée
 * par la `ComplianceFailure` discriminated union fermée de S5 — pas de
 * fuite PII possible par typage.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INVARIANTS (CNIL / AI Act / RGPD)
 *
 *   1. **Audit DANS LES 2 BRANCHES**. Allowed comme blocked, on log.
 *      Pas de "succès → pas la peine" : la traçabilité du `allowed`
 *      prouve qu'on a fait le check (vs ne pas l'avoir fait du tout).
 *
 *   2. **Si `appendAuditLog` throw → propage au caller**. Compliance >
 *      availability : si on ne peut PAS poser l'audit (PII détectée par
 *      le scrubber, erreur Firestore I/O, etc.), on NE PEUT PAS envoyer
 *      le SMS. Le caller (Inngest) verra l'erreur, retry selon sa
 *      policy. JAMAIS de catch silent ici.
 *
 *   3. **Le wrapper N'ALTÈRE JAMAIS la logique S5**. Le résultat
 *      retourné est strictement égal à ce que `preSendCheck` aurait
 *      retourné en pur. Test sentinel structurel
 *      (`pre-send-check-with-audit.test.ts`) verrouille cette
 *      propriété par deep-equal entre les 2 appels.
 *
 *   4. **`targetId = contact.hubspotId`** (PAS le téléphone, PAS l'email,
 *      PAS le nom). Le `hubspotId` est un identifiant interne stable
 *      qui sert déjà de docId Firestore — son usage en audit n'introduit
 *      AUCUNE PII supplémentaire.
 *
 *   5. **Payload `context` = la `failure.context` BRUTE** de S5. La
 *      `ComplianceFailure` discriminated union FERMÉE (`pre-send-check.ts`
 *      l.142-232) verrouille au COMPILE-TIME les clés autorisées dans
 *      `context` : `count`, `hour`, `weekday`, `isoDate`, `documentedLength`,
 *      `daysSinceCheck`, etc. Aucune n'est PII. Défense secondaire :
 *      `detectPiiInPayload` (S6.2) scrute récursif phone/email AVANT
 *      l'écriture Firestore — filet de sécurité runtime au cas où
 *      l'union TS serait élargie un jour sans qu'on remarque.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ⚠️ CETTE FONCTION NE PROTÈGE PAS DE LA RACE CONDITION INNGEST.
 *
 * Le check rate-limit est pure (S4) et lit l'historique passé en
 * argument. Si deux jobs Inngest concurrents appellent
 * `preSendCheckWithAudit` au même moment avec un historique lu HORS
 * tx, les deux peuvent retourner `allowed: true` et envoyer chacun un
 * SMS → 4 SMS effectifs au lieu de 3. Sanction CNIL.
 *
 * Le caller (Inngest function `send-sms` future) DOIT enrober l'envoi
 * SMS dans `withContactLock` (`src/lib/firestore/transactions.ts`) ET
 * re-vérifier `canSendMessage` DANS la tx avec un historique RE-LU
 * DANS la tx via `tx.get(query)`. Voir `concurrency.test.ts` pour le
 * pattern complet validé sur 10 itérations.
 *
 * Schéma d'usage S7 (futur) :
 *
 *   const result = await preSendCheckWithAudit(args)   // audit obligatoire
 *   if (!result.ok) return                              // blocked, déjà audité
 *
 *   await withContactLock(contactId, async (tx, contact) => {
 *     const recentInTx = await tx.get(messagesQueryWindow30d)
 *     if (!canSendMessage(toRecords(recentInTx), now).allowed) {
 *       throw new ComplianceConcurrencyError("rate_limit_race")
 *     }
 *     // INLINE addOutbound (tx parente) — extraction propre en S7
 *   })
 *
 *   await ovhSendSms(...)                              // HORS tx, retry safe
 */
import { appendAuditLog } from "@/lib/firestore/audit-log";

import {
  preSendCheck,
  type PreSendCheckArgs,
  type PreSendCheckDeps,
  type PreSendCheckResult,
} from "./pre-send-check";

// ─────────────────────────────────────────────────────────────────────────────
// Types du payload audit (typés pour exposer la forme aux tests)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Forme du `payload` posé dans `audit_log` pour `action: "compliance_check"`.
 * Discriminé sur `result` pour permettre au caller (dashboard, post-mortem)
 * un narrowing TypeScript propre.
 *
 * `code`/`rule`/`context` sont absents en branche `allowed` (objet
 * minimal — ne pas poser des `null` qui pollueraient Firestore).
 */
export type CompliancePayloadAllowed = {
  result: "allowed";
};

export type CompliancePayloadBlocked = {
  result: "blocked";
  code: string;
  rule: string;
  /** Discriminated union FERMÉE de S5 — verrouille les clés autorisées
   *  par typage. Pas de PII possible par construction. */
  context: Record<string, unknown>;
};

export type CompliancePayload = CompliancePayloadAllowed | CompliancePayloadBlocked;

// ─────────────────────────────────────────────────────────────────────────────
// API publique
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vérifie les 9 règles compliance via `preSendCheck` (S5) et pose
 * INCONDITIONNELLEMENT un audit log `action: "compliance_check"` avec
 * le résultat. Cf. JSDoc en tête de fichier pour les invariants.
 *
 * @param args  Identiques à `preSendCheck` (contact, message,
 *              conversation, recentOutboundMessages, now?).
 * @param deps  Injection optionnelle des règles S4 pour les tests
 *              (cf. `preSendCheck` JSDoc l.59-63). Production : ne pas
 *              fournir.
 *
 * @returns Le même `PreSendCheckResult` que `preSendCheck` aurait
 *          retourné — strict deep-equality (test sentinel).
 *
 * @throws Erreur de `appendAuditLog` propagée au caller :
 *           - `AuditPiiError` si une PII en clair est détectée dans
 *             `context` (filet S6.2 — théoriquement inatteignable car
 *             la discriminated union ne contient que des nombres/strings
 *             non-PII, mais on le laisse en défense profonde).
 *           - `ValidationError` si la structure du payload audit est
 *             invalide (Zod fail — défaut module).
 *           - Erreurs Firestore I/O natives (timeout, perm, etc.).
 */
export async function preSendCheckWithAudit(
  args: PreSendCheckArgs,
  deps?: PreSendCheckDeps,
): Promise<PreSendCheckResult> {
  const result = preSendCheck(args, deps);

  const payload: CompliancePayload = result.ok
    ? { result: "allowed" }
    : {
        result: "blocked",
        code: result.failure.code,
        rule: result.failure.rule,
        // `context` brut de S5. Aucune PII possible par typage union
        // fermée (cf. invariant 5). Le scrubber S6.2 sert de défense
        // secondaire runtime à l'écriture.
        context: result.failure.context,
      };

  await appendAuditLog({
    actorId: "system",
    actorType: "system",
    action: "compliance_check",
    targetType: "contact",
    // hubspotId est l'identifiant interne stable, déjà utilisé comme
    // docId Firestore. PAS de PII supplémentaire vs `targetId: phone`.
    targetId: args.contact.hubspotId,
    payload,
  });

  return result;
}
