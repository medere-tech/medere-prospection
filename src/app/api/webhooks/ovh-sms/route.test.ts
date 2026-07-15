/**
 * Tests POST /api/webhooks/ovh-sms (S9.6-FIX2, INFRA-SMS-001).
 *
 * Scope : route handler unit (mocks env + rate-limit + inngest). Vérifie :
 *   - 200 sur payload form-urlencoded RÉEL (senderid + id number + ...)
 *     avec inngest.send appelé avec EXACTEMENT {phone, body, ovhMessageId}
 *   - 200 sur payload JSON équivalent (fallback défensif défini dans la route)
 *   - normalisation E.164 via senderid=0612345678 → phone="+33612345678"
 *   - 401 sur token absent / invalide / vide
 *   - 400 sur body malformé / shape invalide / senderid non-normalisable
 *   - 429 sur rate-limit dépassé + header Retry-After
 *   - anti-leak : la réponse d'erreur ne contient jamais le body brut ni
 *     le senderid
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
// Constantes / fixtures — CALLBACK PUSH format (S9.6-FIX2)
// ─────────────────────────────────────────────────────────────────────────────

const VALID_TOKEN = "test-secret-min-16-chars-long-xxx";

/**
 * Payload callback push RÉEL (capturé prod S9.6-FIX). Format
 * `application/x-www-form-urlencoded` côté transport → toutes les valeurs
 * sont des STRINGS quand elles arrivent via `URLSearchParams`. La route
 * convertit `id` string→number (`route.ts:143-144`) avant de passer au
 * parser (qui exige `z.number().int()`).
 */
