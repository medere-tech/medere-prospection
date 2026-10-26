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

  // PR1.14.2 — fix FAIT 1 : null-safety sur firstName/lastName.
  it("normalise firstName=null en undefined (Clerk JWT emet null si metadata absent)", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_abc",
      sessionClaims: { role: "admin", firstName: null, lastName: "Faye" },
    });
    await expect(requireRole("admin")).resolves.toMatchObject({
      firstName: undefined,
      lastName: "Faye",
    });
  });

  it("normalise lastName=null en undefined", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_abc",
      sessionClaims: { role: "admin", firstName: "Déthié", lastName: null },
    });
    await expect(requireRole("admin")).resolves.toMatchObject({
      firstName: "Déthié",
      lastName: undefined,
    });
  });
});

describe("requireRole — extraction slackUserId (VUE-CONVERSATION PR0)", () => {
  it("retourne slackUserId si bien formé (`U` + majuscules/digits)", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_abc",
      sessionClaims: { role: "commercial", slackUserId: "U05UVHGBURX" },
    });
    const ctx = await requireRole("commercial");
    expect(ctx.slackUserId).toBe("U05UVHGBURX");
  });

  it("retourne undefined si slackUserId absent (admin sans compte Slack)", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_dethie",
      sessionClaims: { role: "admin" },
    });
    const ctx = await requireRole("admin");
    expect(ctx.slackUserId).toBeUndefined();
  });

  it("normalise '' en undefined (Clerk JWT template remplace missing metadata par chaîne vide)", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_abc",
      sessionClaims: { role: "commercial", slackUserId: "" },
    });
    const ctx = await requireRole("commercial");
    expect(ctx.slackUserId).toBeUndefined();
  });

  it("REFUSE un slackUserId mal formé (pas de prefix U)", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_abc",
      sessionClaims: { role: "commercial", slackUserId: "X12345ABC" },
    });
    await expect(requireRole("commercial")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("REFUSE un slackUserId avec minuscules", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_abc",
      sessionClaims: { role: "commercial", slackUserId: "U05uvhgburx" },
    });
    await expect(requireRole("commercial")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("REFUSE un slackUserId avec caractères spéciaux", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_abc",
      sessionClaims: { role: "commercial", slackUserId: "U05-UVHG" },
    });
    await expect(requireRole("commercial")).rejects.toBeInstanceOf(ForbiddenError);
  });

  // PR1.14.2 — fix FAIT 1 : Clerk JWT template émet `null` pour un
  // shortcode `{{user.public_metadata.slackUserId}}` dont le metadata est
  // absent. Avant le fix, Zod rejetait `null` → tout admin sans
  // slackUserId était bloqué 403 (`e2e-admin`, Déthié, Harry, Justine).
  it("normalise `null` en undefined (admin sans publicMetadata.slackUserId, cas réel user_3L0hWVeHTxDmumIZ7GozNU3LgU5)", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_e2e_admin",
      sessionClaims: { role: "admin", slackUserId: null },
    });
    const ctx = await requireRole("admin");
    expect(ctx.slackUserId).toBeUndefined();
  });
});

