/**
 * Tests `lists.ts` — mock HubspotClient, validation filter regex, edge cases.
 *
 * Couverture : happy path, searchQuery="" retourne tout, filter case-
 * insensitive, retour mal formé → throw, erreur SDK → wrapped
 * ExternalServiceError, warn log si > 200 matches, anti-ReDoS metachars.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExternalServiceError } from "@/lib/utils/errors";

import { __setHubspotClientForTests, type HubspotClient } from "./client";
import { DEFAULT_SMS_LIST_SEARCH_QUERY, listSmsLists } from "./lists";

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

function makeFakeClient(getAllReturn: unknown): HubspotClient {
  return {
    crm: {
      lists: {
        listsApi: {
          getAll: vi.fn().mockResolvedValue(getAllReturn),
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
          getAll: vi.fn().mockRejectedValue(err),
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

beforeEach(() => {
  __setHubspotClientForTests(null);
  mocks.warn.mockReset();
});

afterEach(() => {
  __setHubspotClientForTests(null);
});

describe("listSmsLists — happy path", () => {
  it("filtre par défaut 'SMS' retourne uniquement les listes matchantes", async () => {
    const client = makeFakeClient({
      lists: [
        { listId: "1", name: "SMS Dentistes IDF", size: 200, processingType: "MANUAL" },
        { listId: "2", name: "SMS Médecins PACA", size: 50, processingType: "DYNAMIC" },
        { listId: "3", name: "Email Marketing", size: 10000, processingType: "DYNAMIC" },
        { listId: "4", name: "Newsletter", size: 500, processingType: "MANUAL" },
      ],
    });
    __setHubspotClientForTests(client);

    const res = await listSmsLists();
    expect(res).toHaveLength(2);
    expect(res.map((l) => l.listId)).toEqual(["1", "2"]);
    expect(res[0]!.name).toBe("SMS Dentistes IDF");
    expect(res[0]!.size).toBe(200);
  });

  it("filtre case-insensitive : 'sms' ou 'Sms' matchent 'SMS'", async () => {
    const client = makeFakeClient({
      lists: [
        { listId: "1", name: "sms dentistes", processingType: "MANUAL" },
        { listId: "2", name: "Sms test", processingType: "DYNAMIC" },
      ],
    });
    __setHubspotClientForTests(client);

    const res = await listSmsLists("SMS");
    expect(res).toHaveLength(2);
  });

  it("searchQuery custom : retourne uniquement les listes matchantes", async () => {
    const client = makeFakeClient({
      lists: [
        { listId: "1", name: "SMS Dentistes IDF", processingType: "MANUAL" },
        { listId: "2", name: "SMS Médecins 2026", processingType: "DYNAMIC" },
        { listId: "3", name: "SMS Test 2025", processingType: "MANUAL" },
      ],
    });
    __setHubspotClientForTests(client);

    const res = await listSmsLists("2026");
    expect(res).toHaveLength(1);
    expect(res[0]!.name).toBe("SMS Médecins 2026");
  });

  it("searchQuery vide → retourne TOUTES les listes", async () => {
    const client = makeFakeClient({
      lists: [
        { listId: "1", name: "SMS Dentistes IDF", processingType: "MANUAL" },
        { listId: "2", name: "Email Marketing", processingType: "DYNAMIC" },
        { listId: "3", name: "Newsletter", processingType: "MANUAL" },
      ],
    });
    __setHubspotClientForTests(client);

    const res = await listSmsLists("");
    expect(res).toHaveLength(3);
  });

  it("normalise createdAt Date → ISO string", async () => {
    const fixedDate = new Date("2026-05-01T10:30:00.000Z");
    const client = makeFakeClient({
      lists: [
        {
          listId: "1",
          name: "SMS Test",
          processingType: "MANUAL",
          createdAt: fixedDate,
        },
      ],
    });
    __setHubspotClientForTests(client);

    const res = await listSmsLists();
    expect(res[0]!.createdAt).toBe("2026-05-01T10:30:00.000Z");
  });

  it("size undefined si HubSpot ne renvoie pas la propriété", async () => {
    const client = makeFakeClient({
      lists: [{ listId: "1", name: "SMS Test", processingType: "MANUAL" }],
    });
    __setHubspotClientForTests(client);

    const res = await listSmsLists();
    expect(res[0]!.size).toBeUndefined();
  });

  it("retourne tableau vide si aucune liste ne match", async () => {
    const client = makeFakeClient({
      lists: [{ listId: "1", name: "Email Marketing", processingType: "DYNAMIC" }],
    });
    __setHubspotClientForTests(client);

    const res = await listSmsLists("SMS");
    expect(res).toEqual([]);
  });

  it("retourne tableau vide si HubSpot renvoie aucune liste", async () => {
    const client = makeFakeClient({ lists: [] });
    __setHubspotClientForTests(client);

    expect(await listSmsLists()).toEqual([]);
  });
});

describe("listSmsLists — gestion d'erreur", () => {
  it("SDK throw → wrap en ExternalServiceError retry-friendly", async () => {
    const client = makeFakeClientWithError(new Error("HubSpot 401 Unauthorized"));
    __setHubspotClientForTests(client);

    await expect(listSmsLists()).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("retour SDK mal formé (lists non array) → ExternalServiceError", async () => {
    const client = makeFakeClient({ lists: "not-an-array" });
    __setHubspotClientForTests(client);

    await expect(listSmsLists()).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("retour SDK mal formé (null) → ExternalServiceError", async () => {
    const client = makeFakeClient(null);
    __setHubspotClientForTests(client);

    await expect(listSmsLists()).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("item liste mal formé (manque listId) → ExternalServiceError", async () => {
    const client = makeFakeClient({
      lists: [{ name: "Missing listId", processingType: "MANUAL" }],
    });
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
      // context et message custom OK — le cause SDK reste accessible via
      // .cause mais on vérifie que le message PROPRE ne fuite pas.
      const ext = e as ExternalServiceError;
      expect(ext.message).not.toContain(SECRET_IN_ERR);
      expect(JSON.stringify(ext.context)).not.toContain(SECRET_IN_ERR);
    }
  });
});

describe("listSmsLists — anti-ReDoS searchQuery metachars échappés", () => {
  it("searchQuery '.*' est traité comme litéral (pas regex .* gloutonne)", async () => {
    const client = makeFakeClient({
      lists: [
        { listId: "1", name: "Just dots .* literal", processingType: "MANUAL" },
        { listId: "2", name: "Other list", processingType: "DYNAMIC" },
      ],
    });
    __setHubspotClientForTests(client);

    // Si non échappé, ".*" matcherait n'importe quel nom → 2 résultats.
    // Échappé, ".*" cherche litéralement la chaîne ".*" → 1 résultat.
    const res = await listSmsLists(".*");
    expect(res).toHaveLength(1);
    expect(res[0]!.name).toContain(".*");
  });

  it("searchQuery '(' (regex invalide non échappé) ne crash pas", async () => {
    const client = makeFakeClient({ lists: [] });
    __setHubspotClientForTests(client);

    // Sans échappement, new RegExp("(") throw SyntaxError. Avec
    // échappement, recherche "(" litéral → 0 match.
    await expect(listSmsLists("(")).resolves.toEqual([]);
  });
});

describe("listSmsLists — log warn si > 200 lists matchent", () => {
  it("log warn quand >LIST_COUNT_WARN_THRESHOLD matches", async () => {
    const lists = Array.from({ length: 250 }, (_, i) => ({
      listId: String(i),
      name: `SMS list ${i}`,
      processingType: "MANUAL",
    }));
    const client = makeFakeClient({ lists });
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
    const client = makeFakeClient({ lists });
    __setHubspotClientForTests(client);

    await listSmsLists();
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});

describe("Sentinelle DEFAULT_SMS_LIST_SEARCH_QUERY", () => {
  it("DEFAULT_SMS_LIST_SEARCH_QUERY = 'SMS' (verrouillé)", () => {
    expect(DEFAULT_SMS_LIST_SEARCH_QUERY).toBe("SMS");
  });
});
