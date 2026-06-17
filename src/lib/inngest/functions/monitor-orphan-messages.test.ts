/**
 * Tests unitaires `monitor-orphan-messages` cron handler (S9.4.4).
 *
 * Pattern mocks deps cohérent `send-reply.test.ts` (S9.4.2). Pas d'emulator
 * — tests d'intégration Firestore vivent dans `messages.test.ts` pour
 * `listStaleMessages`.
 *
 * Couverture :
 *   - Sentinelles structurelles : FUNCTION_ID, CRON_EXPRESSION, seuils,
 *     concurrency, retries
 *   - Branche healthy : aucun orphan → pas d'alerte
 *   - Branche orphans_detected drafts only / queued only / both
 *   - Truncation : si list.length === QUERY_LIMIT → truncated flag true
 *   - Anti-PII payload : counts/ages/booleans uniquement, pas de
 *     conversationId/messageId/body/phone
 *   - step.run nommés (memoization Inngest)
 *   - oldest age calculé correctement (DepsInjection now)
 */
import { Timestamp } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StaleMessageEntry } from "@/lib/firestore/messages";

import {
  __CRON_EXPRESSION_FOR_TESTS,
  __FUNCTION_ID_FOR_TESTS,
  __QUERY_LIMIT_FOR_TESTS,
  __STALE_THRESHOLD_MS_FOR_TESTS,
  monitorOrphanMessages,
  type MonitorOrphanMessagesDeps,
  monitorOrphanMessagesHandler,
  type MonitorOrphanMessagesHandlerContext,
} from "./monitor-orphan-messages";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const FIXED_NOW = new Date("2026-06-17T12:00:00Z");
const ONE_HOUR_MS = 60 * 60 * 1000;

