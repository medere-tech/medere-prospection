/**
 * Tests `resolveOrphanNotifyTarget` — fonction pure, pas d'I/O.
 *
 * Prouve l'invariant fail-closed sur `testAccount` sans `SLACK_TEST_CHANNEL_ID` :
 * la cible retournée est `kind: "none"` et JAMAIS un repli vers un
 * destinataire réel (titulaire ni canal orphelins).
 */
import { describe, expect, it } from "vitest";

import { resolveOrphanNotifyTarget } from "./notify-orphan-action";

describe("resolveOrphanNotifyTarget — routage orphan notif", () => {
  it("testAccount + testChannelId présent → canal test", () => {
    const t = resolveOrphanNotifyTarget({
      actorTestAccount: true,
      assignedToSlackUserId: "U123TITULAIRE",
      testChannelId: "C0TESTCHAN",
      orphanChannelId: "C0ORPHANS",
    });
    expect(t.kind).toBe("channel");
    if (t.kind === "channel") {
      expect(t.channelId).toBe("C0TESTCHAN");
      expect(t.reason).toBe("test");
    }
  });

  it("🔒 testAccount SANS testChannelId → `none` (jamais de repli)", () => {
    const t = resolveOrphanNotifyTarget({
      actorTestAccount: true,
      assignedToSlackUserId: "U123TITULAIRE",
      testChannelId: undefined,
      orphanChannelId: "C0ORPHANS",
    });
    expect(t.kind).toBe("none");
    if (t.kind === "none") {
      expect(t.reason).toBe("test_channel_missing");
    }
  });

  it("🔒 testAccount SANS testChannelId NI titulaire → `none` (fail-closed strict)", () => {
    const t = resolveOrphanNotifyTarget({
      actorTestAccount: true,
      assignedToSlackUserId: undefined,
      testChannelId: undefined,
      orphanChannelId: "C0ORPHANS",
    });
    expect(t.kind).toBe("none");
  });

  it("🔒 testAccount + testChannelId='' (vide) → `none`", () => {
    const t = resolveOrphanNotifyTarget({
      actorTestAccount: true,
      assignedToSlackUserId: "U123",
      testChannelId: "",
      orphanChannelId: "C0ORPHANS",
    });
    expect(t.kind).toBe("none");
  });

  it("acteur réel + titulaire → DM titulaire", () => {
    const t = resolveOrphanNotifyTarget({
      actorTestAccount: false,
      assignedToSlackUserId: "U123TITULAIRE",
      testChannelId: undefined,
      orphanChannelId: "C0ORPHANS",
    });
    expect(t.kind).toBe("dm");
    if (t.kind === "dm") expect(t.slackUserId).toBe("U123TITULAIRE");
  });

  it("acteur réel SANS titulaire → canal orphelins (jamais skipped)", () => {
    const t = resolveOrphanNotifyTarget({
      actorTestAccount: false,
      assignedToSlackUserId: undefined,
      testChannelId: "C0TEST",
      orphanChannelId: "C0ORPHANS",
    });
    expect(t.kind).toBe("channel");
    if (t.kind === "channel") {
      expect(t.channelId).toBe("C0ORPHANS");
      expect(t.reason).toBe("titulaire-absent");
    }
  });

  it("acteur réel + assignedTo '' (vide) → canal orphelins", () => {
    const t = resolveOrphanNotifyTarget({
      actorTestAccount: false,
      assignedToSlackUserId: "",
      testChannelId: undefined,
      orphanChannelId: "C0ORPHANS",
    });
    expect(t.kind).toBe("channel");
  });
});
