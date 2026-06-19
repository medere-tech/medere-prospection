/**
 * Tests `lists.ts` — mock HubspotClient, validation filter regex, edge cases.
 *
 * Couverture : happy path, searchQuery="" retourne tout, filter case-
 * insensitive, retour mal formé → throw, erreur SDK → wrapped
 * ExternalServiceError, warn log si > 200 matches, anti-ReDoS metachars,
 * pagination boucle hasMore, sentinelle anti-régression doSearch vs getAll
 * (S10.1.3-FIX-LISTS-DOSEARCH-001), defense-in-depth couche 2 regex code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExternalServiceError } from "@/lib/utils/errors";

import { __setHubspotClientForTests, type HubspotClient } from "./client";
import {
  DEFAULT_SMS_LIST_SEARCH_QUERY,
  HUBSPOT_LISTS_MAX_PAGES,
  HUBSPOT_LISTS_PAGE_SIZE,
  listSmsLists,
} from "./lists";

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock("@/lib/utils/logger", () => ({
  logger: {
    warn: mocks.warn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — fake client
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Construit un client fake avec `doSearch` mocké. `doSearchReturn` peut
 * être un objet `ListSearchResponse`-shaped OU une fonction qui reçoit le
 * request pour répondre dynamiquement (utile pour pagination multi-pages).
 */
function makeFakeClient(
  doSearchReturn: unknown | ((request: Record<string, unknown>) => unknown | Promise<unknown>),
): HubspotClient {
  const doSearch =
    typeof doSearchReturn === "function"
      ? vi.fn().mockImplementation(doSearchReturn as (req: Record<string, unknown>) => unknown)
      : vi.fn().mockResolvedValue(doSearchReturn);
  return {
    crm: {
      lists: {
        listsApi: {
          getAll: vi.fn(),
          doSearch,
        },
        membershipsApi: { getPage: vi.fn() },
      },
      contacts: {
        basicApi: { getById: vi.fn() },
        batchApi: { read: vi.fn() },
      },
    },
  };
}

function makeFakeClientWithError(err: Error): HubspotClient {
  return {
    crm: {
      lists: {
        listsApi: {
          getAll: vi.fn(),
          doSearch: vi.fn().mockRejectedValue(err),
        },
        membershipsApi: { getPage: vi.fn() },
      },
      contacts: {
        basicApi: { getById: vi.fn() },
        batchApi: { read: vi.fn() },
      },
    },
  };
}

/**
 * Construit une réponse `ListSearchResponse` complète à partir d'un
 * tableau de listes — wrap avec `hasMore: false`, `offset: 0`,
 * `total: lists.length` pour simuler une page unique.
 */
function singlePage(lists: unknown[]): {
  lists: unknown[];
  hasMore: boolean;
  offset: number;
  total: number;
} {
  return { lists, hasMore: false, offset: 0, total: lists.length };
}

beforeEach(() => {
  __setHubspotClientForTests(null);
  mocks.warn.mockReset();
});

