import { beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks partagés (vi.hoisted pour pouvoir les référencer depuis les factories
// vi.mock qui sont elles-mêmes hoistées au-dessus des imports).
// ─────────────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  limit: vi.fn(),
  slidingWindow: vi.fn(() => "sliding-window-spec"),
  // Spies invoquées par les constructeurs des classes mockées pour suivre
  // les appels. Pas appelées avec `new` directement (le `new` se fait sur
  // la classe ci-dessous, qui délègue ici la trace).
  RatelimitCtor: vi.fn(),
  RedisCtor: vi.fn(),
  getUpstashEnv: vi.fn(() => ({
    UPSTASH_REDIS_REST_URL: "https://fake.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "fake-token",
  })),
}));

// IMPORTANT : `new vi.fn(() => obj)()` ne fonctionne pas de manière fiable
// en vitest 4 (warning "did not use 'function' or 'class' in implementation").
// On déclare donc une VRAIE classe dans chaque factory et on délègue le
// tracking à une spy vi.fn interne.
vi.mock("@upstash/ratelimit", () => {
  class Ratelimit {
    static slidingWindow = mocks.slidingWindow;
    limit = mocks.limit;
    constructor(opts: unknown) {
      mocks.RatelimitCtor(opts);
    }
  }
  return { Ratelimit };
});

vi.mock("@upstash/redis", () => {
  class Redis {
    kind = "fake-redis";
    constructor(opts: unknown) {
      mocks.RedisCtor(opts);
    }
  }
  return { Redis };
});

vi.mock("./env", () => ({
  getUpstashEnv: mocks.getUpstashEnv,
}));

// Imports APRÈS les vi.mock (le hoister Vitest s'en occupe correctement,
// mais on garde l'ordre lisible).
import type { Redis } from "@upstash/redis";

import { createRateLimiter, type RateLimitWindow } from "./rate-limit";

