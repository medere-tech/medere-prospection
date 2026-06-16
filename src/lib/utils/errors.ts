/**
 * Erreurs typées de l'application.
 *
 * Règle CLAUDE.md : une erreur n'est JAMAIS renvoyée telle quelle au client.
 * On log `message` (technique) + `context` côté serveur ; on ne renvoie au client
 * que `clientMessage` (générique) + `code` + `statusCode`. Aucun secret ni PII ne
 * doit transiter par `clientMessage`.
 */

export type ErrorCode =
  | "VALIDATION"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "COMPLIANCE_BLOCKED"
  | "COMPLIANCE_CONCURRENCY"
  | "EXTERNAL_SERVICE"
  | "CONFIG"
  | "INTERNAL"
  | "AUDIT_PII_DETECTED";

export interface AppErrorOptions {
  /** Message technique pour les logs serveur (détaillé, jamais renvoyé au client). */
  message: string;
  /** Message générique sûr à exposer au client. */
  clientMessage?: string;
  /** Contexte structuré pour les logs (sera redacté par le logger). */
  context?: Record<string, unknown>;
  /** Erreur d'origine (chaînage). */
  cause?: unknown;
}

/** Corps de réponse client : générique, sans détail technique ni PII. */
export interface ClientErrorBody {
  error: { code: ErrorCode; message: string };
}

const DEFAULT_CLIENT_MESSAGE = "Une erreur est survenue. Réessayez plus tard.";

/**
 * Base de toutes les erreurs applicatives. Ne jamais instancier directement :
 * utiliser une sous-classe (chacune porte son `code` + `statusCode`).
 */
export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly statusCode: number;
  /** true = erreur attendue/gérable (4xx métier) ; false = bug inattendu (5xx). */
  readonly isOperational: boolean = true;
  /**
   * true si retry inutile (erreur déterministe, payload corrompu, config
   * absente). Lu par les orchestrateurs (Inngest S6.6, BullMQ, Temporal,
   * etc.) pour mapper vers `NonRetriableError` côté worker — évite les
   * boucles de retry sur des erreurs qui ne se résolvent pas avec le temps.
   */
  readonly noRetry: boolean = false;
  readonly clientMessage: string;
  readonly context?: Record<string, unknown>;

  constructor(options: AppErrorOptions) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    // `new.target` = la sous-classe réellement instanciée.
    this.name = new.target.name;
    this.clientMessage = options.clientMessage ?? DEFAULT_CLIENT_MESSAGE;
    this.context = options.context;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }

  /** Représentation sûre pour les logs (la stack est gérée par le logger). */
  toLogObject(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      statusCode: this.statusCode,
      message: this.message,
      context: this.context,
      isOperational: this.isOperational,
    };
  }

  /** Corps de réponse client (générique, sûr à exposer). */
  toClientBody(): ClientErrorBody {
    return { error: { code: this.code, message: this.clientMessage } };
  }
}

/** 400 — input invalide (échec de validation Zod, paramètre manquant…). */
export class ValidationError extends AppError {
  readonly code = "VALIDATION" as const;
  readonly statusCode = 400;
  constructor(options: AppErrorOptions) {
    super({ clientMessage: "Données invalides.", ...options });
  }
}

/** 401 — authentification absente ou invalide. */
export class UnauthorizedError extends AppError {
  readonly code = "UNAUTHORIZED" as const;
  readonly statusCode = 401;
  constructor(options: AppErrorOptions) {
    super({ clientMessage: "Authentification requise.", ...options });
  }
}

/** 403 — authentifié mais pas autorisé (rôle insuffisant). */
export class ForbiddenError extends AppError {
  readonly code = "FORBIDDEN" as const;
  readonly statusCode = 403;
  constructor(options: AppErrorOptions) {
    super({ clientMessage: "Accès refusé.", ...options });
  }
}

/** 404 — ressource introuvable. */
export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND" as const;
  readonly statusCode = 404;
  /** Retry sur un id qui n'existe pas est inutile (id ne va pas apparaître). */
  override readonly noRetry = true;
  constructor(options: AppErrorOptions) {
    super({ clientMessage: "Ressource introuvable.", ...options });
  }
}

