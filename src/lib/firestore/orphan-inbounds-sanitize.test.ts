/**
 * Tests `sanitizeOrphanInboundForClient` (PR2c tour 2a).
 *
 * Prouve que `phoneHash` et `idempotencyKey` NE SONT JAMAIS exposés dans
 * la vue client. Si quelqu'un les ajoute à la shape plus tard, la
 * sentinelle serialize-with-JSON ci-dessous les détecte.
 */
import { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";

import type { OrphanInboundView } from "./orphan-inbounds";
import { sanitizeOrphanInboundForClient } from "./orphan-inbounds-sanitize";

const SECRET_HASH = "hph_1234_5678_9abc_def0_1234_5678_9abc_def0";
const SECRET_IDEMKEY = "ovh-message-id-SECRET-DO-NOT-LEAK";

function fakeView(overrides: Partial<OrphanInboundView> = {}): OrphanInboundView {
  const now = Timestamp.fromDate(new Date("2026-10-27T12:00:00Z"));
  return {
    docId: "oih_abc123",
    reason: "unknown_contact",
    body: "corps synthétique",
    idempotencyKey: SECRET_IDEMKEY,
    source: "process-reply",
    phoneHash: SECRET_HASH,
    receivedAt: now,
    processingState: "pending",
    isTestFixture: false,
    ...overrides,
  };
}

describe("sanitizeOrphanInboundForClient — fail-closed PII", () => {
  it("expose docId / body / reason / source / processingState / isTestFixture / timestamp ISO", () => {
    const v = sanitizeOrphanInboundForClient(fakeView());
    expect(v.docId).toBe("oih_abc123");
    expect(v.body).toBe("corps synthétique");
    expect(v.reason).toBe("unknown_contact");
    expect(v.source).toBe("process-reply");
    expect(v.processingState).toBe("pending");
    expect(v.isTestFixture).toBe(false);
    expect(v.receivedAtIso).toBe("2026-10-27T12:00:00.000Z");
  });

  it("NE SORT JAMAIS phoneHash — seul `hasPhoneHash: boolean` est exposé", () => {
    const v = sanitizeOrphanInboundForClient(fakeView());
    const serialized = JSON.stringify(v);
    expect(serialized).not.toContain(SECRET_HASH);
    expect(serialized).not.toContain("phoneHash");
    expect(v.hasPhoneHash).toBe(true);
  });

  it("NE SORT JAMAIS idempotencyKey", () => {
    const v = sanitizeOrphanInboundForClient(fakeView());
    const serialized = JSON.stringify(v);
    expect(serialized).not.toContain(SECRET_IDEMKEY);
    expect(serialized).not.toContain("idempotencyKey");
  });

  it("hasPhoneHash === false quand phoneHash absent (parse_failed typique)", () => {
    const v = sanitizeOrphanInboundForClient(
      fakeView({ phoneHash: undefined, reason: "parse_failed" }),
    );
    expect(v.hasPhoneHash).toBe(false);
  });

  it("expose attachment avec timestamps ISO quand présent", () => {
    const attachedAt = Timestamp.fromDate(new Date("2026-10-27T14:00:00Z"));
    const v = sanitizeOrphanInboundForClient(
      fakeView({
        processingState: "attached",
        attachment: {
          conversationId: "c1_hubspot-list-9999",
          messageId: "oih_msg1",
          phoneMatch: "match",
          attachedAt,
          attachedBy: "user_admin_x",
        },
      }),
    );
    expect(v.attachment?.conversationId).toBe("c1_hubspot-list-9999");
    expect(v.attachment?.phoneMatch).toBe("match");
    expect(v.attachment?.attachedAtIso).toBe("2026-10-27T14:00:00.000Z");
  });

  it("expose dismissal avec motif enum fermé", () => {
    const dismissedAt = Timestamp.fromDate(new Date("2026-10-27T15:00:00Z"));
    const v = sanitizeOrphanInboundForClient(
      fakeView({
        processingState: "dismissed",
        dismissal: {
          reason: "unrelated_or_spam",
          dismissedAt,
          dismissedBy: "user_admin_y",
        },
      }),
    );
    expect(v.dismissal?.reason).toBe("unrelated_or_spam");
    expect(v.dismissal?.dismissedAtIso).toBe("2026-10-27T15:00:00.000Z");
  });
});
