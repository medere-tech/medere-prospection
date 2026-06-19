/**
 * Seed orchestrateur HubSpot → Firestore (S10.1.3).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rôle métier
 *
 *   Importe une liste HubSpot SMS dans la collection Firestore `contacts/`
 *   avec traçabilité forensic RGPD complète. Pour chaque contact importé,
 *   pose un audit log `contact_imported_from_hubspot` (compliance-auditor
 *   S10.1.2.b F2 — 1 entrée par contact, payload sans PII).
 *
 *   Idempotent par construction : re-run sur la même liste = même résultat
 *   (les contacts déjà créés throw `ConflictError` côté `createContact` →
 *   absorbés par `skippedAlreadyExistsCount`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pipeline (verbatim brief S10.1.3.1) :
 *
 *   1. appendAuditLog `campaign_started` (sauf si dryRun)
 *   2. Boucle paginée getContactsInList do/while (cursor)
 *      Pour chaque contact :
 *        a. try { mapped = map(raw, campaignId) }
 *           catch (ValidationError) {
 *             skippedMapperErrorCount++;
 *             appendAuditLog contact_import_skipped (sauf dryRun)
 *             continue;
 *           }
 *        b. if (dryRun) { createdCount++; continue; }  // pas de write
 *        c. try { await createContact(mapped) }
 *           catch (ConflictError) {
 *             skippedAlreadyExistsCount++;
 *             continue;  // skip silent — pas d'audit (idempotence)
 *           }
 *           catch (autre) {
 *             skippedMapperErrorCount++;
 *             appendAuditLog contact_import_skipped { reason: "create_failed" }
 *             continue;
 *           }
 *        d. appendAuditLog `contact_imported_from_hubspot`
 *        e. createdCount++
 *   3. appendAuditLog `campaign_completed` (sauf dryRun)
 *   4. return stats
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Sécurité — anti-fuite PII dans payloads audit
 *
 *   AUCUN payload audit ne contient firstName/lastName/phone/email du PS.
 *   Le scrubber `detectPiiInPayload` (audit-log.ts) refuserait l'écriture
 *   (AuditPiiError) si on tentait — defense en profondeur.
 *
 *   Payloads acceptables :
 *     - campaign_started/completed : { listId, listName?, expectedCount,
 *                                       createdCount?, dryRun, durationMs? }
 *     - contact_imported_from_hubspot : { listId, mappingVersion, source }
 *     - contact_import_skipped : { reason, field?, errorCode? }
 *
 *   `targetId` est `hubspotId` (= recordId HubSpot) — identifiant opaque,
 *   semi-PII acceptable (cohérent pattern `createContact` ConflictError
 *   context.hubspotId).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Propagation erreurs SDK
 *
 *   - `getContactsInList` throw `ExternalServiceError` (HubSpot 401/5xx/
 *     timeout) → PROPAGÉ TEL QUEL. Anti-absorption silencieuse : si
 *     HubSpot est down en plein seed, on stoppe (l'opérateur re-lance).
 *
 *   - `createContact` autres erreurs (Firestore quota, timeout) → skip
 *     individuel + audit `contact_import_skipped` + continue. Une erreur
 *     localisée ne doit pas bloquer 199 autres contacts.
 *
 *   - `appendAuditLog` `AuditPiiError` (sentinelle scrubber) → PROPAGÉ.
 *     Bug de notre code (payload contenant PII non-prévue) → fail-loud,
 *     pas de seed cassé qui poserait des audits incomplets.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Architecture testable (Dependency Injection)
 *
 *   Toutes les dépendances I/O passent par `SeedRunnerDeps` (HubSpot SDK,
 *   Firestore, audit). Permet aux tests d'injecter des mocks `vi.fn()`
 *   sans toucher au réseau ni à Firestore emulator.
 */

import type { GetContactsInListOutput, HubspotContactRaw } from "@/lib/hubspot/contacts";
import type { HubspotListInfo } from "@/lib/hubspot/lists";
import { ConflictError, ValidationError } from "@/lib/utils/errors";
import type { Contact } from "@/types/contact";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes verrouillées
// ─────────────────────────────────────────────────────────────────────────────

/** Identifiant d'opération pour logs/erreurs (convention projet). */
export const SEED_RUNNER_OP = "seed.run" as const;