const REAL_CALLBACK_FIELDS = {
  id: "118791103",
  senderid: "+33775745453",
  message: "Test réception Medere 1",
  keyword: "",
  shortcode: "+33939070545",
  tag: "",
  token: VALID_TOKEN,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Request form-urlencoded — c'est le format RÉEL du callback push OVH.
 * `id` est envoyé en string via URLSearchParams (comme OVH le fait), la
 * route le convertit en number côté `readRawPayload`.
 */
function buildFormRequest(
  fields: Record<string, string>,
  opts: { token?: string | null; ip?: string } = {},
): NextRequest {
  const url = new URL("https://medere.example/api/webhooks/ovh-sms");
  if (opts.token !== null) {
    url.searchParams.set("token", opts.token ?? VALID_TOKEN);
  }
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
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
 * Request JSON — fallback défensif défini dans `readRawPayload` (Content-Type
 * absent ou `application/json`). Le format callback push OVH réel est
 * form-urlencoded ; ce helper couvre le path JSON pour prouver que la route
 * gère aussi ce transport (les valeurs numériques restent native, pas de
 * conversion).
 */
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
  // 200 happy path — callback push réel
  // ───────────────────────────────────────────────────────────────────────

  describe("200 happy path (callback push form-urlencoded)", () => {
    it("payload form-urlencoded réel + token valide → 200 + inngest.send avec {phone, body, ovhMessageId}", async () => {
      const res = await POST(buildFormRequest(REAL_CALLBACK_FIELDS));

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

    it("normalise senderid national FR (0612345678 → +33612345678)", async () => {
      const res = await POST(
        buildFormRequest({
          ...REAL_CALLBACK_FIELDS,
          senderid: "0612345678",
        }),
      );

      expect(res.status).toBe(200);
      const event = mockInngestSend.mock.calls[0]?.[0] as { data: Record<string, unknown> };
      expect(event.data).toMatchObject({ phone: "+33612345678" });
    });

    it("payload JSON équivalent (fallback défensif) → 200 avec id NUMBER natif", async () => {
      const res = await POST(
        buildJsonRequest({
          id: 118791103, // number natif en JSON
          senderid: "+33775745453",
          message: "Test JSON",
        }),
      );

      expect(res.status).toBe(200);
      const event = mockInngestSend.mock.calls[0]?.[0] as { data: Record<string, unknown> };
      expect(event.data).toEqual({
        phone: "+33775745453",
        body: "Test JSON",
        ovhMessageId: "118791103",
      });
    });

    it("event.id NON forgé manuellement (règle anti-PII events.ts:49-73)", async () => {
      await POST(buildFormRequest(REAL_CALLBACK_FIELDS));

      const event = mockInngestSend.mock.calls[0]?.[0] as { id?: string };
      expect(event.id).toBeUndefined();
    });

    it("les champs OVH annexes (keyword/shortcode/tag/token) ne fuitent PAS dans l'event data", async () => {
      await POST(buildFormRequest(REAL_CALLBACK_FIELDS));

      const event = mockInngestSend.mock.calls[0]?.[0] as { data: Record<string, unknown> };
      expect(Object.keys(event.data).sort()).toEqual(["body", "ovhMessageId", "phone"]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 401 authentification (token) — inchangé S9.6-FIX2
  // ───────────────────────────────────────────────────────────────────────

  describe("401 token verification", () => {
    it("renvoie 401 si token absent (query param manquant)", async () => {
      const res = await POST(buildFormRequest(REAL_CALLBACK_FIELDS, { token: null }));

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("UNAUTHORIZED");
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it("renvoie 401 si token invalide (mauvais secret)", async () => {
      const res = await POST(
        buildFormRequest(REAL_CALLBACK_FIELDS, { token: "wrong-secret-not-matching" }),
      );

      expect(res.status).toBe(401);
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it("renvoie 401 si token vide (string vide)", async () => {
      const res = await POST(buildFormRequest(REAL_CALLBACK_FIELDS, { token: "" }));

      expect(res.status).toBe(401);
      expect(mockInngestSend).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 400 shape / parse — nouveaux tests format callback push
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
      const withoutId: Record<string, string> = { ...REAL_CALLBACK_FIELDS };
      delete withoutId.id;
      const res = await POST(buildFormRequest(withoutId));

      expect(res.status).toBe(400);
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it("renvoie 400 si senderid absent", async () => {
      const withoutSenderid: Record<string, string> = { ...REAL_CALLBACK_FIELDS };
      delete withoutSenderid.senderid;
      const res = await POST(buildFormRequest(withoutSenderid));

      expect(res.status).toBe(400);
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it("renvoie 400 si senderid non-normalisable en E.164 (junk string)", async () => {
      const res = await POST(
        buildFormRequest({ ...REAL_CALLBACK_FIELDS, senderid: "notaphonenumber" }),
      );

      expect(res.status).toBe(400);
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it("renvoie 400 si message vide", async () => {
      const res = await POST(buildFormRequest({ ...REAL_CALLBACK_FIELDS, message: "" }));

      expect(res.status).toBe(400);
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it("renvoie 400 anti-régression : format LEGACY 'sender' rejeté (dédié au callback push senderid)", async () => {
      // Sentinelle : si demain quelqu'un remet accidentellement le format
      // GET incoming (champ `sender`) au lieu du callback push (senderid),
      // ce test doit casser.
      const res = await POST(
        buildFormRequest({
          id: "42",
          sender: "+33775745453", // ancien nom de champ
          message: "test",
        } as unknown as Record<string, string>),
      );

      expect(res.status).toBe(400);
      expect(mockInngestSend).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 429 rate-limit — inchangé S9.6-FIX2
  // ───────────────────────────────────────────────────────────────────────

  describe("429 rate-limit", () => {
    it("renvoie 429 + Retry-After + court-circuit total (pas de parse, pas d'inngest.send)", async () => {
      setupRateLimiter({
        success: false,
        remaining: 0,
        resetAt: Date.now() + 30_000,
        reason: "rate_limited",
      });

      const res = await POST(buildFormRequest(REAL_CALLBACK_FIELDS));

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

      const res = await POST(buildFormRequest(REAL_CALLBACK_FIELDS));

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

      const res = await POST(buildFormRequest(REAL_CALLBACK_FIELDS));

      expect(res.status).toBe(429);
      expect(mockInngestSend).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Anti-leak
  // ───────────────────────────────────────────────────────────────────────

  describe("anti-leak — la réponse d'erreur ne fuit rien de sensible", () => {
    it("400 shape invalide → la réponse ne contient PAS le senderid/message brut", async () => {
      // Junk sans aucun chiffre — sinon libphonenumber-js extrait un numéro
      // valide de la string, ce qui ferait passer la normalisation.
      const res = await POST(
        buildFormRequest({ ...REAL_CALLBACK_FIELDS, senderid: "notaphonenumberatall" }),
      );

      expect(res.status).toBe(400);
      const bodyText = await res.text();
      expect(bodyText).not.toContain("notaphonenumberatall");
      expect(bodyText).not.toContain(REAL_CALLBACK_FIELDS.message);
      const parsed = JSON.parse(bodyText) as { error: { message: string } };
      expect(parsed.error.message).toBe("Données invalides.");
    });

    it("401 token invalide → la réponse ne contient PAS le token attendu ni reçu", async () => {
      const res = await POST(buildFormRequest(REAL_CALLBACK_FIELDS, { token: "wrong-secret-xxx" }));

      expect(res.status).toBe(401);
      const bodyText = await res.text();
      expect(bodyText).not.toContain(VALID_TOKEN);
      expect(bodyText).not.toContain("wrong-secret-xxx");
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Ordre des couches défensives
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
      const res = await POST(buildFormRequest(REAL_CALLBACK_FIELDS, { token: "wrong-secret" }));

      expect(res.status).toBe(429);
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it("token invalide court-circuite AVANT parse body (économie CPU + anti-leak)", async () => {
      // Body invalide (id absent) ET token invalide → doit renvoyer 401 (pas 400)
      const withoutId: Record<string, string> = { ...REAL_CALLBACK_FIELDS };
      delete withoutId.id;
      const res = await POST(buildFormRequest(withoutId, { token: "wrong-secret" }));

      expect(res.status).toBe(401);
      expect(mockInngestSend).not.toHaveBeenCalled();
    });
  });
});
