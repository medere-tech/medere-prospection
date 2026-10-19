/**
 * Journal Firestore `audit_log/` — point d'entrée unique d'écriture.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Invariants forensiques (CNIL / RGPD) :
 *
 *   1. **Append-only**. Cette API n'expose AUCUN update/delete. Pour
 *      corriger une entrée, écrire un `manual_override` qui pointe la
 *      cible. `firestore.rules` refuse en parallèle toute écriture client.
 *
 *   2. **Zéro PII en clair dans `payload`**. Détection à 2 niveaux :
 *        a. Zod refuse les types non documentés (fail-fast structurel)
 *        b. `detectPiiInPayload` scrute récursif phone E.164 / FR /
 *           email AVANT toute écriture Firestore.
 *      Si violation : throw `AuditPiiError` AVEC le message explicite
 *      "Utiliser safePhoneHash()" (PAS hashPii brut — collision scrubber
 *      ~0.3%, cf. warning JSDoc hashPii + HIGH-1 S9.2.1). JAMAIS
 *      d'écriture partielle.
 *
 *   3. **Timestamp serveur**. Posé via `Timestamp.now()` côté serveur
 *      au moment du `.add()`. L'appelant NE PEUT PAS le forger (omis
 *      par construction du type `AuditLogInput`).
 *
 *   4. **Ordre strict** des contrôles dans `appendAuditLog` :
 *        Zod.parse  →  detectPiiInPayload  →  Firestore.add  →  docId
 *      Toute défaillance arrête la séquence, aucune écriture latente.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * GUARD-002 (S6.6) : c'est ce module qui est appelé par le wrapper
 * `preSendCheckWithAudit` pour logger CHAQUE appel à `preSendCheck`,
 * que la décision soit allowed ou blocked. La structure `payload` que
 * ce wrapper construira a déjà été conçue pour ne contenir que :
 *   - `result: "allowed" | "blocked"`, `rule?`, `code?`, `context?`
 * (`context` étant lui-même la discriminated union fermée de S5 qui
 * exclut les PII par typage). Donc le scrubber sera surtout actif sur
 * des écritures « libres » d'autres callers ; mais il reste actif
 * partout en filet de sécurité.
 */
import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { z } from "zod";

import { getAdminDb } from "@/lib/firestore/admin";
import { AuditPiiError, ValidationError } from "@/lib/utils/errors";
import { detectPiiInPayload } from "@/lib/utils/pii-detector";
import type { AuditLog, AuditLogInput, AuditTargetType } from "@/types/audit-log";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

const AUDIT_COLLECTION = "audit_log";

const ACTOR_TYPES = ["system", "ai", "human"] as const;

const TARGET_TYPES = ["contact", "conversation", "message", "campaign", "user", "prompt"] as const;

/**
 * Liste fermée des actions auditables — alignée sur `src/types/audit-log.ts`
 * (qui est lui-même aligné skill `medere-firestore-schema` + extensions
 * S5/S6.6/S9.1). Garder synchronisé : si une action est ajoutée au type,
 * ELLE DOIT l'être ici aussi, sinon Zod refuse l'écriture.
 *
 * 🔒 **Sentinelle S9.1** : `audit-log.test.ts` verrouille l'égalité
 * ensembliste entre cette whitelist et `AuditAction` (TS) via un test
 * hardcodé. Tout ajout d'un seul côté casse le build — c'est volontaire.
 *
 * Organisation visuelle alignée sur `src/types/audit-log.ts` (sections par
 * cycle de vie). Cf. JSDoc du type pour le détail des sections.
 */
