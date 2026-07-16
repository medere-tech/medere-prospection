/**
 * Tests `commerciaux.ts` — resolve owner HubSpot → Commercial + cache TTL.
 *
 * Pattern : mock `fetch` via `__setAirtableTransportForTests` (transport
 * du client). Fake timers vitest pour tester le cache TTL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetEnvCacheForTests } from "@/lib/security/env";
import { ExternalServiceError } from "@/lib/utils/errors";

import { __setAirtableTransportForTests } from "./client";
import { clearCommerciauxCache, firstOrString, resolveCommercialByOwnerId } from "./commerciaux";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes test
// ─────────────────────────────────────────────────────────────────────────────

const TEST_PAT = "patTESTFAKE.abcdef0123456789xyz";
const TEST_BASE = "appTestBase123";
const TEST_TABLE = "tblTestCommerciaux";

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

/**
 * Helper : construit un record Airtable minimal avec les fields de la
 * table Commerciaux. Chaque champ est optionnel pour tester les combos.
 */
function commercialRecord(
  id: string,
  fields: {
    hubspot_id?: unknown;
    slack_user_id?: unknown;
    Statut?: unknown;
    hubspot_name?: unknown;
  },
) {
  return { id, createdTime: "2026-01-01T00:00:00Z", fields };
}

const noopSleep = vi.fn(async () => {});

beforeEach(() => {
  __resetEnvCacheForTests();
  __setAirtableTransportForTests({ sleep: noopSleep });
  clearCommerciauxCache();
});