/**
 * 409 — conflit sur une ressource (race condition, état déjà atteint qui
 * empêche la mutation demandée). Exemples : 2 commerciaux qui prennent
 * simultanément le même hand-off, tentative de re-handoff d'une
 * conversation déjà assignée, etc.
 *
 * Opérationnel (4xx métier attendu) mais non-retryable : si on retry, on
 * va re-throw le même conflit puisque l'état n'a aucune raison de revenir
 * en arrière.
 */
export class ConflictError extends AppError {
  readonly code = "CONFLICT" as const;
  readonly statusCode = 409;
  /** Un retry sur conflit ne résout rien (l'état ne va pas s'inverser). */
  override readonly noRetry = true;
  constructor(options: AppErrorOptions) {
    super({
      clientMessage: "Ressource déjà dans cet état.",
      ...options,
    });
  }
}

/** 429 — quota dépassé (rate limit Upstash, plafond webhook…). */
export class RateLimitError extends AppError {
  readonly code = "RATE_LIMITED" as const;
  readonly statusCode = 429;
  constructor(options: AppErrorOptions) {
    super({
      clientMessage: "Trop de requêtes. Réessayez plus tard.",
      ...options,
    });
  }
}

/**
 * 422 — envoi bloqué par une règle de conformité (opt-out, plafond 3/30j,
 * plage horaire, Bloctel…). Utilisée par `lib/compliance/`.
 *
 * Le type de `code` est volontairement élargi à l'union
 * `"COMPLIANCE_BLOCKED" | "COMPLIANCE_CONCURRENCY"` pour permettre à la
 * sous-classe `ComplianceConcurrencyError` (S6.6 / DEBT-001) de narrow
 * `code` à `"COMPLIANCE_CONCURRENCY"` tout en restant sous-type de
 * `ComplianceError` (instanceof preservé). Le défaut à l'instanciation
 * directe reste `"COMPLIANCE_BLOCKED"` — comportement S6 inchangé.
 */
export class ComplianceError extends AppError {
  readonly code: "COMPLIANCE_BLOCKED" | "COMPLIANCE_CONCURRENCY" = "COMPLIANCE_BLOCKED";
  readonly statusCode = 422;
  constructor(options: AppErrorOptions) {
    super({ clientMessage: "Envoi non autorisé.", ...options });
  }
}

/**
 * Contexte structuré obligatoire d'une `ComplianceConcurrencyError`.
 *
 * Garantie anti-PII par typage : aucune clé n'est PII par construction.
 *   - `contactId`              : hubspotId (= docId Firestore, identifiant
 *                                interne stable, déjà utilisé partout).
 *   - `ruleName`               : nom de la règle compliance qui a re-check
 *                                fail DANS la tx (ex: `"rate_limit"`).
 *                                Pas de string libre — alignement S4 names.
 *   - `attemptedAt`            : `Date` (référence temporelle de la
 *                                tentative qui a perdu la race). Pas PII.
 *   - `expectedRemainingQuota` : quota restant LU HORS tx (pre-check S5).
 *   - `observedRemainingQuota` : quota restant LU DANS la tx (re-check).
 *                                Si < `expectedRemainingQuota` → preuve
 *                                de la race (une tx concurrente a commit
 *                                entre temps).
 */
export interface ComplianceConcurrencyContext {
  contactId: string;
  ruleName: string;
  attemptedAt: Date;
  expectedRemainingQuota: number;
  observedRemainingQuota: number;
  // Index signature explicite : permet l'assignation à
  // `AppError.context: Record<string, unknown>` sans cast (cf. TS limitation
  // structurelle — un interface SANS index signature ne match PAS un
  // Record<string, unknown>, même quand toutes ses valeurs sont assignables
  // à unknown). C'est un no-op runtime — TS-level only.
  readonly [k: string]: unknown;
}

/**
 * Options d'instanciation d'une `ComplianceConcurrencyError`. Diffère de
 * `AppErrorOptions` en rendant `context` OBLIGATOIRE et typé strict
 * (`ComplianceConcurrencyContext`) — empêche au compile-time tout caller
 * d'omettre les champs forensiques ou d'y glisser une PII par accident.
 */