const ACTIONS = [
  // ── SMS OUTBOUND ───────────────────────────────────────────────────────
  "sms_sent",
  "sms_failed",
  "sms_provider_dispatched",
  "send_blocked",
  // ── SMS INBOUND (S9.1 — process-reply) ─────────────────────────────────
  "sms_received",
  "intent_classified",
  "reply_generated",
  "reply_processed",
  "reply_dropped",
  "reply_draft_dropped",
  "long_form_opt_out_candidate",
  // ── CONVERSATION lifecycle ─────────────────────────────────────────────
  "opt_out",
  "handoff",
  "handoff_accepted",
  // S9.9-PR5a — lead INTERESSE non routé vers un commercial (branche
  // orphelins de `slack-handoff` S9.9-PR5b). Cf. types/audit-log.ts pour
  // la sémantique complète + `HandoffUnassignedPayload` typé.
  "handoff_unassigned",
  // PR-A-INBOUND-HANDED-OFF — SMS entrant arrivé sur conv `handed_off`.
  // Posé par `process-reply` sur la branche handed_off AVANT return. Léa
  // reste muette ; le commercial titulaire reçoit un DM. Cf. types/audit-log.ts
  // pour la sémantique complète + `InboundRelayedToHumanPayload` typé.
  "inbound_relayed_to_human",
  // PR-NO-DROPPED-SMS — SMS entrant qu'aucun chemin "actif" ne gere.
  // Remplace les anciens `reply_dropped reason:"contact_unknown" |
  // "no_active_conversation" | "conversation_became_terminal"`. Cf.
  // types/audit-log.ts pour la semantique + `InboundOnInactiveConversationPayload`.
  "inbound_on_inactive_conversation",
  // VUE-CONVERSATION PR0 — accès au numéro depuis la vue conversation.
  // Payload = `ContactPhoneAccessedPayload` avec `method ∈ {display, copy, call}`.
  // Cf. types/audit-log.ts pour la sémantique.
  "contact_phone_accessed",
  // ── CAMPAIGN / ADMIN ───────────────────────────────────────────────────
  "manual_override",
  "prompt_changed",
  "campaign_started",
  "campaign_paused",
  // S10.1.3 — mirror campaign_started pour clôture forensic seed/campagne
  "campaign_completed",
  // S10.1.4.c — admin déclenche l'envoi du 1er SMS via POST /api/admin/send-first-sms.
  // Cf. types/audit-log.ts pour la sémantique. Sentinelle S9.1 anti-drift TS↔Zod.
  "sms_send_initiated_by_admin",
  // ── DATA ───────────────────────────────────────────────────────────────
  "bloctel_imported",
  "contact_deleted",
  "contact_anonymized",
  // S10.1.3 — seed HubSpot → Firestore (traçabilité forensic RGPD origine)
  "contact_imported_from_hubspot",
  // S10.1.3 — réservé pour création contact MANUELLE (UI admin S10.1.5+ ou
  // API admin futur). PAS posé par le seed HubSpot qui utilise
  // `contact_imported_from_hubspot` (plus spécifique). Whitelist préservée
  // pour éviter un futur PR cross-cutting (audit-log + types + tests + caller).
  "contact_created",
  "contact_import_skipped",
  // ── AUTH ───────────────────────────────────────────────────────────────
  "login",
  "role_changed",
  // ── TRANSVERSE ─────────────────────────────────────────────────────────
  "compliance_check",
  "status_changed",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Zod schema
// ─────────────────────────────────────────────────────────────────────────────

const AuditLogInputSchema = z.object({
  actorId: z.string().min(1),
  actorType: z.enum(ACTOR_TYPES),
  action: z.enum(ACTIONS),
  targetType: z.enum(TARGET_TYPES),
  targetId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  ipAddress: z.string().optional(),
  userAgent: z.string().optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// API publique
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Source de vérité UNIQUE pour la validation Zod + scrubber PII de toute
 * écriture dans `audit_log/`. Utilisé par `appendAuditLog` (autonome) ET
 * `appendAuditLogTx` (transactionnel) → impossible d'avoir 2 chemins de
 * validation divergents (décision Déthié S6.3, leçon des 11 findings
 * security du 1er review S6.2).
 *
 * Throw (dans l'ordre) :
 *   1. `ValidationError` si Zod fail.
 *   2. `AuditPiiError` si une PII en clair est détectée dans `payload`.
 *
 * @internal Exposé pour faciliter les tests unitaires de la branche
 *           validation sans toucher à Firestore. NE PAS utiliser côté
 *           caller applicatif : utiliser `appendAuditLog` ou
 *           `appendAuditLogTx`.
 */
function validateAndScrub(entry: AuditLogInput): AuditLogInput {
  const parsed = AuditLogInputSchema.safeParse(entry);
  if (!parsed.success) {
    // ⚠️  NE PAS ajouter cause: parsed.error — la ZodError contient la
    // valeur reçue dans issue.received, ce qui fuiterait un PII si Zod
    // fail sur un champ payload malformé. Voir env.ts (sanitizeZodError)
    // pour le même pattern documenté.
    throw new ValidationError({
      message: `Audit log input invalid: ${parsed.error.issues
        .map((i) => `${i.path.join(".")} (${i.code})`)
        .join(", ")}`,
      context: {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          code: i.code,
        })),
      },
    });
  }

  const violations = detectPiiInPayload(parsed.data.payload);
  if (violations.length > 0) {
    throw new AuditPiiError({
      message:
        "Audit log refuse les PII en clair. Utiliser safePhoneHash() pour les téléphones (PAS hashPii brut — collision scrubber, cf. JSDoc) ou un docId Firestore.",
      context: {
        // `violations` est déjà sanitisée par `detectPiiInPayload` :
        // path + kind + sample = "[redacted]" constant. Aucune valeur
        // d'origine n'y figure.
        violations,
        action: parsed.data.action,
        targetType: parsed.data.targetType,
      },
    });
  }

  return parsed.data;
}

/**
 * Écrit une entrée dans `audit_log/`. Retourne le docId Firestore généré.
 *
 * Throw possible (DANS L'ORDRE) :
 *   - `ValidationError` : payload structurellement invalide (Zod).
 *   - `AuditPiiError` : PII détecté dans `payload` (phone/email en clair).
 *   - Erreur Firestore native : échec d'écriture I/O (timeout, perm, etc.).
 *
 * @returns docId Firestore (utilisable pour corréler l'entrée plus tard,
 *          ex: réponse de webhook → audit_log doc).
 */
export async function appendAuditLog(entry: AuditLogInput): Promise<string> {
  const validated = validateAndScrub(entry);
  const docRef = await getAdminDb()
    .collection(AUDIT_COLLECTION)
    .add({
      ...validated,
      timestamp: Timestamp.now(),
    });
  return docRef.id;
}

/**
 * Variante TRANSACTIONNELLE de `appendAuditLog`. À utiliser quand on a
 * besoin d'écrire un audit log dans la même transaction qu'une autre
 * mutation (ex: `markOptedOut` qui update `contacts/{id}` + log
 * `action: "opt_out"` → atomique, pas de trou forensic possible si le
 * process crash entre les 2 writes).
 *
 * Réutilise EXACTEMENT la même `validateAndScrub` que `appendAuditLog`
 * → aucune divergence possible des règles Zod / scrubber PII entre les
 * 2 voies d'écriture.
 *
 * Retourne le docId généré côté serveur (string, pas DocumentReference).
 * Décision Déthié S6.3 : `DocumentReference` exposerait `.set/.update/.delete`
 * et romprait la promesse append-only. Le caller a tout ce qu'il faut avec
 * la string.
 *
 * Throw possible (DANS L'ORDRE) :
 *   - `ValidationError` : payload structurellement invalide (Zod).
 *   - `AuditPiiError` : PII détecté dans `payload`.
 *
 * @param tx     transaction Firestore en cours (Admin SDK).
 * @param entry  même contrat que `appendAuditLog`.
 * @returns      docId Firestore (string).
 */
export function appendAuditLogTx(tx: Transaction, entry: AuditLogInput): string {
  const validated = validateAndScrub(entry);
  const docRef = getAdminDb().collection(AUDIT_COLLECTION).doc();
  tx.create(docRef, {
    ...validated,
    timestamp: Timestamp.now(),
  });
  return docRef.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// listAuditLogByTarget (VUE-CONVERSATION PR0) — lecture pour panneau journal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Nombre d'entrées par page par défaut (`limit` omis). 20 = panneau latéral
 * compact dans la vue conversation. Pagination si plus d'historique.
 */
export const LIST_AUDIT_LOG_DEFAULT_LIMIT = 20;

/**
 * Plafond strict — anti-DoS Firestore. Un audit log par contact peut
 * monter à quelques centaines sur un cycle long (3 ans conservation).
 */
export const LIST_AUDIT_LOG_MAX_LIMIT = 100;

/** Input typé. */
export interface ListAuditLogByTargetInput {
  targetType: AuditTargetType;
  targetId: string;
  limit?: number;
  /** docId Firestore du dernier doc de la page précédente. */
  cursor?: string;
}

/** Sortie typée. */
export interface ListAuditLogByTargetOutput {
  entries: Array<AuditLog & { docId: string }>;
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Liste les entrées d'`audit_log/` ciblant un `(targetType, targetId)`,
 * triées `timestamp desc` (plus récente en haut).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INDEX FIRESTORE REQUIS
 *
 *   `audit_log` COLLECTION : `targetType + targetId + timestamp DESC`.
 *   Ajouté dans `firestore.indexes.json` (VUE-CONVERSATION PR0). Déployer
 *   via `npm run firebase:deploy:indexes` AVANT runtime pointant sur
 *   Firestore Cloud (l'emulator accepte sans index).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ⚠️ PII — `payload` scrubber-safe par construction
 *
 * Les payloads sont déjà scrubbés par `validateAndScrub` à l'écriture
 * (`detectPiiInPayload` throw `AuditPiiError`). Aucun phone/email/body
 * en clair ne peut être persisté. Lecture de retour → safe pour UI.
 *
 * `ipAddress` / `userAgent` peuvent être présents mais sont considérés
 * semi-sensibles (traçabilité HTTP, pas PII RGPD).
 *
 * @throws ValidationError si input invalide ou cursor inexistant.
 */
export async function listAuditLogByTarget(
  input: ListAuditLogByTargetInput,
): Promise<ListAuditLogByTargetOutput> {
  const { targetType, targetId, limit: requestedLimit, cursor } = input;

  if (typeof targetId !== "string" || targetId.length === 0) {
    throw new ValidationError({
      message: "listAuditLogByTarget: targetId must be non-empty",
      context: { op: "listAuditLogByTarget", targetType },
    });
  }
  if (
    requestedLimit !== undefined &&
    (!Number.isInteger(requestedLimit) ||
      requestedLimit < 1 ||
      requestedLimit > LIST_AUDIT_LOG_MAX_LIMIT)
  ) {
    throw new ValidationError({
      message: `listAuditLogByTarget: limit must be in [1, ${LIST_AUDIT_LOG_MAX_LIMIT}]`,
      context: { op: "listAuditLogByTarget", requestedLimit },
    });
  }
  const limit = requestedLimit ?? LIST_AUDIT_LOG_DEFAULT_LIMIT;

  let q: FirebaseFirestore.Query = getAdminDb()
    .collection(AUDIT_COLLECTION)
    .where("targetType", "==", targetType)
    .where("targetId", "==", targetId)
    .orderBy("timestamp", "desc");

  if (cursor !== undefined) {
    const cursorSnap = await getAdminDb().collection(AUDIT_COLLECTION).doc(cursor).get();
    if (!cursorSnap.exists) {
      throw new ValidationError({
        message: "listAuditLogByTarget: cursor refers to a non-existent audit entry",
        context: { op: "listAuditLogByTarget", cursorPresent: true },
      });
    }
    q = q.startAfter(cursorSnap);
  }

  const snap = await q.limit(limit + 1).get();
  const docs = snap.docs;
  const hasMore = docs.length > limit;
  const slice = hasMore ? docs.slice(0, limit) : docs;

  const entries: Array<AuditLog & { docId: string }> = slice.map((doc) => {
    const data = doc.data() as AuditLog;
    return { ...data, docId: doc.id };
  });

  const nextCursor = hasMore && slice.length > 0 ? (slice[slice.length - 1]?.id ?? null) : null;

  return { entries, nextCursor, hasMore };
}

/**
 * Constante exposée pour les tests / la doc.
 * @internal
 */
export const __AUDIT_COLLECTION_FOR_TESTS = AUDIT_COLLECTION;

/**
 * Whitelist des actions auditables, exposée pour les tests sentinelles
 * (anti-régression sur les ajouts d'action côté S8+ qui doivent rester
 * synchrones avec `src/types/audit-log.ts::AuditAction`).
 *
 * Lecture-only par construction TypeScript (`as const` + `readonly`).
 *
 * @internal
 */
export const __ACTIONS_FOR_TESTS: readonly string[] = ACTIONS;