function makeCtx(): MonitorOrphanMessagesHandlerContext {
  // step.run mock immédiat (pas de memoization Inngest dans tests
  // unitaires). Pattern miroir send-reply.test.ts.
  const realRun = async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn();
  const runSpy = vi.fn(realRun);
  return {
    event: { id: "cron-test-1" },
    step: {
      run: runSpy as MonitorOrphanMessagesHandlerContext["step"]["run"],
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

function makeStaleEntry(
  conversationId: string,
  messageId: string,
  ageMs: number,
  status: "draft" | "queued",
): StaleMessageEntry {
  const createdAt = Timestamp.fromMillis(FIXED_NOW.getTime() - ageMs);
  return { conversationId, messageId, createdAt, status };
}

function makeDeps(overrides: Partial<MonitorOrphanMessagesDeps> = {}): MonitorOrphanMessagesDeps {
  return {
    listStaleMessages: vi.fn().mockResolvedValue([]),
    captureMonitoringWarning: vi.fn(),
    now: () => FIXED_NOW,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe("monitorOrphanMessagesHandler — S9.4.4", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Sentinelles structurelles
  // ───────────────────────────────────────────────────────────────────────

  describe("sentinelles structurelles", () => {
    it("FUNCTION_ID === 'monitor-orphan-messages' (stable Inngest dashboard)", () => {
      expect(__FUNCTION_ID_FOR_TESTS).toBe("monitor-orphan-messages");
    });

    it("CRON_EXPRESSION === '0 * * * *' (hourly UTC)", () => {
      expect(__CRON_EXPRESSION_FOR_TESTS).toBe("0 * * * *");
    });

    it("STALE_THRESHOLD_MS === 3 600 000 (1h MVP)", () => {
      expect(__STALE_THRESHOLD_MS_FOR_TESTS).toBe(60 * 60 * 1000);
    });

    it("QUERY_LIMIT === 100 (anti-DoS Firestore)", () => {
      expect(__QUERY_LIMIT_FOR_TESTS).toBe(100);
    });

    it("function.concurrency : { limit: 1 } singleton (GF1 anti-overlap)", () => {
      const opts = (
        monitorOrphanMessages as unknown as { opts: { concurrency: { limit: number } } }
      ).opts;
      expect(opts.concurrency.limit).toBe(1);
    });

    it("function.retries === 0 (GF2 monitoring read-only)", () => {
      const opts = (monitorOrphanMessages as unknown as { opts: { retries: number } }).opts;
      expect(opts.retries).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Branche healthy — aucun orphan
  // ───────────────────────────────────────────────────────────────────────

  describe("branche healthy", () => {
    it("aucun draft/queued stale → status='healthy' + PAS d'alerte Sentry", async () => {
      const deps = makeDeps({
        listStaleMessages: vi.fn().mockResolvedValue([]),
      });
      const ctx = makeCtx();

      const result = await monitorOrphanMessagesHandler(ctx, deps);

      expect(result).toEqual({
        status: "healthy",
        staleDraftsCount: 0,
        staleQueuedCount: 0,
      });

      // Pas d'alerte Sentry posée
      expect(deps.captureMonitoringWarning).not.toHaveBeenCalled();

      // Logger.info posé pour observabilité Vercel logs
      expect(ctx.logger.info).toHaveBeenCalledWith(
        "[monitor-orphan-messages] healthy",
        expect.objectContaining({
          staleDraftsCount: 0,
          staleQueuedCount: 0,
        }),
      );
    });

    it("2 step.run appelés (list-stale-drafts + list-stale-queued)", async () => {
      const deps = makeDeps();
      const ctx = makeCtx();

      await monitorOrphanMessagesHandler(ctx, deps);

      const stepRun = ctx.step.run as ReturnType<typeof vi.fn>;
      expect(stepRun).toHaveBeenCalledTimes(2);
      expect(stepRun.mock.calls[0]?.[0]).toBe("list-stale-drafts");
      expect(stepRun.mock.calls[1]?.[0]).toBe("list-stale-queued");
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Branche orphans_detected — drafts only / queued only / both
  // ───────────────────────────────────────────────────────────────────────

  describe("branche orphans_detected", () => {
    it("drafts only (2 stale) → alerte posée + counts corrects", async () => {
      const staleDrafts = [
        makeStaleEntry("cv-1", "msg-d1", 2 * ONE_HOUR_MS, "draft"),
        makeStaleEntry("cv-2", "msg-d2", 1.5 * ONE_HOUR_MS, "draft"),
      ];
      const deps = makeDeps({
        listStaleMessages: vi
          .fn()
          .mockResolvedValueOnce(staleDrafts) // drafts
          .mockResolvedValueOnce([]), // queued
      });
      const ctx = makeCtx();

      const result = await monitorOrphanMessagesHandler(ctx, deps);

      expect(result.status).toBe("orphans_detected");
      if (result.status === "orphans_detected") {
        expect(result.staleDraftsCount).toBe(2);
        expect(result.staleQueuedCount).toBe(0);
        expect(result.oldestDraftAgeMs).toBe(2 * ONE_HOUR_MS); // oldest = first dans le array (sorted ASC par listStaleMessages)
        expect(result.oldestQueuedAgeMs).toBe(0);
        expect(result.draftsTruncated).toBe(false);
        expect(result.queuedTruncated).toBe(false);
      }

      // Alerte Sentry posée 1 fois avec messageKey + payload anti-PII
      expect(deps.captureMonitoringWarning).toHaveBeenCalledTimes(1);
      expect(deps.captureMonitoringWarning).toHaveBeenCalledWith("orphan_messages_detected", {
        extra: {
          staleDraftsCount: 2,
          staleQueuedCount: 0,
          oldestDraftAgeMs: 2 * ONE_HOUR_MS,
          oldestQueuedAgeMs: 0,
          draftsTruncated: false,
          queuedTruncated: false,
          thresholdMs: __STALE_THRESHOLD_MS_FOR_TESTS,
          queryLimit: __QUERY_LIMIT_FOR_TESTS,
        },
        tags: {
          sprint: "S9.4.4",
          monitoring: "orphan_messages",
        },
        fingerprint: ["S9.4.4", "orphan_messages"],
      });
    });

    it("queued only (1 stale) → alerte avec oldestQueuedAgeMs", async () => {
      const staleQueued = [makeStaleEntry("cv-3", "msg-q1", 3 * ONE_HOUR_MS, "queued")];
      const deps = makeDeps({
        listStaleMessages: vi
          .fn()
          .mockResolvedValueOnce([]) // drafts
          .mockResolvedValueOnce(staleQueued), // queued
      });
      const ctx = makeCtx();

      const result = await monitorOrphanMessagesHandler(ctx, deps);

      expect(result.status).toBe("orphans_detected");
      if (result.status === "orphans_detected") {
        expect(result.staleDraftsCount).toBe(0);
        expect(result.staleQueuedCount).toBe(1);
        expect(result.oldestQueuedAgeMs).toBe(3 * ONE_HOUR_MS);
      }
    });

    it("both drafts + queued (1+1) → alerte combinée", async () => {
      const deps = makeDeps({
        listStaleMessages: vi
          .fn()
          .mockResolvedValueOnce([makeStaleEntry("cv-1", "msg-d1", 2 * ONE_HOUR_MS, "draft")])
          .mockResolvedValueOnce([makeStaleEntry("cv-2", "msg-q1", 1.5 * ONE_HOUR_MS, "queued")]),
      });
      const ctx = makeCtx();

      const result = await monitorOrphanMessagesHandler(ctx, deps);

      expect(result.status).toBe("orphans_detected");
      if (result.status === "orphans_detected") {
        expect(result.staleDraftsCount).toBe(1);
        expect(result.staleQueuedCount).toBe(1);
        expect(result.oldestDraftAgeMs).toBe(2 * ONE_HOUR_MS);
        expect(result.oldestQueuedAgeMs).toBe(1.5 * ONE_HOUR_MS);
      }

      // 1 seule alerte Sentry combinée (pas 2 séparées)
      expect(deps.captureMonitoringWarning).toHaveBeenCalledTimes(1);
    });

    it("3 step.run appelés en mode orphans_detected (drafts + queued + report)", async () => {
      const deps = makeDeps({
        listStaleMessages: vi
          .fn()
          .mockResolvedValueOnce([makeStaleEntry("cv-1", "msg-d1", 2 * ONE_HOUR_MS, "draft")])
          .mockResolvedValueOnce([]),
      });
      const ctx = makeCtx();

      await monitorOrphanMessagesHandler(ctx, deps);

      const stepRun = ctx.step.run as ReturnType<typeof vi.fn>;
      expect(stepRun).toHaveBeenCalledTimes(3);
      expect(stepRun.mock.calls.map((c) => c[0])).toEqual([
        "list-stale-drafts",
        "list-stale-queued",
        "report-observability",
      ]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Truncation — incident massif (> QUERY_LIMIT orphans)
  // ───────────────────────────────────────────────────────────────────────

  describe("truncation (incident massif)", () => {
    it("drafts.length === QUERY_LIMIT (100) → draftsTruncated: true", async () => {
      // Simule 100 drafts stale (limit atteint = signal incident massif)
      const drafts = Array.from({ length: __QUERY_LIMIT_FOR_TESTS }, (_, i) =>
        makeStaleEntry(`cv-${i}`, `msg-d${i}`, (2 + i / 100) * ONE_HOUR_MS, "draft"),
      );
      const deps = makeDeps({
        listStaleMessages: vi.fn().mockResolvedValueOnce(drafts).mockResolvedValueOnce([]),
      });
      const ctx = makeCtx();

      const result = await monitorOrphanMessagesHandler(ctx, deps);

      expect(result.status).toBe("orphans_detected");
      if (result.status === "orphans_detected") {
        expect(result.staleDraftsCount).toBe(100);
        expect(result.draftsTruncated).toBe(true);
        expect(result.queuedTruncated).toBe(false);
      }

      // Payload Sentry inclut truncated flag
      const captureCall = (deps.captureMonitoringWarning as ReturnType<typeof vi.fn>).mock.calls[0];
      const extra = (captureCall?.[1] as { extra: Record<string, unknown> }).extra;
      expect(extra.draftsTruncated).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Anti-PII payload Sentry (defense-in-depth)
  // ───────────────────────────────────────────────────────────────────────

  describe("anti-PII payload Sentry", () => {
    it("payload extra ne contient pas conversationId/messageId/body/phone", async () => {
      const staleDrafts = [
        makeStaleEntry("hs_secret_cv", "msg_secret_ID", 2 * ONE_HOUR_MS, "draft"),
      ];
      const deps = makeDeps({
        listStaleMessages: vi.fn().mockResolvedValueOnce(staleDrafts).mockResolvedValueOnce([]),
      });
      const ctx = makeCtx();

      await monitorOrphanMessagesHandler(ctx, deps);

      const captureCall = (deps.captureMonitoringWarning as ReturnType<typeof vi.fn>).mock.calls[0];
      const extra = (captureCall?.[1] as { extra: Record<string, unknown> }).extra;

      // Champs exactement attendus (anti-bypass via Object.keys)
      expect(Object.keys(extra).sort()).toEqual([
        "draftsTruncated",
        "oldestDraftAgeMs",
        "oldestQueuedAgeMs",
        "queryLimit",
        "queuedTruncated",
        "staleDraftsCount",
        "staleQueuedCount",
        "thresholdMs",
      ]);

      // PAS de conversationId/messageId/body/phone exposés
      const serialized = JSON.stringify(captureCall);
      expect(serialized).not.toContain("hs_secret_cv");
      expect(serialized).not.toContain("msg_secret_ID");
      expect(serialized).not.toMatch(/\+33\d{9}/);
      expect(serialized).not.toMatch(/0[1-9]\d{8}/);
      expect(serialized).not.toMatch(/\S+@\S+\.\S+/);
    });

    it("logger.warn ne contient pas conversationId/messageId individuels", async () => {
      const staleDrafts = [
        makeStaleEntry("hs_secret_log", "msg_secret_LOG", 2 * ONE_HOUR_MS, "draft"),
      ];
      const deps = makeDeps({
        listStaleMessages: vi.fn().mockResolvedValueOnce(staleDrafts).mockResolvedValueOnce([]),
      });
      const ctx = makeCtx();

      await monitorOrphanMessagesHandler(ctx, deps);

      const warnCalls = (ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
      const serialized = JSON.stringify(warnCalls);
      expect(serialized).not.toContain("hs_secret_log");
      expect(serialized).not.toContain("msg_secret_LOG");
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // listStaleMessages appelé avec params corrects
  // ───────────────────────────────────────────────────────────────────────

  describe("paramètres passés à listStaleMessages", () => {
    it("appelé avec status='draft' + maxAgeMs=1h + limit=100", async () => {
      const deps = makeDeps();
      const ctx = makeCtx();

      await monitorOrphanMessagesHandler(ctx, deps);

      const listCalls = (deps.listStaleMessages as ReturnType<typeof vi.fn>).mock.calls;
      expect(listCalls[0]?.[0]).toMatchObject({
        status: "draft",
        maxAgeMs: ONE_HOUR_MS,
        limit: __QUERY_LIMIT_FOR_TESTS,
      });
      expect(listCalls[1]?.[0]).toMatchObject({
        status: "queued",
        maxAgeMs: ONE_HOUR_MS,
        limit: __QUERY_LIMIT_FOR_TESTS,
      });
    });
  });
});
