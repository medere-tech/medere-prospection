/**
 * Core logique seed/reset de la conversation de test PR4 — pattern
 * `reset-e2e-orphans-core.ts`. Zéro `process.exit`, zéro console, zéro
 * dotenv. Partagé entre les scripts `scripts/seed-e2e-pr4-conv.mjs` /
 * `scripts/reset-e2e-pr4-conv.mjs` et les tests emulator.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Contrat
 *
 *   - `assertTargetConversationIdAllowed(id)` throw si `id` n'est pas
 *     dans la whitelist PR4 (`testaccount-whitelist.ts`) — SOURCE UNIQUE.
 *   - `scanSeed(db)` / `scanReset(db)` : lecture seule, retournent une
 *     décision + un diff à afficher. Jamais d'écriture.
 *   - `applySeed(db)` / `applyReset(db)` : SEULES écritures, dans UNE
 *     transaction atomique (`tx.create` / `tx.update`). Un échec partout
 *     dans la tx fait rollback complet — aucun doc partiel ne traîne.
 *   - Les 4 fonctions prennent `db: Firestore` en entrée — tests emulator
 *     injectent leur propre instance.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Visibilité dans la liste admin
 *
 *   `listConversations` trie par `lastMessageAt desc` (`conversations.ts:1698`).
 *   Firestore `orderBy` EXCLUT silencieusement les docs dont le champ est
 *   absent. Un seed qui ne poserait pas `lastMessageAt` produirait une
 *   conv INVISIBLE dans la liste admin, prouvée par
 *   `tests/firestore/seed-reset-e2e-pr4.test.ts`.
 *
 *   On pose `lastMessageAt = createdAt = now`. Même sémantique qu'une
 *   conv handed_off en prod sans message postérieur : la conv reste
 *   dans la liste tant qu'un commercial ne l'a pas touchée.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi un projectId obligatoire pour `--apply`
 *
 *   Le script CLI (hors de ce module) demande à l'opérateur de ressaisir
 *   le projectId cible pour `--apply`. Protection contre un `--apply` lancé
 *   par erreur sur `medere-prod`. Ce module ne manipule pas la chaîne
 *   `--apply <projectId>` ; il expose seulement `assertProjectIdMatches`.
 */
import { FieldValue, Timestamp } from "firebase-admin/firestore";

// IMPORTANT : on importe depuis `e2e-conversation-ids.ts` (SANS
// `server-only`), PAS depuis `testaccount-whitelist.ts`. Les scripts CLI
// `scripts/seed-e2e-pr4-conv.mjs` / `scripts/reset-e2e-pr4-conv.mjs`
// tournent sous `tsx` (Node, pas RSC) et `server-only` throw à l'import
// dans ce contexte.
import { E2E_CONV_ID_PR4 } from "@/lib/conversations/e2e-conversation-ids";
import { appendAuditLogTx } from "@/lib/firestore/audit-log";
import { queryBackfillContact } from "@/lib/firestore/backfill-conversation-list-fields";
import {
  computeContactDisplayName,
  normalizeContactNameSearch,
} from "@/lib/firestore/conversation-list-fields";
import { ConversationSchema } from "@/lib/firestore/conversations";
import { ForbiddenError, ValidationError } from "@/lib/utils/errors";

const CONVERSATIONS_COLLECTION = "conversations";

/** Owner (Slack) de la conv PR4 — Dethie admin, cohérent avec E2E_CONV_ID_PR4. */
export const E2E_PR4_HANDOFF_ASSIGNED_TO = "U05UVHGBURX";

/** `contactId` numérique figé (Dethie PS de test). */
export const E2E_PR4_CONTACT_ID = "427963864300";

/** `campaignId` figé — distinct de celui de `E2E_CONV_ID` orphelins. */
export const E2E_PR4_CAMPAIGN_ID = "hubspot-list-999999";

