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

  it("expose attachment avec timestamps ISO et strippe l'auteur Clerk (PR2c tour 2b)", () => {
    const attachedAt = Timestamp.fromDate(new Date("2026-10-27T14:00:00Z"));
    const SECRET_ATTACHED_BY = "user_admin_SECRET_LEAK_X";
    const v = sanitizeOrphanInboundForClient(
      fakeView({
        processingState: "attached",
        attachment: {
          conversationId: "c1_hubspot-list-9999",
          messageId: "oih_msg1",
          phoneMatch: "match",
          attachedAt,
          attachedBy: SECRET_ATTACHED_BY,
        },
      }),
    );
    expect(v.attachment?.conversationId).toBe("c1_hubspot-list-9999");
    expect(v.attachment?.phoneMatch).toBe("match");
    expect(v.attachment?.attachedAtIso).toBe("2026-10-27T14:00:00.000Z");
    // Sans resolveAdminName fourni → `attachedByName: null` (UI → « Admin inconnu »).
    expect(v.attachment?.attachedByName).toBeNull();
    const serialized = JSON.stringify(v);
    expect(serialized).not.toContain(SECRET_ATTACHED_BY);
    expect(serialized).not.toContain('attachedBy":');
  });

  it("expose dismissal avec motif enum fermé et strippe l'auteur Clerk", () => {
    const dismissedAt = Timestamp.fromDate(new Date("2026-10-27T15:00:00Z"));
    const SECRET_DISMISSED_BY = "user_admin_SECRET_LEAK_Y";
    const v = sanitizeOrphanInboundForClient(
      fakeView({
        processingState: "dismissed",
        dismissal: {
          reason: "unrelated_or_spam",
          dismissedAt,
          dismissedBy: SECRET_DISMISSED_BY,
        },
      }),
    );
    expect(v.dismissal?.reason).toBe("unrelated_or_spam");
    expect(v.dismissal?.dismissedAtIso).toBe("2026-10-27T15:00:00.000Z");
    expect(v.dismissal?.dismissedByName).toBeNull();
    const serialized = JSON.stringify(v);
    expect(serialized).not.toContain(SECRET_DISMISSED_BY);
    expect(serialized).not.toContain('dismissedBy":');
  });

  it("expose attachedByName/dismissedByName quand resolveAdminName est fourni", () => {
    const attachedAt = Timestamp.fromDate(new Date("2026-10-27T14:00:00Z"));
    const dismissedAt = Timestamp.fromDate(new Date("2026-10-27T15:00:00Z"));
    const resolver = (userId: string): string | null => {
      if (userId === "user_admin_dethie") return "Déthié Faye";
      if (userId === "user_admin_harry") return "Harry Dumont";
      return null;
    };
    const v = sanitizeOrphanInboundForClient(
      fakeView({
        processingState: "attached",
        attachment: {
          conversationId: "c1_hubspot-list-9999",
          messageId: "oih_msg1",
          phoneMatch: "match",
          attachedAt,
          attachedBy: "user_admin_dethie",
        },
        dismissal: {
          reason: "unrelated_or_spam",
          dismissedAt,
          dismissedBy: "user_admin_harry",
        },
      }),
      null,
      resolver,
    );
    expect(v.attachment?.attachedByName).toBe("Déthié Faye");
    expect(v.dismissal?.dismissedByName).toBe("Harry Dumont");
    // Les identifiants Clerk restent strippés.
    expect(JSON.stringify(v)).not.toContain("user_admin_dethie");
    expect(JSON.stringify(v)).not.toContain("user_admin_harry");
  });

  it("resolveAdminName retourne null → attachedByName null (fallback « Admin inconnu » côté UI)", () => {
    const attachedAt = Timestamp.fromDate(new Date("2026-10-27T14:00:00Z"));
    const v = sanitizeOrphanInboundForClient(
      fakeView({
        processingState: "attached",
        attachment: {
          conversationId: "c1_hubspot-list-9999",
          messageId: "oih_msg1",
          phoneMatch: "match",
          attachedAt,
          attachedBy: "user_admin_deleted",
        },
      }),
      null,
      () => null,
    );
    expect(v.attachment?.attachedByName).toBeNull();
  });

  it("contact résumé exposé quand resolvedContact fourni ; sinon null (PR2c tour 2b)", () => {
    const v1 = sanitizeOrphanInboundForClient(fakeView({ contactId: "c1" }));
    expect(v1.contact).toBeNull();
    const v2 = sanitizeOrphanInboundForClient(fakeView({ contactId: "c1" }), {
      hubspotId: "c1",
      firstName: "Jean",
      lastName: "Dupont",
      civilite: "Dr",
      speciality: "Dentiste",
      city: "Paris",
      consent: { optedOut: false },
    } as unknown as Parameters<typeof sanitizeOrphanInboundForClient>[1]);
    expect(v2.contact?.displayName).toBe("Dr Jean Dupont");
    expect(v2.contact?.speciality).toBe("Dentiste");
    expect(v2.contact?.city).toBe("Paris");
    expect(v2.contact?.optedOut).toBe(false);
  });

  // Sentinelle structurelle PR2c tour 2b (correction post-audit M-1 /
  // M-2) : `contactId` ne doit apparaître NI à la racine NI dans le
  // sous-objet `contact`. Un dev qui réintroduit l'un ou l'autre fait
  // échouer ce test immédiatement.
  it("sentinelle anti-régression : `contactId` strippé partout (racine + sous-objet contact)", () => {
    const v = sanitizeOrphanInboundForClient(fakeView({ contactId: "c1" }), {
      hubspotId: "c1",
      firstName: "Jean",
      lastName: "Dupont",
      civilite: "Dr",
      speciality: "Dentiste",
      city: "Paris",
      consent: { optedOut: false },
    } as unknown as Parameters<typeof sanitizeOrphanInboundForClient>[1]);
    expect(Object.keys(v)).not.toContain("contactId");
    expect(v.contact).not.toBeNull();
    if (v.contact !== null) {
      expect(Object.keys(v.contact)).not.toContain("contactId");
    }
    // Belt-and-braces : le JSON sérialisé ne porte plus la clé `"contactId"`.
    expect(JSON.stringify(v)).not.toContain(`"contactId"`);
  });
});
