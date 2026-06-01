import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigError } from "@/lib/utils/errors";

import {
  __resetEnvCacheForTests,
  getAnthropicEnv,
  getAuditEnv,
  getClerkEnv,
  getCoreEnv,
  getFirebaseEnv,
  getHubspotEnv,
  getInngestEnv,
  getLushaEnv,
  getOvhEnv,
  getSentryEnv,
  getSlackEnv,
  getTwilioEnv,
  getUpstashEnv,
  validateAllEnvNow,
} from "./env";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Stub un set d'env vars en une passe ; undefined = supprime. */
function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    vi.stubEnv(k, v);
  }
}

/**
 * Capture TOUT ce qu'une erreur pourrait porter (message, cause, stack,
 * champs énumérables) en une string sérialisée. Sert au test anti-fuite.
 */
function captureErrorPayload(e: unknown): string {
  if (!(e instanceof Error)) return JSON.stringify(e);
  return JSON.stringify({
    message: e.message,
    cause: e.cause,
    stack: e.stack,
    ...(e as object),
  });
}

beforeEach(() => {
  __resetEnvCacheForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────
// CORE
// ─────────────────────────────────────────────────────────────────────────────

describe("getCoreEnv", () => {
  it("ok avec NODE_ENV seul (les autres sont optionnels)", () => {
    setEnv({
      NODE_ENV: "test",
      NEXT_PUBLIC_APP_URL: undefined,
      APP_SECRET: undefined,
    });
    expect(getCoreEnv().NODE_ENV).toBe("test");
    expect(getCoreEnv().NEXT_PUBLIC_APP_URL).toBeUndefined();
    expect(getCoreEnv().APP_SECRET).toBeUndefined();
  });

  it("ok avec URL et secret valides", () => {
    setEnv({
      NODE_ENV: "production",
      NEXT_PUBLIC_APP_URL: "https://app.medere.fr",
      APP_SECRET: "a".repeat(32),
    });
    const env = getCoreEnv();
    expect(env.NEXT_PUBLIC_APP_URL).toBe("https://app.medere.fr");
    expect(env.APP_SECRET).toHaveLength(32);
  });

  it("throws si NODE_ENV manquant", () => {
    setEnv({ NODE_ENV: undefined });
    expect(() => getCoreEnv()).toThrow(ConfigError);
  });

  it("throws si NODE_ENV hors enum", () => {
    setEnv({ NODE_ENV: "staging" });
    expect(() => getCoreEnv()).toThrow(ConfigError);
  });

  it("throws si APP_SECRET < 32 chars (mais présent)", () => {
    setEnv({ NODE_ENV: "test", APP_SECRET: "short" });
    expect(() => getCoreEnv()).toThrow(ConfigError);
  });

  it("throws si NEXT_PUBLIC_APP_URL n'est pas une URL valide", () => {
    setEnv({ NODE_ENV: "test", NEXT_PUBLIC_APP_URL: "not-a-url" });
    expect(() => getCoreEnv()).toThrow(ConfigError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ANTHROPIC
// ─────────────────────────────────────────────────────────────────────────────

describe("getAnthropicEnv", () => {
  it("ok avec clé bien formée", () => {
    setEnv({ ANTHROPIC_API_KEY: "sk-ant-fake-test-key-1234567890" });
    expect(getAnthropicEnv().ANTHROPIC_API_KEY).toMatch(/^sk-ant-/);
  });

  it("throws si manquante", () => {
    setEnv({ ANTHROPIC_API_KEY: undefined });
    expect(() => getAnthropicEnv()).toThrow(ConfigError);
  });

  it("throws si préfixe incorrect", () => {
    setEnv({ ANTHROPIC_API_KEY: "wrong-prefix-1234" });
    expect(() => getAnthropicEnv()).toThrow(ConfigError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OVH
// ─────────────────────────────────────────────────────────────────────────────

const OVH_VALID = {
  OVH_ENDPOINT: "ovh-eu",
  OVH_APP_KEY: "appkey-x",
  OVH_APP_SECRET: "appsecret-x",
  OVH_CONSUMER_KEY: "consumer-x",
  OVH_SMS_SERVICE_NAME: "sms-ab12345-1",
  OVH_SMS_SENDER: "Medere",
  OVH_WEBHOOK_SECRET: "a".repeat(16),
} as const;

describe("getOvhEnv", () => {
  it("ok avec config complète", () => {
    setEnv(OVH_VALID);
    expect(getOvhEnv().OVH_SMS_SENDER).toBe("Medere");
  });

  it("throws si endpoint hors enum", () => {
    setEnv({ ...OVH_VALID, OVH_ENDPOINT: "ovh-fr" });
    expect(() => getOvhEnv()).toThrow(ConfigError);
  });

  it("throws si OVH_SMS_SENDER > 11 chars (limite OVH)", () => {
    setEnv({ ...OVH_VALID, OVH_SMS_SENDER: "MedereTooLong" });
    expect(() => getOvhEnv()).toThrow(ConfigError);
  });

  it("throws si OVH_WEBHOOK_SECRET < 16 chars", () => {
    setEnv({ ...OVH_VALID, OVH_WEBHOOK_SECRET: "short" });
    expect(() => getOvhEnv()).toThrow(ConfigError);
  });

  it("throws si APP_KEY vide", () => {
    setEnv({ ...OVH_VALID, OVH_APP_KEY: "" });
    expect(() => getOvhEnv()).toThrow(ConfigError);
  });

  it("throws si plusieurs vars manquantes (message liste tous les champs)", () => {
    setEnv({
      OVH_ENDPOINT: undefined,
      OVH_APP_KEY: undefined,
      OVH_APP_SECRET: undefined,
      OVH_CONSUMER_KEY: undefined,
      OVH_SMS_SERVICE_NAME: undefined,
      OVH_SMS_SENDER: undefined,
      OVH_WEBHOOK_SECRET: undefined,
    });
    try {
      getOvhEnv();
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const err = e as ConfigError;
      expect(err.message).toContain("OVH_ENDPOINT");
      expect(err.message).toContain("OVH_WEBHOOK_SECRET");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TWILIO
// ─────────────────────────────────────────────────────────────────────────────

describe("getTwilioEnv", () => {
  const SID = "AC" + "x".repeat(32); // 34 chars total
  const TOKEN = "y".repeat(32);

  it("ok avec SID et token bien formés", () => {
    setEnv({ TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN });
    expect(getTwilioEnv().TWILIO_ACCOUNT_SID).toBe(SID);
  });

  it("throws si SID sans préfixe AC", () => {
    setEnv({ TWILIO_ACCOUNT_SID: "XX" + "x".repeat(32), TWILIO_AUTH_TOKEN: TOKEN });
    expect(() => getTwilioEnv()).toThrow(ConfigError);
  });

  it("throws si SID mauvaise longueur", () => {
    setEnv({ TWILIO_ACCOUNT_SID: "ACtooshort", TWILIO_AUTH_TOKEN: TOKEN });
    expect(() => getTwilioEnv()).toThrow(ConfigError);
  });

  it("throws si AUTH_TOKEN trop court", () => {
    setEnv({ TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: "short" });
    expect(() => getTwilioEnv()).toThrow(ConfigError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HUBSPOT
// ─────────────────────────────────────────────────────────────────────────────

describe("getHubspotEnv", () => {
  it("ok avec ACCESS_TOKEN seul (PORTAL_ID optional)", () => {
    setEnv({
      HUBSPOT_ACCESS_TOKEN: "pat-eu1-fake-token",
      HUBSPOT_PORTAL_ID: undefined,
    });
    expect(getHubspotEnv().HUBSPOT_PORTAL_ID).toBeUndefined();
  });

  it("ok avec PORTAL_ID numérique", () => {
    setEnv({
      HUBSPOT_ACCESS_TOKEN: "pat-eu1-fake-token",
      HUBSPOT_PORTAL_ID: "12345678",
    });
    expect(getHubspotEnv().HUBSPOT_PORTAL_ID).toBe("12345678");
  });

  it("throws si PORTAL_ID non numérique (fourni mais mal formé)", () => {
    setEnv({
      HUBSPOT_ACCESS_TOKEN: "pat-eu1-fake-token",
      HUBSPOT_PORTAL_ID: "abc123",
    });
    expect(() => getHubspotEnv()).toThrow(ConfigError);
  });

  it("throws si ACCESS_TOKEN sans préfixe pat-", () => {
    setEnv({ HUBSPOT_ACCESS_TOKEN: "bearer-xyz" });
    expect(() => getHubspotEnv()).toThrow(ConfigError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LUSHA
// ─────────────────────────────────────────────────────────────────────────────

describe("getLushaEnv", () => {
  it("ok", () => {
    setEnv({ LUSHA_API_KEY: "key-1" });
    expect(getLushaEnv().LUSHA_API_KEY).toBe("key-1");
  });

  it("throws si manquante", () => {
    setEnv({ LUSHA_API_KEY: undefined });
    expect(() => getLushaEnv()).toThrow(ConfigError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SLACK
// ─────────────────────────────────────────────────────────────────────────────

describe("getSlackEnv", () => {
  const SLACK_OK = {
    SLACK_BOT_TOKEN: "xoxb-fake-token",
    SLACK_SIGNING_SECRET: "signsecret",
  };

  it("ok avec required seuls (handoff + user_ids optional)", () => {
    setEnv({
      ...SLACK_OK,
      SLACK_HANDOFF_CHANNEL_ID: undefined,
      SLACK_USER_IDS: undefined,
    });
    const env = getSlackEnv();
    expect(env.SLACK_HANDOFF_CHANNEL_ID).toBeUndefined();
    expect(env.SLACK_USER_IDS).toBeUndefined();
  });

  it("ok avec handoff channel et user_ids JSON valides", () => {
    setEnv({
      ...SLACK_OK,
      SLACK_HANDOFF_CHANNEL_ID: "C0123ABC",
      SLACK_USER_IDS: JSON.stringify({ dentaire: "U05UVHGBURX" }),
    });
    expect(getSlackEnv().SLACK_USER_IDS).toEqual({ dentaire: "U05UVHGBURX" });
  });

  it("throws si BOT_TOKEN sans préfixe xoxb-", () => {
    setEnv({ ...SLACK_OK, SLACK_BOT_TOKEN: "wrong-prefix" });
    expect(() => getSlackEnv()).toThrow(ConfigError);
  });

  it("throws si HANDOFF_CHANNEL_ID mal formé", () => {
    setEnv({ ...SLACK_OK, SLACK_HANDOFF_CHANNEL_ID: "not-a-channel" });
    expect(() => getSlackEnv()).toThrow(ConfigError);
  });

  it("throws si USER_IDS n'est pas un JSON valide", () => {
    setEnv({ ...SLACK_OK, SLACK_USER_IDS: "not json" });
    expect(() => getSlackEnv()).toThrow(ConfigError);
  });

  it("throws si USER_IDS est un JSON array (pas un object)", () => {
    setEnv({ ...SLACK_OK, SLACK_USER_IDS: "[]" });
    expect(() => getSlackEnv()).toThrow(ConfigError);
  });

  it("throws si USER_IDS est un JSON object avec valeurs non-string", () => {
    setEnv({ ...SLACK_OK, SLACK_USER_IDS: '{"a": 123}' });
    expect(() => getSlackEnv()).toThrow(ConfigError);
  });

  it("throws si USER_IDS est null", () => {
    setEnv({ ...SLACK_OK, SLACK_USER_IDS: "null" });
    expect(() => getSlackEnv()).toThrow(ConfigError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIREBASE
// ─────────────────────────────────────────────────────────────────────────────

describe("getFirebaseEnv", () => {
  const FB_OK = {
    FIREBASE_PROJECT_ID: "medere-demo",
    FIREBASE_CLIENT_EMAIL: "sa@medere-demo.iam.gserviceaccount.com",
    FIREBASE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nABCDEF\\n-----END PRIVATE KEY-----\\n",
  };

  it("ok et transforme les \\n échappés en sauts de ligne réels", () => {
    setEnv(FB_OK);
    const env = getFirebaseEnv();
    expect(env.FIREBASE_PRIVATE_KEY).toContain("\n");
    expect(env.FIREBASE_PRIVATE_KEY).not.toContain("\\n");
    expect(env.FIREBASE_PRIVATE_KEY).toContain("PRIVATE KEY");
  });

  it("throws si CLIENT_EMAIL n'est pas un email", () => {
    setEnv({ ...FB_OK, FIREBASE_CLIENT_EMAIL: "pas-un-email" });
    expect(() => getFirebaseEnv()).toThrow(ConfigError);
  });

  it("throws si PRIVATE_KEY ne contient pas PRIVATE KEY", () => {
    setEnv({ ...FB_OK, FIREBASE_PRIVATE_KEY: "random-string" });
    expect(() => getFirebaseEnv()).toThrow(ConfigError);
  });

  it("throws si PROJECT_ID vide", () => {
    setEnv({ ...FB_OK, FIREBASE_PROJECT_ID: "" });
    expect(() => getFirebaseEnv()).toThrow(ConfigError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INNGEST
// ─────────────────────────────────────────────────────────────────────────────

describe("getInngestEnv", () => {
  it("ok", () => {
    setEnv({
      INNGEST_EVENT_KEY: "evt-key",
      INNGEST_SIGNING_KEY: "signkey-1234567890",
    });
    expect(getInngestEnv().INNGEST_SIGNING_KEY).toMatch(/^signkey-/);
  });

  it("throws si SIGNING_KEY sans préfixe signkey-", () => {
    setEnv({
      INNGEST_EVENT_KEY: "evt-key",
      INNGEST_SIGNING_KEY: "wrong-format",
    });
    expect(() => getInngestEnv()).toThrow(ConfigError);
  });

  it("throws si EVENT_KEY manquant", () => {
    setEnv({
      INNGEST_EVENT_KEY: undefined,
      INNGEST_SIGNING_KEY: "signkey-1",
    });
    expect(() => getInngestEnv()).toThrow(ConfigError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SENTRY (toutes vars optionnelles — S8 différée)
// ─────────────────────────────────────────────────────────────────────────────

describe("getSentryEnv", () => {
  it("ok sans aucune var (S8 différée)", () => {
    setEnv({ SENTRY_DSN: undefined, NEXT_PUBLIC_SENTRY_DSN: undefined });
    const env = getSentryEnv();
    expect(env.SENTRY_DSN).toBeUndefined();
    expect(env.NEXT_PUBLIC_SENTRY_DSN).toBeUndefined();
  });

  it("ok avec DSN valides", () => {
    setEnv({
      SENTRY_DSN: "https://abc@o0.ingest.sentry.io/1",
      NEXT_PUBLIC_SENTRY_DSN: "https://def@o0.ingest.sentry.io/2",
    });
    expect(getSentryEnv().SENTRY_DSN).toMatch(/^https:/);
  });

  it("throws si DSN fourni mais non-URL", () => {
    setEnv({ SENTRY_DSN: "not-a-url" });
    expect(() => getSentryEnv()).toThrow(ConfigError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UPSTASH
// ─────────────────────────────────────────────────────────────────────────────

describe("getUpstashEnv", () => {
  it("ok", () => {
    setEnv({
      UPSTASH_REDIS_REST_URL: "https://us1-foo.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "token-x",
    });
    expect(getUpstashEnv().UPSTASH_REDIS_REST_TOKEN).toBe("token-x");
  });

  it("throws si REST_URL n'est pas une URL", () => {
    setEnv({
      UPSTASH_REDIS_REST_URL: "not-a-url",
      UPSTASH_REDIS_REST_TOKEN: "token-x",
    });
    expect(() => getUpstashEnv()).toThrow(ConfigError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLERK
// ─────────────────────────────────────────────────────────────────────────────

describe("getClerkEnv", () => {
  it("ok", () => {
    setEnv({
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_fake",
      CLERK_SECRET_KEY: "sk_test_fake",
    });
    expect(getClerkEnv().CLERK_SECRET_KEY).toMatch(/^sk_/);
  });

  it("throws si PUBLISHABLE_KEY sans préfixe pk_", () => {
    setEnv({
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "wrong",
      CLERK_SECRET_KEY: "sk_test_fake",
    });
    expect(() => getClerkEnv()).toThrow(ConfigError);
  });

  it("throws si SECRET_KEY sans préfixe sk_", () => {
    setEnv({
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_fake",
      CLERK_SECRET_KEY: "wrong",
    });
    expect(() => getClerkEnv()).toThrow(ConfigError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SANITISATION — LE TEST CRITIQUE ANTI-FUITE
// ─────────────────────────────────────────────────────────────────────────────

describe("sanitisation : aucune valeur secrète ne fuit dans l'erreur", () => {
  it("ANTHROPIC_API_KEY mal formée : valeur absente de message/cause/stack/champs", () => {
    const REAL_LEAK_VALUE = "sk-real-secret-1234abcd-DO-NOT-LEAK";
    setEnv({ ANTHROPIC_API_KEY: REAL_LEAK_VALUE });
    try {
      getAnthropicEnv();
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const payload = captureErrorPayload(e);
      expect(payload).not.toContain(REAL_LEAK_VALUE);
      // Ce que le message DOIT contenir : nom du champ + code Zod
      expect((e as ConfigError).message).toContain("ANTHROPIC_API_KEY");
      // cause volontairement undefined (la ZodError porte la valeur)
      expect((e as ConfigError).cause).toBeUndefined();
    }
  });

  it("HUBSPOT_ACCESS_TOKEN mal formé : aucune fuite", () => {
    const REAL_LEAK_VALUE = "pat-real-leaked-hubspot-token-xyz";
    setEnv({ HUBSPOT_ACCESS_TOKEN: REAL_LEAK_VALUE });
    try {
      getHubspotEnv();
      expect.fail("should have thrown");
    } catch (e) {
      expect(captureErrorPayload(e)).not.toContain(REAL_LEAK_VALUE);
    }
  });

  it("SLACK_BOT_TOKEN mal formé : aucune fuite", () => {
    const REAL_LEAK_VALUE = "xoxa-real-token-leaked";
    setEnv({
      SLACK_BOT_TOKEN: REAL_LEAK_VALUE,
      SLACK_SIGNING_SECRET: "secret",
    });
    try {
      getSlackEnv();
      expect.fail("should have thrown");
    } catch (e) {
      expect(captureErrorPayload(e)).not.toContain(REAL_LEAK_VALUE);
    }
  });

  it("SLACK_USER_IDS JSON malformé : contenu JSON absent du message d'erreur", () => {
    const REAL_LEAK_JSON = '{"secret_specialty": "U_REAL_USER_ID_LEAKED"}';
    setEnv({
      SLACK_BOT_TOKEN: "xoxb-x",
      SLACK_SIGNING_SECRET: "x",
      SLACK_USER_IDS: REAL_LEAK_JSON + ",,,broken",
    });
    try {
      getSlackEnv();
      expect.fail("should have thrown");
    } catch (e) {
      expect(captureErrorPayload(e)).not.toContain("U_REAL_USER_ID_LEAKED");
    }
  });

  it("FIREBASE_PRIVATE_KEY pourrie : la valeur n'apparaît nulle part", () => {
    const REAL_LEAK_VALUE = "FAKE_BUT_LOOKS_LIKE_PRIVATE_DATA_xxx";
    setEnv({
      FIREBASE_PROJECT_ID: "p",
      FIREBASE_CLIENT_EMAIL: "sa@p.iam.gserviceaccount.com",
      FIREBASE_PRIVATE_KEY: REAL_LEAK_VALUE,
    });
    try {
      getFirebaseEnv();
      expect.fail("should have thrown");
    } catch (e) {
      expect(captureErrorPayload(e)).not.toContain(REAL_LEAK_VALUE);
    }
  });

  it("message porte le nom du service et les champs en faute", () => {
    setEnv({
      OVH_ENDPOINT: undefined,
      OVH_APP_KEY: undefined,
      OVH_APP_SECRET: undefined,
      OVH_CONSUMER_KEY: undefined,
      OVH_SMS_SERVICE_NAME: undefined,
      OVH_SMS_SENDER: undefined,
      OVH_WEBHOOK_SECRET: undefined,
    });
    try {
      getOvhEnv();
    } catch (e) {
      const err = e as ConfigError;
      expect(err.message).toMatch(/^Invalid env for ovh:/);
      expect(err.context).toMatchObject({ service: "ovh" });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CACHE / MEMOIZATION
// ─────────────────────────────────────────────────────────────────────────────

describe("cache et reset", () => {
  it("memoize : un changement d'env après premier appel n'affecte pas le résultat", () => {
    setEnv({ LUSHA_API_KEY: "first-value" });
    const first = getLushaEnv();
    expect(first.LUSHA_API_KEY).toBe("first-value");

    setEnv({ LUSHA_API_KEY: "second-value" });
    const second = getLushaEnv();
    expect(second.LUSHA_API_KEY).toBe("first-value"); // toujours la 1re
    expect(second).toBe(first); // même référence (preuve du cache)
  });

  it("__resetEnvCacheForTests vide le cache et force le re-parse", () => {
    setEnv({ LUSHA_API_KEY: "first" });
    getLushaEnv();

    setEnv({ LUSHA_API_KEY: "second" });
    __resetEnvCacheForTests();
    expect(getLushaEnv().LUSHA_API_KEY).toBe("second");
  });

  it("__resetEnvCacheForTests throws si appelé hors environnement test (garde runtime)", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => __resetEnvCacheForTests()).toThrow(/outside of tests/);
  });

  it("un échec ne pollue PAS le cache (un retry après fix doit réussir)", () => {
    setEnv({ LUSHA_API_KEY: undefined });
    expect(() => getLushaEnv()).toThrow(ConfigError);

    setEnv({ LUSHA_API_KEY: "now-valid" });
    expect(getLushaEnv().LUSHA_API_KEY).toBe("now-valid");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT (HMAC pepper pour hashPii — irréversibilité forensic)
// ─────────────────────────────────────────────────────────────────────────────

describe("getAuditEnv", () => {
  it("ok avec pepper >= 32 chars", () => {
    setEnv({ AUDIT_PII_PEPPER: "a".repeat(64) });
    expect(getAuditEnv().AUDIT_PII_PEPPER).toHaveLength(64);
  });

  it("throws si AUDIT_PII_PEPPER manquant (jamais optional, fail-fast)", () => {
    setEnv({ AUDIT_PII_PEPPER: undefined });
    expect(() => getAuditEnv()).toThrow(ConfigError);
  });

  it("throws si AUDIT_PII_PEPPER < 32 chars (force entropie minimum)", () => {
    setEnv({ AUDIT_PII_PEPPER: "tooshort" });
    expect(() => getAuditEnv()).toThrow(ConfigError);
  });

  it("erreur SANITISÉE : ne fuite ni la valeur ni le pattern attendu", () => {
    // Régression critique : si on logge ConfigError dans Sentry, on ne
    // doit JAMAIS voir la valeur du pepper (même partielle), même quand
    // c'est juste "tooshort" — par principe.
    const secret = "leaked-pepper-value-do-not-log-me-x";
    setEnv({ AUDIT_PII_PEPPER: "short" });
    try {
      getAuditEnv();
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const payload = captureErrorPayload(e);
      expect(payload).not.toContain("short");
      expect(payload).not.toContain(secret);
      // En revanche on doit voir le NOM du champ (debug aidé).
      expect(payload).toContain("AUDIT_PII_PEPPER");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateAllEnvNow
// ─────────────────────────────────────────────────────────────────────────────

describe("validateAllEnvNow", () => {
  it("rapporte 'ok' pour les services configurés, liste les champs pour les autres", () => {
    // On configure 2 services proprement, on laisse les autres en panne.
    setEnv({
      NODE_ENV: "test",
      LUSHA_API_KEY: "key",
      // Anthropic, OVH, etc. sont undefined ou mal formés.
      ANTHROPIC_API_KEY: undefined,
      OVH_ENDPOINT: undefined,
      OVH_APP_KEY: undefined,
      OVH_APP_SECRET: undefined,
      OVH_CONSUMER_KEY: undefined,
      OVH_SMS_SERVICE_NAME: undefined,
      OVH_SMS_SENDER: undefined,
      OVH_WEBHOOK_SECRET: undefined,
      TWILIO_ACCOUNT_SID: undefined,
      TWILIO_AUTH_TOKEN: undefined,
      HUBSPOT_ACCESS_TOKEN: undefined,
      SLACK_BOT_TOKEN: undefined,
      SLACK_SIGNING_SECRET: undefined,
      FIREBASE_PROJECT_ID: undefined,
      FIREBASE_CLIENT_EMAIL: undefined,
      FIREBASE_PRIVATE_KEY: undefined,
      INNGEST_EVENT_KEY: undefined,
      INNGEST_SIGNING_KEY: undefined,
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: undefined,
      CLERK_SECRET_KEY: undefined,
      AUDIT_PII_PEPPER: undefined,
    });

    const report = validateAllEnvNow();
    expect(report.core).toBe("ok");
    expect(report.lusha).toBe("ok");
    expect(report.sentry).toBe("ok"); // toutes optionnelles
    expect(report.anthropic).not.toBe("ok");
    expect(Array.isArray(report.anthropic)).toBe(true);
    expect(report.ovh).not.toBe("ok");
    expect(report.firebase).not.toBe("ok");
    expect(report.audit).not.toBe("ok"); // requis (jamais optional)
    expect(Array.isArray(report.audit)).toBe(true);
  });

  it("propage une erreur non-ConfigError sans l'absorber (filet anti-bug)", () => {
    // Injection d'un service custom qui throw une erreur générique :
    // valide que validateAllEnvNow ne masque PAS un bug interne en faisant
    // passer le rapport pour "ok".
    expect(() =>
      validateAllEnvNow([
        {
          name: "core",
          fn: () => {
            throw new Error("unexpected internal bug");
          },
        },
      ]),
    ).toThrow("unexpected internal bug");
  });
});