/**
 * Refuse tout identifiant qui n'est pas la cible PR4. Comparaison stricte
 * à `E2E_CONV_ID_PR4` — le seed/reset PR4 ne manipule qu'UNE seule conv
 * (fail-closed sur tout autre). La whitelist compte-test réelle
 * (`TEST_ACCOUNT_WHITELIST_CONV_IDS`) vit dans
 * `src/lib/conversations/testaccount-whitelist.ts` derrière `server-only`
 * et contient les 2 identifiants e2e ; ici on n'autorise que PR4.
 */
export function assertTargetConversationIdAllowed(conversationId: string): void {
  if (conversationId !== E2E_CONV_ID_PR4) {
    throw new ForbiddenError({
      message: `seed-reset-pr4: ${conversationId} is not the PR4 target conversation (expected ${E2E_CONV_ID_PR4})`,
      clientMessage: "Identifiant de conversation PR4 refusé.",
      context: { conversationId, expected: E2E_CONV_ID_PR4 },
    });
  }
}

/**
 * Garantit que le projectId passé (par l'opérateur via CLI) correspond à
 * celui sur lequel on va écrire. Appelé par le script CLI AVANT toute
 * initialisation d'app Firebase en mode `--apply`.
 */
export function assertProjectIdMatches(expected: string, given: string): void {
  if (expected !== given) {
    throw new ValidationError({
      message: `seed-reset-pr4: projectId mismatch (expected ${expected}, given ${given})`,
      context: { expected, given },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// SEED
// ─────────────────────────────────────────────────────────────────────────

export type SeedDecision =
  | {
      readonly kind: "already-exists";
      readonly currentStatus: string;
      readonly completeness: CompletenessResult;
    }
  | { readonly kind: "will-create" };

export type SeedResult =
  | { readonly kind: "created" }
  | { readonly kind: "already-complete" }
  | { readonly kind: "already-incomplete"; readonly issues: readonly string[] };

export interface CompletenessResult {
  readonly complete: boolean;
  readonly issues: readonly string[];
}

/**
 * Vérifie qu'un doc existant est « complet » pour PR4 :
 *   - Parse strict `ConversationSchema` (tous les champs requis + types).
 *   - A `lastMessageAt` posé (invariant visibilité liste admin).
 *   - A `assignedTo === U05UVHGBURX` (titulaire PR4).
 *   - A `handoff.assignedTo === U05UVHGBURX` (cohérence sous-objet).
 *   - Status `handed_off`, `handoffContacted` boolean.
 *
 * Retourne la liste exhaustive des problèmes, jamais `throw`.
 */
export function checkSeedCompleteness(data: unknown): CompletenessResult {
  const issues: string[] = [];
  const parse = ConversationSchema.safeParse(data);
  if (!parse.success) {
    for (const i of parse.error.issues) {
      issues.push(`schema:${i.path.join(".")} (${i.code})`);
    }
    return { complete: false, issues };
  }
  const parsed = parse.data;
  if (!parsed.lastMessageAt) issues.push("lastMessageAt absent (invariant visibilité liste)");
  if (parsed.status !== "handed_off") {
    issues.push(`status=${parsed.status} (attendu handed_off)`);
  }
  if (parsed.assignedTo !== E2E_PR4_HANDOFF_ASSIGNED_TO) {
    issues.push(`assignedTo=${String(parsed.assignedTo)} (attendu ${E2E_PR4_HANDOFF_ASSIGNED_TO})`);
  }
  if (parsed.handoff?.assignedTo !== E2E_PR4_HANDOFF_ASSIGNED_TO) {
    issues.push(
      `handoff.assignedTo=${String(parsed.handoff?.assignedTo)} (attendu ${E2E_PR4_HANDOFF_ASSIGNED_TO})`,
    );
  }
  if (typeof parsed.handoffContacted !== "boolean") {
    issues.push(`handoffContacted non-boolean`);
  }
  return { complete: issues.length === 0, issues };
}

/**
 * Formatte un `SeedResult` (retour de `applySeed`) pour affichage CLI.
 * Sort la logique d'affichage du `.mjs` (que `tsc --noEmit` n'inspecte
 * pas) vers un helper typé testé : `scripts/seed-e2e-pr4-conv.mjs`
 * n'appelle plus que `describeSeedResult(result)`.
 *
 * Contrat :
 *   - `kind: "created"`           → exitCode 0 + message « Conv créée. »
 *   - `kind: "already-complete"`  → exitCode 0 + message « Conv déjà complète. »
 *   - `kind: "already-incomplete"`→ exitCode 1 + liste des issues (une par ligne).
 *
 * Toute évolution de `SeedResult` doit être reflétée ici ET couverte par
 * `seed-reset-e2e-pr4-core.describe.test.ts` (mutation sentinelle :
 * retirer un `case` → le test tombe).
 */
export interface CliOutput {
  readonly lines: readonly string[];
  readonly exitCode: 0 | 1;
}

export function describeSeedResult(result: SeedResult): CliOutput {
  switch (result.kind) {
    case "created":
      return { lines: ["  ✓ Conv créée."], exitCode: 0 };
    case "already-complete":
      return { lines: ["  ↪ Conv déjà seedée et complète. No-op."], exitCode: 0 };
    case "already-incomplete": {
      const lines = [
        "  ✗ Conv déjà présente mais INCOMPLÈTE :",
        ...result.issues.map((i) => `      - ${i}`),
        "  Action requise : corriger le document en base avant de relancer le seed.",
      ];
      return { lines, exitCode: 1 };
    }
  }
}

/**
 * Formatte un `SeedDecision` (retour de `scanSeed`) pour affichage CLI
 * en dry-run. Si la conv existe, affiche le diagnostic de
 * `checkSeedCompleteness` (complète OU liste des issues). Sort en
 * code 1 si le document est présent mais incomplet.
 *
 * Contrat :
 *   - `kind: "will-create"`       → exitCode 0 + « Conv absente ... ».
 *   - `kind: "already-exists"`    + `completeness.complete: true`  → exitCode 0 + « Conv déjà complète. »
 *   - `kind: "already-exists"`    + `completeness.complete: false` → exitCode 1 + liste des issues.
 */
export function describeSeedDecision(decision: SeedDecision): CliOutput {
  if (decision.kind === "will-create") {
    return { lines: ["  ↪ Conv absente — prête à être créée."], exitCode: 0 };
  }
  // already-exists
  if (decision.completeness.complete) {
    return {
      lines: [`  ↪ Conv déjà seedée (status=${decision.currentStatus}) et complète. No-op.`],
      exitCode: 0,
    };
  }
  const lines = [
    `  ✗ Conv déjà présente (status=${decision.currentStatus}) mais INCOMPLÈTE :`,
    ...decision.completeness.issues.map((i) => `      - ${i}`),
    "  Action requise : corriger le document en base avant de relancer le seed.",
  ];
  return { lines, exitCode: 1 };
}

/**
 * Scan (lecture seule) : si le doc existe déjà, renvoie `already-exists`
 * + le résultat de `checkSeedCompleteness` pour afficher le diagnostic.
 */
export async function scanSeed(
  db: FirebaseFirestore.Firestore,
  conversationId: string = E2E_CONV_ID_PR4,
): Promise<SeedDecision> {
  assertTargetConversationIdAllowed(conversationId);
  const snap = await db.collection(CONVERSATIONS_COLLECTION).doc(conversationId).get();
  if (snap.exists) {
    const data = snap.data() ?? {};
    const completeness = checkSeedCompleteness(data);
    return {
      kind: "already-exists",
      currentStatus: String((data as Record<string, unknown>).status ?? "(absent)"),
      completeness,
    };
  }
  return { kind: "will-create" };
}

/**
 * Pose le document conversation PR4 en UNE SEULE écriture atomique
 * (`tx.create` dans `db.runTransaction`).
 *
 * Phase 1 (hors tx, lectures seules) : lookup contact + calcul des champs
 * de liste (`contactDisplayName`, `contactNameSearch`, `contactSpecialty`,
 * `contactCity`). Un throw ici n'écrit RIEN.
 *
 * Phase 2 (dans tx) : `tx.get(ref)` pour détecter l'existence. Si doc
 * déjà présent → `checkSeedCompleteness` ; retourne `already-complete`
 * ou `already-incomplete` (jamais « déjà existant » silencieux sur un
 * doc cassé). Sinon `tx.create(ref, doc)`. Un throw à n'importe quel
 * endroit de la tx fait rollback complet.
 *
 * @internal `options.__onBeforeCommit` — hook test-only pour injecter
 *   un throw ENTRE `tx.create` et le commit. Utilisé par le test
 *   « atomicité : un échec entre les 2 pseudo-écritures NE LAISSE PAS
 *   de doc » (remplace la mutation « 2-step writes avec throw entre »).
 */
export async function applySeed(
  db: FirebaseFirestore.Firestore,
  conversationId: string = E2E_CONV_ID_PR4,
  options: {
    readonly __onBeforeCommit?: () => Promise<void>;
  } = {},
): Promise<SeedResult> {
  assertTargetConversationIdAllowed(conversationId);

  // ── Phase 1 : pré-calcul de TOUS les champs hors transaction ────────────
  const now = Timestamp.now();

  let contactDisplayName: string | undefined;
  let contactNameSearch: string | undefined;
  let contactSpecialty: string | undefined;
  let contactCity: string | undefined;

  const contactSnap = await queryBackfillContact(db, E2E_PR4_CONTACT_ID);
  if (contactSnap.exists) {
    const raw = (contactSnap.data() ?? {}) as Record<string, unknown>;
    const civilite = typeof raw.civilite === "string" ? raw.civilite : undefined;
    const firstName = typeof raw.firstName === "string" ? raw.firstName : "";
    const lastName = typeof raw.lastName === "string" ? raw.lastName : "";
    const dn = computeContactDisplayName({ civilite, firstName, lastName });
    if (dn.length > 0) contactDisplayName = dn;
    const ns = normalizeContactNameSearch(`${firstName} ${lastName}`);
    if (ns.length > 0) contactNameSearch = ns;
    if (typeof raw.speciality === "string" && raw.speciality.length > 0) {
      contactSpecialty = raw.speciality;
    }
    if (typeof raw.city === "string" && raw.city.length > 0) {
      contactCity = raw.city;
    }
  }

  const doc: Record<string, unknown> = {
    contactId: E2E_PR4_CONTACT_ID,
    campaignId: E2E_PR4_CAMPAIGN_ID,
    channel: "sms",
    status: "handed_off",
    intent: "INTERESSE",
    messageCount: 0,
    outboundCount: 0,
    inboundCount: 0,
    followupCount: 0,
    handoffContacted: false,
    assignedTo: E2E_PR4_HANDOFF_ASSIGNED_TO,
    handoff: {
      assignedTo: E2E_PR4_HANDOFF_ASSIGNED_TO,
      assignedAt: now,
      notes: "Conversation de test PR4 — seed e2e.",
    },
    // INVARIANT visibilité : `lastMessageAt` posé = date de création.
    // Firestore `orderBy("lastMessageAt","desc")` exclut les docs sans
    // ce champ. On pose `now` = même instant que `createdAt`/`updatedAt`.
    // Jamais de faux message créé.
    lastMessageAt: now,
    createdAt: now,
    updatedAt: now,
  };
  if (contactDisplayName) doc.contactDisplayName = contactDisplayName;
  if (contactNameSearch) doc.contactNameSearch = contactNameSearch;
  if (contactSpecialty) doc.contactSpecialty = contactSpecialty;
  if (contactCity) doc.contactCity = contactCity;

  // ── Phase 2 : écriture atomique dans une transaction ────────────────────
  const ref = db.collection(CONVERSATIONS_COLLECTION).doc(conversationId);
  return db.runTransaction(async (tx): Promise<SeedResult> => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const completeness = checkSeedCompleteness(snap.data());
      if (completeness.complete) return { kind: "already-complete" };
      return { kind: "already-incomplete", issues: completeness.issues };
    }
    tx.create(ref, doc);
    // Hook test-only pour prouver l'atomicité : un throw ici fait
    // rollback de `tx.create` → aucun doc partiel ne traîne.
    if (options.__onBeforeCommit) await options.__onBeforeCommit();
    return { kind: "created" };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// RESET
// ─────────────────────────────────────────────────────────────────────────

export type ResetDecision =
  | { readonly kind: "absent" }
  | {
      readonly kind: "has-marking";
      readonly contactedBy: string;
      readonly contactedAtMs: number;
    }
  | { readonly kind: "no-marking" };

/**
 * Scan (lecture seule) : détecte si un marquage « j'ai contacté »
 * existe. Décide ce qu'il faut annuler.
 */
export async function scanReset(
  db: FirebaseFirestore.Firestore,
  conversationId: string = E2E_CONV_ID_PR4,
): Promise<ResetDecision> {
  assertTargetConversationIdAllowed(conversationId);
  const snap = await db.collection(CONVERSATIONS_COLLECTION).doc(conversationId).get();
  if (!snap.exists) return { kind: "absent" };
  const data = snap.data() ?? {};
  const handoff = (data.handoff ?? {}) as Record<string, unknown>;
  const contactedBy = typeof handoff.contactedBy === "string" ? handoff.contactedBy : undefined;
  const contactedAt = handoff.contactedAt as Timestamp | undefined;
  if (data.handoffContacted === true && contactedBy && contactedAt) {
    return {
      kind: "has-marking",
      contactedBy,
      contactedAtMs: contactedAt.toMillis(),
    };
  }
  return { kind: "no-marking" };
}

/**
 * Efface `handoff.contactedAt`, `handoff.contactedBy`, pose
 * `handoffContacted: false`, bump `updatedAt`. Si un marquage existait,
 * écrit un audit `handoff_contact_undone` système (actorType `system`).
 * `actorTestAccount` n'est PAS passé par l'appelant : la sentinelle
 * `validateAndScrub` (`src/lib/firestore/audit-log.ts:234-248`) défaulte
 * à `false` pour les actors non-`human` — attendu puisque `seed-reset-pr4`
 * est un acteur système de maintenance, pas un compte de test.
 * Idempotent : tourner 2× ne pose qu'un seul audit (le 2e passage voit
 * `no-marking`).
 */
export async function applyReset(
  db: FirebaseFirestore.Firestore,
  conversationId: string = E2E_CONV_ID_PR4,
): Promise<{ readonly wroteAudit: boolean; readonly cleared: boolean }> {
  assertTargetConversationIdAllowed(conversationId);
  const ref = db.collection(CONVERSATIONS_COLLECTION).doc(conversationId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { wroteAudit: false, cleared: false };
    const data = snap.data() ?? {};
    const handoff = (data.handoff ?? {}) as Record<string, unknown>;
    const originalContactedBy =
      typeof handoff.contactedBy === "string" ? handoff.contactedBy : null;
    const originalContactedAt = handoff.contactedAt as Timestamp | undefined;
    const hadMarking = data.handoffContacted === true && originalContactedBy !== null;

    const now = Timestamp.now();
    tx.update(ref, {
      "handoff.contactedAt": FieldValue.delete(),
      "handoff.contactedBy": FieldValue.delete(),
      handoffContacted: false,
      updatedAt: now,
    });

    if (hadMarking) {
      appendAuditLogTx(tx, {
        actorId: "seed-reset-pr4",
        actorType: "system",
        action: "handoff_contact_undone",
        targetType: "conversation",
        targetId: conversationId,
        payload: {
          originalContactedBy,
          originalContactedAtMs:
            originalContactedAt instanceof Timestamp ? originalContactedAt.toMillis() : null,
          reason: "e2e-reset",
        },
      });
    }

    return { wroteAudit: hadMarking, cleared: true };
  });
}
