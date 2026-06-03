import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetEnvCacheForTests } from "@/lib/security/env";
import { ConfigError } from "@/lib/utils/errors";

import { __setOvhClientForTests, getOvhClient, type OvhClient } from "./client";

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

function stubOvhEnv(): void {
  vi.stubEnv("OVH_ENDPOINT", TEST_OVH_ENDPOINT);
  vi.stubEnv("OVH_APP_KEY", TEST_OVH_APP_KEY);
  vi.stubEnv("OVH_APP_SECRET", TEST_OVH_APP_SECRET);
  vi.stubEnv("OVH_CONSUMER_KEY", TEST_OVH_CONSUMER_KEY);
  vi.stubEnv("OVH_SMS_SERVICE_NAME", TEST_OVH_SMS_SERVICE_NAME);
  vi.stubEnv("OVH_SMS_SENDER", TEST_OVH_SMS_SENDER);
  vi.stubEnv("OVH_WEBHOOK_SECRET", TEST_OVH_WEBHOOK_SECRET);
}

/** Capture l'ensemble des champs d'une erreur pour test anti-fuite. */
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
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────
// getOvhClient
// ─────────────────────────────────────────────────────────────────────────────

describe("getOvhClient", () => {
  it("construit le client au premier appel quand l'env est valide", () => {
    stubOvhEnv();
    const c = getOvhClient();
    expect(c).toBeDefined();
    expect(typeof c.requestPromised).toBe("function");
  });

  it("memoize : deux appels successifs retournent la même instance", () => {
    stubOvhEnv();
    const c1 = getOvhClient();
    const c2 = getOvhClient();
    expect(c1).toBe(c2);
  });

  it("throw ConfigError quand OVH_APP_KEY manquante", () => {
    stubOvhEnv();
    vi.stubEnv("OVH_APP_KEY", undefined);
    expect(() => getOvhClient()).toThrow(ConfigError);
  });

  it("throw ConfigError quand OVH_CONSUMER_KEY manquante", () => {
    stubOvhEnv();
    vi.stubEnv("OVH_CONSUMER_KEY", undefined);
    expect(() => getOvhClient()).toThrow(ConfigError);
  });

  it("throw ConfigError quand OVH_ENDPOINT est une valeur invalide (hors enum)", () => {
    stubOvhEnv();
    vi.stubEnv("OVH_ENDPOINT", "not-a-valid-endpoint");
    expect(() => getOvhClient()).toThrow(ConfigError);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // ANTI-FUITE — aucun credential ne doit transiter par les messages d'erreur
  // ───────────────────────────────────────────────────────────────────────────

  it("anti-fuite : aucune valeur de credential dans le message ConfigError (app_secret, consumer_key, webhook_secret)", () => {
    stubOvhEnv();
    vi.stubEnv("OVH_CONSUMER_KEY", undefined);
    try {
      getOvhClient();
      expect.fail("should have thrown");
    } catch (e) {
      const payload = captureErrorPayload(e);
      // Test des 3 secrets — même non en cause directe, ils ne doivent JAMAIS
      // apparaître dans une erreur (garantie défensive contre la fuite latérale).
      expect(payload).not.toContain(TEST_OVH_APP_SECRET);
      expect(payload).not.toContain(TEST_OVH_CONSUMER_KEY);
      expect(payload).not.toContain(TEST_OVH_WEBHOOK_SECRET);
      expect(payload).not.toContain(TEST_OVH_APP_KEY);
    }
  });

  it("anti-fuite : aucune fuite pour endpoint invalide (vérifie sanitisation Zod S2)", () => {
    stubOvhEnv();
    vi.stubEnv("OVH_ENDPOINT", "secret-leaking-bad-endpoint-12345");
    try {
      getOvhClient();
      expect.fail("should have thrown");
    } catch (e) {
      const payload = captureErrorPayload(e);
      // La valeur de l'endpoint invalide ne doit pas remonter dans l'erreur
      // (sanitisation S2 : message = "Invalid env for ovh: OVH_ENDPOINT (invalid_value)").
      expect(payload).not.toContain("secret-leaking-bad-endpoint-12345");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// __setOvhClientForTests — back-door tests
// ─────────────────────────────────────────────────────────────────────────────

describe("__setOvhClientForTests", () => {
  it("injecte un fake utilisable à la place du SDK réel", () => {
    const fake: OvhClient = { requestPromised: vi.fn() };
    __setOvhClientForTests(fake);
    expect(getOvhClient()).toBe(fake);
  });

  it("null reset le cache → prochain getOvhClient() reconstruit via env", () => {
    const fake: OvhClient = { requestPromised: vi.fn() };
    __setOvhClientForTests(fake);
    expect(getOvhClient()).toBe(fake);

    __setOvhClientForTests(null);
    stubOvhEnv();
    const c = getOvhClient();
    expect(c).not.toBe(fake);
    expect(typeof c.requestPromised).toBe("function");
  });

  it("refuse en NODE_ENV !== 'test'", () => {
    vi.stubEnv("NODE_ENV", "production");
    const fake: OvhClient = { requestPromised: vi.fn() };
    expect(() => __setOvhClientForTests(fake)).toThrow(/outside of tests/);
  });

  it("refuse en NODE_ENV='development'", () => {
    vi.stubEnv("NODE_ENV", "development");
    const fake: OvhClient = { requestPromised: vi.fn() };
    expect(() => __setOvhClientForTests(fake)).toThrow(/outside of tests/);
  });
});
