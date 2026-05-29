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
 *      "Utiliser hashPii()". JAMAIS d'écriture partielle.
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
import { Timestamp } from "firebase-admin/firestore";
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
 * S5/S6.6). Garder synchronisé : si une action est ajoutée au type, ELLE
 * DOIT l'être ici aussi, sinon Zod refuse l'écriture.
 */
const ACTIONS = [
  "sms_sent",
  "sms_received",
  "sms_failed",
  "send_blocked",
  "opt_out",
  "handoff",
  "handoff_accepted",
  "manual_override",
  "prompt_changed",
  "bloctel_imported",
  "contact_deleted",
  "contact_anonymized",
  "campaign_started",
  "campaign_paused",
  "login",
  "role_changed",
  "compliance_check",
  "long_form_opt_out_candidate",
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
        "Audit log refuse les PII en clair. Utiliser hashPii() pour les identifiants sensibles.",
      context: {
        // `violations` est déjà sanitisée par `detectPiiInPayload` :
        // path + kind + sample tronqué. Aucune valeur d'origine n'y figure.
        violations,
        action: parsed.data.action,
        targetType: parsed.data.targetType,
      },
    });
  }

  const docRef = await getAdminDb()
    .collection(AUDIT_COLLECTION)
    .add({
      ...parsed.data,
      timestamp: Timestamp.now(),
    });

  return docRef.id;
}

/**
 * Constante exposée pour les tests / la doc.
 * @internal
 */
export const __AUDIT_COLLECTION_FOR_TESTS = AUDIT_COLLECTION;
