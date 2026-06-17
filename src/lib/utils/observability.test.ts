/**
 * Tests `observability.ts` wrapper Sentry + Pino (S9.4.4).
 *
 * Couverture :
 *   - Dual-output : log Pino warn + Sentry.captureMessage appelés TOUS LES 2
 *   - Sentry niveau "warning" (pas "error")
 *   - Extra / tags / fingerprint propagés correctement
 *   - Best-effort Sentry : si SDK throw, log Pino-only, pas de propagation
 *     d'erreur au caller
 *   - Anti-PII : typage strict ObservabilityExtra empêche objets imbriqués
 *     (verrouillé compile-time via @ts-expect-error si bypass tenté — pas
 *     testable runtime, on documente uniquement)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks (DOIVENT être déclarés AVANT l'import du wrapper).
// ─────────────────────────────────────────────────────────────────────────────
vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
}));

vi.mock("@/lib/utils/logger", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

// Imports AFTER mocks
import * as Sentry from "@sentry/nextjs";

import { logger } from "@/lib/utils/logger";

import { captureMonitoringWarning } from "./observability";

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe("captureMonitoringWarning — S9.4.4", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Dual-output : Pino warn + Sentry captureMessage
  // ───────────────────────────────────────────────────────────────────────

  describe("dual-output (Pino + Sentry)", () => {
    it("appelle Sentry.captureMessage avec level='warning' + messageKey + options", () => {
      captureMonitoringWarning("orphan_messages_detected", {
        extra: { staleDraftsCount: 3, staleQueuedCount: 0 },
        tags: { sprint: "S9.4.4", monitoring: "orphan_messages" },
        fingerprint: ["S9.4.4", "orphan_messages"],
      });

      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(Sentry.captureMessage).toHaveBeenCalledWith("orphan_messages_detected", {
        level: "warning",
        extra: { staleDraftsCount: 3, staleQueuedCount: 0 },
        tags: { sprint: "S9.4.4", monitoring: "orphan_messages" },
        fingerprint: ["S9.4.4", "orphan_messages"],
      });
    });

    it("appelle logger.warn TOUJOURS en parallèle de Sentry (dual-output)", () => {
      captureMonitoringWarning("orphan_messages_detected", {
        extra: { staleDraftsCount: 2 },
        tags: { sprint: "S9.4.4" },
      });

      expect(logger.warn).toHaveBeenCalledTimes(1);
      const call = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0];
      // Pino signature : objet en 1er, message en 2ème
      const logObj = call?.[0] as Record<string, unknown>;
      const logMsg = call?.[1] as string;
      expect(logObj.staleDraftsCount).toBe(2);
      expect(logObj.tags).toEqual({ sprint: "S9.4.4" });
      expect(logObj.observability_kind).toBe("monitoring_warning");
      expect(logMsg).toBe("[observability] orphan_messages_detected");
    });

    it("options vide accepté (defaults vers {})", () => {
      captureMonitoringWarning("test_no_options");

      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);

      const sentryCall = (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sentryCall?.[0]).toBe("test_no_options");
      expect(sentryCall?.[1]).toEqual({
        level: "warning",
        extra: undefined,
        tags: undefined,
        fingerprint: undefined,
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Best-effort Sentry : SDK throw → log Pino-only
  // ───────────────────────────────────────────────────────────────────────

  describe("best-effort Sentry (anti-propagation erreur)", () => {
    it("Sentry.captureMessage throw → log Pino warn + log Pino error + PAS de propagation", () => {
      vi.mocked(Sentry.captureMessage).mockImplementationOnce(() => {
        throw new Error("Sentry transport failure");
      });

      // L'appel NE DOIT PAS throw (best-effort).
      expect(() =>
        captureMonitoringWarning("orphan_messages_detected", {
          extra: { staleDraftsCount: 1 },
        }),
      ).not.toThrow();

      // Le log Pino warn est posé AVANT le try Sentry → présent.
      expect(logger.warn).toHaveBeenCalledTimes(1);
      // Le log Pino error capture la failure Sentry (dégradation gracieuse).
      expect(logger.error).toHaveBeenCalledTimes(1);
      const errCall = (logger.error as ReturnType<typeof vi.fn>).mock.calls[0];
      const errObj = errCall?.[0] as Record<string, unknown>;
      expect(errObj.observability_kind).toBe("sentry_capture_failure");
      expect(errObj.sentryError).toBe("Sentry transport failure");
      expect(errObj.originalMessageKey).toBe("orphan_messages_detected");
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Anti-PII — typage strict ObservabilityExtra
  // ───────────────────────────────────────────────────────────────────────

  describe("anti-PII typage strict", () => {
    it("accepte les types primitifs scalaires (string, number, boolean, null)", () => {
      captureMonitoringWarning("type_check", {
        extra: {
          countAsNumber: 42,
          enabledAsBoolean: true,
          missingAsNull: null,
          labelAsString: "scrubber-safe",
        },
      });

      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      const sentryCall = (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sentryCall?.[1]).toMatchObject({
        extra: {
          countAsNumber: 42,
          enabledAsBoolean: true,
          missingAsNull: null,
          labelAsString: "scrubber-safe",
        },
      });
    });

    it("le payload sérialisé ne contient pas de PII (sentinelle scrubber-safe)", () => {
      // Sentinelle defense-in-depth : si un caller passe un string PII dans
      // extra (autorisé par typage car string), on vérifie au runtime
      // qu'aucun pattern E.164/FR/email n'apparaît dans le payload final.
      // C'est la responsabilité du CALLER de discipliner — ce test
      // document le contrat anti-PII attendu.
      captureMonitoringWarning("payload_sentinelle", {
        extra: {
          // Valeurs SAINES (scrubber-safe par construction côté caller)
          staleDraftsCount: 3,
          oldestDraftAgeMs: 4_500_000,
        },
        tags: { sprint: "S9.4.4" },
      });

      const sentryCall = (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      const serialized = JSON.stringify(sentryCall);

      // Aucune PII attendue dans un usage légitime du wrapper
      expect(serialized).not.toMatch(/\+33\d{9}/); // E.164 FR
      expect(serialized).not.toMatch(/0[1-9]\d{8}/); // FR national
      expect(serialized).not.toMatch(/\S+@\S+\.\S+/); // email
    });
  });
});
