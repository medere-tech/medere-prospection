import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetEnvCacheForTests } from "@/lib/security/env";
import {
  ConfigError,
  ExternalServiceError,
  InternalError,
  RateLimitError,
  ValidationError,
} from "@/lib/utils/errors";

import { __setOvhClientForTests, type OvhClient } from "./client";
import { sendSms } from "./send-sms";
import type { SmsPayload } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes nommées — aucun credential réel (contrainte S7a.3 [2])
// ─────────────────────────────────────────────────────────────────────────────

const TEST_OVH_ENDPOINT = "ovh-eu";
const TEST_OVH_APP_KEY = "test-app-key-fake";
const TEST_OVH_APP_SECRET = "test-app-secret-fake";
const TEST_OVH_CONSUMER_KEY = "test-consumer-key-fake";
const TEST_OVH_SMS_SERVICE_NAME = "sms-test-fake";
const TEST_OVH_SMS_SENDER = "MedereTest";
const TEST_OVH_WEBHOOK_SECRET = "test-webhook-secret-fake-min-16chars";

const TEST_RECEIVER = "+33612345678";
const TEST_MESSAGE = "Bonjour Dr X, formation DPC ANDPC. Intéressé ? STOP pour arrêter.";

function stubOvhEnv(): void {
  vi.stubEnv("OVH_ENDPOINT", TEST_OVH_ENDPOINT);
  vi.stubEnv("OVH_APP_KEY", TEST_OVH_APP_KEY);
  vi.stubEnv("OVH_APP_SECRET", TEST_OVH_APP_SECRET);
  vi.stubEnv("OVH_CONSUMER_KEY", TEST_OVH_CONSUMER_KEY);
  vi.stubEnv("OVH_SMS_SERVICE_NAME", TEST_OVH_SMS_SERVICE_NAME);
  vi.stubEnv("OVH_SMS_SENDER", TEST_OVH_SMS_SENDER);
  vi.stubEnv("OVH_WEBHOOK_SECRET", TEST_OVH_WEBHOOK_SECRET);
}

function makeFakeClient(): {
  client: OvhClient;
  requestPromised: ReturnType<typeof vi.fn>;
} {
  const requestPromised = vi.fn();
  return { client: { requestPromised }, requestPromised };
}

function makeOkResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ids: [42],
    totalCreditsRemoved: 1,
    validReceivers: [TEST_RECEIVER],
    invalidReceivers: [],
    ...overrides,
  };
}

/** Capture tous les champs d'une erreur (anti-fuite). */
function captureErrorPayload(e: unknown): string {
  if (!(e instanceof Error)) return JSON.stringify(e);
  return JSON.stringify({
    message: e.message,
    cause: (e as { cause?: unknown }).cause,
    stack: e.stack,
    context: (e as { context?: unknown }).context,
    ...(e as object),
  });
}

