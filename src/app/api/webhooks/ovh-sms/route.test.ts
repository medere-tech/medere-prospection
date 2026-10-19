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

const {
  mockRateLimitCheck,
  mockInngestSend,
  mockGetOvhEnv,
  mockGetSlackEnv,
  mockGetCoreEnv,
  mockAddOrphan,
  mockSendInactiveNotif,
  mockCaptureMonitoringWarning,
  mockAppendAuditLog,
} = vi.hoisted(() => ({
  mockRateLimitCheck: vi.fn(),
  mockInngestSend: vi.fn(),
  mockGetOvhEnv: vi.fn(),
  mockGetSlackEnv: vi.fn(),
  mockGetCoreEnv: vi.fn(),
  mockAddOrphan: vi.fn(),
  mockSendInactiveNotif: vi.fn(),
  mockCaptureMonitoringWarning: vi.fn(),
  mockAppendAuditLog: vi.fn(),
}));

// ─────────────────────────────────────────────────────────────────────────────
// vi.mock (hoistés automatiquement en tête)
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("@/lib/security/env", () => ({
  getOvhEnv: mockGetOvhEnv,
  getSlackEnv: mockGetSlackEnv,
  getCoreEnv: mockGetCoreEnv,
  // BUG-DEDUP-RACE : safeExternalIdHash -> hashPii -> getAuditEnv().AUDIT_PII_PEPPER.
  // Pepper fixe pour determinisme des tests event.id.
  getAuditEnv: () => ({ AUDIT_PII_PEPPER: "x".repeat(64) }),
}));

vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: vi.fn(() => ({ check: mockRateLimitCheck })),
}));

vi.mock("@/lib/inngest/client", () => ({
  getInngestClient: vi.fn(() => ({ send: mockInngestSend })),
}));

vi.mock("@/lib/firestore/audit-log", () => ({
  appendAuditLog: mockAppendAuditLog,
}));

vi.mock("@/lib/firestore/orphan-inbounds", () => ({
  addOrphanInboundIdempotent: mockAddOrphan,
}));

vi.mock("@/lib/slack/notify-inbound-on-inactive-conversation", () => ({
  sendInboundOnInactiveConversationNotification: mockSendInactiveNotif,
}));