/**
 * Limit max par appel `getContactsInList`. HubSpot wrapper borne à 100
 * (cf. `GET_CONTACTS_IN_LIST_MAX_LIMIT`). On utilise le max pour minimiser
 * le nombre d'appels API (200 contacts MVP = 2 pages).
 *
 * 🔒 SENTINEL — verrouillé par test sentinelle.
 */
export const SEED_BATCH_LIMIT = 100 as const;

/**
 * Borne max de `listName` dans payload audit `campaign_started`.
 * S10.1.3 compliance T1-2 : `listName` vient de l'opérateur HubSpot
 * (champ libre). Si un opérateur saisit accidentellement un téléphone
 * ou email dans le nom de liste, le scrubber `detectPiiInPayload`
 * thrown → audit bloque + seed avorte avec audit `started` posé sans
 * `completed`.
 *
 * Mitigation defense-in-depth :
 *   - Truncate `listName` à 100 chars (anti-bloat audit + indication
 *     visuelle qu'un nom anormalement long est suspect)
 *   - Replace les patterns PII (E.164, FR national, email) par
 *     `[REDACTED]` AVANT d'envoyer au scrubber
 */
const LIST_NAME_MAX_CHARS = 100;
const PII_REPLACER_REGEX =
  /(\+\d{10,15})|(\b0[1-9](?:[ .-]?\d{2}){4}\b)|([\w.+-]+@[\w-]+\.[\w-]+)/g;

/**
 * Sanitise un `listName` HubSpot avant insertion dans payload audit.
 * Truncate + replace patterns PII reconnus. Pure function, testable
 * isolé.
 *
 * @internal — exposé pour tests sentinelles.
 */
export function sanitizeListNameForAudit(raw: string): string {
  const truncated = raw.length > LIST_NAME_MAX_CHARS ? raw.slice(0, LIST_NAME_MAX_CHARS) : raw;
  return truncated.replace(PII_REPLACER_REGEX, "[REDACTED]");
}

/**
 * Version du mapper HubSpot → Firestore stockée dans chaque audit
 * `contact_imported_from_hubspot`. Permet de retracer quelle version du
 * mapping a produit chaque contact en cas de plainte CNIL future.
 *
 * 🔒 SENTINEL — toute modification du mapper (`HUBSPOT_CIVILITE_MAP` ou
 * autres) doit bump cette version + re-validation compliance-auditor.
 */
export const SEED_MAPPING_VERSION = "1.0.0" as const;

// ─────────────────────────────────────────────────────────────────────────────
// Types publics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dépendances I/O injectables. Permet aux tests de mock chaque interaction
 * sans cascade Firestore/HubSpot. Pattern miroir `preSendCheckDeps` (S5).
 *
 * Les types `typeof import(...)` capturent la signature ACTUELLE des
 * fonctions — si une signature évolue, TypeScript râle au compile-time
 * sur les callers (seed-runner + tests).
 */
export interface SeedRunnerDeps {
  listSmsLists: (searchQuery?: string) => Promise<HubspotListInfo[]>;
  getContactsInList: (
    listId: string,
    opts?: { cursor?: string; limit?: number },
  ) => Promise<GetContactsInListOutput>;
  mapHubSpotContactToFirestoreContact: (input: {
    raw: HubspotContactRaw;
    campaignId: string;
  }) => Contact;
  createContact: (input: Contact) => Promise<{ contactId: string }>;
  appendAuditLog: (entry: {
    actorId: string;
    actorType: "system" | "ai" | "human";
    action: string;
    targetType: "contact" | "conversation" | "message" | "campaign" | "user" | "prompt";
    targetId: string;
    payload: Record<string, unknown>;
  }) => Promise<string>;
}

/** Input du `runSeed` — informations de la campagne à importer. */
export interface SeedRunInput {
  /** ID HubSpot de la liste source. */
  listId: string;
  /** Nom UI de la liste (forensic, audit log). */
  listName: string;
  /** Nombre attendu (depuis `HubspotListInfo.size`) — diff vs `fetchedCount` détecte un décalage. */
  expectedCount: number;
  /** Convention `hubspot-list-${listId}` (déterministe). */
  campaignId: string;
  /** Si true : 0 write Firestore, 0 audit log. Validation mapping seulement. */
  dryRun: boolean;
}

