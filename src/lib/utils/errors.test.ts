import { describe, expect, it } from "vitest";

import {
  AppError,
  AuditPiiError,
  ComplianceConcurrencyError,
  ComplianceError,
  ConfigError,
  ConflictError,
  ExternalServiceError,
  ForbiddenError,
  InternalError,
  isAppError,
  NotFoundError,
  RateLimitError,
  toAppError,
  UnauthorizedError,
  ValidationError,
} from "./errors";

describe("AppError subclasses", () => {
  const cases = [
    { Cls: ValidationError, code: "VALIDATION", status: 400, operational: true },
    { Cls: UnauthorizedError, code: "UNAUTHORIZED", status: 401, operational: true },
    { Cls: ForbiddenError, code: "FORBIDDEN", status: 403, operational: true },
    { Cls: NotFoundError, code: "NOT_FOUND", status: 404, operational: true },
    { Cls: ConflictError, code: "CONFLICT", status: 409, operational: true },
    { Cls: RateLimitError, code: "RATE_LIMITED", status: 429, operational: true },
    { Cls: ComplianceError, code: "COMPLIANCE_BLOCKED", status: 422, operational: true },
    { Cls: ExternalServiceError, code: "EXTERNAL_SERVICE", status: 502, operational: true },
    { Cls: ConfigError, code: "CONFIG", status: 500, operational: false },
    { Cls: InternalError, code: "INTERNAL", status: 500, operational: false },
    {
      Cls: AuditPiiError,
      code: "AUDIT_PII_DETECTED",
      status: 500,
      operational: false,
    },
  ] as const;

  it.each(cases)(
    "$Cls.name porte le bon code/statusCode/isOperational",
    ({ Cls, code, status, operational }) => {
      const err = new Cls({ message: "technique" });
      expect(err).toBeInstanceOf(AppError);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(code);
      expect(err.statusCode).toBe(status);
      expect(err.isOperational).toBe(operational);
      expect(err.name).toBe(Cls.name);
      expect(err.message).toBe("technique");
    },
  );

  it("expose un clientMessage générique par défaut, jamais le message technique", () => {
    const err = new ValidationError({ message: "phone +33612345678 invalide" });
    expect(err.clientMessage).toBe("Données invalides.");
    expect(err.clientMessage).not.toContain("+33612345678");
  });

  it("permet de surcharger le clientMessage", () => {
    const err = new ValidationError({
      message: "technique",
      clientMessage: "Le numéro est invalide.",
    });
    expect(err.clientMessage).toBe("Le numéro est invalide.");
  });

  it("conserve le contexte et la cause d'origine", () => {
    const cause = new Error("boom");
    const err = new ExternalServiceError({
      message: "OVH timeout",
      context: { service: "ovh", attempt: 2 },
      cause,
    });
    expect(err.context).toEqual({ service: "ovh", attempt: 2 });
    expect(err.cause).toBe(cause);
  });
});

