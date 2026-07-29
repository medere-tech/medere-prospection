/**
 * Tests `notify-handoff.ts` — appel Slack chat.postMessage via mock client.
 *
 * Pattern : `__setSlackClientForTests({ chat: { postMessage: vi.fn() } })`
 * injecte un fake client (aligné pattern HubSpot / OVH).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExternalServiceError } from "@/lib/utils/errors";

import {
  __setSlackClientForTests,
  type SlackPostMessageArgs,
  type SlackPostMessageResult,
} from "./client";
import type { HandoffInput } from "./format-handoff";
import { type SendHandoffInput, sendHandoffNotification } from "./notify-handoff";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture minimale
// ─────────────────────────────────────────────────────────────────────────────

const BASE_HANDOFF: HandoffInput = {
  firstName: "Marie",
  speciality: "Chirurgien-dentiste",
  city: "Paris",
  lastInboundBody: "Bonjour, votre offre m'intéresse.",
  conversationId: "conv-abc-123",
  isOrphan: false,
  dashboardUrl: "https://dashboard.medere.fr/conversations/conv-abc-123",
};

type PostMessageFn = (args: SlackPostMessageArgs) => Promise<SlackPostMessageResult>;

/**
 * Injecte un fake WebClient avec `chat.postMessage` mockable. Retourne
 * la spy pour introspection (`.mock.calls[i]`).
 */
function stubSlackClient(impl: PostMessageFn) {
  const spy = vi.fn<PostMessageFn>(impl);
  __setSlackClientForTests({ chat: { postMessage: spy } });
  return spy;
}