beforeEach(() => {
  mocks.limit.mockReset();
  mocks.slidingWindow.mockClear();
  mocks.RatelimitCtor.mockClear();
  mocks.RedisCtor.mockClear();
  mocks.getUpstashEnv.mockClear();
  // Défaut : succès. Les tests qui veulent un échec / refus override par mockResolvedValueOnce.
  mocks.limit.mockResolvedValue({
    success: true,
    limit: 10,
    remaining: 9,
    reset: 1_780_000_000_000,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Chemin normal : Upstash répond
// ─────────────────────────────────────────────────────────────────────────────

describe("createRateLimiter — chemin normal (Upstash répond)", () => {
  it("autorisation : success true + reason 'allowed' + mapping des champs", async () => {
    const rl = createRateLimiter({ limit: 10, window: "1 m", prefix: "t" });
    const result = await rl.check("user-1");
    expect(result).toEqual({
      success: true,
      limit: 10,
      remaining: 9,
      resetAt: 1_780_000_000_000,
      reason: "allowed",
    });
  });

  it("refus rate-limit : success false + reason 'rate_limited'", async () => {
    mocks.limit.mockResolvedValueOnce({
      success: false,
      limit: 10,
      remaining: 0,
      reset: 1_780_000_000_000,
    });
    const rl = createRateLimiter({ limit: 10, window: "1 m", prefix: "t" });
    const result = await rl.check("user-1");
    expect(result.success).toBe(false);
    expect(result.reason).toBe("rate_limited");
    expect(result.remaining).toBe(0);
  });

  it("transmet l'identifier à Ratelimit.limit()", async () => {
    const rl = createRateLimiter({ limit: 10, window: "1 m", prefix: "t" });
    await rl.check("user-42");
    expect(mocks.limit).toHaveBeenCalledWith("user-42");
  });

  it("construit Ratelimit avec prefix, slidingWindow(limit, window) et redis", async () => {
    const rl = createRateLimiter({ limit: 7, window: "30 s", prefix: "pf" });
    await rl.check("u");
    expect(mocks.slidingWindow).toHaveBeenCalledWith(7, "30 s");
    expect(mocks.RatelimitCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        prefix: "pf",
        limiter: "sliding-window-spec",
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Paresse et cache
// ─────────────────────────────────────────────────────────────────────────────

describe("createRateLimiter — paresse et cache", () => {
  it("ne lit pas l'env tant que check() n'est pas appelé", () => {
    createRateLimiter({ limit: 10, window: "1 m", prefix: "t" });
    expect(mocks.getUpstashEnv).not.toHaveBeenCalled();
    expect(mocks.RatelimitCtor).not.toHaveBeenCalled();
    expect(mocks.RedisCtor).not.toHaveBeenCalled();
  });

  it("instancie Ratelimit UNE seule fois pour plusieurs check()", async () => {
    const rl = createRateLimiter({ limit: 10, window: "1 m", prefix: "t" });
    await rl.check("u1");
    await rl.check("u2");
    await rl.check("u3");
    expect(mocks.RatelimitCtor).toHaveBeenCalledTimes(1);
    expect(mocks.limit).toHaveBeenCalledTimes(3);
  });

  it("avec redis injecté : getUpstashEnv + Redis ctor ne sont PAS appelés", async () => {
    const fakeRedis = { kind: "injected" } as unknown as Redis;
    const rl = createRateLimiter({ limit: 10, window: "1 m", prefix: "t" }, fakeRedis);
    await rl.check("u");
    expect(mocks.getUpstashEnv).not.toHaveBeenCalled();
    expect(mocks.RedisCtor).not.toHaveBeenCalled();
    // Le client injecté est bien transmis à Ratelimit.
    expect(mocks.RatelimitCtor).toHaveBeenCalledWith(expect.objectContaining({ redis: fakeRedis }));
  });

  it("sans redis injecté : getUpstashEnv + Redis ctor sont appelés avec l'env", async () => {
    const rl = createRateLimiter({ limit: 10, window: "1 m", prefix: "t" });
    await rl.check("u");
    expect(mocks.getUpstashEnv).toHaveBeenCalledTimes(1);
    expect(mocks.RedisCtor).toHaveBeenCalledWith({
      url: "https://fake.upstash.io",
      token: "fake-token",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// failureMode — comportement en cas de panne Upstash
// ─────────────────────────────────────────────────────────────────────────────

describe("createRateLimiter — failureMode (panne Upstash)", () => {
  beforeEach(() => {
    mocks.limit.mockRejectedValue(new Error("upstash unreachable"));
  });

  it("DÉFAUT (fail-closed) : Upstash down → success false + reason 'rate_limiter_unavailable'", async () => {
    const rl = createRateLimiter({ limit: 10, window: "1 m", prefix: "x" });
    const result = await rl.check("u");
    expect(result.success).toBe(false);
    expect(result.reason).toBe("rate_limiter_unavailable");
    expect(result.remaining).toBe(0);
    expect(result.limit).toBe(10);
  });

  it("explicite 'closed' : même comportement que le défaut", async () => {
    const rl = createRateLimiter({
      limit: 10,
      window: "1 m",
      prefix: "x",
      failureMode: "closed",
    });
    const result = await rl.check("u");
    expect(result.success).toBe(false);
    expect(result.reason).toBe("rate_limiter_unavailable");
  });

  it("'open' : Upstash down → success true + reason 'rate_limiter_unavailable_failed_open'", async () => {
    const rl = createRateLimiter({
      limit: 10,
      window: "1 m",
      prefix: "x",
      failureMode: "open",
    });
    const result = await rl.check("u");
    expect(result.success).toBe(true);
    expect(result.reason).toBe("rate_limiter_unavailable_failed_open");
    expect(result.remaining).toBe(10);
  });

  it("ne throw JAMAIS sur panne — le caller log via le champ reason", async () => {
    const rl = createRateLimiter({ limit: 10, window: "1 m", prefix: "x" });
    await expect(rl.check("u")).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Typage du window (template literal) — vérif runtime triviale,
// la vraie garantie est au compile time (tsc strict).
// ─────────────────────────────────────────────────────────────────────────────

describe("createRateLimiter — typage RateLimitWindow", () => {
  it("accepte les 4 unités s/m/h/d", () => {
    const windows: RateLimitWindow[] = ["10 s", "1 m", "24 h", "7 d"];
    expect(windows).toHaveLength(4);
  });
});