/**
 * Statistiques retournées par `runSeed`. Consumé par le CLI wrapper pour
 * affichage final + exit code.
 *
 * `completedAt` est `null` si `runSeed` n'a PAS atteint la fin (exception
 * propagée en milieu de boucle, ex: HubSpot down). Forensic indirect :
 * audit `campaign_started` SANS `campaign_completed` = interruption.
 */
export interface SeedStats {
  listId: string;
  campaignId: string;
  dryRun: boolean;
  expectedCount: number;
  fetchedCount: number;
  createdCount: number;
  skippedAlreadyExistsCount: number;
  skippedMapperErrorCount: number;
  pagesProcessed: number;
  durationMs: number;
  startedAt: string;
  completedAt: string | null;
}

/** Résultat du traitement d'1 contact (pour `processContact` testabilité unitaire). */
export type ProcessContactOutcome =
  | "created"
  | "already_exists"
  | "skipped_mapper"
  | "skipped_create_error";

// ─────────────────────────────────────────────────────────────────────────────
// processContact — pure-ish (1 contact, testable isolé)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Traite 1 contact HubSpot brut : map → createContact → audit.
 *
 * Découplé de `runSeed` pour permettre des tests unit ciblés sur les 4
 * branches d'outcome (created / already_exists / skipped_mapper /
 * skipped_create_error) sans mock de pagination HubSpot.
 *
 * @returns outcome — utilisé par `runSeed` pour incrémenter les compteurs
 *                    de `SeedStats`.
 * @throws  ExternalServiceError si `appendAuditLog` throw (sentinelle
 *          AuditPiiError ou Firestore down) — anti-corruption forensic.
 */
export async function processContact(
  raw: HubspotContactRaw,
  campaignId: string,
  listId: string,
  deps: SeedRunnerDeps,
  isDryRun: boolean,
): Promise<ProcessContactOutcome> {
  // ── Étape A : Mapping HubSpot → Firestore ───────────────────────────────
  let mapped: Contact;
  try {
    mapped = deps.mapHubSpotContactToFirestoreContact({ raw, campaignId });
  } catch (err) {
    if (err instanceof ValidationError) {
      // ValidationError = profession non listée OU phone non normalisable
      // OU firstName vide. 1-2 contacts sur 200 peuvent fail = acceptable.
      // Audit + skip (sauf dryRun).
      if (!isDryRun) {
        await deps.appendAuditLog({
          actorId: "system:seed",
          actorType: "system",
          action: "contact_import_skipped",
          targetType: "contact",
          // raw.id est le recordId HubSpot. Si raw.id absent (très rare,
          // mapper aurait dû le détecter en amont), fallback fingerprint.
          targetId: typeof raw.id === "string" && raw.id.length > 0 ? raw.id : "unknown-hs",
          payload: {
            reason: "mapper_failed",
            // err.context contient déjà missingField/invalidField/
            // professionFingerprint sanitisés par mapper.ts — re-propagés
            // tels quels (zéro PII).
            ...(err.context as Record<string, unknown>),
            errorCode: err.code,
          },
        });
      }
      return "skipped_mapper";
    }
    // Autre erreur inattendue côté mapper (bug interne) → propage.
    throw err;
  }

  // ── Étape B : Dry-run court-circuit (pas de write) ──────────────────────
  if (isDryRun) {
    return "created"; // compte comme "créable" mais aucune mutation réelle
  }

  // ── Étape C : createContact avec absorb ConflictError ───────────────────
  try {
    await deps.createContact(mapped);
  } catch (err) {
    if (err instanceof ConflictError) {
      // hubspotId déjà présent en Firestore = idempotence absorb.
      // PAS d'audit (sinon spam à chaque re-run).
      return "already_exists";
    }
    // Erreur INATTENDUE post-mapper (mapper a validé Zod, donc cette
    // erreur vient de Firestore : quota, timeout, permission). Audit +
    // skip — anti-stop-the-world (1 contact pète pas 199 autres).
    await deps.appendAuditLog({
      actorId: "system:seed",
      actorType: "system",
      action: "contact_import_skipped",
      targetType: "contact",
      targetId: mapped.hubspotId,
      payload: {
        reason: "create_failed",
        errorCode: (err as { code?: string }).code ?? "UNKNOWN",
        errorKind: (err as Error).constructor?.name ?? "Error",
      },
    });
    return "skipped_create_error";
  }

  // ── Étape D : Audit traçabilité forensic RGPD origine HubSpot ───────────
  // Compliance-auditor S10.1.2.b F2 : 1 entrée par contact créé,
  // payload sans PII (juste métadonnées d'origine).
  await deps.appendAuditLog({
    actorId: "system:seed",
    actorType: "system",
    action: "contact_imported_from_hubspot",
    targetType: "contact",
    targetId: mapped.hubspotId,
    payload: {
      listId,
      mappingVersion: SEED_MAPPING_VERSION,
      source: "hubspot",
    },
  });

  return "created";
}

