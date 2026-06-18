/**
 * Tests `client.ts` — pattern miroir OVH client.test.ts.
 *
 * Couverture : memoize, ConfigError sur env manquante, back-door tests,
 * garde NODE_ENV, sentinelle constantes verrouillées.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetEnvCacheForTests } from "@/lib/security/env";
import { ConfigError } from "@/lib/utils/errors";

import {
  __setHubspotClientForTests,
  getHubspotClient,
  HUBSPOT_API_RETRIES,
  type HubspotClient,
} from "./client";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes nommées — aucun credential réel
// ─────────────────────────────────────────────────────────────────────────────

const TEST_HUBSPOT_ACCESS_TOKEN = "pat-eu1-fake-test-token-not-real";

function stubHubspotEnv(): void {
  vi.stubEnv("HUBSPOT_ACCESS_TOKEN", TEST_HUBSPOT_ACCESS_TOKEN);
}

beforeEach(() => {
  __setHubspotClientForTests(null);
  __resetEnvCacheForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────
// getHubspotClient
// ─────────────────────────────────────────────────────────────────────────────

describe("getHubspotClient", () => {
  it("construit le client au premier appel quand l'env est valide", () => {
    stubHubspotEnv();
    const c = getHubspotClient();
    expect(c).toBeDefined();
    expect(c.crm).toBeDefined();
    expect(c.crm.lists).toBeDefined();
    expect(c.crm.contacts).toBeDefined();
  });

  it("memoize : deux appels successifs retournent la même instance", () => {
    stubHubspotEnv();
    const c1 = getHubspotClient();
    const c2 = getHubspotClient();
    expect(c1).toBe(c2);
  });

  it("throw ConfigError quand HUBSPOT_ACCESS_TOKEN manquante", () => {
    // Pas de stub → env vide → getHubspotEnv throw ConfigError.
    expect(() => getHubspotClient()).toThrow(ConfigError);
  });

  it("throw ConfigError quand HUBSPOT_ACCESS_TOKEN ne match pas pat-*", () => {
    vi.stubEnv("HUBSPOT_ACCESS_TOKEN", "Bearer-invalid-prefix");
    expect(() => getHubspotClient()).toThrow(ConfigError);
  });

  it("ConfigError ne fuite PAS la valeur du token dans message/context", () => {
    const SECRET = "pat-eu1-VERY-SECRET-VALUE-DO-NOT-LOG-123";
    vi.stubEnv("HUBSPOT_ACCESS_TOKEN", "wrong-prefix");
    try {
      getHubspotClient();
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const serialized = JSON.stringify({
        message: (e as Error).message,
        context: (e as { context?: unknown }).context,
      });
      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain("wrong-prefix");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// __setHubspotClientForTests — back-door
// ─────────────────────────────────────────────────────────────────────────────

describe("__setHubspotClientForTests", () => {
  it("injecte un client fake utilisable comme HubspotClient", () => {
    const fake: HubspotClient = {
      crm: {
        lists: {
          listsApi: { getAll: vi.fn() },
          membershipsApi: { getPage: vi.fn() },
        },
        contacts: {
          basicApi: { getById: vi.fn() },
          batchApi: { read: vi.fn() },
        },
      },
    };
    __setHubspotClientForTests(fake);
    expect(getHubspotClient()).toBe(fake);
  });

  it("passer null force la re-résolution via getHubspotEnv au prochain appel", () => {
    const fake = {
      crm: {
        lists: {
          listsApi: { getAll: vi.fn() },
          membershipsApi: { getPage: vi.fn() },
        },
        contacts: {
          basicApi: { getById: vi.fn() },
          batchApi: { read: vi.fn() },
        },
      },
    } as unknown as HubspotClient;
    __setHubspotClientForTests(fake);
    expect(getHubspotClient()).toBe(fake);

    __setHubspotClientForTests(null);
    stubHubspotEnv();
    const real = getHubspotClient();
    expect(real).not.toBe(fake);
    expect(real.crm).toBeDefined();
  });

  it("garde runtime : throw si appelé hors NODE_ENV='test'", () => {
    const originalEnv = process.env.NODE_ENV;
    try {
      // @ts-expect-error - mutation NODE_ENV en runtime pour test garde
      process.env.NODE_ENV = "production";
      expect(() => __setHubspotClientForTests(null)).toThrow(
        /__setHubspotClientForTests called outside of tests/,
      );
    } finally {
      // @ts-expect-error - restore NODE_ENV
      process.env.NODE_ENV = originalEnv;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sentinelles constantes verrouillées
// ─────────────────────────────────────────────────────────────────────────────

describe("Sentinelles HUBSPOT_API_RETRIES", () => {
  it("HUBSPOT_API_RETRIES = 3 (verrouillé)", () => {
    expect(HUBSPOT_API_RETRIES).toBe(3);
  });
});
