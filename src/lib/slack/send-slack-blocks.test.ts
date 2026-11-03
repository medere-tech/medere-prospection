/**
 * Tests `send-slack-blocks.ts` — fonction UNIQUE d'envoi Slack
 * (PR2c tour 2b bloc C octies).
 *
 * Verrouille le contrat partagé entre `sendInboundAfterHandoffNotification`
 * et `notifyOrphanAttachedBestEffort` : validation DM, anti-unfurl,
 * mapping d'erreurs `ExternalServiceError`, log sans PII.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExternalServiceError, ValidationError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

import {
  __setSlackClientForTests,
  type SlackPostMessageArgs,
  type SlackPostMessageResult,
} from "./client";
import { sendSlackBlocks, type SendSlackBlocksInput } from "./send-slack-blocks";

type PostMessageFn = (args: SlackPostMessageArgs) => Promise<SlackPostMessageResult>;

function stubSlackClient(impl: PostMessageFn) {
  const spy = vi.fn<PostMessageFn>(impl);
  __setSlackClientForTests({ chat: { postMessage: spy } });
  return spy;
}

afterEach(() => {
  __setSlackClientForTests(null);
  vi.restoreAllMocks();
});

const BLOCKS = [
  { type: "section", text: { type: "mrkdwn", text: "*test*" } },
] as const satisfies ReadonlyArray<Record<string, unknown>>;

const BASE_DM: SendSlackBlocksInput = {
  target: { kind: "dm", slackUserId: "U05VANESSA" },
  fallbackText: "Fallback",
  blocks: BLOCKS,
  logEvent: "Test log event",
};

describe("sendSlackBlocks — routage", () => {
  it("DM : channel = slackUserId", async () => {
    const spy = stubSlackClient(async () => ({ ok: true, ts: "t1", channel: "D123" }));
    const r = await sendSlackBlocks(BASE_DM);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0].channel).toBe("U05VANESSA");
    expect(r).toEqual({ ts: "t1", channel: "D123" });
  });

  it("channel : channel = channelId (pas de validation user-id)", async () => {
    const spy = stubSlackClient(async () => ({ ok: true, ts: "t2", channel: "C0ORPHANS" }));
    await sendSlackBlocks({
      ...BASE_DM,
      target: { kind: "channel", channelId: "C0ORPHANS" },
    });
    expect(spy.mock.calls[0]?.[0].channel).toBe("C0ORPHANS");
  });

  it("DM : slackUserId invalide → ValidationError (defense-in-depth)", async () => {
    stubSlackClient(async () => ({ ok: true, ts: "t", channel: "c" }));
    await expect(
      sendSlackBlocks({
        ...BASE_DM,
        target: { kind: "dm", slackUserId: "not-a-slack-id" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("sendSlackBlocks — anti-unfurl + fallback", () => {
  it("pose unfurl_links=false et unfurl_media=false", async () => {
    const spy = stubSlackClient(async () => ({ ok: true, ts: "t", channel: "c" }));
    await sendSlackBlocks(BASE_DM);
    const args = spy.mock.calls[0]?.[0];
    expect(args?.unfurl_links).toBe(false);
    expect(args?.unfurl_media).toBe(false);
  });

  it("passe fallbackText comme `text`", async () => {
    const spy = stubSlackClient(async () => ({ ok: true, ts: "t", channel: "c" }));
    await sendSlackBlocks({ ...BASE_DM, fallbackText: "Mon fallback neutre" });
    expect(spy.mock.calls[0]?.[0].text).toBe("Mon fallback neutre");
  });

  it("passe les blocks fournis", async () => {
    const spy = stubSlackClient(async () => ({ ok: true, ts: "t", channel: "c" }));
    await sendSlackBlocks(BASE_DM);
    expect(spy.mock.calls[0]?.[0].blocks).toEqual(BLOCKS);
  });
});

describe("sendSlackBlocks — mapping d'erreurs", () => {
  it("rejet SDK → ExternalServiceError avec cause préservée", async () => {
    const cause = new Error("network down");
    stubSlackClient(async () => {
      throw cause;
    });
    const err = (await sendSlackBlocks(BASE_DM).catch((e) => e)) as ExternalServiceError;
    expect(err).toBeInstanceOf(ExternalServiceError);
    expect(err.cause).toBe(cause);
    expect(err.message).toContain("Slack chat.postMessage failed");
  });

  it("réponse {ok:false} → ExternalServiceError avec slackError", async () => {
    stubSlackClient(async () => ({ ok: false, error: "channel_not_found" }));
    const err = (await sendSlackBlocks(BASE_DM).catch((e) => e)) as ExternalServiceError;
    expect(err).toBeInstanceOf(ExternalServiceError);
    expect(err.message).toContain("returned non-ok");
    const ctx = err.toLogObject() as { context?: Record<string, unknown> };
    expect(ctx.context?.slackError).toBe("channel_not_found");
  });

  it("`ts` manquant → ExternalServiceError (fail-closed strict)", async () => {
    stubSlackClient(async () => ({ ok: true, channel: "c" }) as unknown as SlackPostMessageResult);
    await expect(sendSlackBlocks(BASE_DM)).rejects.toBeInstanceOf(ExternalServiceError);
  });
});

describe("sendSlackBlocks — log sans PII", () => {
  it("logger.info posé avec service/targetKind/channel/ts + logContext", async () => {
    stubSlackClient(async () => ({ ok: true, ts: "t", channel: "c" }));
    const infoSpy = vi.spyOn(logger, "info");
    await sendSlackBlocks({ ...BASE_DM, logContext: { isOptOut: true, variant: "orphan" } });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "slack",
        targetKind: "dm",
        channel: "c",
        ts: "t",
        isOptOut: true,
        variant: "orphan",
      }),
      "Test log event",
    );
  });
});
