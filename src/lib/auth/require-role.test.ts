/**
 * Tests `requireRole` — couverture RBAC complète, mock @clerk/nextjs/server.
 *
 * Cible : ≥ 95% lines + branches. Tous les codepaths :
 *   - userId absent          → UnauthorizedError 401
 *   - sessionClaims null     → ForbiddenError 403 + log warn
 *   - role invalide (Zod)    → ForbiddenError 403 + log warn
 *   - admin sur "admin"      → OK
 *   - admin sur "commercial" → OK (hiérarchie)
 *   - commercial sur "commercial" → OK
 *   - commercial sur "admin" → ForbiddenError 403
 *   - firstName/lastName     → extraits si présents, undefined sinon
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/utils/logger", () => ({
  logger: {
    warn: mocks.warn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import APRÈS les mocks (l'import résout les vi.mock hoistés ci-dessus).
import { ForbiddenError, UnauthorizedError } from "@/lib/utils/errors";

import { requireRole, RoleSchema } from "./require-role";

beforeEach(() => {
  mocks.auth.mockReset();
  mocks.warn.mockReset();
});

describe("RoleSchema (sentinelle anti-bypass)", () => {
  it("accepte 'admin' et 'commercial'", () => {
    expect(RoleSchema.parse("admin")).toBe("admin");
    expect(RoleSchema.parse("commercial")).toBe("commercial");
  });

  it("REFUSE les rôles inventés (superadmin, owner, etc.)", () => {
    expect(() => RoleSchema.parse("superadmin")).toThrow();
    expect(() => RoleSchema.parse("owner")).toThrow();
    expect(() => RoleSchema.parse("")).toThrow();
    expect(() => RoleSchema.parse(undefined)).toThrow();
  });
});

describe("requireRole — auth manquante", () => {
  it("throw UnauthorizedError 401 si userId null", async () => {
    mocks.auth.mockResolvedValue({ userId: null, sessionClaims: null });

    await expect(requireRole("admin")).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(requireRole("admin")).rejects.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
    });
  });

  it("ne log PAS de warn quand userId absent (rien à signaler côté config Clerk)", async () => {
    mocks.auth.mockResolvedValue({ userId: null, sessionClaims: null });
    await expect(requireRole("admin")).rejects.toBeInstanceOf(UnauthorizedError);
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});

describe("requireRole — sessionClaims mal configurés", () => {
  it("throw ForbiddenError 403 si sessionClaims null", async () => {
    mocks.auth.mockResolvedValue({ userId: "user_abc", sessionClaims: null });

    await expect(requireRole("admin")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requireRole("admin")).rejects.toMatchObject({
      statusCode: 403,
      code: "FORBIDDEN",
      clientMessage: "Rôle utilisateur non configuré. Contactez l'administrateur.",
    });
  });

  it("logge warn sentinelle de config si sessionClaims absent", async () => {
    mocks.auth.mockResolvedValue({ userId: "user_abc", sessionClaims: null });
    await expect(requireRole("admin")).rejects.toBeInstanceOf(ForbiddenError);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_abc" }),
      expect.stringContaining("[requireRole] sessionClaims invalid"),
    );
  });

  it("throw ForbiddenError si role absent du JWT", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_abc",
      sessionClaims: { firstName: "Déthié", lastName: "Faye" },
    });
    await expect(requireRole("admin")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("throw ForbiddenError si role est un rôle inventé (superadmin)", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_abc",
      sessionClaims: { role: "superadmin" },
    });
    await expect(requireRole("admin")).rejects.toBeInstanceOf(ForbiddenError);
    expect(mocks.warn).toHaveBeenCalled();
  });

  it("warn N'INCLUT JAMAIS la valeur du role invalide (pas de fuite Zod)", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_abc",
      sessionClaims: { role: "secret-role-NEVER-LOG" },
    });
    await expect(requireRole("admin")).rejects.toBeInstanceOf(ForbiddenError);
    const [logObj] = mocks.warn.mock.calls[0] ?? [];
    expect(JSON.stringify(logObj)).not.toContain("secret-role-NEVER-LOG");
  });
});

describe("requireRole — hiérarchie admin > commercial", () => {
  it("admin sur requireRole('admin') → OK", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_admin",
      sessionClaims: { role: "admin" },
    });
    await expect(requireRole("admin")).resolves.toMatchObject({
      userId: "user_admin",
      role: "admin",
    });
  });

  it("admin sur requireRole('commercial') → OK (hiérarchie)", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_admin",
      sessionClaims: { role: "admin" },
    });
    await expect(requireRole("commercial")).resolves.toMatchObject({
      userId: "user_admin",
      role: "admin",
    });
  });

  it("commercial sur requireRole('commercial') → OK", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_commercial",
      sessionClaims: { role: "commercial" },
    });
    await expect(requireRole("commercial")).resolves.toMatchObject({
      userId: "user_commercial",
      role: "commercial",
    });
  });

  it("commercial sur requireRole('admin') → ForbiddenError", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_commercial",
      sessionClaims: { role: "commercial" },
    });
    await expect(requireRole("admin")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requireRole("admin")).rejects.toMatchObject({
      statusCode: 403,
      context: { userId: "user_commercial", role: "commercial", required: "admin" },
    });
  });
});

describe("requireRole — extraction firstName/lastName", () => {
  it("retourne firstName + lastName si présents dans le JWT", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_abc",
      sessionClaims: { role: "admin", firstName: "Déthié", lastName: "Faye" },
    });
    await expect(requireRole("admin")).resolves.toEqual({
      userId: "user_abc",
      role: "admin",
      firstName: "Déthié",
      lastName: "Faye",
    });
  });

  it("retourne undefined pour firstName/lastName si absents (dégradation gracieuse)", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_abc",
      sessionClaims: { role: "commercial" },
    });
    await expect(requireRole("commercial")).resolves.toEqual({
      userId: "user_abc",
      role: "commercial",
      firstName: undefined,
      lastName: undefined,
    });
  });

  it("refuse un firstName vide (Zod min(1).optional() — '' invalide)", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_abc",
      sessionClaims: { role: "admin", firstName: "", lastName: "Faye" },
    });
    await expect(requireRole("admin")).rejects.toBeInstanceOf(ForbiddenError);
  });
});
