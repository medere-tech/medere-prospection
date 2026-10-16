import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __DASHBOARD_URL_FALLBACK_FOR_TESTS } from "@/lib/inngest/functions/slack-handoff";
import { logger } from "@/lib/utils/logger";

import { DASHBOARD_URL_FALLBACK, getDashboardConversationUrl } from "./dashboard-url";

describe("dashboard-url (PR-A)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("sentinelle anti-drift", () => {
    it("DASHBOARD_URL_FALLBACK === __DASHBOARD_URL_FALLBACK_FOR_TESTS (slack-handoff.ts)", () => {
      // Verrouille l'invariant : les deux pipelines Slack doivent produire
      // STRICTEMENT la même URL fallback (sinon un commercial reçoit deux
      // liens différents pour la même conversation).
      expect(DASHBOARD_URL_FALLBACK).toBe(__DASHBOARD_URL_FALLBACK_FOR_TESTS);
    });
  });

  describe("getDashboardConversationUrl", () => {
    it("base URL fournie → construit `${base}/conversations/${convId}`", () => {
      const url = getDashboardConversationUrl("contact_123_camp_a", {
        getBaseUrl: () => "https://dashboard.medere.fr",
      });
      expect(url).toBe("https://dashboard.medere.fr/conversations/contact_123_camp_a");
    });

    it("trailing slash dans la base → nettoyé (idempotent)", () => {
      const url = getDashboardConversationUrl("conv_x", {
        getBaseUrl: () => "https://dashboard.medere.fr//",
      });
      expect(url).toBe("https://dashboard.medere.fr/conversations/conv_x");
    });

    it("base undefined → fallback Vercel + warn", () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      const url = getDashboardConversationUrl("conv_x", { getBaseUrl: () => undefined });
      expect(url).toBe(`${DASHBOARD_URL_FALLBACK}/conversations/conv_x`);
      expect(warnSpy).toHaveBeenCalledOnce();
      // Pas de PII dans le log : juste l'opération.
      const payload = warnSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(payload.op).toBe("getDashboardConversationUrl");
    });

    it("base chaîne vide → fallback Vercel + warn (traité comme undefined)", () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      const url = getDashboardConversationUrl("conv_y", { getBaseUrl: () => "" });
      expect(url).toBe(`${DASHBOARD_URL_FALLBACK}/conversations/conv_y`);
      expect(warnSpy).toHaveBeenCalledOnce();
    });

    it("conversationId contenant un '/' hypothétique → encodé defense-in-depth", () => {
      // Scénario défensif : un futur campaignId pourrait introduire un
      // caractère réservé URL. On vérifie que l'URL reste cohérente.
      const url = getDashboardConversationUrl("contact/a_camp/b", {
        getBaseUrl: () => "https://dashboard.medere.fr",
      });
      expect(url).toBe("https://dashboard.medere.fr/conversations/contact%2Fa_camp%2Fb");
    });
  });
});
