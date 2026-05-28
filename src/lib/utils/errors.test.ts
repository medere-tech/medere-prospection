import { describe, expect, it } from "vitest";

import {
  AppError,
  ComplianceError,
  ConfigError,
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
    { Cls: RateLimitError, code: "RATE_LIMITED", status: 429, operational: true },
    { Cls: ComplianceError, code: "COMPLIANCE_BLOCKED", status: 422, operational: true },
    { Cls: ExternalServiceError, code: "EXTERNAL_SERVICE", status: 502, operational: true },
    { Cls: ConfigError, code: "CONFIG", status: 500, operational: false },
    { Cls: InternalError, code: "INTERNAL", status: 500, operational: false },
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

describe("isAppError", () => {
  it("vrai pour une AppError, faux sinon", () => {
    expect(isAppError(new ValidationError({ message: "x" }))).toBe(true);
    expect(isAppError(new Error("x"))).toBe(false);
    expect(isAppError("x")).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError(undefined)).toBe(false);
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
