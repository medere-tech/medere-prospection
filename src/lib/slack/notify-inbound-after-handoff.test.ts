/**
 * Tests `notify-inbound-after-handoff.ts` — appel Slack chat.postMessage
 * via mock client. Pattern miroir strict de `notify-handoff.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExternalServiceError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

import {
  __setSlackClientForTests,
  type SlackPostMessageArgs,
  type SlackPostMessageResult,
} from "./client";
import type { InboundAfterHandoffInput } from "./format-inbound-after-handoff";
import {
  type SendInboundAfterHandoffInput,
  sendInboundAfterHandoffNotification,
} from "./notify-inbound-after-handoff";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture minimale
// ─────────────────────────────────────────────────────────────────────────────

const BASE: InboundAfterHandoffInput = {
  firstName: "Marie",
  speciality: "Dentiste",
  city: "Paris",
  lastInboundBody: "Je suis en vacances cette semaine, on peut en reparler lundi ?",
  conversationId: "conv-abc-123",
  isOptOut: false,
  dashboardUrl: "https://dashboard.medere.fr/conversations/conv-abc-123",
};

type PostMessageFn = (args: SlackPostMessageArgs) => Promise<SlackPostMessageResult>;

function stubSlackClient(impl: PostMessageFn) {
  const spy = vi.fn<PostMessageFn>(impl);
  __setSlackClientForTests({ chat: { postMessage: spy } });
  return spy;
}

afterEach(() => {
  __setSlackClientForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Routage DM
// ─────────────────────────────────────────────────────────────────────────────

describe("sendInboundAfterHandoffNotification — routage", () => {
  it("DM : chat.postMessage.channel = slackUserId", async () => {
    const spy = stubSlackClient(async () => ({
      ok: true,
      ts: "1700000000.100",
      channel: "D0VANESSA",
    }));

    const input: SendInboundAfterHandoffInput = {
      ...BASE,
      target: { kind: "dm", slackUserId: "U05VANESSA" },
    };
    const result = await sendInboundAfterHandoffNotification(input);

    expect(spy).toHaveBeenCalledOnce();
    const args = spy.mock.calls[0]?.[0];
    expect(args?.channel).toBe("U05VANESSA");
    expect(result).toEqual({ ts: "1700000000.100", channel: "D0VANESSA" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Contenu du postMessage
// ─────────────────────────────────────────────────────────────────────────────

describe("sendInboundAfterHandoffNotification — contenu", () => {
  it("passe des blocks construits par buildInboundAfterHandoffBlocks", async () => {
    const spy = stubSlackClient(async () => ({ ok: true, ts: "t", channel: "c" }));
    await sendInboundAfterHandoffNotification({
      ...BASE,
      target: { kind: "dm", slackUserId: "U05UVHGBURX" },
    });
    const args = spy.mock.calls[0]?.[0];
    expect(Array.isArray(args?.blocks)).toBe(true);
    const serialized = JSON.stringify(args?.blocks);
    expect(serialized).toContain("Nouveau message d'un lead que vous suivez");
  });

  it("variante STOP : fallback text + bloc action", async () => {
    const spy = stubSlackClient(async () => ({ ok: true, ts: "t", channel: "c" }));
    await sendInboundAfterHandoffNotification({
      ...BASE,
      isOptOut: true,
      target: { kind: "dm", slackUserId: "U05UVHGBURX" },
    });
    const args = spy.mock.calls[0]?.[0];
    expect(args?.text).toBe("Demande d'arret (STOP) a traiter");
    const serialized = JSON.stringify(args?.blocks);
    expect(serialized).toContain("Demande d'arret (STOP) sur un lead que vous suivez");
    expect(serialized).toContain("Ne plus recontacter");
  });

  it("variante normale : fallback text neutre", async () => {
    const spy = stubSlackClient(async () => ({ ok: true, ts: "t", channel: "c" }));
    await sendInboundAfterHandoffNotification({
      ...BASE,
      target: { kind: "dm", slackUserId: "U05UVHGBURX" },
    });
    const args = spy.mock.calls[0]?.[0];
    expect(args?.text).toBe("Nouveau message d'un lead");
  });

  it("unfurl_links=false et unfurl_media=false (anti-preview)", async () => {
    const spy = stubSlackClient(async () => ({ ok: true, ts: "t", channel: "c" }));
    await sendInboundAfterHandoffNotification({
      ...BASE,
      target: { kind: "dm", slackUserId: "U05UVHGBURX" },
    });
    const args = spy.mock.calls[0]?.[0];
    expect(args?.unfurl_links).toBe(false);
    expect(args?.unfurl_media).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Erreurs SDK
// ─────────────────────────────────────────────────────────────────────────────

describe("sendInboundAfterHandoffNotification — erreurs", () => {
  it("SDK Promise rejection → ExternalServiceError sans PII dans context", async () => {
    stubSlackClient(async () => {
      throw new Error("network timeout");
    });

    const input: SendInboundAfterHandoffInput = {
      ...BASE,
      target: { kind: "dm", slackUserId: "U05UVHGBURX" },
    };

    await expect(sendInboundAfterHandoffNotification(input)).rejects.toBeInstanceOf(
      ExternalServiceError,
    );

    try {
      await sendInboundAfterHandoffNotification(input);
      expect.fail("should throw");
    } catch (e) {
      const err = e as ExternalServiceError;
      const ctx = err.context as Record<string, unknown>;
      expect(ctx.service).toBe("slack");
      expect(ctx.targetKind).toBe("dm");
      // Anti-PII: pas de body/firstName/dashboardUrl dans le context erreur
      const serialized = JSON.stringify(ctx);
      expect(serialized).not.toContain(BASE.firstName);
      expect(serialized).not.toContain(BASE.lastInboundBody);
      expect(serialized).not.toContain(BASE.dashboardUrl);
    }
  });

  it("reponse ok=false → ExternalServiceError avec slackError court", async () => {
    stubSlackClient(async () => ({ ok: false, error: "channel_not_found" }));

    try {
      await sendInboundAfterHandoffNotification({
        ...BASE,
        target: { kind: "dm", slackUserId: "U05UVHGBURX" },
      });
      expect.fail("should throw");
    } catch (e) {
      const err = e as ExternalServiceError;
      const ctx = err.context as Record<string, unknown>;
      expect(ctx.slackError).toBe("channel_not_found");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Logs anti-PII
// ─────────────────────────────────────────────────────────────────────────────

describe("sendInboundAfterHandoffNotification — logs sans PII", () => {
  it("info log : jamais body/firstName/dashboardUrl", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    stubSlackClient(async () => ({ ok: true, ts: "t", channel: "D0X" }));

    await sendInboundAfterHandoffNotification({
      ...BASE,
      target: { kind: "dm", slackUserId: "U05UVHGBURX" },
    });

    const serialized = JSON.stringify(infoSpy.mock.calls);
    expect(serialized).not.toContain(BASE.firstName);
    expect(serialized).not.toContain(BASE.lastInboundBody);
    expect(serialized).not.toContain(BASE.dashboardUrl);
    // En revanche : isOptOut est bien expose (metadata non-PII utile)
    expect(serialized).toContain("isOptOut");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sentinelles format Slack user ID (fix LOW security-reviewer PR-A)
// ─────────────────────────────────────────────────────────────────────────────

describe("sendInboundAfterHandoffNotification — defense-in-depth format slackUserId", () => {
  it("slackUserId invalide (doc legacy) → throw ValidationError AVANT postMessage", async () => {
    const spy = stubSlackClient(async () => ({ ok: true, ts: "t", channel: "c" }));
    const input: SendInboundAfterHandoffInput = {
      ...BASE,
      target: { kind: "dm", slackUserId: "VanessaRabba" },
    };
    await expect(sendInboundAfterHandoffNotification(input)).rejects.toThrow(
      /invalid Slack user ID/,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("slackUserId `<@U...>` wrappe → throw", async () => {
    const spy = stubSlackClient(async () => ({ ok: true, ts: "t", channel: "c" }));
    const input: SendInboundAfterHandoffInput = {
      ...BASE,
      target: { kind: "dm", slackUserId: "<@U05UVHGBURX>" },
    };
    await expect(sendInboundAfterHandoffNotification(input)).rejects.toThrow(
      /invalid Slack user ID/,
    );
    expect(spy).not.toHaveBeenCalled();
  });
});