export interface ComplianceConcurrencyErrorOptions extends Omit<AppErrorOptions, "context"> {
  context: ComplianceConcurrencyContext;
}

/**
 * 422 — concurrence détectée DANS une transaction Firestore : le re-check
 * de la règle compliance (typiquement `rate_limit` 3 SMS / 30j) a échoué
 * parce qu'une autre transaction a commit AVANT nous entre temps. La tx
 * courante a rollback proprement — aucun SMS n'est parti côté OVH, aucun
 * message Firestore n'a été créé.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * RAISON D'ÊTRE (S6.6 / DEBT-001 / INFRA-DETTE-001)
 *
 * Distincte de `ComplianceError("rate_limit_exceeded")` :
 *
 *   - `ComplianceError` (code `COMPLIANCE_BLOCKED`) = la pré-vérif HORS tx
 *     a détecté un blocage stable (le contact EST déjà au plafond). Retry
 *     ne va pas changer le résultat ; l'orchestrateur doit logger un
 *     audit `send_blocked` et passer à la suite.
 *
 *   - `ComplianceConcurrencyError` (code `COMPLIANCE_CONCURRENCY`) = la
 *     pré-vérif HORS tx a dit OK, mais la transaction Firestore qui
 *     enrobe l'envoi a perdu une race contre une autre tx concurrente
 *     juste avant le commit. Retry pertinent : la prochaine itération
 *     relira l'historique mis à jour et soit passera (place dispo —
 *     improbable si un 4ème événement arrive 30j+ après les 3 précédents,
 *     mais possible), soit se transformera proprement en
 *     `ComplianceError("rate_limit_exceeded")` lue HORS tx au tour
 *     suivant (avec son audit `send_blocked` complet).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * RETRY-FRIENDLY (`noRetry = false`)
 *
 * `noRetry` reste à `false` (défaut hérité de `AppError`). Côté Inngest
 * (S6.6+ / DEBT-001), cette erreur N'EST PAS wrappée en `NonRetriableError`
 * — elle propage telle quelle, ce qui déclenche la politique retry par
 * défaut Inngest (4 tentatives, backoff exponentiel). C'est un scénario
 * opérationnel légitime (2 events concurrents sur le même contact, ex:
 * re-émission manuelle d'une campagne), PAS une attaque ni un payload
 * corrompu — le retry naturel résout le problème en lisant l'état final.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * QUI THROW / QUI CATCH
 *
 *   - **Throw** : `sendOutboundWithLock()` (`lib/firestore/transactions.ts`,
 *     S6.6 / DEBT-001) — quand `canSendMessage(recordsInTx)` retourne
 *     `allowed: false` DANS la transaction après que la pré-vérif HORS tx
 *     ait dit OK. La tx Firestore rollback automatiquement (write
 *     message + audits jamais commit).
 *
 *   - **Catch** : `send-first-sms` Inngest function (DEBT-001.5) — laisse
 *     propager l'erreur (pas de wrapping `NonRetriableError`), Inngest
 *     retry le step après backoff. Le caller logue UNIQUEMENT un audit
 *     `send_blocked` AVANT de throw pour traçabilité forensique.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CLIENT MESSAGE
 *
 * Hérite de `ComplianceError` : `"Envoi non autorisé."` — strictement
 * identique au cas pre-vérif HORS tx. AUCUN champ technique (contactId,
 * quotas, ruleName) ne doit fuir côté client : ils restent dans `context`
 * pour les logs serveur uniquement (et seront redactés par le scrubber
 * S6.2 lors de l'écriture en audit log si jamais).
 */
export class ComplianceConcurrencyError extends ComplianceError {
  override readonly code = "COMPLIANCE_CONCURRENCY" as const;
  // Narrowed type pour les callers (compile-time). Le runtime value est
  // posé par le constructeur parent `AppError` via `super({...context})`
  // — pas besoin de réassigner ici. `!` informe TS qu'on assume la
  // définite assignment via super().
  override readonly context!: ComplianceConcurrencyContext;
  constructor(options: ComplianceConcurrencyErrorOptions) {
    super({
      clientMessage: "Envoi non autorisé.",
      message: options.message,
      cause: options.cause,
      context: options.context,
    });
  }
}