describe("requireRole — testAccount en prod (PR1.14.1 défense en profondeur)", () => {
  it("REFUSE un compte testAccount=true quand VERCEL_ENV=production (claim boolean)", async () => {
    const prev = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = "production";
    try {
      mocks.auth.mockResolvedValue({
        userId: "user_e2e_admin",
        sessionClaims: { role: "admin", testAccount: true },
      });
      await expect(requireRole("admin")).rejects.toBeInstanceOf(ForbiddenError);
    } finally {
      if (prev === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = prev;
    }
  });

  // PR1.14.2 fail-closed strict : "true" (string) n'est PLUS accepté par
  // Zod. Le JWT template Clerk émet un boolean natif (sans guillemets).
  // Toute string → échec Zod → ForbiddenError pour sessionClaims invalid.
  it("REFUSE un claim testAccount='true' string (fail-closed Zod — JWT template boolean attendu)", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_abc",
      sessionClaims: { role: "admin", testAccount: "true" },
    });
    await expect(requireRole("admin")).rejects.toBeInstanceOf(ForbiddenError);
    expect(mocks.warn).toHaveBeenCalled();
  });

  it("REFUSE un claim testAccount=1 (number)", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_abc",
      sessionClaims: { role: "admin", testAccount: 1 },
    });
    await expect(requireRole("admin")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("REFUSE un claim testAccount='TRUE' (majuscules — pas en pattern Clerk JSON)", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_abc",
      sessionClaims: { role: "admin", testAccount: "TRUE" },
    });
    await expect(requireRole("admin")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("REFUSE un claim testAccount='yes'", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_abc",
      sessionClaims: { role: "admin", testAccount: "yes" },
    });
    await expect(requireRole("admin")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("REFUSE un claim testAccount={} (objet)", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_abc",
      sessionClaims: { role: "admin", testAccount: {} },
    });
    await expect(requireRole("admin")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("accepte un compte testAccount=true en VERCEL_ENV=preview (staging/test environnement)", async () => {
    const prev = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = "preview";
    try {
      mocks.auth.mockResolvedValue({
        userId: "user_e2e_admin",
        sessionClaims: { role: "admin", testAccount: true },
      });
      const ctx = await requireRole("admin");
      expect(ctx.role).toBe("admin");
    } finally {
      if (prev === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = prev;
    }
  });

  it("accepte un compte testAccount=false même en VERCEL_ENV=production (compte réel)", async () => {
    const prev = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = "production";
    try {
      mocks.auth.mockResolvedValue({
        userId: "user_dethie",
        sessionClaims: { role: "admin", testAccount: false },
      });
      const ctx = await requireRole("admin");
      expect(ctx.role).toBe("admin");
    } finally {
      if (prev === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = prev;
    }
  });

  it("accepte un claim testAccount absent (comptes réels historiques sans le claim)", async () => {
    const prev = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = "production";
    try {
      mocks.auth.mockResolvedValue({
        userId: "user_dethie",
        sessionClaims: { role: "admin" },
      });
      const ctx = await requireRole("admin");
      expect(ctx.role).toBe("admin");
    } finally {
      if (prev === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = prev;
    }
  });

  // PR1.14.2 — fix FAIT 1 : null-safety sur testAccount (Clerk JWT emet null
  // si le metadata est absent plutot que de supprimer la clé).
  it("accepte testAccount=null et le normalise en false (comptes reels sans le claim)", async () => {
    const prev = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = "production";
    try {
      mocks.auth.mockResolvedValue({
        userId: "user_dethie",
        sessionClaims: { role: "admin", testAccount: null },
      });
      const ctx = await requireRole("admin");
      expect(ctx.role).toBe("admin");
    } finally {
      if (prev === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = prev;
    }
  });
});

// PR1.14.2 — fix FAIT 1 : cas reel (user_3L0hWVeHTxDmumIZ7GozNU3LgU5
// = e2e-admin) qui bloquait tous les scenarios signInAsAdmin. On rejoue
// le payload JWT exact tel que Clerk l'emet pour un admin sans
// slackUserId : TOUTES les cles optionnelles arrivent `null`.
describe("requireRole — reproduction cas reel e2e-admin (FAIT 1)", () => {
  it("accepte un admin dont tous les champs optionnels sont null (slackUserId, firstName, lastName)", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_e2e_admin",
      sessionClaims: {
        role: "admin",
        firstName: null,
        lastName: null,
        slackUserId: null,
        testAccount: true,
      },
    });
    const ctx = await requireRole("admin");
    expect(ctx).toEqual({
      userId: "user_e2e_admin",
      role: "admin",
      firstName: undefined,
      lastName: undefined,
      slackUserId: undefined,
    });
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("meme cas, hierarchie : admin sur requireRole('commercial') passe", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_e2e_admin",
      sessionClaims: {
        role: "admin",
        firstName: null,
        lastName: null,
        slackUserId: null,
        testAccount: true,
      },
    });
    const ctx = await requireRole("commercial");
    expect(ctx.role).toBe("admin");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requireRoleOrForbidden — PR2b-1 round 3
// ─────────────────────────────────────────────────────────────────────────────
//
// Prouve qu'un refus de rôle (`e2e-no-role` sur /admin/conversations) :
//   - appelle `forbidden()` de `next/navigation` (sentinel Next 403)
//   - NE throw PAS `ForbiddenError` au caller (c'est `forbidden()` qui
//     throw son propre sentinel, intercepté en amont par Next)
//   - NE journalise AUCUNE erreur applicative via `logger.error`
//     (le `logger.warn` interne de `requireRole` reste autorisé — c'est
//     une sentinelle de config, pas une erreur runtime).
//
// Mutation (voir dernier test) : si on retire le try/catch de
// `requireRoleOrForbidden` et qu'on laisse `requireRole` throw tel
// quel, le test "forbidden() appelé" tombe.

const navMock = vi.hoisted(() => ({ forbidden: vi.fn() }));
vi.mock("next/navigation", () => ({
  forbidden: navMock.forbidden,
}));

describe("requireRoleOrForbidden — refus silent côté Next (PR2b-1)", () => {
  beforeEach(() => {
    navMock.forbidden.mockReset();
    navMock.forbidden.mockImplementation(() => {
      // Mimique le sentinel réel : throw un objet non-ForbiddenError
      // que Next intercepte en amont. Pas un `throw new ForbiddenError`.
      const sentinel = new Error("NEXT_FORBIDDEN_SENTINEL");
      (sentinel as unknown as { digest: string }).digest = "NEXT_FORBIDDEN";
      throw sentinel;
    });
  });

  it("sessionClaims invalides → `forbidden()` appelé, 0 appel à logger.error", async () => {
    const { requireRoleOrForbidden } = await import("./require-role");
    const { logger } = await import("@/lib/utils/logger");
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    mocks.auth.mockResolvedValue({
      userId: "user_no_role",
      sessionClaims: null,
    });

    await expect(requireRoleOrForbidden("commercial")).rejects.toMatchObject({
      digest: "NEXT_FORBIDDEN",
    });
    expect(navMock.forbidden).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("rôle insuffisant (commercial sur `admin`) → `forbidden()`, 0 logger.error", async () => {
    const { requireRoleOrForbidden } = await import("./require-role");
    const { logger } = await import("@/lib/utils/logger");
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    mocks.auth.mockResolvedValue({
      userId: "user_commercial",
      sessionClaims: {
        role: "commercial",
        firstName: "V",
        lastName: "R",
        slackUserId: "UVANESSA",
        testAccount: false,
      },
    });

    await expect(requireRoleOrForbidden("admin")).rejects.toMatchObject({
      digest: "NEXT_FORBIDDEN",
    });
    expect(navMock.forbidden).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("session absente → `UnauthorizedError` propagée (middleware Clerk doit catcher amont)", async () => {
    const { requireRoleOrForbidden } = await import("./require-role");
    mocks.auth.mockResolvedValue({ userId: null, sessionClaims: null });

    await expect(requireRoleOrForbidden("commercial")).rejects.toMatchObject({
      name: "UnauthorizedError",
    });
    expect(navMock.forbidden).not.toHaveBeenCalled();
  });

  it("happy path (admin sur commercial) → retourne RoleContext, 0 appel forbidden()", async () => {
    const { requireRoleOrForbidden } = await import("./require-role");
    mocks.auth.mockResolvedValue({
      userId: "user_admin",
      sessionClaims: {
        role: "admin",
        firstName: "Déthié",
        lastName: "Faye",
        slackUserId: "U05UVHGBURX",
        testAccount: false,
      },
    });
    const ctx = await requireRoleOrForbidden("commercial");
    expect(ctx.role).toBe("admin");
    expect(ctx.userId).toBe("user_admin");
    expect(navMock.forbidden).not.toHaveBeenCalled();
  });

  it("MUTATION : si on retire le try/catch, ForbiddenError remonte au caller (Next log applicatif)", async () => {
    // Simule la mutation (code AVANT PR2b-1 round 3) : on appelle
    // directement `requireRole`. L'exception `ForbiddenError` remonte
    // AU CALLER, donc à Next qui la log comme erreur applicative
    // (observé sur preview a86724a — `Error: requireRole: invalid
    // sessionClaims ...` dans les logs Vercel).
    const { requireRole } = await import("./require-role");
    const { ForbiddenError } = await import("@/lib/utils/errors");
    mocks.auth.mockResolvedValue({
      userId: "user_no_role",
      sessionClaims: null,
    });
    await expect(requireRole("commercial")).rejects.toBeInstanceOf(ForbiddenError);
    // `forbidden()` n'est PAS appelé → c'est exactement le bug qu'on
    // corrige. La preuve inverse : `requireRoleOrForbidden` ci-dessus
    // appelle bien `forbidden()`.
    expect(navMock.forbidden).not.toHaveBeenCalled();
  });
});