// ─────────────────────────────────────────────────────────────────────────────
// runSeed — orchestrateur principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lance le seed complet d'une liste HubSpot vers Firestore.
 *
 * Pipeline complet (cf. JSDoc en-tête du module) avec audits campagne
 * début/fin + audits par contact + stats agrégées.
 *
 * @throws ExternalServiceError si `getContactsInList` (HubSpot down) ou
 *         `appendAuditLog` (AuditPiiError ou Firestore down) throw.
 *         Propagation telle quelle — anti-absorption silencieuse.
 *
 * @returns `SeedStats` avec `completedAt: string` si succès complet,
 *          `null` si exception en milieu de boucle (mais déjà thrown).
 *          (En pratique, si exception thrown, le caller catch et n'aura
 *          pas le SeedStats partiel — pattern Go-style "either OK either
 *          throw", pas de demi-résultat exposé.)
 */
export async function runSeed(input: SeedRunInput, deps: SeedRunnerDeps): Promise<SeedStats> {
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();

  const stats: SeedStats = {
    listId: input.listId,
    campaignId: input.campaignId,
    dryRun: input.dryRun,
    expectedCount: input.expectedCount,
    fetchedCount: 0,
    createdCount: 0,
    skippedAlreadyExistsCount: 0,
    skippedMapperErrorCount: 0,
    pagesProcessed: 0,
    durationMs: 0,
    startedAt: startedAtIso,
    completedAt: null,
  };

  // ── Étape 1 : audit campaign_started (sauf dryRun) ──────────────────────
  if (!input.dryRun) {
    await deps.appendAuditLog({
      actorId: "system:seed",
      actorType: "system",
      action: "campaign_started",
      targetType: "campaign",
      targetId: input.campaignId,
      payload: {
        listId: input.listId,
        // S10.1.3 T1-2 compliance : sanitisation defense-in-depth contre
        // un opérateur HubSpot qui nommerait une liste "SMS 0612345678"
        // ou similaire — le scrubber bloquerait sinon le seed entier.
        listName: sanitizeListNameForAudit(input.listName),
        expectedCount: input.expectedCount,
        dryRun: false,
      },
    });
  }

  // ── Étape 2 : boucle paginée HubSpot ────────────────────────────────────
  let cursor: string | undefined;
  do {
    const page = await deps.getContactsInList(input.listId, {
      cursor,
      limit: SEED_BATCH_LIMIT,
    });
    stats.pagesProcessed++;
    stats.fetchedCount += page.contacts.length;

    for (const raw of page.contacts) {
      const outcome = await processContact(raw, input.campaignId, input.listId, deps, input.dryRun);
      switch (outcome) {
        case "created":
          stats.createdCount++;
          break;
        case "already_exists":
          stats.skippedAlreadyExistsCount++;
          break;
        case "skipped_mapper":
        case "skipped_create_error":
          stats.skippedMapperErrorCount++;
          break;
      }
    }

    cursor = page.nextCursor;
  } while (cursor !== undefined);

  // ── Étape 3 : audit campaign_completed (sauf dryRun) ────────────────────
  const completedAtMs = Date.now();
  stats.durationMs = completedAtMs - startedAtMs;
  stats.completedAt = new Date(completedAtMs).toISOString();

  if (!input.dryRun) {
    await deps.appendAuditLog({
      actorId: "system:seed",
      actorType: "system",
      action: "campaign_completed",
      targetType: "campaign",
      targetId: input.campaignId,
      payload: {
        listId: input.listId,
        createdCount: stats.createdCount,
        skippedAlreadyExists: stats.skippedAlreadyExistsCount,
        skippedMapperError: stats.skippedMapperErrorCount,
        durationMs: stats.durationMs,
      },
    });
  }

  return stats;
}
