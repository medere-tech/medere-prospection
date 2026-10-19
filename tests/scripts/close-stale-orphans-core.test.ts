/**
 * Tests unitaires des helpers purs de `scripts/close-stale-orphans.mjs`
 * (R5-Point4). Couvre :
 *   - Les 5 exit codes (via les asserts qui retournent `{ ok, exitCode }`)
 *   - Les 5 garde-fous (mutation testing : chaque assertion a son test rouge)
 *   - La construction du path OVH (fenetre +/- 10 min)
 *   - La resolution E.164 (externalReceiver prioritaire, fallback contact)
 *   - Le build du payload audit (zero PII, forme stable)
 *   - Le build du snapshot (Timestamps serialises via marker)
 *
 * Les tests n'ouvrent AUCUNE connexion Firestore ni OVH : helpers purs,
 * injection de dependance (`getContactFn`).
 */
import { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";

import {
  ABANDON_REASON,
  assertAllAreAbandonable,
  assertIdsAreTargets,
  AUDIT_REASON,
  buildAuditPayload,
  buildOvhSearchPath,
  buildSnapshotPayload,
  CONVERSATION_ID,
  maskPhone,
  MESSAGE_SPECS,
  NEW_STATUS,
  OVH_SEARCH_WINDOW_MS,
  resolveReceiverE164,
  toSnapshotSafe,
} from "../../scripts/_lib/close-stale-orphans-core.mjs";

// Type local pour les retours des asserts (les .mjs n'ont pas de .d.ts).
type RefusedAssert = { ok: false; exitCode: number; errors: string[] };

/**
 * Narrow le retour d'un assert `.mjs` (non type) vers la branche "refuse".
 * Fail le test si `ok=true`. Apres l'appel, `res` est type `RefusedAssert`.
 */
function assertRefused(res: unknown): asserts res is RefusedAssert {
  expect(res).toMatchObject({ ok: false });
  const r = res as { ok: boolean };
  if (r.ok) throw new Error("test precondition: expected refusal");
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de fixtures
// ─────────────────────────────────────────────────────────────────────────────

interface OvhCheck {
  searched: boolean;
  found?: number;
  windowMs?: number;
  receiverMasked?: string;
  createdAtIso?: string;
  reason?: string;
}

interface Result {
  messageId: string;
  expectedStatus: string;
  actualStatus: string;
  direction: string;
  outboundKind: string;
  createdAt: Timestamp;
  hasExternalReceiver: boolean;
  ovhCheck: OvhCheck;
  rawData: Record<string, unknown>;
}

function makeResult(partial: Partial<Result> = {}): Result {
  return {
    messageId: "USqzioSTVioix630LgDs",
    expectedStatus: "draft",
    actualStatus: "draft",
    direction: "outbound",
    outboundKind: "solicitation",
    createdAt: Timestamp.fromMillis(1_700_000_000_000),
    hasExternalReceiver: true,
    ovhCheck: {
      searched: true,
      found: 0,
      windowMs: OVH_SEARCH_WINDOW_MS,
      receiverMasked: "****9876",
      createdAtIso: new Date(1_700_000_000_000).toISOString(),
    },
    rawData: {
      status: "draft",
      direction: "outbound",
      externalReceiver: "+33612349876",
      createdAt: Timestamp.fromMillis(1_700_000_000_000),
    },
    ...partial,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Constantes figees — mutation testing
// ─────────────────────────────────────────────────────────────────────────────

describe("assertIdsAreTargets (exit code 5)", () => {
  it("ok sur les 3 ids attendus en ordre", () => {
    const res = assertIdsAreTargets({ CONVERSATION_ID, MESSAGE_SPECS });
    expect(res).toEqual({ ok: true });
  });

  it("refuse si CONVERSATION_ID a change (mutation)", () => {
    const res = assertIdsAreTargets({
      CONVERSATION_ID: "999_other-list-99",
      MESSAGE_SPECS,
    });
    assertRefused(res);
    expect(res.exitCode).toBe(5);
    expect(res.errors.join("|")).toContain("CONVERSATION_ID");
  });

  it("refuse si un id de message a change (mutation)", () => {
    const mutated = MESSAGE_SPECS.map((s: { id: string; expectedStatus: string }, i: number) =>
      i === 1 ? { ...s, id: "ZZZZZZZZZZZZZZZZZZZZ" } : s,
    );
    const res = assertIdsAreTargets({ CONVERSATION_ID, MESSAGE_SPECS: mutated });
    assertRefused(res);
    expect(res.exitCode).toBe(5);
    expect(res.errors.join("|")).toContain("MESSAGE_SPECS");
  });

  it("refuse si on ajoute un 4e message (mutation)", () => {
    const mutated = [...MESSAGE_SPECS, { id: "aaaaaaaaaaaaaaaaaaaa", expectedStatus: "draft" }];
    const res = assertIdsAreTargets({ CONVERSATION_ID, MESSAGE_SPECS: mutated });
    assertRefused(res);
    expect(res.exitCode).toBe(5);
  });

  it("refuse si on retire un message (mutation)", () => {
    const mutated = MESSAGE_SPECS.slice(0, 2);
    const res = assertIdsAreTargets({ CONVERSATION_ID, MESSAGE_SPECS: mutated });
    assertRefused(res);
    expect(res.exitCode).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Garde-fou etat des messages — mutation testing
// ─────────────────────────────────────────────────────────────────────────────

describe("assertAllAreAbandonable (exit code 5)", () => {
  it("ok : 3 messages dans l'etat attendu + 0 job OVH", () => {
    const results = [
      makeResult({
        messageId: "USqzioSTVioix630LgDs",
        expectedStatus: "draft",
        actualStatus: "draft",
      }),
      makeResult({
        messageId: "AdaORskN73zCCQmY8akj",
        expectedStatus: "queued",
        actualStatus: "queued",
      }),
      makeResult({
        messageId: "oZkis4s1XdnZDHmJGKyp",
        expectedStatus: "queued",
        actualStatus: "queued",
      }),
    ];
    expect(assertAllAreAbandonable(results)).toEqual({ ok: true });
  });

  it("refuse si un status a change entre pre-flight et apply (race)", () => {
    const results = [makeResult({ actualStatus: "failed", expectedStatus: "draft" })];
    const res = assertAllAreAbandonable(results);
    assertRefused(res);
    expect(res.exitCode).toBe(5);
    expect(res.errors.join(" | ")).toMatch(/status="failed".*attendu "draft"/);
  });

  it("refuse si OVH a trouve >= 1 job dans +/- 10 min (SMS envoye)", () => {
    const results = [
      makeResult({
        ovhCheck: {
          searched: true,
          found: 1,
          windowMs: OVH_SEARCH_WINDOW_MS,
          receiverMasked: "****9876",
          createdAtIso: new Date().toISOString(),
        },
      }),
    ];
    const res = assertAllAreAbandonable(results);
    assertRefused(res);
    expect(res.exitCode).toBe(5);
    expect(res.errors.join(" | ")).toContain("OVH a trouve 1 job");
  });

  it("refuse si verif OVH impossible (pas de receveur)", () => {
    const results = [
      makeResult({
        ovhCheck: {
          searched: false,
          reason: "no externalReceiver and contact.phone.e164 missing",
        },
      }),
    ];
    const res = assertAllAreAbandonable(results);
    assertRefused(res);
    expect(res.exitCode).toBe(5);
    expect(res.errors.join(" | ")).toContain("verif OVH impossible");
  });

  it("agrege plusieurs refus (defense : mentionne CHAQUE message en erreur)", () => {
    const results = [
      makeResult({ messageId: "A", actualStatus: "failed", expectedStatus: "draft" }),
      makeResult({
        messageId: "B",
        ovhCheck: { searched: true, found: 2, windowMs: OVH_SEARCH_WINDOW_MS },
      }),
      makeResult({ messageId: "C", ovhCheck: { searched: false, reason: "missing createdAt" } }),
    ];
    const res = assertAllAreAbandonable(results);
    assertRefused(res);
    expect(res.errors.length).toBeGreaterThanOrEqual(3);
    expect(res.errors.some((e: string) => e.includes("msg=A"))).toBe(true);
    expect(res.errors.some((e: string) => e.includes("msg=B"))).toBe(true);
    expect(res.errors.some((e: string) => e.includes("msg=C"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Resolution E.164 (via injection de dependance getContactFn)
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveReceiverE164", () => {
  it("priorite 1 : externalReceiver present dans le doc message", async () => {
    const msg = { externalReceiver: "+33612349876" };
    const got = await resolveReceiverE164(msg, "123_cam1", async () => {
      throw new Error("ne doit PAS etre appele si externalReceiver present");
    });
    expect(got).toBe("+33612349876");
  });

  it("priorite 2 : contact.phone.e164 via contactId extrait de conversationId", async () => {
    const msg = { externalReceiver: null };
    const got = await resolveReceiverE164(
      msg,
      "427963864300_hubspot-list-6081",
      async (id: string) => {
        expect(id).toBe("427963864300");
        return { phone: { e164: "+33611111111" } };
      },
    );
    expect(got).toBe("+33611111111");
  });

  it("retourne null si pas d'externalReceiver et contact absent", async () => {
    const got = await resolveReceiverE164({}, "123_cam", async () => null);
    expect(got).toBeNull();
  });

  it("retourne null si contact.phone.e164 absent", async () => {
    const got = await resolveReceiverE164({}, "123_cam", async () => ({ phone: {} }));
    expect(got).toBeNull();
  });

  it("retourne null si conversationId n'a pas de separateur `_`", async () => {
    const got = await resolveReceiverE164({}, "", async () => ({
      phone: { e164: "+33611111111" },
    }));
    expect(got).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Construction du path OVH — fenetre +/- 10 min
// ─────────────────────────────────────────────────────────────────────────────

describe("buildOvhSearchPath", () => {
  it("encode service, applique la fenetre, convertit +33 -> 0033", () => {
    const createdAt = new Date("2026-10-16T12:00:00.000Z");
    const path = buildOvhSearchPath("sms-ab12345-1", "+33612349876", createdAt);
    expect(path).toContain("/sms/sms-ab12345-1/outgoing");
    expect(path).toContain("creationDatetime.from=2026-10-16T11%3A50%3A00.000Z");
    expect(path).toContain("creationDatetime.to=2026-10-16T12%3A10%3A00.000Z");
    expect(path).toContain("receiver=0033612349876");
  });

  it("throw si createdAt n'est pas une Date (defense anti-mauvais caller)", () => {
    expect(() => buildOvhSearchPath("svc", "+33612349876", null as unknown as Date)).toThrow(
      /createdAt/,
    );
  });

  it("fenetre = exactement 10 min * 2 = 20 min au total", () => {
    const createdAt = new Date("2026-01-01T10:00:00.000Z");
    const path = buildOvhSearchPath("svc", "+33611111111", createdAt);
    const fromMatch = path.match(/from=([^&]+)/);
    const toMatch = path.match(/to=([^&]+)/);
    expect(fromMatch).not.toBeNull();
    expect(toMatch).not.toBeNull();
    const fromIso = fromMatch?.[1] ?? "";
    const toIso = toMatch?.[1] ?? "";
    const from = new Date(decodeURIComponent(fromIso));
    const to = new Date(decodeURIComponent(toIso));
    expect(to.getTime() - from.getTime()).toBe(20 * 60 * 1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Payload audit — zero PII, forme stable
// ─────────────────────────────────────────────────────────────────────────────

describe("buildAuditPayload", () => {
  it("construit un payload scrubber-safe (aucun phone, aucun email)", () => {
    const result = makeResult();
    const payload = buildAuditPayload(result, "draft");
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/\+33\d{9}/);
    expect(serialized).not.toMatch(/\b0[67]\d{8}\b/);
    expect(serialized).not.toMatch(/@/);
    expect(payload.reason).toBe(AUDIT_REASON);
    expect(payload.conversationId).toBe(CONVERSATION_ID);
    expect(payload.previousStatus).toBe("draft");
    expect(payload.newStatus).toBe(NEW_STATUS);
    expect(payload.abandonReason).toBe(ABANDON_REASON);
    expect(payload.ovhProof.searched).toBe(true);
    expect(payload.ovhProof.foundJobs).toBe(0);
    expect(payload.ovhProof.windowMs).toBe(OVH_SEARCH_WINDOW_MS);
  });

  it("preserve previousStatus (draft vs queued) pour trace forensic", () => {
    const result = makeResult();
    expect(buildAuditPayload(result, "draft").previousStatus).toBe("draft");
    expect(buildAuditPayload(result, "queued").previousStatus).toBe("queued");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot serialisation
// ─────────────────────────────────────────────────────────────────────────────

describe("toSnapshotSafe / buildSnapshotPayload", () => {
  it("convertit Timestamp Firestore via marker __firestoreTimestamp__", () => {
    const ts = Timestamp.fromMillis(1_700_000_000_000);
    const out = toSnapshotSafe(ts) as {
      __firestoreTimestamp__: boolean;
      seconds: number;
      nanoseconds: number;
      iso: string;
    };
    expect(out.__firestoreTimestamp__).toBe(true);
    expect(out.seconds).toBe(ts.seconds);
    expect(out.nanoseconds).toBe(ts.nanoseconds);
    expect(out.iso).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("convertit Date JS via marker __jsDate__", () => {
    const d = new Date("2026-10-19T12:00:00.000Z");
    const out = toSnapshotSafe(d) as { __jsDate__: boolean; iso: string };
    expect(out.__jsDate__).toBe(true);
    expect(out.iso).toBe("2026-10-19T12:00:00.000Z");
  });

  it("preserve les primitives / null / arrays / objets imbriques", () => {
    expect(toSnapshotSafe(42)).toBe(42);
    expect(toSnapshotSafe(null)).toBeNull();
    expect(toSnapshotSafe("abc")).toBe("abc");
    expect(toSnapshotSafe([1, 2, 3])).toEqual([1, 2, 3]);
    expect(toSnapshotSafe({ a: { b: [1] } })).toEqual({ a: { b: [1] } });
  });

  it("buildSnapshotPayload : forme stable, projectId inclus, note presente", () => {
    const results = [makeResult()];
    const payload = buildSnapshotPayload(results, "project-xyz") as {
      projectId: string;
      conversationId: string;
      messages: Array<{ messageId: string; data: Record<string, unknown> }>;
      note: string;
    };
    expect(payload.projectId).toBe("project-xyz");
    expect(payload.conversationId).toBe(CONVERSATION_ID);
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0]?.messageId).toBe("USqzioSTVioix630LgDs");
    expect(payload.note).toContain("JAMAIS de delete");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// maskPhone
// ─────────────────────────────────────────────────────────────────────────────

describe("maskPhone", () => {
  it("masque un E.164 FR aux 4 derniers chiffres", () => {
    expect(maskPhone("+33612349876")).toBe("****9876");
  });

  it("masque un format national 06", () => {
    expect(maskPhone("0612349876")).toBe("****9876");
  });

  it("retourne '****' pour input non-string ou vide", () => {
    expect(maskPhone(null as unknown as string)).toBe("****");
    expect(maskPhone("")).toBe("****");
    expect(maskPhone("abc")).toBe("****");
  });
});
