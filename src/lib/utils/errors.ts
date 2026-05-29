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
  | "RATE_LIMITED"
  | "COMPLIANCE_BLOCKED"
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
 */
export class ComplianceError extends AppError {
  readonly code = "COMPLIANCE_BLOCKED" as const;
  readonly statusCode = 422;
  constructor(options: AppErrorOptions) {
    super({ clientMessage: "Envoi non autorisé.", ...options });
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
 * l'identifiant via `hashPii()` ou utiliser un docId à la place AVANT
 * d'appeler `appendAuditLog`. Cf. GUARD-002 + S6.2 arbitrage Déthié.
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
