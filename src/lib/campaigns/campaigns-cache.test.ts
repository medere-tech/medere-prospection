/**
 * Tests `getCachedSmsCampaigns` — PR2b-2 round 3 R3-P1.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/hubspot/lists", () => ({
  listSmsLists: vi.fn(),
}));

import { listSmsLists } from "@/lib/hubspot/lists";

import {
  __resetCampaignsCache_FOR_TESTS,
  campaignNameByListIdFrom,
  getCachedSmsCampaigns,
} from "./campaigns-cache";

const mockListSmsLists = vi.mocked(listSmsLists);

const CAMPAIGNS = [
  {
    listId: "6081",
    name: "SMS Dentistes IDF",
    size: 10,
    processingType: "MANUAL",
    createdAt: "2026-05-29T12:00:00.000Z",
  },
];

describe("getCachedSmsCampaigns", () => {
  beforeEach(() => {
    __resetCampaignsCache_FOR_TESTS();
    mockListSmsLists.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("1er appel → tape HubSpot, 2e appel dans la fenêtre → aucun appel supplémentaire", async () => {
    mockListSmsLists.mockResolvedValue(CAMPAIGNS);
    const a = await getCachedSmsCampaigns();
    const b = await getCachedSmsCampaigns();
    expect(a).toEqual(CAMPAIGNS);
    expect(b).toEqual(CAMPAIGNS);
    expect(mockListSmsLists).toHaveBeenCalledTimes(1);
  });

  it("appels concurrents partagent la même promesse (anti-thundering herd)", async () => {
    let resolveListSms: (v: (typeof CAMPAIGNS)[number][]) => void = () => {};
    mockListSmsLists.mockImplementation(
      () =>
        new Promise<(typeof CAMPAIGNS)[number][]>((resolve) => {
          resolveListSms = resolve;
        }),
    );
    const p1 = getCachedSmsCampaigns();
    const p2 = getCachedSmsCampaigns();
    const p3 = getCachedSmsCampaigns();
    expect(mockListSmsLists).toHaveBeenCalledTimes(1);
    resolveListSms([...CAMPAIGNS]);
    const [a, b, c] = await Promise.all([p1, p2, p3]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("expiration TTL 5 min → nouvel appel HubSpot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
    mockListSmsLists.mockResolvedValue(CAMPAIGNS);

    await getCachedSmsCampaigns();
    expect(mockListSmsLists).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-10-26T12:04:00Z"));
    await getCachedSmsCampaigns();
    expect(mockListSmsLists).toHaveBeenCalledTimes(1); // encore dans la fenêtre

    vi.setSystemTime(new Date("2026-10-26T12:05:30Z"));
    await getCachedSmsCampaigns();
    expect(mockListSmsLists).toHaveBeenCalledTimes(2); // TTL expiré
  });

  it("rejet → cache invalidé, prochain appel retente", async () => {
    mockListSmsLists
      .mockRejectedValueOnce(new Error("HubSpot 503"))
      .mockResolvedValueOnce(CAMPAIGNS);
    await expect(getCachedSmsCampaigns()).rejects.toThrow("HubSpot 503");
    const r = await getCachedSmsCampaigns();
    expect(r).toEqual(CAMPAIGNS);
    expect(mockListSmsLists).toHaveBeenCalledTimes(2);
  });
});

describe("campaignNameByListIdFrom", () => {
  it("construit la map listId → name", () => {
    const m = campaignNameByListIdFrom(CAMPAIGNS);
    expect(m.get("6081")).toBe("SMS Dentistes IDF");
    expect(m.size).toBe(1);
  });

  it("liste vide → map vide", () => {
    expect(campaignNameByListIdFrom([]).size).toBe(0);
  });
});
