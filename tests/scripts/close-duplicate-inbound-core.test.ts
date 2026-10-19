/**
 * Tests unitaires des helpers purs de `scripts/close-duplicate-inbound.mjs`
 * (R5-Point5). Couvre :
 *   - Exit codes (5 = garde-fou, 0 = ok, autres gere par le script)
 *   - Mutation testing : chaque garde-fou a son test rouge
 *   - computeConversationCorrections : les 4 branches
 *     (lastInboundAt pointe sur doublon vs non, candidate present vs absent)
 *   - Payload audit : zero PII
 *   - Snapshot : forme stable + Timestamp markers
 */
import { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";

import {
  assertIdsAreTargets,
  assertStateIsDuplicable,
  AUDIT_REASON,
  buildAuditPayload,
  buildSnapshotPayload,
  computeConversationCorrections,
  CONVERSATION_ID,
  DUPLICATE_ID,
  EXPECTED_DUPLICATE_STATUS,
  EXPECTED_EXTERNAL_ID,
  NEW_STATUS,
  ORIGINAL_ID,
  toSnapshotSafe,
} from "../../scripts/_lib/close-duplicate-inbound-core.mjs";

type RefusedAssert = { ok: false; exitCode: number; errors: string[] };

function assertRefused(res: unknown): asserts res is RefusedAssert {
  expect(res).toMatchObject({ ok: false });
  const r = res as { ok: boolean };
  if (r.ok) throw new Error("test precondition: expected refusal");
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const ORIG_CREATED_MS = 1_729_000_000_000;
const DUP_CREATED_MS = 1_729_000_010_000;

interface Candidate {
  id: string;
  createdAt: Timestamp;
  status: string;
  externalId: string;
}

interface State {
  conv: Record<string, unknown>;
  original: Record<string, unknown>;
  duplicate: Record<string, unknown>;
  inboundCandidates: Candidate[];
}

function makeState(): State {
  return {
    conv: {
      inboundCount: 5,
      lastInboundAt: Timestamp.fromMillis(DUP_CREATED_MS),
    },
    original: {
      direction: "inbound",
      status: "received",
      externalId: EXPECTED_EXTERNAL_ID,
      createdAt: Timestamp.fromMillis(ORIG_CREATED_MS),
    },
    duplicate: {
      direction: "inbound",
      status: "received",
      externalId: EXPECTED_EXTERNAL_ID,
      createdAt: Timestamp.fromMillis(DUP_CREATED_MS),
    },
    inboundCandidates: [
      {
        id: DUPLICATE_ID,
        createdAt: Timestamp.fromMillis(DUP_CREATED_MS),
        status: "received",
        externalId: EXPECTED_EXTERNAL_ID,
      },
      {
        id: ORIGINAL_ID,
        createdAt: Timestamp.fromMillis(ORIG_CREATED_MS),
        status: "received",
        externalId: EXPECTED_EXTERNAL_ID,
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Constantes figees
// ─────────────────────────────────────────────────────────────────────────────

describe("assertIdsAreTargets (exit code 5)", () => {
  it("ok sur les 4 constantes attendues", () => {
    const res = assertIdsAreTargets({
      CONVERSATION_ID,
      ORIGINAL_ID,
      DUPLICATE_ID,
      EXPECTED_EXTERNAL_ID,
    });
    expect(res).toEqual({ ok: true });
  });

  it("refuse si une constante change (mutation)", () => {
    const res = assertIdsAreTargets({
      CONVERSATION_ID: "autre",
      ORIGINAL_ID,
      DUPLICATE_ID,
      EXPECTED_EXTERNAL_ID,
    });
    assertRefused(res);
    expect(res.exitCode).toBe(5);
    expect(res.errors.join(" | ")).toContain("CONVERSATION_ID");
  });

  it("refuse si ORIGINAL_ID change", () => {
    const res = assertIdsAreTargets({
      CONVERSATION_ID,
      ORIGINAL_ID: "wrong",
      DUPLICATE_ID,
      EXPECTED_EXTERNAL_ID,
    });
    assertRefused(res);
    expect(res.exitCode).toBe(5);
  });

  it("refuse si EXPECTED_EXTERNAL_ID change", () => {
    const res = assertIdsAreTargets({
      CONVERSATION_ID,
      ORIGINAL_ID,
      DUPLICATE_ID,
      EXPECTED_EXTERNAL_ID: "99999",
    });
    assertRefused(res);
    expect(res.exitCode).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Garde-fou etat
// ─────────────────────────────────────────────────────────────────────────────

describe("assertStateIsDuplicable (exit code 5)", () => {
  it("ok sur l'etat happy-path", () => {
    expect(assertStateIsDuplicable(makeState())).toEqual({ ok: true });
  });

  it("refuse si doublon direction != inbound", () => {
    const s = makeState();
    s.duplicate.direction = "outbound";
    const res = assertStateIsDuplicable(s);
    assertRefused(res);
    expect(res.exitCode).toBe(5);
    expect(res.errors.join(" | ")).toContain("doublon direction");
  });

  it("refuse si original direction != inbound", () => {
    const s = makeState();
    s.original.direction = "outbound";
    const res = assertStateIsDuplicable(s);
    assertRefused(res);
    expect(res.errors.some((e: string) => e.includes("original direction"))).toBe(true);
  });

  it("refuse si doublon.status != 'received' (race)", () => {
    const s = makeState();
    s.duplicate.status = "duplicate"; // deja ferme → race
    const res = assertStateIsDuplicable(s);
    assertRefused(res);
    expect(res.errors.some((e: string) => e.includes("doublon status"))).toBe(true);
  });

  it("refuse si externalId divergent entre les 2 docs", () => {
    const s = makeState();
    s.duplicate.externalId = "autre-id";
    const res = assertStateIsDuplicable(s);
    assertRefused(res);
    expect(res.errors.some((e: string) => e.includes("meme externalId"))).toBe(true);
  });

  it("refuse si original.externalId != EXPECTED_EXTERNAL_ID", () => {
    const s = makeState();
    s.original.externalId = "9999";
    s.duplicate.externalId = "9999";
    const res = assertStateIsDuplicable(s);
    assertRefused(res);
    expect(res.errors.some((e: string) => e.includes("original externalId"))).toBe(true);
  });

  it("refuse si doublon.createdAt < original.createdAt (identification inversee)", () => {
    const s = makeState();
    s.duplicate.createdAt = Timestamp.fromMillis(ORIG_CREATED_MS - 1000);
    const res = assertStateIsDuplicable(s);
    assertRefused(res);
    expect(res.errors.some((e: string) => e.includes("anterieur"))).toBe(true);
  });

  it("refuse si createdAt manquant", () => {
    const s = makeState();
    s.duplicate.createdAt = null;
    const res = assertStateIsDuplicable(s);
    assertRefused(res);
    expect(res.errors.some((e: string) => e.includes("createdAt manquant"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeConversationCorrections — branches
// ─────────────────────────────────────────────────────────────────────────────

describe("computeConversationCorrections", () => {
  it("inboundCount decremente de 1 (toujours)", () => {
    const c = computeConversationCorrections(makeState());
    expect(c.inboundCount.before).toBe(5);
    expect(c.inboundCount.after).toBe(4);
    expect(c.inboundCount.changed).toBe(true);
  });

  it("inboundCount reste >= 0 (defense bug compteur negatif)", () => {
    const s = makeState();
    s.conv.inboundCount = 0;
    const c = computeConversationCorrections(s);
    expect(c.inboundCount.after).toBe(0);
    expect(c.inboundCount.changed).toBe(false);
  });

  it("lastInboundAt bouge si pointe sur le doublon : candidate = original", () => {
    const c = computeConversationCorrections(makeState());
    expect(c.lastInboundAt.changed).toBe(true);
    expect(c.lastInboundAt.source).toBe(`message/${ORIGINAL_ID}`);
    expect(c.lastInboundAt.newValue).toBeInstanceOf(Timestamp);
    expect((c.lastInboundAt.newValue as Timestamp).toMillis()).toBe(ORIG_CREATED_MS);
  });

  it("lastInboundAt inchange si ne pointe PAS sur le doublon (createdAt different)", () => {
    const s = makeState();
    s.conv.lastInboundAt = Timestamp.fromMillis(ORIG_CREATED_MS);
    const c = computeConversationCorrections(s);
    expect(c.lastInboundAt.changed).toBe(false);
    expect(c.lastInboundAt.source).toBe("unchanged");
  });

  it("lastInboundAt -> null si aucun autre inbound (candidate introuvable)", () => {
    const s = makeState();
    const dup = s.inboundCandidates[0];
    expect(dup).toBeDefined();
    s.inboundCandidates = dup ? [dup] : [];
    const c = computeConversationCorrections(s);
    expect(c.lastInboundAt.changed).toBe(true);
    expect(c.lastInboundAt.newValue).toBeNull();
    expect(c.lastInboundAt.source).toBe("no_remaining_inbound_null");
  });

  it("lastInboundAt ignore candidate marque 'duplicate' (defense re-run)", () => {
    const s = makeState();
    const dup = s.inboundCandidates[0];
    const orig = s.inboundCandidates[1];
    expect(dup).toBeDefined();
    expect(orig).toBeDefined();
    s.inboundCandidates = [dup as Candidate, { ...(orig as Candidate), status: "duplicate" }];
    const c = computeConversationCorrections(s);
    expect(c.lastInboundAt.changed).toBe(true);
    expect(c.lastInboundAt.newValue).toBeNull();
  });

  it("inboundCount=undefined -> traite comme 0 (defense data manquante)", () => {
    const s = makeState();
    delete s.conv.inboundCount;
    const c = computeConversationCorrections(s);
    expect(c.inboundCount.before).toBe(0);
    expect(c.inboundCount.after).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit payload — zero PII
// ─────────────────────────────────────────────────────────────────────────────

describe("buildAuditPayload", () => {
  it("payload scrubber-safe : aucun phone, aucun email", () => {
    const c = computeConversationCorrections(makeState());
    const payload = buildAuditPayload(c);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/\+33\d{9}/);
    expect(serialized).not.toMatch(/\b0[67]\d{8}\b/);
    expect(serialized).not.toMatch(/@/);
  });

  it("payload contient tous les champs forensiques attendus", () => {
    const c = computeConversationCorrections(makeState());
    const payload = buildAuditPayload(c);
    expect(payload.reason).toBe(AUDIT_REASON);
    expect(payload.conversationId).toBe(CONVERSATION_ID);
    expect(payload.originalMessageId).toBe(ORIGINAL_ID);
    expect(payload.duplicateMessageId).toBe(DUPLICATE_ID);
    expect(payload.duplicateOf).toBe(ORIGINAL_ID);
    expect(payload.previousStatus).toBe(EXPECTED_DUPLICATE_STATUS);
    expect(payload.newStatus).toBe(NEW_STATUS);
    expect(payload.counterCorrection.inboundCount.before).toBe(5);
    expect(payload.counterCorrection.inboundCount.after).toBe(4);
    expect(payload.counterCorrection.lastInboundAt.changed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot
// ─────────────────────────────────────────────────────────────────────────────

describe("toSnapshotSafe / buildSnapshotPayload", () => {
  it("convertit Timestamp Firestore via marker __firestoreTimestamp__", () => {
    const ts = Timestamp.fromMillis(1_729_000_000_000);
    const out = toSnapshotSafe(ts) as { __firestoreTimestamp__: boolean; seconds: number };
    expect(out.__firestoreTimestamp__).toBe(true);
    expect(out.seconds).toBe(ts.seconds);
  });

  it("preserve nested data (duplicate + original + conv)", () => {
    const state = makeState();
    const c = computeConversationCorrections(state);
    const payload = buildSnapshotPayload(state, c, "project-xyz") as {
      projectId: string;
      original: { id: string; data: Record<string, unknown> };
      duplicate: { id: string; data: Record<string, unknown> };
      conversationBefore: Record<string, unknown>;
      plannedCorrections: Record<string, unknown>;
      note: string;
    };
    expect(payload.projectId).toBe("project-xyz");
    expect(payload.original.id).toBe(ORIGINAL_ID);
    expect(payload.duplicate.id).toBe(DUPLICATE_ID);
    expect(payload.conversationBefore).toBeDefined();
    expect(payload.plannedCorrections).toBeDefined();
    expect(payload.note).toContain("JAMAIS de delete");
    expect(payload.note).toContain("L'ORIGINAL reste intact");
  });
});
