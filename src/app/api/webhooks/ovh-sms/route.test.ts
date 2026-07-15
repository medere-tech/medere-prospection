/**
 * Tests POST /api/webhooks/ovh-sms (S9.6, INFRA-SMS-001).
 *
 * Scope : route handler unit (mocks env + rate-limit + inngest). Vérifie :
 *   - 200 sur payload JSON + token valides → inngest.send appelé avec
 *     EXACTEMENT {phone, body, ovhMessageId}
 *   - 200 sur payload form-urlencoded (id STRING → converti en NUMBER
 *     puis mappé vers ovhMessageId STRING)
 *   - 401 sur token absent
 *   - 401 sur token invalide (timing-safe compare)
 *   - 400 sur body JSON malformé (transport-level)
 *   - 400 sur shape invalide (parser Zod)
 *   - 400 sur sender non-E.164
 *   - 429 sur rate-limit dépassé + header Retry-After
 *   - anti-leak : la réponse d'erreur ne contient jamais le body brut ni
 *     le sender
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * PATTERN MOCK — vi.hoisted pour référence stable
 *
 * `createRateLimiter` et `getInngestClient` sont appelés au load du module
 * `route.ts` (`ovhWebhookLimiter` module-level singleton, `getInngestClient`
 * dans le handler). Les mocks `vi.mock(...)` sont hoistés en tête du fichier
 * PAR Vitest → tout `const` déclaré au top ne serait pas visible dans la
 * factory du mock. On utilise `vi.hoisted()` pour partager des `vi.fn()`
 * référentiellement stables entre les factories et les tests. Ainsi le
 * `check` récupéré par `ovhWebhookLimiter` au load == celui reprogrammé
 * dans les `beforeEach` / `setupRateLimiter`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Références partagées entre les vi.mock factories et les tests
// ─────────────────────────────────────────────────────────────────────────────

const { mockRateLimitCheck, mockInngestSend, mockGetOvhEnv } = vi.hoisted(() => ({
  mockRateLimitCheck: vi.fn(),
  mockInngestSend: vi.fn(),
  mockGetOvhEnv: vi.fn(),
}));

// ─────────────────────────────────────────────────────────────────────────────
// vi.mock (hoistés automatiquement en tête)
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("@/lib/security/env", () => ({
  getOvhEnv: mockGetOvhEnv,
}));

vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: vi.fn(() => ({ check: mockRateLimitCheck })),
}));

vi.mock("@/lib/inngest/client", () => ({
  getInngestClient: vi.fn(() => ({ send: mockInngestSend })),
}));

vi.mock("@/lib/utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Imports APRÈS les vi.mock (les modules mockés sont résolus au load).
import { POST } from "./route";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes / fixtures
// ─────────────────────────────────────────────────────────────────────────────

const VALID_TOKEN = "test-secret-min-16-chars-long-xxx";

const REAL_OVH_INBOUND = {
  credits: 0,
  creationDatetime: "2026-07-15T12:24:10+02:00",
  id: 118791103,
  sender: "+33775745453",
  message: "Test réception Medere 1",
  tag: "",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildJsonRequest(
  body: unknown,
  opts: { token?: string | null; ip?: string } = {},
): NextRequest {
  const url = new URL("https://medere.example/api/webhooks/ovh-sms");
  if (opts.token !== null) {
    url.searchParams.set("token", opts.token ?? VALID_TOKEN);
  }
  return new NextRequest(url, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": opts.ip ?? "203.0.113.42",
    },
  });
}

function buildFormRequest(
  body: Record<string, string>,
  opts: { token?: string | null; ip?: string } = {},
): NextRequest {
  const url = new URL("https://medere.example/api/webhooks/ovh-sms");
  if (opts.token !== null) {
    url.searchParams.set("token", opts.token ?? VALID_TOKEN);
  }
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) form.append(k, v);
  return new NextRequest(url, {
    method: "POST",
    body: form.toString(),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": opts.ip ?? "203.0.113.42",
    },
  });
}

/**
 * Reprogramme le mock partagé `mockRateLimitCheck` — pass-through par défaut.
 */