beforeEach(() => {
  __setOvhClientForTests(null);
  __resetEnvCacheForTests();
  stubOvhEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy paths
// ─────────────────────────────────────────────────────────────────────────────

describe("sendSms — happy paths", () => {
  it("retourne SmsResult avec messageIds string + creditsRemoved", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockResolvedValueOnce(
      makeOkResponse({ ids: [42, 43], validReceivers: [TEST_RECEIVER, "+33611111111"] }),
    );
    __setOvhClientForTests(client);

    const result = await sendSms({
      receivers: [TEST_RECEIVER, "+33611111111"],
      message: TEST_MESSAGE,
    });

    expect(result.messageIds).toEqual(["42", "43"]);
    expect(result.creditsRemoved).toBe(1);
  });

  it("convertit ids: number[] → string[] (cohérence Firestore messages.externalId)", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockResolvedValueOnce(makeOkResponse({ ids: [12345678901234] }));
    __setOvhClientForTests(client);

    const result = await sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE });
    expect(result.messageIds).toEqual(["12345678901234"]);
    expect(result.messageIds.every((id) => typeof id === "string")).toBe(true);
  });

  it("appelle le SDK avec POST + path /sms/{serviceName}/jobs", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockResolvedValueOnce(makeOkResponse());
    __setOvhClientForTests(client);

    await sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE });

    expect(requestPromised).toHaveBeenCalledOnce();
    const [method, path] = requestPromised.mock.calls[0]!;
    expect(method).toBe("POST");
    expect(path).toBe(`/sms/${TEST_OVH_SMS_SERVICE_NAME}/jobs`);
  });

  it("envoie sender depuis l'env (anti-spoofing — pas paramétrable)", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockResolvedValueOnce(makeOkResponse());
    __setOvhClientForTests(client);

    await sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE });

    const body = requestPromised.mock.calls[0]![2] as { sender: string };
    expect(body.sender).toBe(TEST_OVH_SMS_SENDER);
  });

  it("change de sender si OVH_SMS_SENDER change dans l'env (cohérence config-driven)", async () => {
    vi.stubEnv("OVH_SMS_SENDER", "OtherSender");
    __resetEnvCacheForTests();

    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockResolvedValueOnce(makeOkResponse());
    __setOvhClientForTests(client);

    await sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE });

    const body = requestPromised.mock.calls[0]![2] as { sender: string };
    expect(body.sender).toBe("OtherSender");
  });

  it("envoie noStopClause: false (filet OVH actif — décision MVP S7a.3)", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockResolvedValueOnce(makeOkResponse());
    __setOvhClientForTests(client);

    await sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE });

    const body = requestPromised.mock.calls[0]![2] as { noStopClause: boolean };
    expect(body.noStopClause).toBe(false);
  });

  it("envoie class: 1 (SMS standard, lu destinataire)", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockResolvedValueOnce(makeOkResponse());
    __setOvhClientForTests(client);

    await sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE });

    const body = requestPromised.mock.calls[0]![2] as { class: number };
    expect(body.class).toBe(1);
  });

  it("envoie validityPeriod: 2880 minutes (48h default)", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockResolvedValueOnce(makeOkResponse());
    __setOvhClientForTests(client);

    await sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE });

    const body = requestPromised.mock.calls[0]![2] as { validityPeriod: number };
    expect(body.validityPeriod).toBe(2880);
  });

  it("propage receivers et message au SDK", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockResolvedValueOnce(makeOkResponse());
    __setOvhClientForTests(client);

    await sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE });

    const body = requestPromised.mock.calls[0]![2] as {
      message: string;
      receivers: string[];
    };
    expect(body.message).toBe(TEST_MESSAGE);
    expect(body.receivers).toEqual([TEST_RECEIVER]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation INPUT
// ─────────────────────────────────────────────────────────────────────────────

describe("sendSms — validation INPUT", () => {
  it("body vide → ValidationError, SDK non appelé", async () => {
    const { client, requestPromised } = makeFakeClient();
    __setOvhClientForTests(client);

    await expect(sendSms({ receivers: [TEST_RECEIVER], message: "" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(requestPromised).not.toHaveBeenCalled();
  });

  it("body = 1600 chars (BODY_MAX_LENGTH cohérence S6.5) → accepté", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockResolvedValueOnce(makeOkResponse());
    __setOvhClientForTests(client);

    const message = "x".repeat(1600);
    const result = await sendSms({ receivers: [TEST_RECEIVER], message });
    expect(result.messageIds).toEqual(["42"]);
  });

  it("body = 1601 chars → ValidationError AVANT SDK", async () => {
    const { client, requestPromised } = makeFakeClient();
    __setOvhClientForTests(client);

    const message = "x".repeat(1601);
    await expect(sendSms({ receivers: [TEST_RECEIVER], message })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(requestPromised).not.toHaveBeenCalled();
  });

  it("receivers vide → ValidationError, SDK non appelé", async () => {
    const { client, requestPromised } = makeFakeClient();
    __setOvhClientForTests(client);

    await expect(sendSms({ receivers: [], message: TEST_MESSAGE })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(requestPromised).not.toHaveBeenCalled();
  });

  it("receivers contenant string vide → ValidationError", async () => {
    const { client, requestPromised } = makeFakeClient();
    __setOvhClientForTests(client);

    await expect(
      sendSms({ receivers: ["+33612345678", ""], message: TEST_MESSAGE }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(requestPromised).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // M3 — strictObject anti-spoofing (4e filet de défense)
  // ──────────────────────────────────────────────────────────────────────────

  it("[M3] cast forcé d'un payload avec 'sender' inconnu → ValidationError, SDK non appelé", async () => {
    const { client, requestPromised } = makeFakeClient();
    __setOvhClientForTests(client);

    // Simule un caller buggué qui force le cast TS (copy-paste depuis un
    // autre wrapper qui aurait un `sender`, par exemple). `z.strictObject`
    // doit REFUSER explicitement, pas silencieusement strip.
    await expect(
      sendSms({
        receivers: [TEST_RECEIVER],
        message: TEST_MESSAGE,
        sender: "PHISH",
      } as unknown as SmsPayload),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(requestPromised).not.toHaveBeenCalled();
  });

  it("[M3] cast forcé avec autre champ inconnu ('class', 'sourceAddr') → ValidationError", async () => {
    const { client, requestPromised } = makeFakeClient();
    __setOvhClientForTests(client);

    await expect(
      sendSms({
        receivers: [TEST_RECEIVER],
        message: TEST_MESSAGE,
        class: 0,
      } as unknown as SmsPayload),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      sendSms({
        receivers: [TEST_RECEIVER],
        message: TEST_MESSAGE,
        sourceAddr: "fake",
      } as unknown as SmsPayload),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(requestPromised).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // B4 — borne haute receivers.max(1000)
  // ──────────────────────────────────────────────────────────────────────────

  it("[B4] receivers.length = 1000 (borne incluse) → accepté", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockResolvedValueOnce({
      ids: Array.from({ length: 1000 }, (_, i) => i + 1),
      totalCreditsRemoved: 1000,
      validReceivers: Array.from(
        { length: 1000 },
        (_, i) => `+3361234${String(i).padStart(4, "0")}`,
      ),
      invalidReceivers: [],
    });
    __setOvhClientForTests(client);

    const receivers = Array.from(
      { length: 1000 },
      (_, i) => `+3361234${String(i).padStart(4, "0")}`,
    );
    const result = await sendSms({ receivers, message: TEST_MESSAGE });
    expect(result.messageIds).toHaveLength(1000);
  });

  it("[B4] receivers.length = 1001 → ValidationError AVANT SDK", async () => {
    const { client, requestPromised } = makeFakeClient();
    __setOvhClientForTests(client);

    const receivers = Array.from(
      { length: 1001 },
      (_, i) => `+3361234${String(i).padStart(4, "0")}`,
    );
    await expect(sendSms({ receivers, message: TEST_MESSAGE })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(requestPromised).not.toHaveBeenCalled();
  });

  it("anti-fuite : ValidationError ne propage pas la valeur invalide", async () => {
    const { client } = makeFakeClient();
    __setOvhClientForTests(client);

    const sensitiveMessage = "Mon numéro perso 0612345678 ne devrait pas fuiter";
    try {
      await sendSms({ receivers: [], message: sensitiveMessage });
      expect.fail("should have thrown");
    } catch (e) {
      const payload = captureErrorPayload(e);
      // Le message est valide mais on a vide receivers : la valeur reste
      // dans le payload Zod mais NE doit PAS remonter dans l'erreur.
      expect(payload).not.toContain("0612345678");
      expect(payload).not.toContain(sensitiveMessage);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mapping erreurs SDK (HTTP status numbers)
// ─────────────────────────────────────────────────────────────────────────────

describe("sendSms — mapping erreurs SDK HTTP", () => {
  it("401 → ConfigError noRetry", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockRejectedValueOnce({ error: 401, message: "Bad signature" });
    __setOvhClientForTests(client);

    try {
      await sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).noRetry).toBe(true);
      expect((e as ConfigError).context?.status).toBe(401);
    }
  });

  it("403 → ConfigError noRetry", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockRejectedValueOnce({ error: 403, message: "Forbidden" });
    __setOvhClientForTests(client);

    await expect(
      sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("400 → ConfigError (payload mal formé = bug code)", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockRejectedValueOnce({ error: 400, message: "Invalid sender" });
    __setOvhClientForTests(client);

    try {
      await sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toMatch(/bad input/i);
    }
  });

  it("404 → ConfigError (serviceName inexistant)", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockRejectedValueOnce({ error: 404, message: "Not found" });
    __setOvhClientForTests(client);

    try {
      await sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toMatch(/route or service/i);
    }
  });

  it("429 → RateLimitError (retry-friendly)", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockRejectedValueOnce({ error: 429, message: "Too many" });
    __setOvhClientForTests(client);

    try {
      await sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RateLimitError);
      expect((e as RateLimitError).context?.status).toBe(429);
    }
  });

  it("500 → ExternalServiceError", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockRejectedValueOnce({ error: 500, message: "Boom" });
    __setOvhClientForTests(client);

    await expect(
      sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE }),
    ).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("503 → ExternalServiceError", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockRejectedValueOnce({ error: 503, message: "Unavailable" });
    __setOvhClientForTests(client);

    await expect(
      sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE }),
    ).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("410 (4xx catch-all non spécifique) → ConfigError", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockRejectedValueOnce({ error: 410, message: "Gone" });
    __setOvhClientForTests(client);

    try {
      await sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toMatch(/client error/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mapping erreurs SDK (errno réseau / OAuth / shape inconnu)
// ─────────────────────────────────────────────────────────────────────────────

describe("sendSms — mapping erreurs SDK non-HTTP", () => {
  it("errno réseau 'ENOTFOUND' (string) → ExternalServiceError", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockRejectedValueOnce({ error: "ENOTFOUND" });
    __setOvhClientForTests(client);

    try {
      await sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExternalServiceError);
      expect((e as ExternalServiceError).context?.errno).toBe("ENOTFOUND");
    }
  });

  it("errno réseau 'ETIMEDOUT' (string) → ExternalServiceError", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockRejectedValueOnce({ error: "ETIMEDOUT" });
    __setOvhClientForTests(client);

    await expect(
      sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE }),
    ).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("OAuth-like object (rare en appKey mode) → ExternalServiceError", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockRejectedValueOnce({
      error: { statusCode: 401, error: "token_expired" },
    });
    __setOvhClientForTests(client);

    try {
      await sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExternalServiceError);
      expect((e as ExternalServiceError).context?.kind).toBe("oauth-error");
    }
  });

  it("reject avec shape inattendu (pas OvhReject) → InternalError", async () => {
    const { client, requestPromised } = makeFakeClient();
    // Pas un OvhReject — pas de propriété `error`.
    requestPromised.mockRejectedValueOnce(new Error("Random JS error"));
    __setOvhClientForTests(client);

    try {
      await sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InternalError);
    }
  });

  it("reject avec OvhReject mais error = null → InternalError (shape catch-all)", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockRejectedValueOnce({ error: null });
    __setOvhClientForTests(client);

    await expect(
      sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE }),
    ).rejects.toBeInstanceOf(InternalError);
  });

  it("reject avec OvhReject mais error = boolean (cas non couvert) → InternalError", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockRejectedValueOnce({ error: true });
    __setOvhClientForTests(client);

    await expect(
      sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE }),
    ).rejects.toBeInstanceOf(InternalError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// invalidReceivers / no valid receivers (réponse 200 mais partielle)
// ─────────────────────────────────────────────────────────────────────────────

describe("sendSms — gestion invalidReceivers / no valid receivers", () => {
  it("invalidReceivers.length > 0 → ValidationError reason='ovh_rejected_receivers'", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockResolvedValueOnce(
      makeOkResponse({
        ids: [42],
        validReceivers: [TEST_RECEIVER],
        invalidReceivers: ["+33600000000"],
      }),
    );
    __setOvhClientForTests(client);

    try {
      await sendSms({
        receivers: [TEST_RECEIVER, "+33600000000"],
        message: TEST_MESSAGE,
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      const ctx = (e as ValidationError).context;
      expect(ctx?.reason).toBe("ovh_rejected_receivers");
      expect(ctx?.invalidReceivers).toEqual(["+33600000000"]);
      expect(ctx?.validReceivers).toEqual([TEST_RECEIVER]);
    }
  });

  it("validReceivers vide + invalidReceivers vide (edge) → ValidationError reason='no_valid_receivers'", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockResolvedValueOnce(
      makeOkResponse({ ids: [], validReceivers: [], invalidReceivers: [] }),
    );
    __setOvhClientForTests(client);

    try {
      await sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).context?.reason).toBe("no_valid_receivers");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Réponse SDK shape inattendu
// ─────────────────────────────────────────────────────────────────────────────

describe("sendSms — réponse SDK shape inattendu", () => {
  it("réponse manquant 'ids' → ExternalServiceError", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockResolvedValueOnce({
      totalCreditsRemoved: 1,
      validReceivers: [TEST_RECEIVER],
      invalidReceivers: [],
    });
    __setOvhClientForTests(client);

    try {
      await sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExternalServiceError);
      expect((e as ExternalServiceError).message).toMatch(/unexpected shape/i);
    }
  });

  it("réponse ids: string[] au lieu de number[] → ExternalServiceError", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockResolvedValueOnce(makeOkResponse({ ids: ["42"] }));
    __setOvhClientForTests(client);

    await expect(
      sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE }),
    ).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("réponse null → ExternalServiceError", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockResolvedValueOnce(null);
    __setOvhClientForTests(client);

    await expect(
      sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE }),
    ).rejects.toBeInstanceOf(ExternalServiceError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ANTI-FUITE — credentials + PII jamais dans les erreurs
// ─────────────────────────────────────────────────────────────────────────────

describe("sendSms — anti-fuite credentials & PII", () => {
  it("aucun credential ne fuit dans une erreur 401 (anti-fuite SDK message)", async () => {
    const { client, requestPromised } = makeFakeClient();
    // Le SDK pourrait propager le consumer key tronqué dans `message`.
    // On simule en injectant les credentials dans le message rejeté.
    requestPromised.mockRejectedValueOnce({
      error: 401,
      message: `Bad signature for consumerKey=${TEST_OVH_CONSUMER_KEY} secret=${TEST_OVH_APP_SECRET}`,
    });
    __setOvhClientForTests(client);

    try {
      await sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE });
      expect.fail("should have thrown");
    } catch (e) {
      const payload = captureErrorPayload(e);
      expect(payload).not.toContain(TEST_OVH_CONSUMER_KEY);
      expect(payload).not.toContain(TEST_OVH_APP_SECRET);
      expect(payload).not.toContain(TEST_OVH_APP_KEY);
      expect(payload).not.toContain(TEST_OVH_WEBHOOK_SECRET);
    }
  });

  it("aucun receiver / message ne fuit dans une erreur 500", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockRejectedValueOnce({ error: 500, message: "Internal" });
    __setOvhClientForTests(client);

    try {
      await sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE });
      expect.fail("should have thrown");
    } catch (e) {
      const payload = captureErrorPayload(e);
      // Le receiver et le body NE doivent JAMAIS apparaître dans le contexte
      // d'erreur côté wrapper (cf. JSDoc send-sms — `mapOvhError` ne propage
      // que op + service + status).
      expect(payload).not.toContain(TEST_RECEIVER);
      expect(payload).not.toContain(TEST_MESSAGE);
    }
  });

  it("aucun receiver ne fuit dans une erreur de validation Zod sur réponse SDK", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised.mockResolvedValueOnce({ wrong: "shape" });
    __setOvhClientForTests(client);

    try {
      await sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE });
      expect.fail("should have thrown");
    } catch (e) {
      const payload = captureErrorPayload(e);
      expect(payload).not.toContain(TEST_RECEIVER);
      expect(payload).not.toContain(TEST_MESSAGE);
    }
  });

  // Note : pour le cas invalidReceivers, c'est volontaire d'avoir les
  // receivers dans le context (forensic compliance) — pas un anti-fuite.
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotence — non gérée côté wrapper
// ─────────────────────────────────────────────────────────────────────────────

describe("sendSms — idempotence absente du wrapper", () => {
  it("appelée 2 fois avec le même payload → 2 appels SDK distincts (pas de dedup interne)", async () => {
    const { client, requestPromised } = makeFakeClient();
    requestPromised
      .mockResolvedValueOnce(makeOkResponse({ ids: [1] }))
      .mockResolvedValueOnce(makeOkResponse({ ids: [2] }));
    __setOvhClientForTests(client);

    const r1 = await sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE });
    const r2 = await sendSms({ receivers: [TEST_RECEIVER], message: TEST_MESSAGE });

    expect(requestPromised).toHaveBeenCalledTimes(2);
    expect(r1.messageIds).toEqual(["1"]);
    expect(r2.messageIds).toEqual(["2"]);
  });
});