/**
 * Contexte structuré obligatoire d'une `ComplianceFailureError`. Anti-PII
 * par construction : aucune clé n'est PII.
 *
 *   - `rule`           : nom de la `ComplianceRule` qui a refusé (voir
 *                        `src/lib/compliance/pre-send-check.ts`). Typé
 *                        `string` ici (pas import du type côté errors.ts
 *                        pour éviter un cycle d'import compliance→errors).
 *   - `code`           : `ComplianceFailCode` correspondant (idem `string`
 *                        pour la raison ci-dessus).
 *   - `failureContext` : contexte structuré du failure tel que renvoyé
 *                        par `preSendCheck` (discriminated union FERMÉE
 *                        de pre-send-check.ts — aucune clé PII possible).
 */
export interface ComplianceFailureContext {
  rule: string;
  code: string;
  failureContext: Record<string, unknown>;
  // Index signature explicite : permet l'assignation à
  // `AppError.context: Record<string, unknown>` sans cast (cf. pattern
  // miroir `ComplianceConcurrencyContext` ci-dessus, TS limitation
  // structurelle no-op runtime).
  readonly [k: string]: unknown;
}

/**
 * Options d'instanciation d'une `ComplianceFailureError`. Diffère de
 * `AppErrorOptions` en rendant `context` OBLIGATOIRE et typé strict
 * (`ComplianceFailureContext`) — empêche au compile-time tout caller
 * d'omettre les champs forensiques.
 */
export interface ComplianceFailureErrorOptions extends Omit<AppErrorOptions, "context"> {
  context: ComplianceFailureContext;
}

/**
 * 422 — refus compliance détecté DANS une transaction Firestore (S9.4.1
 * `preSendCheckWithAuditTx`). Sous-classe de `ComplianceError` →
 * `instanceof ComplianceError` reste true pour les callers compliance-aware.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * DISTINCTION VS `ComplianceConcurrencyError`
 *
 *   - `ComplianceConcurrencyError` (`noRetry=false`) : RACE détectée DANS
 *     la tx (la pré-vérif HORS tx a dit OK mais une autre tx a saturé le
 *     plafond entre temps). Retry naturel Inngest pertinent — la prochaine
 *     itération relira l'état mis à jour et soit passera, soit se
 *     transformera en blocage stable. Réservé à `rate_limit` (seule règle
 *     sujette à la race en S6 pattern).
 *
 *   - `ComplianceFailureError` (`noRetry=TRUE`) : BLOCAGE STABLE détecté
 *     dans la tx (S9.4.1 pattern — entre génération draft et envoi, la
 *     fenêtre temporelle minutes/heures permet un consent drift sur n'importe
 *     laquelle des 9 rules). Retry ne va pas inverser la décision (le PS
 *     a opt-out, l'heure est passée, le contact a été marqué invalide).
 *     L'orchestrateur (`commitDraftToQueued`) catch l'erreur HORS tx pour
 *     poser les audits `compliance_check (blocked)` + `reply_draft_dropped`
 *     en best-effort, puis retourne `{ok: false, failure}` au caller.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * QUI THROW / QUI CATCH
 *
 *   - **Throw** : `preSendCheckWithAuditTx()` (S9.4.1) quand
 *     `preSendCheck` retourne `{ok: false, failure}` DANS une transaction
 *     Firestore. La tx rollback automatiquement (aucun audit
 *     `compliance_check (allowed)` ne sera commit, aucune transition
 *     `draft→queued` ne sera commit).
 *
 *   - **Catch** : `commitDraftToQueued()` (S9.4.1) HORS withContactLock —
 *     pose les 2 audits best-effort puis return `{ok: false, failure}`
 *     au caller (handler send-reply S9.4.2 ou tests).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CLIENT MESSAGE
 *
 * Hérite de `ComplianceError` : `"Envoi non autorisé."` — strictement
 * identique au cas pre-vérif HORS tx. AUCUN champ technique (rule, code,
 * failureContext) ne doit fuir côté client.
 */