vi.mock("@/lib/utils/observability", () => ({
  captureMonitoringWarning: mockCaptureMonitoringWarning,
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
    mockGetSlackEnv.mockReturnValue({
      SLACK_ORPHAN_LEADS_CHANNEL_ID: "C0ORPHAN",
    });
    mockGetCoreEnv.mockReturnValue({ NEXT_PUBLIC_APP_URL: "https://dashboard.test" });
    setupRateLimiter({ success: true });
    mockInngestSend.mockResolvedValue({ ids: ["evt_xxx"] });
    mockAddOrphan.mockResolvedValue({ docId: "oih_orphan_test_12345", created: true });
    mockSendInactiveNotif.mockResolvedValue({ ts: "orphan.ts", channel: "C0ORPHAN", kind: "send" });
    mockAppendAuditLog.mockResolvedValue("audit-id");
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

    it("event.id est deterministe sms.reply.<hash> (fix BUG-DEDUP-RACE A)", async () => {
      // Depuis BUG-DEDUP-RACE : event.id est forge DELIBEREMENT a partir
      // d'un hash HMAC + chunking de ovhMessageId (regle events.ts:70
      // "hash HMAC-SHA256 d'un tuple sensible AUTORISE"). Permet la dedup
      // 60s native Inngest sur les retries OVH.
      await POST(buildFormRequest(REAL_CALLBACK_FIELDS));

      const event = mockInngestSend.mock.calls[0]?.[0] as { id?: string };
      expect(event.id).toBeDefined();
      // Format strict : prefixe + hash chunke (oih_XXXX_XXXX_...).
      expect(event.id).toMatch(/^sms\.reply\.oih_([a-f0-9]{1,4}_){7}[a-f0-9]{1,4}$/);
      // ANTI-PII : pas d'ovhMessageId brut, pas de phone, pas de body
      // dans l'event.id (defense-in-depth events.ts:49-73).
      expect(event.id).not.toContain("118791103"); // ovhMessageId brut
      expect(event.id).not.toContain("33775745453"); // phone brut
      expect(event.id).not.toContain("Medere"); // body brut
    });

    it("3 retries OVH avec meme ovhMessageId -> MEME event.id (fix BUG-DEDUP-RACE A)", async () => {
      // Scenario prod 16/10 : OVH a envoye 3 appels webhook en ~1s pour
      // UN SEUL SMS. Avec event.id deterministe, Inngest dedupe les 2
      // doublons sur une fenetre 60s AVANT que le pipeline process-reply
      // ne soit lance.
      await POST(buildFormRequest(REAL_CALLBACK_FIELDS));
      await POST(buildFormRequest(REAL_CALLBACK_FIELDS));
      await POST(buildFormRequest(REAL_CALLBACK_FIELDS));

      expect(mockInngestSend).toHaveBeenCalledTimes(3);
      const id1 = (mockInngestSend.mock.calls[0]?.[0] as { id?: string }).id;
      const id2 = (mockInngestSend.mock.calls[1]?.[0] as { id?: string }).id;
      const id3 = (mockInngestSend.mock.calls[2]?.[0] as { id?: string }).id;
      expect(id1).toBe(id2);
      expect(id2).toBe(id3);
    });

    it("ovhMessageIds differents -> event.id differents (anti-collision)", async () => {
      await POST(buildFormRequest(REAL_CALLBACK_FIELDS));
      await POST(buildFormRequest({ ...REAL_CALLBACK_FIELDS, id: "999999999" }));

      const id1 = (mockInngestSend.mock.calls[0]?.[0] as { id?: string }).id;
      const id2 = (mockInngestSend.mock.calls[1]?.[0] as { id?: string }).id;
      expect(id1).not.toBe(id2);
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

    it("Finding 7 : body malforme + token INVALIDE -> 401, RIEN stocke, RIEN notifie", async () => {
      // Preuve que le path non authentifie court-circuite TOTALEMENT :
      // meme si le body est illisible (parse_failed potentiel), aucun
      // orphan n'est stocke et aucune notif Slack n'est postee tant que
      // le token n'est pas valide. Le path W3/W4 "token valide + parse_failed"
      // vit uniquement derriere le gate token (anti-amplification DoS
      // post-leak secret — complement du finding security-reviewer MED-1).
      const url = new URL("https://medere.example/api/webhooks/ovh-sms");
      url.searchParams.set("token", "wrong-secret");
      const req = new NextRequest(url, {
        method: "POST",
        body: "{this is also broken json",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.42",
        },
      });

      const res = await POST(req);

      expect(res.status).toBe(401);
      // Preuves : aucun side-effect downstream.
      expect(mockInngestSend).not.toHaveBeenCalled();
      expect(mockAddOrphan).not.toHaveBeenCalled();
      expect(mockSendInactiveNotif).not.toHaveBeenCalled();
      expect(mockAppendAuditLog).not.toHaveBeenCalled();
      // Pas d'alerte Sentry orphan (le parse n'a jamais tourne).
      const parseFailedSentry = mockCaptureMonitoringWarning.mock.calls.find(
        (c) => c[0] === "ovh_webhook.parse_failed",
      );
      expect(parseFailedSentry).toBeUndefined();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 200 orphan — PR-NO-DROPPED-SMS (W3/W4 payload illisible token valide)
  // ───────────────────────────────────────────────────────────────────────

  describe("200 orphan storage (W3/W4) — token VALIDE + payload illisible", () => {
    // Finding 7 PR-NO-DROPPED-SMS : les tests ci-dessous envoient
    // `?token=${VALID_TOKEN}` (via buildFormRequest/buildJsonRequest par
    // defaut, qui definit `url.searchParams.set("token", opts.token ?? VALID_TOKEN)`).
    // La route accepte alors la requete (token valide, pas de rate-limit
    // unauth, pas de 401), tente le parse, echoue -> orphan + canal +
    // Sentry error + 200. Si quelqu'un passait `{token: null}` ou
    // `{token: "wrong"}`, la route ferait 401 avant parse (test couvert
    // dans le describe "401 token verification" plus haut).

    it("Finding 4 — audit inbound_on_inactive_conversation pose sur W3/W4/W5/W6 (parse_failed + enqueue_failed)", async () => {
      // W3 parse_failed
      const url = new URL("https://medere.example/api/webhooks/ovh-sms");
      url.searchParams.set("token", VALID_TOKEN);
      await POST(
        new NextRequest(url, {
          method: "POST",
          body: "{not valid json",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": "203.0.113.42",
          },
        }),
      );
      expect(mockAppendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "inbound_on_inactive_conversation",
          targetType: "message",
          payload: expect.objectContaining({
            reason: "parse_failed",
            wasOptOut: false,
            notifiedVia: "orphan_channel",
          }),
        }),
      );

      // W5/W6 enqueue_failed
      mockAppendAuditLog.mockClear();
      mockInngestSend.mockRejectedValueOnce(new Error("INNGEST_HS"));
      await POST(buildFormRequest({ ...REAL_CALLBACK_FIELDS, message: "STOP" }));
      expect(mockAppendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "inbound_on_inactive_conversation",
          payload: expect.objectContaining({
            reason: "enqueue_failed",
            wasOptOut: true,
            phoneHash: expect.stringMatching(/^hph_/),
          }),
        }),
      );
    });

    it("body JSON malformé → 200 + orphan reason=parse_failed + canal Slack + Sentry error", async () => {
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

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
      expect(mockInngestSend).not.toHaveBeenCalled();

      // Orphan stocke avec reason=parse_failed
      expect(mockAddOrphan).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "parse_failed",
          source: "webhook-ovh-sms",
        }),
      );

      // Notif canal orphelins
      expect(mockSendInactiveNotif).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { kind: "channel", channelId: "C0ORPHAN" },
          reason: "parse_failed",
        }),
      );

      // Sentry level=error
      const sentryCall = mockCaptureMonitoringWarning.mock.calls.find(
        (c) => c[0] === "ovh_webhook.parse_failed",
      );
      expect(sentryCall).toBeDefined();
      expect((sentryCall![1] as { level: string }).level).toBe("error");
    });

    it("shape invalide (champ id absent) → 200 + orphan reason=parse_failed (W4 Zod)", async () => {
      const withoutId: Record<string, string> = { ...REAL_CALLBACK_FIELDS };
      delete withoutId.id;
      const res = await POST(buildFormRequest(withoutId));

      expect(res.status).toBe(200);
      expect(mockInngestSend).not.toHaveBeenCalled();
      expect(mockAddOrphan).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "parse_failed", source: "webhook-ovh-sms" }),
      );
    });

    it("senderid absent → 200 + orphan reason=parse_failed", async () => {
      const withoutSenderid: Record<string, string> = { ...REAL_CALLBACK_FIELDS };
      delete withoutSenderid.senderid;
      const res = await POST(buildFormRequest(withoutSenderid));

      expect(res.status).toBe(200);
      expect(mockInngestSend).not.toHaveBeenCalled();
      expect(mockAddOrphan).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "parse_failed" }),
      );
    });

    it("senderid non-normalisable → 200 + orphan reason=parse_failed", async () => {
      const res = await POST(
        buildFormRequest({ ...REAL_CALLBACK_FIELDS, senderid: "notaphonenumber" }),
      );

      expect(res.status).toBe(200);
      expect(mockInngestSend).not.toHaveBeenCalled();
      expect(mockAddOrphan).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "parse_failed" }),
      );
    });

    it("message vide → 200 + orphan reason=parse_failed", async () => {
      const res = await POST(buildFormRequest({ ...REAL_CALLBACK_FIELDS, message: "" }));

      expect(res.status).toBe(200);
      expect(mockInngestSend).not.toHaveBeenCalled();
      expect(mockAddOrphan).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "parse_failed" }),
      );
    });

    it("format LEGACY 'sender' → 200 + orphan reason=parse_failed (sentinelle anti-regression)", async () => {
      // Sentinelle : si demain quelqu'un remet accidentellement le format
      // GET incoming (`sender`) au lieu du callback push (`senderid`), le
      // parse Zod echoue -> orphan stocke, canal alerte, pas de drop silent.
      const res = await POST(
        buildFormRequest({
          id: "42",
          sender: "+33775745453",
          message: "test",
        } as unknown as Record<string, string>),
      );

      expect(res.status).toBe(200);
      expect(mockInngestSend).not.toHaveBeenCalled();
      expect(mockAddOrphan).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "parse_failed" }),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 429 rate-limit — PR-NO-DROPPED-SMS W1 : seulement sur token invalide
  // ───────────────────────────────────────────────────────────────────────

  describe("429 rate-limit anti-bruteforce (W1 — token invalide uniquement)", () => {
    it("token invalide + rate-limit sature → 429 + Retry-After", async () => {
      setupRateLimiter({
        success: false,
        remaining: 0,
        resetAt: Date.now() + 30_000,
        reason: "rate_limited",
      });

      const res = await POST(buildFormRequest(REAL_CALLBACK_FIELDS, { token: "wrong" }));

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("RATE_LIMITED");
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it("Retry-After >= 1 seconde meme si resetAt expire (garde-fou)", async () => {
      setupRateLimiter({
        success: false,
        remaining: 0,
        resetAt: Date.now() - 5000,
        reason: "rate_limited",
      });

      const res = await POST(buildFormRequest(REAL_CALLBACK_FIELDS, { token: "wrong" }));

      expect(res.status).toBe(429);
      const retryAfter = Number.parseInt(res.headers.get("Retry-After") ?? "0", 10);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
    });

    it("fail-closed sur panne rate-limiter (token invalide)", async () => {
      setupRateLimiter({
        success: false,
        remaining: 0,
        resetAt: Date.now() + 60_000,
        reason: "rate_limiter_unavailable",
      });

      const res = await POST(buildFormRequest(REAL_CALLBACK_FIELDS, { token: "wrong" }));

      expect(res.status).toBe(429);
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it("token VALIDE + rate-limit sature -> PAS 429, continue (W1 appels OVH authentifies jamais limites)", async () => {
      // Nouvelle semantique PR-NO-DROPPED-SMS : le rate-limit observed sur
      // token valide ne bloque jamais, il emet seulement un Sentry warning.
      setupRateLimiter({
        success: false,
        remaining: 0,
        resetAt: Date.now() + 60_000,
        reason: "rate_limited",
      });

      const res = await POST(buildFormRequest(REAL_CALLBACK_FIELDS));

      expect(res.status).toBe(200);
      expect(mockInngestSend).toHaveBeenCalled();
      // Sentry warning compteur anomalie (log d'observabilite, pas bloquant)
      const observedWarn = mockCaptureMonitoringWarning.mock.calls.find(
        (c) => c[0] === "ovh_webhook.high_rate_authenticated",
      );
      expect(observedWarn).toBeDefined();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // W5/W6 — fix compliance-auditor HIGH : wasOptOut detecte sur enqueue_failed
  // ───────────────────────────────────────────────────────────────────────

  describe("W5/W6 enqueue_failed — wasOptOut detecte si body contient STOP (fix HIGH)", () => {
    it("inngest.send rejette + body='STOP' -> orphan wasOptOut=true + canal avec signal + Sentry tag was_opt_out=true", async () => {
      // Simule Inngest HS (ex: panne cloud au moment ou un PS envoie STOP).
      mockInngestSend.mockRejectedValueOnce(new Error("INNGEST_UNAVAILABLE"));

      const res = await POST(
        buildFormRequest({
          ...REAL_CALLBACK_FIELDS,
          message: "STOP",
        }),
      );

      expect(res.status).toBe(500);

      // Orphan stocke avec wasOptOut=true (correlation forensic).
      expect(mockAddOrphan).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "enqueue_failed",
          source: "webhook-ovh-sms",
          wasOptOut: true,
        }),
      );

      // Canal orphelins notifie avec wasOptOut=true -> le formatter rend
      // la section "Desabonnement detecte dans le texte" visible pour l'humain.
      expect(mockSendInactiveNotif).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "enqueue_failed",
          wasOptOut: true,
          target: { kind: "channel", channelId: "C0ORPHAN" },
        }),
      );

      // Sentry tag was_opt_out=true pour pagination astreinte prioritaire.
      const sentryCall = mockCaptureMonitoringWarning.mock.calls.find(
        (c) => c[0] === "ovh_webhook.enqueue_failed",
      );
      expect(sentryCall).toBeDefined();
      const sentryOpts = sentryCall![1] as { tags: { was_opt_out: string } };
      expect(sentryOpts.tags.was_opt_out).toBe("true");
    });

    it("inngest.send rejette + body non-STOP -> orphan wasOptOut=false + Sentry tag was_opt_out=false", async () => {
      mockInngestSend.mockRejectedValueOnce(new Error("INNGEST_UNAVAILABLE"));

      const res = await POST(
        buildFormRequest({
          ...REAL_CALLBACK_FIELDS,
          message: "Je rappelle demain, merci",
        }),
      );

      expect(res.status).toBe(500);
      expect(mockAddOrphan).toHaveBeenCalledWith(expect.objectContaining({ wasOptOut: false }));
      expect(mockSendInactiveNotif).toHaveBeenCalledWith(
        expect.objectContaining({ wasOptOut: false }),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Anti-leak
  // ───────────────────────────────────────────────────────────────────────

  describe("anti-leak — reponse n'expose pas le payload hostile", () => {
    it("senderid junk → 200 ack, la reponse ne contient PAS le senderid/message brut", async () => {
      // La route repond 200 ack a OVH (payload stocke en orphelins). La
      // reponse HTTP ne doit JAMAIS contenir le payload hostile — le body
      // de la reponse est juste `{ok: true}`.
      const res = await POST(
        buildFormRequest({ ...REAL_CALLBACK_FIELDS, senderid: "notaphonenumberatall" }),
      );

      expect(res.status).toBe(200);
      const bodyText = await res.text();
      expect(bodyText).not.toContain("notaphonenumberatall");
      expect(bodyText).not.toContain(REAL_CALLBACK_FIELDS.message);
      const parsed = JSON.parse(bodyText) as { ok: boolean };
      expect(parsed.ok).toBe(true);
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
