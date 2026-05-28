import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ValidationError } from "@/lib/utils/errors";

import {
  SLACK_REPLAY_WINDOW_SECONDS,
  timingSafeStringEqual,
  verifyHmacSignature,
  verifyOvhWebhookToken,
  verifySlackSignature,
} from "./webhook-signatures";

// ─────────────────────────────────────────────────────────────────────────────
// timingSafeStringEqual — primitif anti-bypass
// ─────────────────────────────────────────────────────────────────────────────

describe("timingSafeStringEqual", () => {
  it("vrai pour deux chaînes identiques non vides", () => {
    expect(timingSafeStringEqual("abc123", "abc123")).toBe(true);
  });

  it("faux pour deux chaînes différentes de même longueur", () => {
    expect(timingSafeStringEqual("abc123", "abc124")).toBe(false);
  });

  it("faux pour des chaînes de longueurs différentes (sans throw)", () => {
    expect(timingSafeStringEqual("abc", "abcdef")).toBe(false);
    expect(timingSafeStringEqual("abcdef", "abc")).toBe(false);
  });

  /*
   * ANTI-BYPASS — comportement contre-intuitif mais voulu :
   * `"" === ""` est `true` en algèbre, mais ici on retourne `false`.
   * Justification : un secret attendu mal configuré à "" ne doit JAMAIS
   * valider — sinon un attaquant qui n'envoie pas de token passerait.
   * Un futur dev pourrait être tenté de "corriger" → ne PAS le faire.
   * Ces 3 tests verrouillent l'intention.
   */
  it("ANTI-BYPASS : deux chaînes vides → false (jamais d'égalité avec vide)", () => {
    expect(timingSafeStringEqual("", "")).toBe(false);
  });

  it("ANTI-BYPASS : expected vide → false", () => {
    expect(timingSafeStringEqual("", "received-token")).toBe(false);
  });

  it("ANTI-BYPASS : received vide → false", () => {
    expect(timingSafeStringEqual("expected-token", "")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verifySlackSignature — HMAC SHA-256 + anti-replay 5 min
// ─────────────────────────────────────────────────────────────────────────────

/** Helper : signe un body Slack-style avec le secret donné. */
function slackSign(signingSecret: string, timestamp: string, body: string): string {
  const base = `v0:${timestamp}:${body}`;
  return `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
}

describe("verifySlackSignature", () => {
  const SECRET = "slack-signing-secret-test";
  const BODY = JSON.stringify({ token: "x", team_id: "T1", challenge: "abc" });
  // Horloge figée à un timestamp connu pour les tests.
  const FIXED_NOW_MS = 1_780_000_000_000; // 2026-05-28 environ
  const FIXED_NOW_SEC = Math.floor(FIXED_NOW_MS / 1000);
  const now = () => FIXED_NOW_MS;

  it("vrai pour signature + timestamp valides", () => {
    const ts = String(FIXED_NOW_SEC);
    const sig = slackSign(SECRET, ts, BODY);
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: ts,
        signature: sig,
        rawBody: BODY,
        now,
      }),
    ).toBe(true);
  });

  it("faux si timestamp > 5 min dans le passé (anti-replay)", () => {
    const ts = String(FIXED_NOW_SEC - SLACK_REPLAY_WINDOW_SECONDS - 1);
    const sig = slackSign(SECRET, ts, BODY);
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: ts,
        signature: sig,
        rawBody: BODY,
        now,
      }),
    ).toBe(false);
  });

  it("faux si timestamp > 5 min dans le futur (clock skew)", () => {
    const ts = String(FIXED_NOW_SEC + SLACK_REPLAY_WINDOW_SECONDS + 1);
    const sig = slackSign(SECRET, ts, BODY);
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: ts,
        signature: sig,
        rawBody: BODY,
        now,
      }),
    ).toBe(false);
  });

  it("vrai aux bornes exactes (±5 min)", () => {
    const tsPast = String(FIXED_NOW_SEC - SLACK_REPLAY_WINDOW_SECONDS);
    const tsFuture = String(FIXED_NOW_SEC + SLACK_REPLAY_WINDOW_SECONDS);
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: tsPast,
        signature: slackSign(SECRET, tsPast, BODY),
        rawBody: BODY,
        now,
      }),
    ).toBe(true);
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: tsFuture,
        signature: slackSign(SECRET, tsFuture, BODY),
        rawBody: BODY,
        now,
      }),
    ).toBe(true);
  });

  it("faux si body altéré d'un seul caractère", () => {
    const ts = String(FIXED_NOW_SEC);
    const sig = slackSign(SECRET, ts, BODY);
    const tamperedBody = BODY.replace("abc", "abd");
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: ts,
        signature: sig,
        rawBody: tamperedBody,
        now,
      }),
    ).toBe(false);
  });

  it("faux si signature altérée d'un seul caractère", () => {
    const ts = String(FIXED_NOW_SEC);
    const sig = slackSign(SECRET, ts, BODY);
    // Flip le dernier caractère.
    const tampered = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: ts,
        signature: tampered,
        rawBody: BODY,
        now,
      }),
    ).toBe(false);
  });

  it("faux si la signature n'a pas le préfixe v0=", () => {
    const ts = String(FIXED_NOW_SEC);
    // HMAC valide mais sans le préfixe v0=
    const hexOnly = createHmac("sha256", SECRET).update(`v0:${ts}:${BODY}`).digest("hex");
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: ts,
        signature: hexOnly,
        rawBody: BODY,
        now,
      }),
    ).toBe(false);
  });

  it("faux si timestamp n'est pas un entier valide", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: "not-a-number",
        signature: slackSign(SECRET, "not-a-number", BODY),
        rawBody: BODY,
        now,
      }),
    ).toBe(false);
  });

  it("faux si signingSecret vide", () => {
    const ts = String(FIXED_NOW_SEC);
    expect(
      verifySlackSignature({
        signingSecret: "",
        timestamp: ts,
        signature: "v0=anything",
        rawBody: BODY,
        now,
      }),
    ).toBe(false);
  });

  it("faux si timestamp est null (header absent)", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: null,
        signature: "v0=anything",
        rawBody: BODY,
        now,
      }),
    ).toBe(false);
  });

  it("faux si signature est null (header absent)", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: String(FIXED_NOW_SEC),
        signature: null,
        rawBody: BODY,
        now,
      }),
    ).toBe(false);
  });

  it("utilise Date.now() par défaut si `now` non fourni", () => {
    // Pas de mock : on prend l'horloge réelle. Le test vérifie juste que
    // la fonction ne throw pas et accepte un timestamp = maintenant.
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = slackSign(SECRET, ts, BODY);
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: ts,
        signature: sig,
        rawBody: BODY,
      }),
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verifyOvhWebhookToken — shared secret query param
// ─────────────────────────────────────────────────────────────────────────────

describe("verifyOvhWebhookToken", () => {
  it("vrai pour token reçu = token attendu", () => {
    expect(
      verifyOvhWebhookToken({
        expected: "ovh-webhook-secret-16chars",
        received: "ovh-webhook-secret-16chars",
      }),
    ).toBe(true);
  });

  it("faux pour token reçu différent", () => {
    expect(
      verifyOvhWebhookToken({
        expected: "ovh-webhook-secret-16chars",
        received: "ovh-webhook-wrong-token-xx",
      }),
    ).toBe(false);
  });

  it("faux si token reçu null (query param absent)", () => {
    expect(
      verifyOvhWebhookToken({
        expected: "ovh-webhook-secret-16chars",
        received: null,
      }),
    ).toBe(false);
  });

  it("faux si token reçu undefined", () => {
    expect(
      verifyOvhWebhookToken({
        expected: "ovh-webhook-secret-16chars",
        received: undefined,
      }),
    ).toBe(false);
  });

  it("ANTI-BYPASS : faux si expected vide (mal configuré)", () => {
    expect(verifyOvhWebhookToken({ expected: "", received: "any-token" })).toBe(false);
    // Et même contre vide-vs-vide
    expect(verifyOvhWebhookToken({ expected: "", received: "" })).toBe(false);
  });

  it("faux pour longueurs différentes (constant-time, pas de throw)", () => {
    expect(
      verifyOvhWebhookToken({
        expected: "long-expected-token-16chars",
        received: "short",
      }),
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verifyHmacSignature — HMAC générique
// ─────────────────────────────────────────────────────────────────────────────

describe("verifyHmacSignature", () => {
  const SECRET = "shared-secret";
  const BODY = '{"event":"hello"}';

  it("vrai pour HMAC SHA-256 valide (défaut)", () => {
    const sig = createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(verifyHmacSignature({ secret: SECRET, body: BODY, signature: sig })).toBe(true);
  });

  it("vrai pour HMAC SHA-512", () => {
    const sig = createHmac("sha512", SECRET).update(BODY).digest("hex");
    expect(
      verifyHmacSignature({
        secret: SECRET,
        body: BODY,
        signature: sig,
        algorithm: "sha512",
      }),
    ).toBe(true);
  });

  it("vrai pour encodage base64", () => {
    const sig = createHmac("sha256", SECRET).update(BODY).digest("base64");
    expect(
      verifyHmacSignature({
        secret: SECRET,
        body: BODY,
        signature: sig,
        encoding: "base64",
      }),
    ).toBe(true);
  });

  it("faux si body altéré", () => {
    const sig = createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(
      verifyHmacSignature({
        secret: SECRET,
        body: BODY + " ",
        signature: sig,
      }),
    ).toBe(false);
  });

  it("faux si secret vide (anti-bypass)", () => {
    expect(verifyHmacSignature({ secret: "", body: BODY, signature: "anysig" })).toBe(false);
  });

  it("faux si signature null", () => {
    expect(verifyHmacSignature({ secret: SECRET, body: BODY, signature: null })).toBe(false);
  });

  it("faux si signature undefined", () => {
    expect(
      verifyHmacSignature({
        secret: SECRET,
        body: BODY,
        signature: undefined,
      }),
    ).toBe(false);
  });

  it("throw ValidationError pour un algorithme non supporté (allowlist)", () => {
    expect(() =>
      verifyHmacSignature({
        secret: SECRET,
        body: BODY,
        signature: "x",
        // @ts-expect-error — on teste l'invariant runtime via une valeur invalide
        algorithm: "md5",
      }),
    ).toThrow(ValidationError);
  });
});
