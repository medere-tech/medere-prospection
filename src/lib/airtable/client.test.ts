/**
 * Tests `client.ts` — fetch Airtable bas niveau + retry + timeout + auth.
 *
 * Pattern : `__setAirtableTransportForTests({ fetch, sleep })` injecte un
 * fake `fetch` (vi.fn qui retourne des Response mockées) et un `sleep`
 * no-op (skip les 100ms/500ms/2s/5s de backoff → tests instantanés).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetEnvCacheForTests } from "@/lib/security/env";
import { ConfigError, ExternalServiceError } from "@/lib/utils/errors";

import { __setAirtableTransportForTests, fetchAirtableRecords } from "./client";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers types — vi.fn typé pour introspection .mock.calls[i][j]
// ─────────────────────────────────────────────────────────────────────────────

type FetchFn = typeof globalThis.fetch;
type SleepFn = (ms: number) => Promise<void>;

// ─────────────────────────────────────────────────────────────────────────────
// Constantes test — aucun credential réel
// ─────────────────────────────────────────────────────────────────────────────

const TEST_PAT = "patTESTFAKE.abcdef0123456789xyz";
const TEST_BASE = "appTestBase123";
const TEST_TABLE = "tblTestTable456";

function stubAirtableEnv(): void {
  vi.stubEnv("AIRTABLE_PAT", TEST_PAT);
  vi.stubEnv("AIRTABLE_BASE_ID", TEST_BASE);
  vi.stubEnv("AIRTABLE_COMMERCIAUX_TABLE_ID", TEST_TABLE);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, body = "boom"): Response {
  return new Response(body, { status });
}

const noopSleep = vi.fn<SleepFn>(async () => {});

beforeEach(() => {
  __resetEnvCacheForTests();
  __setAirtableTransportForTests({ sleep: noopSleep });
  noopSleep.mockClear();
});

afterEach(() => {
  // Ordre critique : restaurer NODE_ENV AVANT le reset du transport — le
  // back-door `__setAirtableTransportForTests` a une garde `NODE_ENV === "test"`
  // qui throw si un test précédent a stub NODE_ENV="production" (cf. le test
  // "garde NODE_ENV" ci-dessous).
  vi.unstubAllEnvs();
  __setAirtableTransportForTests(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path — single page + pagination
// ─────────────────────────────────────────────────────────────────────────────

describe("fetchAirtableRecords — happy path", () => {
  it("retourne les records sur une page unique (pas d'offset)", async () => {
    stubAirtableEnv();
    const mockFetch = vi.fn<FetchFn>(async () =>
      jsonResponse({
        records: [{ id: "rec1", createdTime: "2026-01-01T00:00:00Z", fields: { name: "Alice" } }],
      }),
    );
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    const records = await fetchAirtableRecords(TEST_TABLE, ["name"]);
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe("rec1");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("suit la pagination via offset et concatène les pages", async () => {
    stubAirtableEnv();
    const mockFetch = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(
        jsonResponse({
          records: [{ id: "rec1", createdTime: "t", fields: {} }],
          offset: "cursor-page-2",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          records: [{ id: "rec2", createdTime: "t", fields: {} }],
        }),
      );
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    const records = await fetchAirtableRecords(TEST_TABLE, ["name"]);
    expect(records.map((r) => r.id)).toEqual(["rec1", "rec2"]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // 2ᵉ appel : URL contient bien l'offset
    const secondCallUrl = mockFetch.mock.calls[1]?.[0] as string;
    expect(secondCallUrl).toContain("offset=cursor-page-2");
  });

  it("construit l'URL avec fields[] répétés (data minimization)", async () => {
    stubAirtableEnv();
    const mockFetch = vi.fn<FetchFn>(async () => jsonResponse({ records: [] }));
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    await fetchAirtableRecords(TEST_TABLE, ["a", "b", "c"]);
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain("fields%5B%5D=a");
    expect(url).toContain("fields%5B%5D=b");
    expect(url).toContain("fields%5B%5D=c");
  });

  it("envoie l'Authorization Bearer PAT et Accept JSON", async () => {
    stubAirtableEnv();
    const mockFetch = vi.fn<FetchFn>(async () => jsonResponse({ records: [] }));
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    await fetchAirtableRecords(TEST_TABLE, ["name"]);
    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TEST_PAT}`);
    expect(headers.Accept).toBe("application/json");
    expect(init.method).toBe("GET");
    // AbortSignal.timeout est bien attaché
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Retry — transient errors (429 / 5xx / network)
// ─────────────────────────────────────────────────────────────────────────────

describe("fetchAirtableRecords — retry (transient)", () => {
  it("retry sur 500 (2 échecs puis succès) → 3 fetch calls", async () => {
    stubAirtableEnv();
    const mockFetch = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(errorResponse(500))
      .mockResolvedValueOnce(errorResponse(500))
      .mockResolvedValueOnce(jsonResponse({ records: [] }));
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    const records = await fetchAirtableRecords(TEST_TABLE, ["name"]);
    expect(records).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    // 2 échecs → 2 sleeps intercalés (avant tentatives #2 et #3)
    expect(noopSleep).toHaveBeenCalledTimes(2);
  });

  it("retry sur 429 (rate limit)", async () => {
    stubAirtableEnv();
    const mockFetch = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(errorResponse(429))
      .mockResolvedValueOnce(jsonResponse({ records: [] }));
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    await fetchAirtableRecords(TEST_TABLE, ["name"]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retry sur erreur network (fetch throw TypeError)", async () => {
    stubAirtableEnv();
    const mockFetch = vi
      .fn<FetchFn>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse({ records: [] }));
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    await fetchAirtableRecords(TEST_TABLE, ["name"]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("propage ExternalServiceError après 4 tentatives 500 (retries épuisés)", async () => {
    stubAirtableEnv();
    const mockFetch = vi.fn<FetchFn>(async () => errorResponse(503, "backend down"));
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    await expect(fetchAirtableRecords(TEST_TABLE, ["name"])).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
    expect(mockFetch).toHaveBeenCalledTimes(4);
    // 3 sleeps intercalés (avant #2, #3, #4). Pas de sleep avant la 1ère.
    expect(noopSleep).toHaveBeenCalledTimes(3);
  });

  it("respecte le backoff exponentiel : sleeps de 500ms, 2000ms, 5000ms", async () => {
    stubAirtableEnv();
    const mockFetch = vi.fn<FetchFn>(async () => errorResponse(500));
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    await expect(fetchAirtableRecords(TEST_TABLE, ["name"])).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
    // RETRY_DELAYS_MS[1..3] = [500, 2000, 5000] (indice 0 = pré-tentative-1
    // n'est jamais utilisé côté sleep — la 1ère tentative part sans wait).
    const sleepArgs = noopSleep.mock.calls.map((c) => c[0]);
    expect(sleepArgs).toEqual([500, 2000, 5000]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// No-retry — deterministic errors (401 / 403 / 404 / autres 4xx)
// ─────────────────────────────────────────────────────────────────────────────

describe("fetchAirtableRecords — no-retry (deterministic)", () => {
  it("401 → throw immédiat SANS retry", async () => {
    stubAirtableEnv();
    const mockFetch = vi.fn<FetchFn>(async () => errorResponse(401, "AUTHENTICATION_REQUIRED"));
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    await expect(fetchAirtableRecords(TEST_TABLE, ["name"])).rejects.toMatchObject({
      code: "EXTERNAL_SERVICE",
      context: { status: 401 },
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(noopSleep).not.toHaveBeenCalled();
  });

  it("403 → throw immédiat SANS retry", async () => {
    stubAirtableEnv();
    const mockFetch = vi.fn<FetchFn>(async () => errorResponse(403, "FORBIDDEN"));
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    await expect(fetchAirtableRecords(TEST_TABLE, ["name"])).rejects.toMatchObject({
      context: { status: 403 },
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("404 → throw immédiat SANS retry", async () => {
    stubAirtableEnv();
    const mockFetch = vi.fn<FetchFn>(async () => errorResponse(404, "NOT_FOUND"));
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    await expect(fetchAirtableRecords(TEST_TABLE, ["name"])).rejects.toMatchObject({
      context: { status: 404 },
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("400 (bad request) → throw immédiat SANS retry", async () => {
    stubAirtableEnv();
    const mockFetch = vi.fn<FetchFn>(async () => errorResponse(400, "INVALID_REQUEST"));
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    await expect(fetchAirtableRecords(TEST_TABLE, ["name"])).rejects.toMatchObject({
      context: { status: 400 },
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sécurité : PAT jamais loggé, body tronqué
// ─────────────────────────────────────────────────────────────────────────────

describe("fetchAirtableRecords — sécurité", () => {
  it("le PAT n'apparaît JAMAIS dans le message ou le context de l'erreur", async () => {
    stubAirtableEnv();
    const mockFetch = vi.fn<FetchFn>(async () => errorResponse(401, "AUTHENTICATION_REQUIRED"));
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    try {
      await fetchAirtableRecords(TEST_TABLE, ["name"]);
      expect.fail("should have thrown");
    } catch (e) {
      const err = e as ExternalServiceError;
      // Serialize toute l'erreur (message + context + cause + own enumerable)
      const serialized = JSON.stringify({
        message: err.message,
        context: err.context,
        cause: err.cause,
        ...(err as object),
      });
      expect(serialized).not.toContain(TEST_PAT);
    }
  });

  it("le body d'erreur est tronqué à 200 chars (protection log spam)", async () => {
    stubAirtableEnv();
    const hugeBody = "X".repeat(1000);
    const mockFetch = vi.fn<FetchFn>(async () => errorResponse(401, hugeBody));
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    try {
      await fetchAirtableRecords(TEST_TABLE, ["name"]);
      expect.fail("should have thrown");
    } catch (e) {
      const err = e as ExternalServiceError;
      const body = err.context?.body as string;
      expect(body.length).toBeLessThanOrEqual(200 + "…[truncated]".length);
      expect(body).toContain("[truncated]");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Erreurs de config (env manquante)
// ─────────────────────────────────────────────────────────────────────────────

describe("fetchAirtableRecords — env manquante", () => {
  it("propage ConfigError si AIRTABLE_PAT manque", async () => {
    // Env volontairement pas stubbée (PR1 exige les 3 vars).
    vi.stubEnv("AIRTABLE_PAT", undefined as unknown as string);
    vi.stubEnv("AIRTABLE_BASE_ID", TEST_BASE);
    vi.stubEnv("AIRTABLE_COMMERCIAUX_TABLE_ID", TEST_TABLE);

    // Le fetch ne doit même pas être appelé.
    const mockFetch = vi.fn<FetchFn>();
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    await expect(fetchAirtableRecords(TEST_TABLE, ["name"])).rejects.toBeInstanceOf(ConfigError);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Back-door : garde NODE_ENV
// ─────────────────────────────────────────────────────────────────────────────

describe("__setAirtableTransportForTests — garde NODE_ENV", () => {
  it("throw si appelé hors NODE_ENV=test", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => __setAirtableTransportForTests(null)).toThrow(/outside of tests/);
  });
});