describe("AppError serialization", () => {
  it("toLogObject() expose les champs techniques sans stack", () => {
    const err = new ComplianceError({
      message: "blocked: opt-out",
      context: { rule: "opt_out" },
    });
    expect(err.toLogObject()).toEqual({
      name: "ComplianceError",
      code: "COMPLIANCE_BLOCKED",
      statusCode: 422,
      message: "blocked: opt-out",
      context: { rule: "opt_out" },
      isOperational: true,
    });
  });

  it("toClientBody() ne renvoie que code + clientMessage", () => {
    const err = new NotFoundError({ message: "contact abc123 introuvable" });
    expect(err.toClientBody()).toEqual({
      error: { code: "NOT_FOUND", message: "Ressource introuvable." },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// noRetry (MED-2 S6.2 — signal aux orchestrateurs Inngest/BullMQ/...)
// ─────────────────────────────────────────────────────────────────────────────

describe("noRetry — marqueur orchestrateur (MED-2 S6.2)", () => {
  it("AuditPiiError.noRetry === true (payload corrompu, retry inutile)", () => {
    const err = new AuditPiiError({ message: "pii detected" });
    expect(err.noRetry).toBe(true);
  });

  it("ConfigError.noRetry === true (env manquante, retry inutile)", () => {
    const err = new ConfigError({ message: "missing var" });
    expect(err.noRetry).toBe(true);
  });

  it("ValidationError.noRetry === false (défaut — input client peut être corrigé)", () => {
    const err = new ValidationError({ message: "invalid" });
    expect(err.noRetry).toBe(false);
  });

  it("NotFoundError.noRetry === true (id ne va pas réapparaître)", () => {
    const err = new NotFoundError({ message: "missing" });
    expect(err.noRetry).toBe(true);
  });

  it("ConflictError.noRetry === true (état ne va pas s'inverser)", () => {
    const err = new ConflictError({ message: "already done" });
    expect(err.noRetry).toBe(true);
  });

  it("ExternalServiceError.noRetry === false (transient, retry pertinent)", () => {
    const err = new ExternalServiceError({ message: "ovh down" });
    expect(err.noRetry).toBe(false);
  });

  it("InternalError.noRetry === false par défaut (bug peut être transient)", () => {
    const err = new InternalError({ message: "boom" });
    expect(err.noRetry).toBe(false);
  });
});

describe("isAppError", () => {
  it("vrai pour une AppError, faux sinon", () => {
    expect(isAppError(new ValidationError({ message: "x" }))).toBe(true);
    expect(isAppError(new Error("x"))).toBe(false);
    expect(isAppError("x")).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError(undefined)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ComplianceConcurrencyError (S6.6 / DEBT-001.1)
// ─────────────────────────────────────────────────────────────────────────────

describe("ComplianceConcurrencyError (DEBT-001.1)", () => {
  // `attemptedAt` est fixé dans un beforeAll pour rester déterministe ;
  // toutes les assertions context utilisent CE Date strictement.
  const FIXED_AT = new Date("2026-06-08T10:30:00.000Z");

  function makeValidContext() {
    return {
      contactId: "hubspot_12345",
      ruleName: "rate_limit",
      attemptedAt: FIXED_AT,
      expectedRemainingQuota: 1,
      observedRemainingQuota: 0,
    } as const;
  }

  it("constructor accepte un context valide et expose les 5 clés forensiques", () => {
    const err = new ComplianceConcurrencyError({
      message: "rate_limit race detected at commit",
      context: makeValidContext(),
    });
    expect(err.context).toEqual({
      contactId: "hubspot_12345",
      ruleName: "rate_limit",
      attemptedAt: FIXED_AT,
      expectedRemainingQuota: 1,
      observedRemainingQuota: 0,
    });
  });

  it("est instanceof ComplianceError ET AppError ET Error", () => {
    const err = new ComplianceConcurrencyError({
      message: "race",
      context: makeValidContext(),
    });
    expect(err).toBeInstanceOf(ComplianceConcurrencyError);
    expect(err).toBeInstanceOf(ComplianceError);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
  });

  it("code === 'COMPLIANCE_CONCURRENCY' (sentinelle anti-régression)", () => {
    const err = new ComplianceConcurrencyError({
      message: "race",
      context: makeValidContext(),
    });
    expect(err.code).toBe("COMPLIANCE_CONCURRENCY");
    // Sentinelle structurelle : si quelqu'un renomme le code, ce check
    // strict casse. Le pattern Inngest noRetry mapping (S6.6+) compte
    // sur ce code exact pour distinguer la concurrence d'un blocage stable.
    expect(err.code).not.toBe("COMPLIANCE_BLOCKED");
  });

  it("statusCode === 422 (sentinelle anti-régression — cohérence ComplianceError)", () => {
    const err = new ComplianceConcurrencyError({
      message: "race",
      context: makeValidContext(),
    });
    // 422 cohérent avec ComplianceError (Unprocessable Entity). Pas 409
    // (ConflictError), pas 429 (RateLimitError). Si quelqu'un change ça,
    // la signification métier change → tests dépendants doivent péter.
    expect(err.statusCode).toBe(422);
  });

  it("noRetry === false (retry-friendly, défaut hérité — Q3 DEBT-001)", () => {
    // Décision Déthié Q3 : 2 events Inngest concurrents = scénario
    // opérationnel légitime. Inngest doit retry → noRetry=false.
    // Le code prod (sendOutboundWithLock S6.6+) propage l'erreur telle
    // quelle, PAS de wrap NonRetriableError.
    const err = new ComplianceConcurrencyError({
      message: "race",
      context: makeValidContext(),
    });
    expect(err.noRetry).toBe(false);
  });

  it("isOperational === true (4xx métier attendu, pas un bug)", () => {
    const err = new ComplianceConcurrencyError({
      message: "race",
      context: makeValidContext(),
    });
    expect(err.isOperational).toBe(true);
  });

  it("clientMessage === 'Envoi non autorisé.' et NE fuit NI contactId NI compteurs", () => {
    const err = new ComplianceConcurrencyError({
      message: "rate_limit race: hubspot_12345 expected=1 observed=0",
      context: makeValidContext(),
    });
    // Anti-fuite info technique : le clientMessage doit être strictement
    // identique au cas pre-vérif HORS tx (cohérence côté client).
    expect(err.clientMessage).toBe("Envoi non autorisé.");
    // Sentinelle exhaustive — aucun champ technique ne doit transiter
    // par le clientMessage, même si le message technique en contient.
    expect(err.clientMessage).not.toContain("hubspot_12345");
    expect(err.clientMessage).not.toContain("rate_limit");
    expect(err.clientMessage).not.toContain("expected");
    expect(err.clientMessage).not.toContain("observed");
  });

  it("toClientBody() ne renvoie QUE code + clientMessage générique", () => {
    const err = new ComplianceConcurrencyError({
      message: "race",
      context: makeValidContext(),
    });
    // Sentinelle structurelle : la forme renvoyée au client est strictement
    // { error: { code, message } } — pas de context, pas de statusCode,
    // pas de stack, pas de PII contactId.
    expect(err.toClientBody()).toEqual({
      error: { code: "COMPLIANCE_CONCURRENCY", message: "Envoi non autorisé." },
    });
  });

  it("toLogObject() expose les champs techniques + context forensique pour les logs", () => {
    const err = new ComplianceConcurrencyError({
      message: "race detected",
      context: makeValidContext(),
    });
    expect(err.toLogObject()).toEqual({
      name: "ComplianceConcurrencyError",
      code: "COMPLIANCE_CONCURRENCY",
      statusCode: 422,
      message: "race detected",
      context: {
        contactId: "hubspot_12345",
        ruleName: "rate_limit",
        attemptedAt: FIXED_AT,
        expectedRemainingQuota: 1,
        observedRemainingQuota: 0,
      },
      isOperational: true,
    });
  });

  it("err.name === 'ComplianceConcurrencyError' (set via new.target.name)", () => {
    const err = new ComplianceConcurrencyError({
      message: "race",
      context: makeValidContext(),
    });
    expect(err.name).toBe("ComplianceConcurrencyError");
  });

  it("conserve cause via super (chaînage Firestore tx exception → forensique)", () => {
    const rootCause = new Error("Firestore tx aborted (revision conflict)");
    const err = new ComplianceConcurrencyError({
      message: "race",
      context: makeValidContext(),
      cause: rootCause,
    });
    expect(err.cause).toBe(rootCause);
  });

  it("isAppError(ComplianceConcurrencyError) === true", () => {
    const err = new ComplianceConcurrencyError({
      message: "race",
      context: makeValidContext(),
    });
    expect(isAppError(err)).toBe(true);
  });

  it("toAppError ne re-wrap pas (déjà AppError)", () => {
    const err = new ComplianceConcurrencyError({
      message: "race",
      context: makeValidContext(),
    });
    expect(toAppError(err)).toBe(err);
  });
});

describe("toAppError", () => {
  it("renvoie l'AppError telle quelle (pas de double wrap)", () => {
    const original = new ForbiddenError({ message: "x" });
    expect(toAppError(original)).toBe(original);
  });

  it("enveloppe une Error standard en InternalError en gardant message + cause", () => {
    const original = new Error("db down");
    const wrapped = toAppError(original);
    expect(wrapped).toBeInstanceOf(InternalError);
    expect(wrapped.message).toBe("db down");
    expect(wrapped.cause).toBe(original);
    expect(wrapped.isOperational).toBe(false);
  });

  it("enveloppe une string", () => {
    const wrapped = toAppError("plain string failure");
    expect(wrapped).toBeInstanceOf(InternalError);
    expect(wrapped.message).toBe("plain string failure");
  });

  it("enveloppe une valeur inconnue avec un message par défaut", () => {
    expect(toAppError({ weird: true }).message).toBe("Unknown error");
    expect(toAppError(null).message).toBe("Unknown error");
  });
});