function setupRateLimiter(
  result: {
    success?: boolean;
    remaining?: number;
    resetAt?: number;
    reason?: string;
  } = {},
): void {
  const success = result.success ?? true;
  mockRateLimitCheck.mockResolvedValue({
    success,
    limit: 60,
    remaining: result.remaining ?? (success ? 59 : 0),
    resetAt: result.resetAt ?? Date.now() + 60_000,
    reason: result.reason ?? (success ? "allowed" : "rate_limited"),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/webhooks/ovh-sms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOvhEnv.mockReturnValue({ OVH_WEBHOOK_SECRET: VALID_TOKEN });
    setupRateLimiter({ success: true });
    mockInngestSend.mockResolvedValue({ ids: ["evt_xxx"] });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 200 happy path
  // ───────────────────────────────────────────────────────────────────────

  describe("200 happy path", () => {
    it("payload JSON valide + token valide → 200 + inngest.send appelé avec {phone, body, ovhMessageId}", async () => {
      const res = await POST(buildJsonRequest(REAL_OVH_INBOUND));

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);

      expect(mockInngestSend).toHaveBeenCalledTimes(1);
      const event = mockInngestSend.mock.calls[0]?.[0] as { data: Record<string, unknown> };
      expect(event.data).toEqual({
        phone: "+33775745453",
        body: "Test réception Medere 1",
        ovhMessageId: "118791103",
      });
    });

    it("payload form-urlencoded → id STRING converti en NUMBER puis ovhMessageId STRING", async () => {
      const res = await POST(
        buildFormRequest({
          id: "118791103",
          sender: "+33775745453",
          message: "Test form",
        }),
      );

      expect(res.status).toBe(200);
      const event = mockInngestSend.mock.calls[0]?.[0] as { data: Record<string, unknown> };
      expect(event.data).toEqual({
        phone: "+33775745453",
        body: "Test form",
        ovhMessageId: "118791103",
      });
    });

    it("event.id NON forgé manuellement (règle anti-PII events.ts:49-73)", async () => {
      await POST(buildJsonRequest(REAL_OVH_INBOUND));

      const event = mockInngestSend.mock.calls[0]?.[0] as { id?: string };
      expect(event.id).toBeUndefined();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 401 authentification (token)
  // ───────────────────────────────────────────────────────────────────────

  describe("401 token verification", () => {
    it("renvoie 401 si token absent (query param manquant)", async () => {
      const res = await POST(buildJsonRequest(REAL_OVH_INBOUND, { token: null }));

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("UNAUTHORIZED");
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it("renvoie 401 si token invalide (mauvais secret)", async () => {
      const res = await POST(
        buildJsonRequest(REAL_OVH_INBOUND, { token: "wrong-secret-not-matching" }),
      );

      expect(res.status).toBe(401);
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it("renvoie 401 si token vide (string vide)", async () => {
      const res = await POST(buildJsonRequest(REAL_OVH_INBOUND, { token: "" }));

      expect(res.status).toBe(401);
      expect(mockInngestSend).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 400 shape / parse
  // ───────────────────────────────────────────────────────────────────────

  describe("400 validation", () => {
    it("renvoie 400 si body JSON malformé", async () => {
      const url = new URL("https://medere.example/api/webhooks/ovh-sms");
      url.searchParams.set("token", VALID_TOKEN);
      const req = new NextRequest(url, {
        method: "POST",
        body: "{not valid json",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.42",
        },
      });

      const res = await POST(req);

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION");
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it("renvoie 400 si shape invalide (champ id absent)", async () => {
      const res = await POST(buildJsonRequest({ sender: "+33775745453", message: "test" }));

      expect(res.status).toBe(400);
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it("renvoie 400 si sender non-E.164 (national FR sans +33)", async () => {
      const res = await POST(buildJsonRequest({ ...REAL_OVH_INBOUND, sender: "0775745453" }));

      expect(res.status).toBe(400);
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it("renvoie 400 si message vide", async () => {
      const res = await POST(buildJsonRequest({ ...REAL_OVH_INBOUND, message: "" }));

      expect(res.status).toBe(400);
      expect(mockInngestSend).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 429 rate-limit
  // ───────────────────────────────────────────────────────────────────────

  describe("429 rate-limit", () => {
    it("renvoie 429 + Retry-After + court-circuit total (pas de parse, pas d'inngest.send)", async () => {
      setupRateLimiter({
        success: false,
        remaining: 0,
        resetAt: Date.now() + 30_000,
        reason: "rate_limited",
      });

      const res = await POST(buildJsonRequest(REAL_OVH_INBOUND));

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("RATE_LIMITED");
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it("Retry-After >= 1 seconde même si resetAt est passé (garde-fou)", async () => {
      setupRateLimiter({
        success: false,
        remaining: 0,
        resetAt: Date.now() - 5000, // déjà expiré
        reason: "rate_limited",
      });

      const res = await POST(buildJsonRequest(REAL_OVH_INBOUND));

      expect(res.status).toBe(429);
      const retryAfter = Number.parseInt(res.headers.get("Retry-After") ?? "0", 10);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
    });

    it("renvoie 429 aussi sur panne rate-limiter (fail-closed)", async () => {
      setupRateLimiter({
        success: false,
        remaining: 0,
        resetAt: Date.now() + 60_000,
        reason: "rate_limiter_unavailable",
      });

      const res = await POST(buildJsonRequest(REAL_OVH_INBOUND));

      expect(res.status).toBe(429);
      expect(mockInngestSend).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Anti-leak
  // ───────────────────────────────────────────────────────────────────────

  describe("anti-leak — la réponse d'erreur ne fuit rien de sensible", () => {
    it("400 shape invalide → la réponse ne contient PAS le sender/body brut", async () => {
      const res = await POST(buildJsonRequest({ ...REAL_OVH_INBOUND, sender: "0775745453" }));

      expect(res.status).toBe(400);
      const bodyText = await res.text();
      expect(bodyText).not.toContain("0775745453");
      expect(bodyText).not.toContain(REAL_OVH_INBOUND.message);
      const parsed = JSON.parse(bodyText) as { error: { message: string } };
      expect(parsed.error.message).toBe("Données invalides.");
    });

    it("401 token invalide → la réponse ne contient PAS le token attendu ni reçu", async () => {
      const res = await POST(buildJsonRequest(REAL_OVH_INBOUND, { token: "wrong-secret-xxx" }));

      expect(res.status).toBe(401);
      const bodyText = await res.text();
      expect(bodyText).not.toContain(VALID_TOKEN);
      expect(bodyText).not.toContain("wrong-secret-xxx");
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Ordre : rate-limit AVANT token, token AVANT parse
  // ───────────────────────────────────────────────────────────────────────

  describe("ordre des couches défensives", () => {
    it("rate-limit court-circuite AVANT vérif token (protection brute-force)", async () => {
      setupRateLimiter({
        success: false,
        remaining: 0,
        resetAt: Date.now() + 60_000,
        reason: "rate_limited",
      });

      // Token invalide ET rate-limit dépassé → doit renvoyer 429 (pas 401)
      const res = await POST(buildJsonRequest(REAL_OVH_INBOUND, { token: "wrong-secret" }));

      expect(res.status).toBe(429);
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it("token invalide court-circuite AVANT parse body (économie CPU + anti-leak)", async () => {
      // Body invalide (id absent) ET token invalide → doit renvoyer 401 (pas 400)
      const res = await POST(
        buildJsonRequest(
          { sender: "+33775745453", message: "test" }, // id absent → serait 400
          { token: "wrong-secret" },
        ),
      );

      expect(res.status).toBe(401);
      expect(mockInngestSend).not.toHaveBeenCalled();
    });
  });
});