afterEach(() => {
  __setHubspotClientForTests(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// listSmsLists — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("listSmsLists — happy path", () => {
  it("filtre par défaut 'SMS' retourne uniquement les listes matchantes", async () => {
    const client = makeFakeClient(
      singlePage([
        {
          listId: "1",
          name: "SMS Dentistes IDF",
          processingType: "MANUAL",
          additionalProperties: { size: "200" },
        },
        {
          listId: "2",
          name: "SMS Médecins PACA",
          processingType: "DYNAMIC",
          additionalProperties: { size: "50" },
        },
        { listId: "3", name: "Email Marketing", processingType: "DYNAMIC" },
        { listId: "4", name: "Newsletter", processingType: "MANUAL" },
      ]),
    );
    __setHubspotClientForTests(client);

    const res = await listSmsLists();
    expect(res).toHaveLength(2);
    expect(res.map((l) => l.listId)).toEqual(["1", "2"]);
    expect(res[0]!.name).toBe("SMS Dentistes IDF");
    expect(res[0]!.size).toBe(200);
  });

  it("filtre case-insensitive : 'sms' ou 'Sms' matchent 'SMS'", async () => {
    const client = makeFakeClient(
      singlePage([
        { listId: "1", name: "sms dentistes", processingType: "MANUAL" },
        { listId: "2", name: "Sms test", processingType: "DYNAMIC" },
      ]),
    );
    __setHubspotClientForTests(client);

    const res = await listSmsLists("SMS");
    expect(res).toHaveLength(2);
  });

  it("searchQuery custom : retourne uniquement les listes matchantes", async () => {
    const client = makeFakeClient(
      singlePage([
        { listId: "1", name: "SMS Dentistes IDF", processingType: "MANUAL" },
        { listId: "2", name: "SMS Médecins 2026", processingType: "DYNAMIC" },
        { listId: "3", name: "SMS Test 2025", processingType: "MANUAL" },
      ]),
    );
    __setHubspotClientForTests(client);

    const res = await listSmsLists("2026");
    expect(res).toHaveLength(1);
    expect(res[0]!.name).toBe("SMS Médecins 2026");
  });

  it("searchQuery vide → retourne TOUTES les listes", async () => {
    const client = makeFakeClient(
      singlePage([
        { listId: "1", name: "SMS Dentistes IDF", processingType: "MANUAL" },
        { listId: "2", name: "Email Marketing", processingType: "DYNAMIC" },
        { listId: "3", name: "Newsletter", processingType: "MANUAL" },
      ]),
    );
    __setHubspotClientForTests(client);

    const res = await listSmsLists("");
    expect(res).toHaveLength(3);
  });

  it("normalise createdAt Date → ISO string", async () => {
    const fixedDate = new Date("2026-05-01T10:30:00.000Z");
    const client = makeFakeClient(
      singlePage([
        {
          listId: "1",
          name: "SMS Test",
          processingType: "MANUAL",
          createdAt: fixedDate,
        },
      ]),
    );
    __setHubspotClientForTests(client);

    const res = await listSmsLists();
    expect(res[0]!.createdAt).toBe("2026-05-01T10:30:00.000Z");
  });

  it("size undefined si HubSpot ne renvoie pas additionalProperties.size", async () => {
    const client = makeFakeClient(
      singlePage([{ listId: "1", name: "SMS Test", processingType: "MANUAL" }]),
    );
    __setHubspotClientForTests(client);

    const res = await listSmsLists();
    expect(res[0]!.size).toBeUndefined();
  });

  it("size parsé depuis additionalProperties.size (string API → number)", async () => {
    const client = makeFakeClient(
      singlePage([
        {
          listId: "1",
          name: "SMS Test",
          processingType: "MANUAL",
          additionalProperties: { size: "502" },
        },
      ]),
    );
    __setHubspotClientForTests(client);

    const res = await listSmsLists();
    expect(res[0]!.size).toBe(502);
  });

  it("size invalid (non-numérique) → undefined (fail-safe)", async () => {
    const client = makeFakeClient(
      singlePage([
        {
          listId: "1",
          name: "SMS Test",
          processingType: "MANUAL",
          additionalProperties: { size: "NaN" },
        },
      ]),
    );
    __setHubspotClientForTests(client);

    const res = await listSmsLists();
    expect(res[0]!.size).toBeUndefined();
  });

  it("retourne tableau vide si aucune liste ne match", async () => {
    const client = makeFakeClient(
      singlePage([{ listId: "1", name: "Email Marketing", processingType: "DYNAMIC" }]),
    );
    __setHubspotClientForTests(client);

    const res = await listSmsLists("SMS");
    expect(res).toEqual([]);
  });

  it("retourne tableau vide si HubSpot renvoie aucune liste", async () => {
    const client = makeFakeClient(singlePage([]));
    __setHubspotClientForTests(client);

    expect(await listSmsLists()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listSmsLists — gestion d'erreur
// ─────────────────────────────────────────────────────────────────────────────

describe("listSmsLists — gestion d'erreur", () => {
  it("SDK throw → wrap en ExternalServiceError retry-friendly", async () => {
    const client = makeFakeClientWithError(new Error("HubSpot 401 Unauthorized"));
    __setHubspotClientForTests(client);

    await expect(listSmsLists()).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("retour SDK mal formé (lists non array) → ExternalServiceError", async () => {
    const client = makeFakeClient({ lists: "not-an-array", hasMore: false, offset: 0, total: 0 });
    __setHubspotClientForTests(client);

    await expect(listSmsLists()).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("retour SDK mal formé (null) → ExternalServiceError", async () => {
    const client = makeFakeClient(null);
    __setHubspotClientForTests(client);

    await expect(listSmsLists()).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("retour SDK mal formé (hasMore manquant) → ExternalServiceError", async () => {
    const client = makeFakeClient({ lists: [], offset: 0, total: 0 });
    __setHubspotClientForTests(client);

    await expect(listSmsLists()).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("item liste mal formé (manque listId) → ExternalServiceError", async () => {
    const client = makeFakeClient(
      singlePage([{ name: "Missing listId", processingType: "MANUAL" }]),
    );
    __setHubspotClientForTests(client);

    await expect(listSmsLists()).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("ExternalServiceError NE contient PAS le err.message SDK brut", async () => {
    const SECRET_IN_ERR = "pat-eu1-LEAKED-SECRET-TOKEN-DO-NOT-LOG";
    const client = makeFakeClientWithError(new Error(`401: token ${SECRET_IN_ERR}`));
    __setHubspotClientForTests(client);

    try {
      await listSmsLists();
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExternalServiceError);
      const ext = e as ExternalServiceError;
      expect(ext.message).not.toContain(SECRET_IN_ERR);
      expect(JSON.stringify(ext.context)).not.toContain(SECRET_IN_ERR);
    }
  });

  it("S10.1.3-FIX security F1 : sérialisation Pino { err: ext } NE leak PAS le token", async () => {
    // Sentinelle defense-in-depth contre logger.error({ err: ext }).
    // Si `cause: err` était attaché à l'ExternalServiceError, le
    // sérialiseur Pino par défaut traverserait `cause.message` et
    // fuirait le token. Le fix retire `cause: err` du throw côté
    // `listSmsLists` → forensic via context op/offset/pageCount.
    const SECRET = "pat-eu1-NEVER-LOG-THIS-TOKEN-S10-1-3-FIX-F1";
    const client = makeFakeClientWithError(new Error(`401: token ${SECRET}`));
    __setHubspotClientForTests(client);

    try {
      await listSmsLists();
      expect.fail("should have thrown");
    } catch (e) {
      // Simule le sérialiseur Pino par défaut : `JSON.stringify({err: ext})`.
      const serialized = JSON.stringify({ err: e });
      expect(serialized).not.toContain(SECRET);
      // Vérification supplémentaire : .cause ne doit pas exister (ou être
      // undefined) — sinon un sérialiseur custom pourrait quand même
      // fuir.
      const ext = e as Error & { cause?: unknown };
      expect(ext.cause).toBeUndefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listSmsLists — anti-ReDoS searchQuery metachars échappés (couche 2)
// ─────────────────────────────────────────────────────────────────────────────

describe("listSmsLists — anti-ReDoS searchQuery metachars échappés", () => {
  it("searchQuery '.*' est traité comme litéral (pas regex .* gloutonne)", async () => {
    const client = makeFakeClient(
      singlePage([
        { listId: "1", name: "Just dots .* literal", processingType: "MANUAL" },
        { listId: "2", name: "Other list", processingType: "DYNAMIC" },
      ]),
    );
    __setHubspotClientForTests(client);

    const res = await listSmsLists(".*");
    expect(res).toHaveLength(1);
    expect(res[0]!.name).toContain(".*");
  });

  it("searchQuery '(' (regex invalide non échappé) ne crash pas", async () => {
    const client = makeFakeClient(singlePage([]));
    __setHubspotClientForTests(client);

    await expect(listSmsLists("(")).resolves.toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listSmsLists — log warn si > 200 lists matchent
// ─────────────────────────────────────────────────────────────────────────────

describe("listSmsLists — log warn si > 200 lists matchent", () => {
  it("log warn quand >LIST_COUNT_WARN_THRESHOLD matches", async () => {
    const lists = Array.from({ length: 250 }, (_, i) => ({
      listId: String(i),
      name: `SMS list ${i}`,
      processingType: "MANUAL",
    }));
    const client = makeFakeClient(singlePage(lists));
    __setHubspotClientForTests(client);

    await listSmsLists();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ matched: 250 }),
      expect.stringContaining("[listSmsLists]"),
    );
  });

  it("pas de log warn quand 200 ou moins", async () => {
    const lists = Array.from({ length: 199 }, (_, i) => ({
      listId: String(i),
      name: `SMS list ${i}`,
      processingType: "MANUAL",
    }));
    const client = makeFakeClient(singlePage(lists));
    __setHubspotClientForTests(client);

    await listSmsLists();
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sentinelles constantes
// ─────────────────────────────────────────────────────────────────────────────

describe("Sentinelles constantes", () => {
  it("DEFAULT_SMS_LIST_SEARCH_QUERY = 'SMS' (verrouillé)", () => {
    expect(DEFAULT_SMS_LIST_SEARCH_QUERY).toBe("SMS");
  });

  it("HUBSPOT_LISTS_PAGE_SIZE = 500 (HubSpot v3 max page)", () => {
    expect(HUBSPOT_LISTS_PAGE_SIZE).toBe(500);
  });

  it("HUBSPOT_LISTS_MAX_PAGES = 200 (anti-boucle infinie)", () => {
    expect(HUBSPOT_LISTS_MAX_PAGES).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S10.1.3-FIX-LISTS-DOSEARCH-001 — Sentinelle anti-régression
// ─────────────────────────────────────────────────────────────────────────────

describe("S10.1.3-FIX-LISTS-DOSEARCH-001 — sentinelle anti-régression", () => {
  it("appelle listsApi.doSearch et JAMAIS listsApi.getAll", async () => {
    const client = makeFakeClient(singlePage([]));
    __setHubspotClientForTests(client);

    await listSmsLists("SMS");

    const mockGetAll = client.crm.lists.listsApi.getAll as ReturnType<typeof vi.fn>;
    const mockDoSearch = client.crm.lists.listsApi.doSearch as ReturnType<typeof vi.fn>;
    expect(mockGetAll).not.toHaveBeenCalled();
    expect(mockDoSearch).toHaveBeenCalled();
  });

  it("doSearch reçoit additionalProperties: ['size'] (D2 récupère le size)", async () => {
    const client = makeFakeClient(singlePage([]));
    __setHubspotClientForTests(client);

    await listSmsLists("SMS");

    const mockDoSearch = client.crm.lists.listsApi.doSearch as ReturnType<typeof vi.fn>;
    expect(mockDoSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalProperties: ["size"],
      }),
    );
  });

  it("doSearch reçoit query: searchQuery (D1 couche 1 — filter API)", async () => {
    const client = makeFakeClient(singlePage([]));
    __setHubspotClientForTests(client);

    await listSmsLists("SMS");

    const mockDoSearch = client.crm.lists.listsApi.doSearch as ReturnType<typeof vi.fn>;
    expect(mockDoSearch).toHaveBeenCalledWith(expect.objectContaining({ query: "SMS" }));
  });

  it("doSearch reçoit count: HUBSPOT_LISTS_PAGE_SIZE + offset: 0 initial", async () => {
    const client = makeFakeClient(singlePage([]));
    __setHubspotClientForTests(client);

    await listSmsLists("SMS");

    const mockDoSearch = client.crm.lists.listsApi.doSearch as ReturnType<typeof vi.fn>;
    expect(mockDoSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        count: HUBSPOT_LISTS_PAGE_SIZE,
        offset: 0,
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S10.1.3-FIX — Defense-in-depth couche 2 regex code-side
// ─────────────────────────────────────────────────────────────────────────────

describe("S10.1.3-FIX — defense-in-depth filter regex code-side (couche 2)", () => {
  it("rejette les listes retournées hors-match (bug serveur HubSpot simulé)", async () => {
    // HubSpot retourne 2 listes alors qu'on a demandé "SMS" — la 2e
    // ne match pas le pattern. Couche 2 (regex code) doit la rejeter
    // même si l'API serveur a buggué et l'a renvoyée.
    const client = makeFakeClient(
      singlePage([
        { listId: "1", name: "SMS Campaign", processingType: "MANUAL" },
        // HubSpot bug : retourné malgré query "SMS"
        { listId: "2", name: "Email Campaign", processingType: "DYNAMIC" },
      ]),
    );
    __setHubspotClientForTests(client);

    const result = await listSmsLists("SMS");
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("SMS Campaign");
    // "Email Campaign" rejected by code-side regex
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S10.1.3-FIX — Pagination explicite (BP4)
// ─────────────────────────────────────────────────────────────────────────────

describe("S10.1.3-FIX — pagination boucle hasMore", () => {
  it("single page hasMore=false → 1 seul appel doSearch", async () => {
    const client = makeFakeClient(
      singlePage([{ listId: "1", name: "SMS", processingType: "MANUAL" }]),
    );
    __setHubspotClientForTests(client);

    await listSmsLists();

    const mockDoSearch = client.crm.lists.listsApi.doSearch as ReturnType<typeof vi.fn>;
    expect(mockDoSearch).toHaveBeenCalledTimes(1);
  });

  it("multi-page hasMore=true puis hasMore=false → 2 appels doSearch, offset cumulatif", async () => {
    // Page 1 : 3 listes, hasMore=true
    // Page 2 : 2 listes, hasMore=false
    let callIdx = 0;
    const client = makeFakeClient(() => {
      callIdx++;
      if (callIdx === 1) {
        return {
          lists: [
            { listId: "1", name: "SMS A", processingType: "MANUAL" },
            { listId: "2", name: "SMS B", processingType: "MANUAL" },
            { listId: "3", name: "SMS C", processingType: "MANUAL" },
          ],
          hasMore: true,
          offset: 0,
          total: 5,
        };
      }
      return {
        lists: [
          { listId: "4", name: "SMS D", processingType: "MANUAL" },
          { listId: "5", name: "SMS E", processingType: "MANUAL" },
        ],
        hasMore: false,
        offset: 3,
        total: 5,
      };
    });
    __setHubspotClientForTests(client);

    const res = await listSmsLists();
    expect(res).toHaveLength(5);

    const mockDoSearch = client.crm.lists.listsApi.doSearch as ReturnType<typeof vi.fn>;
    expect(mockDoSearch).toHaveBeenCalledTimes(2);
    // 1er appel : offset 0
    expect(mockDoSearch.mock.calls[0]?.[0]).toMatchObject({ offset: 0 });
    // 2e appel : offset 3 (incrémenté de page 1.lists.length)
    expect(mockDoSearch.mock.calls[1]?.[0]).toMatchObject({ offset: 3 });
  });

  it("anti-boucle infinie : > HUBSPOT_LISTS_MAX_PAGES → ExternalServiceError", async () => {
    // hasMore reste true indéfiniment (bug serveur HubSpot simulé)
    const client = makeFakeClient(() => ({
      lists: [{ listId: "x", name: "SMS infini", processingType: "MANUAL" }],
      hasMore: true,
      offset: 0,
      total: 999999,
    }));
    __setHubspotClientForTests(client);

    await expect(listSmsLists()).rejects.toBeInstanceOf(ExternalServiceError);
  });
});