afterEach(() => {
  // Ordre critique : unstub des env AVANT reset du transport — le back-door
  // `__setAirtableTransportForTests` a une garde `NODE_ENV === "test"` qui
  // throw si un test a stub NODE_ENV="production" (cf. test
  // "clearCommerciauxCache refuse hors NODE_ENV=test").
  vi.unstubAllEnvs();
  __setAirtableTransportForTests(null);
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// firstOrString helper
// ─────────────────────────────────────────────────────────────────────────────

describe("firstOrString", () => {
  it("string → renvoie tel quel", () => {
    expect(firstOrString("U05")).toBe("U05");
  });

  it("array [string, ...] → renvoie le 1er élément", () => {
    expect(firstOrString(["U05", "U06"])).toBe("U05");
  });

  it("array vide → undefined", () => {
    expect(firstOrString([])).toBeUndefined();
  });

  it("array [nonString] → undefined", () => {
    expect(firstOrString([123])).toBeUndefined();
  });

  it("null / undefined / number → undefined", () => {
    expect(firstOrString(null)).toBeUndefined();
    expect(firstOrString(undefined)).toBeUndefined();
    expect(firstOrString(42)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveCommercialByOwnerId — cas nominaux
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveCommercialByOwnerId — cas nominaux", () => {
  it("owner présent + Statut=Actif → { slackUserId, name, active:true }", async () => {
    stubAirtableEnv();
    const mockFetch = vi.fn(async () =>
      jsonResponse({
        records: [
          commercialRecord("rec1", {
            hubspot_id: "477507801",
            slack_user_id: "U05VANESSA",
            Statut: "Actif",
            hubspot_name: "Vanessa Rabba",
          }),
        ],
      }),
    );
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    const c = await resolveCommercialByOwnerId("477507801");
    expect(c).toEqual({
      slackUserId: "U05VANESSA",
      name: "Vanessa Rabba",
      active: true,
    });
  });

  it("owner présent + Statut=Inactif → active:false (PAS null — module rapporte l'état)", async () => {
    stubAirtableEnv();
    const mockFetch = vi.fn(async () =>
      jsonResponse({
        records: [
          commercialRecord("rec1", {
            hubspot_id: "477507801",
            slack_user_id: "U05VANESSA",
            Statut: "Inactif",
            hubspot_name: "Vanessa Rabba",
          }),
        ],
      }),
    );
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    const c = await resolveCommercialByOwnerId("477507801");
    expect(c).not.toBeNull();
    expect(c?.active).toBe(false);
    expect(c?.slackUserId).toBe("U05VANESSA"); // rapporté même si inactif
  });

  it("Statut casse mixte 'ACTIF' → active:true (case-insensitive après trim)", async () => {
    stubAirtableEnv();
    const mockFetch = vi.fn(async () =>
      jsonResponse({
        records: [
          commercialRecord("rec1", {
            hubspot_id: "1",
            slack_user_id: "U05",
            Statut: "  ACTIF ",
            hubspot_name: "X",
          }),
        ],
      }),
    );
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    const c = await resolveCommercialByOwnerId("1");
    expect(c?.active).toBe(true);
  });

  it("Statut vide OU absent → active:false (défaut sûr)", async () => {
    stubAirtableEnv();
    const mockFetch = vi.fn(async () =>
      jsonResponse({
        records: [
          commercialRecord("rec1", {
            hubspot_id: "1",
            slack_user_id: "U05",
            hubspot_name: "X",
            // Statut omis
          }),
          commercialRecord("rec2", {
            hubspot_id: "2",
            slack_user_id: "U06",
            Statut: "",
            hubspot_name: "Y",
          }),
        ],
      }),
    );
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    expect((await resolveCommercialByOwnerId("1"))?.active).toBe(false);
    expect((await resolveCommercialByOwnerId("2"))?.active).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveCommercialByOwnerId — retours null
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveCommercialByOwnerId — null", () => {
  it("owner absent de la table → null", async () => {
    stubAirtableEnv();
    const mockFetch = vi.fn(async () =>
      jsonResponse({
        records: [
          commercialRecord("rec1", {
            hubspot_id: "111",
            slack_user_id: "U05",
            Statut: "Actif",
            hubspot_name: "X",
          }),
        ],
      }),
    );
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    const c = await resolveCommercialByOwnerId("999-unknown-owner");
    expect(c).toBeNull();
  });

  it("owner présent mais slack_user_id vide → null (impossible à DM)", async () => {
    stubAirtableEnv();
    const mockFetch = vi.fn(async () =>
      jsonResponse({
        records: [
          commercialRecord("rec1", {
            hubspot_id: "477507801",
            slack_user_id: "",
            Statut: "Actif",
            hubspot_name: "X",
          }),
        ],
      }),
    );
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    expect(await resolveCommercialByOwnerId("477507801")).toBeNull();
  });

  it("owner présent mais slack_user_id absent → null", async () => {
    stubAirtableEnv();
    const mockFetch = vi.fn(async () =>
      jsonResponse({
        records: [
          commercialRecord("rec1", {
            hubspot_id: "477507801",
            Statut: "Actif",
            hubspot_name: "X",
            // slack_user_id omis
          }),
        ],
      }),
    );
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    expect(await resolveCommercialByOwnerId("477507801")).toBeNull();
  });

  it("ownerId vide ou whitespace → null (court-circuit, aucun fetch)", async () => {
    stubAirtableEnv();
    const mockFetch = vi.fn(async () => jsonResponse({ records: [] }));
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    expect(await resolveCommercialByOwnerId("")).toBeNull();
    expect(await resolveCommercialByOwnerId("   ")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation cross-format (piège hubspot_id String vs Number)
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveCommercialByOwnerId — normalisation", () => {
  it("hubspot_id renvoyé en Number par Airtable → matche l'ownerId string", async () => {
    stubAirtableEnv();
    const mockFetch = vi.fn(async () =>
      jsonResponse({
        records: [
          commercialRecord("rec1", {
            hubspot_id: 477507801, // NOMBRE (pas string)
            slack_user_id: "U05VANESSA",
            Statut: "Actif",
            hubspot_name: "Vanessa",
          }),
        ],
      }),
    );
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    // ownerId côté HubSpot arrive typiquement en string
    const c = await resolveCommercialByOwnerId("477507801");
    expect(c?.slackUserId).toBe("U05VANESSA");
  });

  it("hubspot_id avec espaces autour → matche après trim", async () => {
    stubAirtableEnv();
    const mockFetch = vi.fn(async () =>
      jsonResponse({
        records: [
          commercialRecord("rec1", {
            hubspot_id: "  477507801  ",
            slack_user_id: "U05",
            Statut: "Actif",
            hubspot_name: "X",
          }),
        ],
      }),
    );
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    expect(await resolveCommercialByOwnerId("477507801")).not.toBeNull();
  });

  it("slack_user_id renvoyé en array [U05...] → firstOrString extrait la valeur", async () => {
    stubAirtableEnv();
    const mockFetch = vi.fn(async () =>
      jsonResponse({
        records: [
          commercialRecord("rec1", {
            hubspot_id: "1",
            slack_user_id: ["U05VANESSA"], // ARRAY (linked-record)
            Statut: "Actif",
            hubspot_name: "Vanessa",
          }),
        ],
      }),
    );
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    const c = await resolveCommercialByOwnerId("1");
    expect(c?.slackUserId).toBe("U05VANESSA");
  });

  it('hubspot_name en array ["Vanessa"] → firstOrString extrait', async () => {
    stubAirtableEnv();
    const mockFetch = vi.fn(async () =>
      jsonResponse({
        records: [
          commercialRecord("rec1", {
            hubspot_id: "1",
            slack_user_id: "U05",
            Statut: "Actif",
            hubspot_name: ["Vanessa Rabba"],
          }),
        ],
      }),
    );
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    expect((await resolveCommercialByOwnerId("1"))?.name).toBe("Vanessa Rabba");
  });

  it("ligne sans hubspot_id → skip silencieusement (n'écrase pas la Map)", async () => {
    stubAirtableEnv();
    const mockFetch = vi.fn(async () =>
      jsonResponse({
        records: [
          commercialRecord("rec1", {
            hubspot_id: "",
            slack_user_id: "U05",
            Statut: "Actif",
            hubspot_name: "Orphelin",
          }),
          commercialRecord("rec2", {
            hubspot_id: "477507801",
            slack_user_id: "U06",
            Statut: "Actif",
            hubspot_name: "Valide",
          }),
        ],
      }),
    );
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    // La ligne sans hubspot_id n'écrase pas ; la ligne valide est résolvable.
    expect((await resolveCommercialByOwnerId("477507801"))?.slackUserId).toBe("U06");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cache TTL 5 min
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveCommercialByOwnerId — cache TTL", () => {
  it("2 appels rapprochés → 1 seul fetch (cache hit)", async () => {
    stubAirtableEnv();
    const mockFetch = vi.fn(async () =>
      jsonResponse({
        records: [
          commercialRecord("rec1", {
            hubspot_id: "1",
            slack_user_id: "U05",
            Statut: "Actif",
            hubspot_name: "X",
          }),
        ],
      }),
    );
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    await resolveCommercialByOwnerId("1");
    await resolveCommercialByOwnerId("1");
    await resolveCommercialByOwnerId("2"); // même cache, owner absent → null
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("après TTL (5min + 1s) → re-fetch complet", async () => {
    stubAirtableEnv();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T10:00:00Z"));

    const mockFetch = vi.fn(async () =>
      jsonResponse({
        records: [
          commercialRecord("rec1", {
            hubspot_id: "1",
            slack_user_id: "U05",
            Statut: "Actif",
            hubspot_name: "X",
          }),
        ],
      }),
    );
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    await resolveCommercialByOwnerId("1");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Avance 5min + 1s → cache expiré
    vi.setSystemTime(new Date("2026-01-01T10:05:01Z"));

    await resolveCommercialByOwnerId("1");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("clearCommerciauxCache() force le re-fetch immédiat", async () => {
    stubAirtableEnv();
    const mockFetch = vi.fn(async () =>
      jsonResponse({
        records: [
          commercialRecord("rec1", {
            hubspot_id: "1",
            slack_user_id: "U05",
            Statut: "Actif",
            hubspot_name: "X",
          }),
        ],
      }),
    );
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    await resolveCommercialByOwnerId("1");
    clearCommerciauxCache();
    await resolveCommercialByOwnerId("1");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("clearCommerciauxCache refuse hors NODE_ENV=test", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => clearCommerciauxCache()).toThrow(/outside of tests/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Propagation d'erreur (Airtable down après retries)
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveCommercialByOwnerId — erreur propagée", () => {
  it("ExternalServiceError du client remonte au caller (pas de swallow)", async () => {
    stubAirtableEnv();
    const mockFetch = vi.fn(async () => new Response("boom", { status: 503 }));
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    await expect(resolveCommercialByOwnerId("477507801")).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
  });

  it("après une erreur, le cache reste vide → le prochain appel re-tente le fetch", async () => {
    stubAirtableEnv();
    const mockFetch = vi
      .fn()
      // 4 échecs → épuise les retries → throw ExternalServiceError
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      // Succès sur le 5e appel (nouveau cycle de retries)
      .mockResolvedValueOnce(
        jsonResponse({
          records: [
            commercialRecord("rec1", {
              hubspot_id: "1",
              slack_user_id: "U05",
              Statut: "Actif",
              hubspot_name: "X",
            }),
          ],
        }),
      );
    __setAirtableTransportForTests({ fetch: mockFetch, sleep: noopSleep });

    await expect(resolveCommercialByOwnerId("1")).rejects.toBeInstanceOf(ExternalServiceError);
    // Nouveau cycle : cache vide → re-tente
    const c = await resolveCommercialByOwnerId("1");
    expect(c?.slackUserId).toBe("U05");
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });
});
