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
import type { AuditLogInput } from "@/types/audit-log";

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
  "long_form_opt_out_candidate",
  // ── CONVERSATION lifecycle ─────────────────────────────────────────────
  "opt_out",
  "handoff",
  "handoff_accepted",
  // ── CAMPAIGN / ADMIN ───────────────────────────────────────────────────
  "manual_override",
  "prompt_changed",
  "campaign_started",
  "campaign_paused",
  // ── DATA ───────────────────────────────────────────────────────────────
  "bloctel_imported",
  "contact_deleted",
  "contact_anonymized",
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
