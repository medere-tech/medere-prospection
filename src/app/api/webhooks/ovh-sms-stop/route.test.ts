/**
 * Tests `/api/webhooks/ovh-sms-stop` — route d'OBSERVATION du callback
 * OVH stopCallBack (DIAG-STOP-OVH étape B).
 *
 * Pattern miroir strict de `/api/webhooks/ovh-sms/route.test.ts` :
 *   - vi.mock pour `@/lib/security/env`, `@/lib/security/rate-limit`,
 *     `@/lib/firestore/admin`, `@/lib/utils/logger`.
 *   - buildRequest helpers pour GET, POST form-urlencoded, POST JSON.
 *   - zéro valeur brute dans la persist Firestore est VERROUILLÉE par
 *     une sentinelle qui spy sur `collection.add`.
 */
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks hoistés (meme pattern que /api/webhooks/ovh-sms/route.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

interface RateLimitResult {
  success: boolean;
  remaining: number;
  resetAt: number;
  reason: string | null;
}

// `AddFn` capture volontairement l'argument qu'OVH enverra (le doc a
// persister). Le mock s'en moque pour la logique, mais TS a besoin du
// 1er argument pour que `mock.calls[0]![0]` soit indexable (sinon
// tuple vide -> TS2493).
type AddFn = (data: unknown) => Promise<{ id: string }>;
type CollectionFn = (name: string) => { add: AddFn };
type GetAdminDbFn = () => { collection: CollectionFn };

const { mockGetOvhEnv, mockRateLimitCheck, mockAdd, mockCollection, mockGetAdminDb } = vi.hoisted(
  () => ({
    mockGetOvhEnv: vi.fn(() => ({
      OVH_WEBHOOK_SECRET: "test-secret-min-16-chars-long-xxx",
    })),
    mockRateLimitCheck: vi.fn(
      async (): Promise<RateLimitResult> => ({
        success: true,
        remaining: 59,
        resetAt: Date.now() + 60_000,
        reason: null,
      }),
    ),
    mockAdd: vi.fn<AddFn>(async () => ({ id: "doc_mock_id" })),
    mockCollection: vi.fn<CollectionFn>(),
    mockGetAdminDb: vi.fn<GetAdminDbFn>(),
  }),
);

// Branche collection -> add et getAdminDb -> collection APRES hoist.
mockCollection.mockImplementation(() => ({ add: mockAdd }));
mockGetAdminDb.mockImplementation(() => ({ collection: mockCollection }));

vi.mock("@/lib/security/env", () => ({
  getOvhEnv: mockGetOvhEnv,
  // safeExternalIdHash -> hashPii -> getAuditEnv().AUDIT_PII_PEPPER.
  getAuditEnv: () => ({ AUDIT_PII_PEPPER: "y".repeat(64) }),
}));

vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: vi.fn(() => ({ check: mockRateLimitCheck })),
}));

vi.mock("@/lib/firestore/admin", () => ({
  getAdminDb: mockGetAdminDb,
}));

