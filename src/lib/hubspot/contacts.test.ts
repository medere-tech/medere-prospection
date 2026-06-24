/**
 * Tests `contacts.ts` — mock HubspotClient, pipeline memberships+batch.
 *
 * Couverture : happy path pagination, listId vide → throw, limit hors
 * bornes → throw, retour memberships mal formé → throw, batch mal formé
 * → throw, liste vide court-circuite batchApi, getContact happy + erreur.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExternalServiceError, ValidationError } from "@/lib/utils/errors";

import { __setHubspotClientForTests, type HubspotClient } from "./client";
import {
  GET_CONTACTS_IN_LIST_DEFAULT_LIMIT,
  GET_CONTACTS_IN_LIST_MAX_LIMIT,
  getContact,
  getContactsInList,
  HUBSPOT_CONTACT_PROPERTIES,
} from "./contacts";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — fake client builder
// ─────────────────────────────────────────────────────────────────────────────

function makeFakeClient(opts: {
  getPage?: (...args: unknown[]) => Promise<unknown>;
  batchRead?: (...args: unknown[]) => Promise<unknown>;
  basicGetById?: (...args: unknown[]) => Promise<unknown>;
}): HubspotClient {
  return {
    crm: {
      lists: {
        listsApi: { getAll: vi.fn(), doSearch: vi.fn() },
        membershipsApi: {
          getPage: opts.getPage ?? vi.fn().mockResolvedValue({ results: [] }),
        },
      },
      contacts: {
        basicApi: {
          getById: opts.basicGetById ?? vi.fn().mockResolvedValue({ id: "0", properties: {} }),
        },
        batchApi: {
          read: opts.batchRead ?? vi.fn().mockResolvedValue({ results: [] }),
        },
      },
    },
  };
}

beforeEach(() => {
  __setHubspotClientForTests(null);
});

afterEach(() => {
  __setHubspotClientForTests(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// getContactsInList — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("getContactsInList — happy path", () => {
  it("page 1 : récupère recordIds + détails, hasMore=false", async () => {
    const getPage = vi.fn().mockResolvedValue({
      results: [
        { recordId: "101", membershipTimestamp: new Date() },
        { recordId: "102", membershipTimestamp: new Date() },
      ],
      // pas de paging.next → dernière page
    });
    const batchRead = vi.fn().mockResolvedValue({
      results: [
        { id: "101", properties: { firstname: "Jean", lastname: "Dupont" } },
        { id: "102", properties: { firstname: "Marie", lastname: "Martin" } },
      ],
    });
    __setHubspotClientForTests(makeFakeClient({ getPage, batchRead }));

    const res = await getContactsInList("list-123");
    expect(res.contacts).toHaveLength(2);
    expect(res.contacts[0]!.id).toBe("101");
    expect(res.contacts[0]!.properties.firstname).toBe("Jean");
    expect(res.hasMore).toBe(false);
    expect(res.nextCursor).toBeUndefined();
  });

  it("page avec nextCursor → hasMore=true", async () => {
    const getPage = vi.fn().mockResolvedValue({
      results: [{ recordId: "101" }],
      paging: { next: { after: "cursor-page-2" } },
    });
    const batchRead = vi.fn().mockResolvedValue({
      results: [{ id: "101", properties: { firstname: "Jean" } }],
    });
    __setHubspotClientForTests(makeFakeClient({ getPage, batchRead }));

    const res = await getContactsInList("list-123");
    expect(res.hasMore).toBe(true);
    expect(res.nextCursor).toBe("cursor-page-2");
  });

  it("liste vide → court-circuite batchApi.read (économie 1 round-trip)", async () => {
    const getPage = vi.fn().mockResolvedValue({ results: [] });
    const batchRead = vi.fn();
    __setHubspotClientForTests(makeFakeClient({ getPage, batchRead }));

    const res = await getContactsInList("list-123");
    expect(res.contacts).toEqual([]);
    expect(res.hasMore).toBe(false);
    expect(batchRead).not.toHaveBeenCalled();
  });

  it("cursor propagé : 2e page après 1ère reprend avec cursor", async () => {
    const getPage = vi.fn().mockResolvedValue({
      results: [{ recordId: "201" }],
    });
    const batchRead = vi.fn().mockResolvedValue({
      results: [{ id: "201", properties: { firstname: "Alice" } }],
    });
    __setHubspotClientForTests(makeFakeClient({ getPage, batchRead }));

    await getContactsInList("list-123", { cursor: "cursor-page-2" });
    expect(getPage).toHaveBeenCalledWith(
      "list-123",
      "cursor-page-2",
      undefined,
      GET_CONTACTS_IN_LIST_DEFAULT_LIMIT,
    );
  });

  it("limit custom appliquée à membershipsApi.getPage", async () => {
    const getPage = vi.fn().mockResolvedValue({ results: [] });
    __setHubspotClientForTests(makeFakeClient({ getPage }));

    await getContactsInList("list-123", { limit: 50 });
    expect(getPage).toHaveBeenCalledWith("list-123", undefined, undefined, 50);
  });

  it("HUBSPOT_CONTACT_PROPERTIES envoyé à batchApi.read", async () => {
    const getPage = vi.fn().mockResolvedValue({ results: [{ recordId: "1" }] });
    const batchRead = vi.fn().mockResolvedValue({
      results: [{ id: "1", properties: {} }],
    });
    __setHubspotClientForTests(makeFakeClient({ getPage, batchRead }));

    await getContactsInList("list-123");
    expect(batchRead).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: [{ id: "1" }],
        properties: [...HUBSPOT_CONTACT_PROPERTIES],
        propertiesWithHistory: [],
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getContactsInList — validation input
// ─────────────────────────────────────────────────────────────────────────────

describe("getContactsInList — validation input", () => {
  it("listId vide → ValidationError", async () => {
    await expect(getContactsInList("")).rejects.toBeInstanceOf(ValidationError);
    await expect(getContactsInList("   ")).rejects.toBeInstanceOf(ValidationError);
  });

  it("limit < 1 → ValidationError", async () => {
    await expect(getContactsInList("list-123", { limit: 0 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(getContactsInList("list-123", { limit: -10 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("limit > MAX → ValidationError (anti-DoS)", async () => {
    await expect(
      getContactsInList("list-123", { limit: GET_CONTACTS_IN_LIST_MAX_LIMIT + 1 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(getContactsInList("list-123", { limit: 500 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("limit = MAX → accepté (borne incluse)", async () => {
    const getPage = vi.fn().mockResolvedValue({ results: [] });
    __setHubspotClientForTests(makeFakeClient({ getPage }));
    await expect(
      getContactsInList("list-123", { limit: GET_CONTACTS_IN_LIST_MAX_LIMIT }),
    ).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getContactsInList — gestion d'erreur SDK
// ─────────────────────────────────────────────────────────────────────────────

describe("getContactsInList — gestion d'erreur", () => {
  it("membershipsApi.getPage throw → ExternalServiceError", async () => {
    const getPage = vi.fn().mockRejectedValue(new Error("401 Unauthorized"));
    __setHubspotClientForTests(makeFakeClient({ getPage }));

    await expect(getContactsInList("list-123")).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("memberships retourne shape mal formée → ExternalServiceError", async () => {
    const getPage = vi.fn().mockResolvedValue({ results: "not-an-array" });
    __setHubspotClientForTests(makeFakeClient({ getPage }));

    await expect(getContactsInList("list-123")).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("memberships item sans recordId → ExternalServiceError", async () => {
    const getPage = vi.fn().mockResolvedValue({
      results: [{ missingRecordId: true }],
    });
    __setHubspotClientForTests(makeFakeClient({ getPage }));

    await expect(getContactsInList("list-123")).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("batchApi.read throw → ExternalServiceError", async () => {
    const getPage = vi.fn().mockResolvedValue({ results: [{ recordId: "1" }] });
    const batchRead = vi.fn().mockRejectedValue(new Error("500 Server Error"));
    __setHubspotClientForTests(makeFakeClient({ getPage, batchRead }));

    await expect(getContactsInList("list-123")).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("batch retour shape mal formée → ExternalServiceError", async () => {
    const getPage = vi.fn().mockResolvedValue({ results: [{ recordId: "1" }] });
    const batchRead = vi.fn().mockResolvedValue({ wrong: "shape" });
    __setHubspotClientForTests(makeFakeClient({ getPage, batchRead }));

    await expect(getContactsInList("list-123")).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("ExternalServiceError NE fuite PAS de PII dans context (recordIds count, pas IDs)", async () => {
    const getPage = vi.fn().mockResolvedValue({
      results: [{ recordId: "SECRET_PS_ID_999" }, { recordId: "SECRET_PS_ID_888" }],
    });
    const batchRead = vi.fn().mockRejectedValue(new Error("network failure"));
    __setHubspotClientForTests(makeFakeClient({ getPage, batchRead }));

    try {
      await getContactsInList("list-123");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExternalServiceError);
      const ext = e as ExternalServiceError;
      const ctx = JSON.stringify(ext.context);
      expect(ctx).not.toContain("SECRET_PS_ID_999");
      expect(ctx).not.toContain("SECRET_PS_ID_888");
      expect(ctx).toContain("recordIdsCount");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getContact (basicApi)
// ─────────────────────────────────────────────────────────────────────────────

describe("getContact — happy path", () => {
  it("retourne le contact avec id + properties", async () => {
    const basicGetById = vi.fn().mockResolvedValue({
      id: "999",
      properties: { firstname: "Jean", email: "jean@example.com" },
    });
    __setHubspotClientForTests(makeFakeClient({ basicGetById }));

    const res = await getContact("999");
    expect(res.id).toBe("999");
    expect(res.properties.firstname).toBe("Jean");
  });

  it("appelle basicApi.getById avec HUBSPOT_CONTACT_PROPERTIES", async () => {
    const basicGetById = vi.fn().mockResolvedValue({
      id: "999",
      properties: {},
    });
    __setHubspotClientForTests(makeFakeClient({ basicGetById }));

    await getContact("999");
    expect(basicGetById).toHaveBeenCalledWith("999", [...HUBSPOT_CONTACT_PROPERTIES]);
  });
});

describe("getContact — validation + erreurs", () => {
  it("hubspotId vide → ValidationError", async () => {
    await expect(getContact("")).rejects.toBeInstanceOf(ValidationError);
    await expect(getContact("   ")).rejects.toBeInstanceOf(ValidationError);
  });

  it("SDK throw 404 → ExternalServiceError", async () => {
    const basicGetById = vi.fn().mockRejectedValue(new Error("404 Not Found"));
    __setHubspotClientForTests(makeFakeClient({ basicGetById }));

    await expect(getContact("999")).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("retour mal formé → ExternalServiceError", async () => {
    const basicGetById = vi.fn().mockResolvedValue({ wrong: "shape" });
    __setHubspotClientForTests(makeFakeClient({ basicGetById }));

    await expect(getContact("999")).rejects.toBeInstanceOf(ExternalServiceError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sentinelles
// ─────────────────────────────────────────────────────────────────────────────

describe("Sentinelles contacts.ts", () => {
  it("HUBSPOT_CONTACT_PROPERTIES = 11 props (9 alignées Q-A-b2 S10.1.2.b.0 + 2 opt-out S10.1.9 OPTOUT-FILTER-001)", () => {
    expect(HUBSPOT_CONTACT_PROPERTIES).toEqual([
      "firstname",
      "lastname",
      "email",
      "phone",
      "mobilephone",
      "city",
      "zip",
      "civilite",
      "profession",
      // S10.1.9 OPTOUT-FILTER-001 — propriétés opt-out (filtrées dans
      // seed-runner.ts étape A.0, AVANT mapping). Suppression accidentelle
      // ici masquerait les opt-out → import de contacts opposés au
      // démarchage → 375 k€ L.34-5 CPCE / 75 k€ Bloctel.
      "hs_email_optout",
      "sms_opted_out",
    ]);
  });

  it("GET_CONTACTS_IN_LIST_DEFAULT_LIMIT = 100, MAX = 100", () => {
    expect(GET_CONTACTS_IN_LIST_DEFAULT_LIMIT).toBe(100);
    expect(GET_CONTACTS_IN_LIST_MAX_LIMIT).toBe(100);
  });
});