export class ComplianceFailureError extends ComplianceError {
  override readonly code = "COMPLIANCE_BLOCKED" as const;
  /**
   * Distinct de `ComplianceConcurrencyError.noRetry=false` : un refus
   * compliance stable (opt_out, hours, rate_limit non-race, etc.) ne
   * s'inversera pas avec un retry — c'est une décision métier finale.
   * L'orchestrateur traite le retour `{ok: false, failure}` du caller
   * (`commitDraftToQueued`), pas un retry.
   */
  override readonly noRetry = true;
  override readonly context!: ComplianceFailureContext;
  constructor(options: ComplianceFailureErrorOptions) {
    super({
      clientMessage: "Envoi non autorisé.",
      message: options.message,
      cause: options.cause,
      context: options.context,
    });
  }
}

/** 502 — échec d'un service tiers (OVH, HubSpot, Anthropic…). Opérationnel. */
export class ExternalServiceError extends AppError {
  readonly code = "EXTERNAL_SERVICE" as const;
  readonly statusCode = 502;
  constructor(options: AppErrorOptions) {
    super({
      clientMessage: "Service temporairement indisponible.",
      ...options,
    });
  }
}

/** 500 — configuration serveur invalide (env var manquante…). NON opérationnel. */
export class ConfigError extends AppError {
  readonly code = "CONFIG" as const;
  readonly statusCode = 500;
  override readonly isOperational = false;
  /** Un retry ne fera pas apparaître la variable d'env manquante : déterministe. */
  override readonly noRetry = true;
  constructor(options: AppErrorOptions) {
    super({ clientMessage: DEFAULT_CLIENT_MESSAGE, ...options });
  }
}

/** 500 — erreur inattendue (bug). NON opérationnel. */
export class InternalError extends AppError {
  readonly code = "INTERNAL" as const;
  readonly statusCode = 500;
  override readonly isOperational = false;
  constructor(options: AppErrorOptions) {
    super({ clientMessage: DEFAULT_CLIENT_MESSAGE, ...options });
  }
}

/**
 * 500 — PII détecté dans un payload d'audit log avant écriture Firestore.
 * NON opérationnel : c'est un bug code du caller qui aurait dû hash
 * l'identifiant via `safePhoneHash()` (pour téléphones — PAS `hashPii`
 * brut, cf. warning JSDoc + HIGH-1 S9.2.1) ou utiliser un docId à la
 * place AVANT d'appeler `appendAuditLog`. Cf. GUARD-002 + S6.2 arbitrage
 * Déthié.
 *
 * `context.violations` contient la liste sanitisée (path + kind + sample
 * tronqué) — JAMAIS la valeur d'origine. Le logger peut consommer le
 * context tel quel sans risque de fuite.
 *
 * Côté Inngest (S6.6) : cette erreur doit être traitée `no-retry` +
 * alerte Sentry/Slack. Un retry infini sur un payload corrompu serait
 * pire que d'arrêter la chaîne d'envoi pour ce job.
 */
export class AuditPiiError extends AppError {
  readonly code = "AUDIT_PII_DETECTED" as const;
  readonly statusCode = 500;
  override readonly isOperational = false;
  /** Payload corrompu : un retry échouera identiquement sur la même PII. */
  override readonly noRetry = true;
  constructor(options: AppErrorOptions) {
    super({ clientMessage: DEFAULT_CLIENT_MESSAGE, ...options });
  }
}

/** Type guard : `e` est une erreur applicative connue. */
export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/**
 * Normalise n'importe quelle valeur catchée en `AppError`. Une valeur déjà
 * `AppError` est renvoyée telle quelle ; sinon elle est enveloppée dans une
 * `InternalError` (le message d'origine est conservé pour les logs, jamais
 * exposé au client).
 */
export function toAppError(e: unknown): AppError {
  if (isAppError(e)) return e;
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "Unknown error";
  return new InternalError({ message, cause: e });
}