afterEach(() => {
  __setSlackClientForTests(null);
  vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────
// Routage — DM vs canal
// ─────────────────────────────────────────────────────────────────────────────

describe("sendHandoffNotification — routage", () => {
  it("target.kind='dm' → chat.postMessage.channel = slackUserId", async () => {
    const spy = stubSlackClient(async () => ({
      ok: true,
      ts: "1700000000.001",
      channel: "D0XXXXXXXXX", // Slack ouvre le DM channel automatiquement
    }));

    const input: SendHandoffInput = {
      ...BASE_HANDOFF,
      target: { kind: "dm", slackUserId: "U05VANESSA" },
    };
    const result = await sendHandoffNotification(input);

    expect(spy).toHaveBeenCalledTimes(1);
    const args = spy.mock.calls[0]?.[0];
    expect(args?.channel).toBe("U05VANESSA");
    expect(result).toEqual({ ts: "1700000000.001", channel: "D0XXXXXXXXX" });
  });

  it("target.kind='channel' → chat.postMessage.channel = channelId", async () => {
    const spy = stubSlackClient(async () => ({
      ok: true,
      ts: "1700000000.002",
      channel: "C0ORPHANLEADS",
    }));

    const input: SendHandoffInput = {
      ...BASE_HANDOFF,
      isOrphan: true,
      target: { kind: "channel", channelId: "C0ORPHANLEADS" },
    };
    await sendHandoffNotification(input);

    const args = spy.mock.calls[0]?.[0];
    expect(args?.channel).toBe("C0ORPHANLEADS");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Contenu du postMessage — blocks + fallback text + unfurl off
// ─────────────────────────────────────────────────────────────────────────────

describe("sendHandoffNotification — contenu chat.postMessage", () => {
  it("passe des blocks (Block Kit) construits via buildHandoffBlocks", async () => {
    const spy = stubSlackClient(async () => ({ ok: true, ts: "t", channel: "c" }));

    await sendHandoffNotification({
      ...BASE_HANDOFF,
      target: { kind: "dm", slackUserId: "U05" },
    });

    const args = spy.mock.calls[0]?.[0];
    expect(args?.blocks).toBeDefined();
    expect(Array.isArray(args?.blocks)).toBe(true);
    // 5 blocks garantis par format-handoff.test.ts
    expect(args?.blocks).toHaveLength(5);
  });

  it("fallback text (mobile / a11y) neutre — pas de PII (DM)", async () => {
    const spy = stubSlackClient(async () => ({ ok: true, ts: "t", channel: "c" }));

    await sendHandoffNotification({
      ...BASE_HANDOFF,
      target: { kind: "dm", slackUserId: "U05" },
    });

    const args = spy.mock.calls[0]?.[0];
    expect(args?.text).toBe("Nouveau lead intéressé pour vous");
    // Anti-PII : le fallback text ne doit PAS contenir firstName/body
    expect(args?.text).not.toContain("Marie");
    expect(args?.text).not.toContain("intéresse");
  });

  it("fallback text neutre — orphelin", async () => {
    const spy = stubSlackClient(async () => ({ ok: true, ts: "t", channel: "c" }));

    await sendHandoffNotification({
      ...BASE_HANDOFF,
      isOrphan: true,
      target: { kind: "channel", channelId: "C0" },
    });

    const args = spy.mock.calls[0]?.[0];
    expect(args?.text).toBe("Lead non attribué à traiter");
  });

  it("désactive unfurl_links + unfurl_media (anti-leak d'IDs via GET Slack)", async () => {
    const spy = stubSlackClient(async () => ({ ok: true, ts: "t", channel: "c" }));

    await sendHandoffNotification({
      ...BASE_HANDOFF,
      target: { kind: "dm", slackUserId: "U05" },
    });

    const args = spy.mock.calls[0]?.[0];
    expect(args?.unfurl_links).toBe(false);
    expect(args?.unfurl_media).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gestion d'erreur — SDK rejette OU Slack répond ok:false
// ─────────────────────────────────────────────────────────────────────────────

describe("sendHandoffNotification — erreurs", () => {
  it("SDK rejette (network) → ExternalServiceError (cause préservée)", async () => {
    const rootCause = new Error("ECONNRESET");
    stubSlackClient(async () => {
      throw rootCause;
    });

    try {
      await sendHandoffNotification({
        ...BASE_HANDOFF,
        target: { kind: "dm", slackUserId: "U05" },
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExternalServiceError);
      const err = e as ExternalServiceError;
      expect(err.code).toBe("EXTERNAL_SERVICE");
      expect(err.statusCode).toBe(502);
      expect(err.context).toMatchObject({ service: "slack", targetKind: "dm" });
      expect(err.cause).toBe(rootCause);
    }
  });

  it("Slack répond {ok:false, error:'channel_not_found'} → ExternalServiceError avec slackError", async () => {
    stubSlackClient(async () => ({
      ok: false,
      error: "channel_not_found",
    }));

    try {
      await sendHandoffNotification({
        ...BASE_HANDOFF,
        target: { kind: "channel", channelId: "C0BAD" },
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExternalServiceError);
      const err = e as ExternalServiceError;
      expect(err.context).toMatchObject({
        service: "slack",
        targetKind: "channel",
        slackError: "channel_not_found",
      });
    }
  });

  it("Slack répond {ok:false} sans error → slackError='unknown'", async () => {
    stubSlackClient(async () => ({ ok: false }));

    try {
      await sendHandoffNotification({
        ...BASE_HANDOFF,
        target: { kind: "dm", slackUserId: "U05" },
      });
      expect.fail("should have thrown");
    } catch (e) {
      const err = e as ExternalServiceError;
      expect(err.context?.slackError).toBe("unknown");
    }
  });

  it("Slack répond ok:true mais ts manquant → ExternalServiceError (contrat violé)", async () => {
    stubSlackClient(async () => ({
      ok: true,
      channel: "D0",
      // ts manquant
    }));

    await expect(
      sendHandoffNotification({
        ...BASE_HANDOFF,
        target: { kind: "dm", slackUserId: "U05" },
      }),
    ).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("erreur : le contexte NE contient PAS body/firstName/dashboardUrl (anti-PII log)", async () => {
    stubSlackClient(async () => ({ ok: false, error: "not_in_channel" }));

    try {
      await sendHandoffNotification({
        ...BASE_HANDOFF,
        target: { kind: "channel", channelId: "C0" },
      });
      expect.fail("should have thrown");
    } catch (e) {
      const err = e as ExternalServiceError;
      const serialized = JSON.stringify({
        message: err.message,
        context: err.context,
      });
      expect(serialized).not.toContain(BASE_HANDOFF.firstName);
      expect(serialized).not.toContain(BASE_HANDOFF.lastInboundBody);
      expect(serialized).not.toContain(BASE_HANDOFF.dashboardUrl);
    }
  });
});