vi.mock("@/lib/utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Imports APRÈS les mocks.
import { maskValueForStopCallback, summarizeParams } from "@/lib/ovh/stop-callback";

import { GET, POST } from "./route";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers requêtes
// ─────────────────────────────────────────────────────────────────────────────

const VALID_TOKEN = "test-secret-min-16-chars-long-xxx";

function buildGetRequest(query: Record<string, string> = {}): NextRequest {
  const url = new URL("https://medere.example/api/webhooks/ovh-sms-stop");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new NextRequest(url, { method: "GET" });
}

function buildFormPostRequest(
  query: Record<string, string>,
  fields: Record<string, string>,
): NextRequest {
  const url = new URL("https://medere.example/api/webhooks/ovh-sms-stop");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new NextRequest(url, {
    method: "POST",
    body: form.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
}

function buildJsonPostRequest(
  query: Record<string, string>,
  body: Record<string, unknown>,
): NextRequest {
  const url = new URL("https://medere.example/api/webhooks/ovh-sms-stop");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.clearAllMocks();
  mockAdd.mockImplementation(async () => ({ id: "doc_mock_id" }));
  mockRateLimitCheck.mockImplementation(async () => ({
    success: true,
    remaining: 59,
    resetAt: Date.now() + 60_000,
    reason: null,
  }));
});

// ─────────────────────────────────────────────────────────────────────────────
// Vérification token
// ─────────────────────────────────────────────────────────────────────────────

describe("/api/webhooks/ovh-sms-stop — token", () => {
  it("GET sans token → 401 + aucune ecriture Firestore", async () => {
    const res = await GET(buildGetRequest({}));
    expect(res.status).toBe(401);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("GET token invalide → 401 + aucune ecriture", async () => {
    const res = await GET(buildGetRequest({ token: "WRONG" }));
    expect(res.status).toBe(401);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("POST token invalide → 401 + aucune ecriture", async () => {
    const res = await POST(buildFormPostRequest({ token: "WRONG" }, { id: "118791103" }));
    expect(res.status).toBe(401);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("401 ne log PAS la valeur du token recue (anti-leak)", async () => {
    const { logger } = await import("@/lib/utils/logger");
    const warnSpy = vi.mocked(logger.warn);
    await GET(buildGetRequest({ token: "LEAK_CANDIDATE_SECRET_XYZ" }));
    const serialized = JSON.stringify(warnSpy.mock.calls);
    expect(serialized).not.toContain("LEAK_CANDIDATE_SECRET_XYZ");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("/api/webhooks/ovh-sms-stop — GET happy path", () => {
  it("GET token valide + query params → 200 + persist methode=GET + params masques", async () => {
    const res = await GET(buildGetRequest({ token: VALID_TOKEN, number: "+33612345678" }));
    expect(res.status).toBe(200);
    expect(mockAdd).toHaveBeenCalledOnce();
    const persisted = mockAdd.mock.calls[0]![0] as {
      method: string;
      queryParams: Array<{ name: string; masked: { type: string; last4?: string; hash?: string } }>;
      bodyParams?: unknown;
    };
    expect(persisted.method).toBe("GET");
    // `token` est filtre, pas dans queryParams.
    const names = persisted.queryParams.map((p) => p.name);
    expect(names).not.toContain("token");
    expect(names).toContain("number");
    // Le numero est masque : phoneLike + hash + last4, PAS la valeur brute.
    const numberParam = persisted.queryParams.find((p) => p.name === "number");
    expect(numberParam?.masked.type).toBe("phoneLike");
    expect(numberParam?.masked.last4).toBe("5678");
    expect(numberParam?.masked.hash).toMatch(/^oih_/);
    // bodyParams absent sur GET
    expect(persisted.bodyParams).toBeUndefined();
  });

  it("GET corps vide (aucun query param hors token) → 200 + queryParams=[]", async () => {
    const res = await GET(buildGetRequest({ token: VALID_TOKEN }));
    expect(res.status).toBe(200);
    const persisted = mockAdd.mock.calls[0]![0] as { queryParams: unknown[] };
    expect(persisted.queryParams).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST happy path (form-urlencoded)
// ─────────────────────────────────────────────────────────────────────────────

describe("/api/webhooks/ovh-sms-stop — POST form-urlencoded", () => {
  it("POST form token valide → 200 + persist method=POST + bodyParams masques", async () => {
    const res = await POST(
      buildFormPostRequest(
        { token: VALID_TOKEN },
        { id: "118791103", senderid: "+33612345678", message: "STOP" },
      ),
    );
    expect(res.status).toBe(200);
    expect(mockAdd).toHaveBeenCalledOnce();
    const persisted = mockAdd.mock.calls[0]![0] as {
      method: string;
      contentType: string;
      bodyParams: Array<{ name: string; masked: { type: string; length: number; last4?: string } }>;
    };
    expect(persisted.method).toBe("POST");
    expect(persisted.contentType).toContain("application/x-www-form-urlencoded");
    const senderParam = persisted.bodyParams.find((p) => p.name === "senderid");
    expect(senderParam?.masked.type).toBe("phoneLike");
    expect(senderParam?.masked.last4).toBe("5678");
    const messageParam = persisted.bodyParams.find((p) => p.name === "message");
    expect(messageParam?.masked.type).toBe("text");
    expect(messageParam?.masked.length).toBe(4);
  });

  it("POST form corps vide → 200 + bodyParams=[]", async () => {
    const res = await POST(buildFormPostRequest({ token: VALID_TOKEN }, {}));
    expect(res.status).toBe(200);
    const persisted = mockAdd.mock.calls[0]![0] as { bodyParams: unknown[] };
    expect(persisted.bodyParams).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST happy path (JSON)
// ─────────────────────────────────────────────────────────────────────────────

describe("/api/webhooks/ovh-sms-stop — POST JSON", () => {
  it("POST JSON token valide → 200 + persist bodyParams masques", async () => {
    const res = await POST(
      buildJsonPostRequest(
        { token: VALID_TOKEN },
        { id: 118791103, senderid: "+33612345678", message: "STOP" },
      ),
    );
    expect(res.status).toBe(200);
    const persisted = mockAdd.mock.calls[0]![0] as {
      contentType: string;
      bodyParams: Array<{ name: string; masked: { type: string; length: number } }>;
    };
    expect(persisted.contentType).toContain("application/json");
    // `id` est serialise en string via JSON.stringify (ex "118791103")
    // -> matche phoneLike (9+ digits).
    const idParam = persisted.bodyParams.find((p) => p.name === "id");
    expect(idParam?.masked.type).toBe("phoneLike");
  });

  it("POST JSON corps vide (`{}`) → 200 + bodyParams=[]", async () => {
    const res = await POST(buildJsonPostRequest({ token: VALID_TOKEN }, {}));
    expect(res.status).toBe(200);
    const persisted = mockAdd.mock.calls[0]![0] as { bodyParams: unknown[] };
    expect(persisted.bodyParams).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SENTINELLE anti-PII — zéro valeur brute persistée
// ─────────────────────────────────────────────────────────────────────────────

describe("/api/webhooks/ovh-sms-stop — SENTINELLE anti-PII", () => {
  const HOSTILE_VALUES = {
    senderid: "+33612345678", // E.164
    receiver: "0612345678", // FR national
    message: "Je m'appelle Dupont et mon email est dupont@example.fr", // texte PII
    email: "fake@example.com",
    id: "118791103",
  };

  it("POST form avec plein de PII → serialized persist NE CONTIENT aucune valeur brute", async () => {
    await POST(buildFormPostRequest({ token: VALID_TOKEN }, HOSTILE_VALUES));
    expect(mockAdd).toHaveBeenCalledOnce();
    const persisted = mockAdd.mock.calls[0]![0];
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain("+33612345678");
    expect(serialized).not.toContain("0612345678");
    expect(serialized).not.toContain("Dupont");
    expect(serialized).not.toContain("dupont@example.fr");
    expect(serialized).not.toContain("fake@example.com");
    expect(serialized).not.toContain("Je m'appelle");
    expect(serialized).not.toContain("118791103");
  });

  it("POST JSON avec PII → idem, aucune valeur brute", async () => {
    await POST(buildJsonPostRequest({ token: VALID_TOKEN }, HOSTILE_VALUES));
    const persisted = mockAdd.mock.calls[0]![0];
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain("+33612345678");
    expect(serialized).not.toContain("0612345678");
    expect(serialized).not.toContain("Dupont");
    expect(serialized).not.toContain("@example.fr");
    expect(serialized).not.toContain("118791103");
  });

  it("GET query avec token sensible → token NON persiste et NON logue", async () => {
    const { logger } = await import("@/lib/utils/logger");
    const infoSpy = vi.mocked(logger.info);
    await GET(buildGetRequest({ token: VALID_TOKEN, number: "+33612345678" }));
    const persisted = mockAdd.mock.calls[0]![0];
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain(VALID_TOKEN);
    const infoSerialized = JSON.stringify(infoSpy.mock.calls);
    expect(infoSerialized).not.toContain(VALID_TOKEN);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rate-limit
// ─────────────────────────────────────────────────────────────────────────────

describe("/api/webhooks/ovh-sms-stop — rate-limit", () => {
  it("rate-limit 429 → court-circuit, aucune verif token ni ecriture", async () => {
    mockRateLimitCheck.mockImplementation(async () => ({
      success: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
      reason: "rate_limit_exceeded",
    }));
    const res = await GET(buildGetRequest({ token: VALID_TOKEN }));
    expect(res.status).toBe(429);
    expect(mockAdd).not.toHaveBeenCalled();
    expect(res.headers.get("Retry-After")).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests unitaires des helpers (exposés)
// ─────────────────────────────────────────────────────────────────────────────

describe("maskValueForStopCallback", () => {
  it("E.164 → phoneLike + hash + last4", () => {
    const m = maskValueForStopCallback("+33612345678");
    expect(m.type).toBe("phoneLike");
    expect(m.last4).toBe("5678");
    expect(m.hash).toMatch(/^oih_/);
    expect(m.length).toBe(12);
  });

  it("FR national → phoneLike", () => {
    const m = maskValueForStopCallback("0612345678");
    expect(m.type).toBe("phoneLike");
    expect(m.last4).toBe("5678");
  });

  it("Texte quelconque → text + length SEULEMENT", () => {
    const m = maskValueForStopCallback("STOP MERCI");
    expect(m.type).toBe("text");
    expect(m.length).toBe(10);
    expect(m).not.toHaveProperty("hash");
    expect(m).not.toHaveProperty("last4");
  });

  it("Chaine courte numeric (<8 digits) → text, PAS phoneLike", () => {
    const m = maskValueForStopCallback("1234567");
    expect(m.type).toBe("text");
    expect(m.length).toBe(7);
  });

  it("Non-string → non-string", () => {
    const m = maskValueForStopCallback(42);
    expect(m.type).toBe("non-string");
  });
});

describe("summarizeParams", () => {
  it("filtre la cle `token` systematiquement", () => {
    const out = summarizeParams({ token: "SECRET", number: "+33612345678" });
    const names = out.map((p) => p.name);
    expect(names).not.toContain("token");
    expect(names).toContain("number");
  });

  it("objet vide → tableau vide", () => {
    expect(summarizeParams({})).toEqual([]);
  });
});
