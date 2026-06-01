/**
 * Tests pre-send-check-with-audit.ts. 100% coverage non-négociable
 * (lib/compliance, cf. vitest.config.ts seuil).
 *
 * Couvre :
 *
 *   - Sentinel structurel deep-equal : preSendCheck(args) === wrapper(args)
 *     pour ok=true ET ok=false. Prouve que le wrapper N'ALTÈRE JAMAIS la
 *     logique S5.
 *
 *   - Branche allowed : 1 audit payload { result: "allowed" }.
 *
 *   - Branche blocked × chaque rule (rate_limit, opted_out, ai_disclosure,
 *     stop_optout, outside_hours, legitimate_interest, phone_invalid,
 *     phone_voip, bloctel_*) : payload contient code/rule/context corrects.
 *
 *   - targetId = contact.hubspotId (PAS phone, PAS email — sentinel anti-PII).
 *
 *   - actorId/actorType = "system" + action = "compliance_check"
 *     (sentinels typage).
 *
 *   - `appendAuditLog` throw → propage (compliance > availability).
 *
 *   - `deps` (injection règles S4) passé tel quel à preSendCheck.
 *
 * Toute interaction Firestore est MOCKÉE — ces tests vivent dans la
 * config root (pas firestore emulator). Le test d'intégration réel
 * (audit posé en base) vit dans concurrency.test.ts en S6.6.4.
 */
import { Timestamp } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as auditLogModule from "@/lib/firestore/audit-log";
import { AuditPiiError } from "@/lib/utils/errors";
import type { Contact } from "@/types/contact";

import { preSendCheck, type PreSendCheckArgs, type PreSendCheckDeps } from "./pre-send-check";
import { preSendCheckWithAudit } from "./pre-send-check-with-audit";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de seed (in-memory, pas de Firestore)
// ─────────────────────────────────────────────────────────────────────────────

const FIXED_NOW = new Date("2026-05-12T11:00:00Z"); // mardi, 13h Paris (plage 10-13h)

function buildValidContact(overrides: Partial<Contact> = {}): Contact {
  const now = Timestamp.fromDate(FIXED_NOW);
  return {
    hubspotId: "hs_abc123",
    firstName: "Jean",
    lastName: "Dupont",
    civilite: "Dr",
    speciality: "dentiste",
    city: "Paris",
    postalCode: "75001",
    phone: {
      e164: "+33612345678",
      raw: "06 12 34 56 78",
      type: "mobile",
      valid: true,
      lookupAt: now,
    },
    segment: "b2b_cabinet",
    bloctelChecked: true,
    bloctelOptOut: false,
    bloctelCheckedAt: now,
    consent: {
      legitimateInterest: "Contact HubSpot Médéré importé le 2026-05-29, dentiste IDF, opt-in B2B.",
      optedOut: false,
    },
    enrichment: {
      source: "hubspot",
      enrichedAt: now,
    },
    status: "ready",
    campaignId: "dentistes-idf-mai-2026",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Args qui passent TOUTES les règles via deps tout-mocké-allowed.
 * Permet de tester précisément CHAQUE règle en remplaçant UN deps à la fois.
 */
function buildPassingArgs(): {
  args: PreSendCheckArgs;
  deps: Required<PreSendCheckDeps>;
} {
  const contact = buildValidContact();
  return {
    args: {
      contact,
      message: "Bonjour, Léa de Médéré. Une question rapide à vous poser. STOP pour refuser.",
      conversation: { messageCount: 0 },
      recentOutboundMessages: [],
      now: FIXED_NOW,
    },
    deps: {
      hasAIDisclosure: vi.fn(() => true),
      hasOptOut: vi.fn(() => true),
      canSendMessage: vi.fn(() => ({ allowed: true })),
      isAllowedSendTime: vi.fn(() => ({ allowed: true })),
      canSendB2C: vi.fn(() => ({ allowed: true })),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe("preSendCheckWithAudit", () => {
  let appendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    appendSpy = vi.spyOn(auditLogModule, "appendAuditLog").mockResolvedValue("audit-id-stub");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Sentinel deep-equal — invariant 3 (wrapper N'ALTÈRE JAMAIS la logique S5)
  // ───────────────────────────────────────────────────────────────────────

  describe("sentinel structurel", () => {
    it("ok=true : wrapper(args) === preSendCheck(args) (deep equal)", async () => {
      const { args, deps } = buildPassingArgs();

      const pureResult = preSendCheck(args, deps);
      const auditedResult = await preSendCheckWithAudit(args, deps);

      expect(auditedResult).toEqual(pureResult);
      expect(pureResult.ok).toBe(true);
    });

    it("ok=false : wrapper(args) === preSendCheck(args) (deep equal)", async () => {
      const { args, deps } = buildPassingArgs();
      // Bloque sur rate_limit (3 outbound récents)
      args.recentOutboundMessages = [
        { direction: "outbound", sentAt: new Date(FIXED_NOW.getTime() - 1 * 86400_000) },
        { direction: "outbound", sentAt: new Date(FIXED_NOW.getTime() - 2 * 86400_000) },
        { direction: "outbound", sentAt: new Date(FIXED_NOW.getTime() - 3 * 86400_000) },
      ];
      deps.canSendMessage = vi.fn(() => ({
        allowed: false,
        reason: "Plafond 3/30j atteint (3 envois récents)",
      }));

      const pureResult = preSendCheck(args, deps);
      const auditedResult = await preSendCheckWithAudit(args, deps);

      expect(auditedResult).toEqual(pureResult);
      expect(pureResult.ok).toBe(false);
    });

    it("le wrapper PASSE deps tel quel à preSendCheck (injection préservée)", async () => {
      const { args, deps } = buildPassingArgs();

      await preSendCheckWithAudit(args, deps);

      // Toutes les règles ont été consultées (preSendCheck a court-
      // circuité ou pas selon le contenu, mais les dépendances injectées
      // ont bien été appelées).
      expect(deps.hasAIDisclosure).toHaveBeenCalled();
      expect(deps.hasOptOut).toHaveBeenCalled();
      expect(deps.canSendMessage).toHaveBeenCalled();
      expect(deps.isAllowedSendTime).toHaveBeenCalled();
      expect(deps.canSendB2C).toHaveBeenCalled();
    });

    it("wrapper sans deps → preSendCheck utilise les vraies impls S4 (smoke test)", async () => {
      // Sans deps, preSendCheck appelle les vraies hasAIDisclosure /
      // hasOptOut etc. de S4. On vérifie que ça compile et passe le
      // wrapper sans crash — le résultat dépend du message et du now,
      // ici on a un message qui contient "Léa" + "STOP" donc ça passe
      // hasAIDisclosure + hasOptOut. Les autres règles (rate_limit,
      // hours) sont validées par leurs propres tests S4.
      const { args } = buildPassingArgs();
      // Pas de deps. Le wrapper relaye à preSendCheck qui utilise S4 réel.
      await preSendCheckWithAudit(args);
      // Soft assertion : un audit a été posé (peu importe le verdict).
      expect(appendSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Branche allowed
  // ───────────────────────────────────────────────────────────────────────

  describe("branche allowed", () => {
    it("audit avec payload { result: 'allowed' } UNIQUEMENT", async () => {
      const { args, deps } = buildPassingArgs();

      const result = await preSendCheckWithAudit(args, deps);

      expect(result.ok).toBe(true);
      expect(appendSpy).toHaveBeenCalledTimes(1);
      const call = appendSpy.mock.calls[0]?.[0];
      expect(call?.action).toBe("compliance_check");
      expect(call?.actorId).toBe("system");
      expect(call?.actorType).toBe("system");
      expect(call?.targetType).toBe("contact");
      expect(call?.targetId).toBe("hs_abc123");
      expect(call?.payload).toEqual({ result: "allowed" });
    });

    it("PAS de code/rule/context dans payload allowed (objet minimal)", async () => {
      const { args, deps } = buildPassingArgs();
      await preSendCheckWithAudit(args, deps);

      const call = appendSpy.mock.calls[0]?.[0];
      expect(call?.payload).not.toHaveProperty("code");
      expect(call?.payload).not.toHaveProperty("rule");
      expect(call?.payload).not.toHaveProperty("context");
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Branche blocked × chaque rule
  // ───────────────────────────────────────────────────────────────────────

  describe("branche blocked", () => {
    it("opted_out → payload { result, code, rule, context: {} }", async () => {
      const { args, deps } = buildPassingArgs();
      args.contact = buildValidContact({
        consent: {
          legitimateInterest: args.contact.consent.legitimateInterest,
          optedOut: true,
          optedOutAt: Timestamp.fromDate(FIXED_NOW),
          optedOutChannel: "sms",
        },
      });

      const result = await preSendCheckWithAudit(args, deps);

      expect(result.ok).toBe(false);
      const call = appendSpy.mock.calls[0]?.[0];
      expect(call?.payload).toEqual({
        result: "blocked",
        code: "opted_out",
        rule: "opt_out",
        context: {},
      });
    });

    it("ai_disclosure_missing → payload context: {} (1er SMS sans annonce IA)", async () => {
      const { args, deps } = buildPassingArgs();
      deps.hasAIDisclosure = vi.fn(() => false);
      args.conversation = { messageCount: 0 };

      await preSendCheckWithAudit(args, deps);

      const call = appendSpy.mock.calls[0]?.[0];
      expect(call?.payload).toEqual({
        result: "blocked",
        code: "ai_disclosure_missing",
        rule: "ai_disclosure",
        context: {},
      });
    });

    it("stop_optout_missing → payload context: {}", async () => {
      const { args, deps } = buildPassingArgs();
      deps.hasOptOut = vi.fn(() => false);

      await preSendCheckWithAudit(args, deps);

      const call = appendSpy.mock.calls[0]?.[0];
      expect(call?.payload).toEqual({
        result: "blocked",
        code: "stop_optout_missing",
        rule: "stop_present",
        context: {},
      });
    });

    it("rate_limit_exceeded → payload context: { count, maxAllowed, windowDays }", async () => {
      const { args, deps } = buildPassingArgs();
      args.recentOutboundMessages = [
        { direction: "outbound", sentAt: new Date(FIXED_NOW.getTime() - 1 * 86400_000) },
        { direction: "outbound", sentAt: new Date(FIXED_NOW.getTime() - 2 * 86400_000) },
        { direction: "outbound", sentAt: new Date(FIXED_NOW.getTime() - 3 * 86400_000) },
      ];
      deps.canSendMessage = vi.fn(() => ({ allowed: false, reason: "Plafond 3/30j" }));

      await preSendCheckWithAudit(args, deps);

      const call = appendSpy.mock.calls[0]?.[0];
      expect(call?.payload).toEqual({
        result: "blocked",
        code: "rate_limit_exceeded",
        rule: "rate_limit",
        context: { count: 3, maxAllowed: 3, windowDays: 30 },
      });
    });

    it("outside_hours → payload context: { hour, minute, weekday } (mardi 22h Paris)", async () => {
      const { args, deps } = buildPassingArgs();
      // 12 mai 2026 = mardi. 20h UTC = 22h Paris (UTC+2 en été).
      args.now = new Date("2026-05-12T20:00:00Z");
      deps.isAllowedSendTime = vi.fn(() => ({
        allowed: false,
        reason: "Hors plage L-V 10-13h / 14-20h",
      }));

      await preSendCheckWithAudit(args, deps);

      const call = appendSpy.mock.calls[0]?.[0];
      const payload = call?.payload as Record<string, unknown>;
      expect(payload.result).toBe("blocked");
      expect(payload.code).toBe("outside_hours");
      expect(payload.rule).toBe("hours");
      const ctx = payload.context as { hour: number; minute: number; weekday: number };
      expect(ctx.hour).toBe(22);
      expect(ctx.minute).toBe(0);
      expect(ctx.weekday).toBe(2); // mardi
    });

    it("bloctel_not_checked → payload context: {} (default branch bloctel)", async () => {
      const { args, deps } = buildPassingArgs();
      deps.canSendB2C = vi.fn(() => ({
        allowed: false,
        reason: "Bloctel non vérifié",
      }));

      await preSendCheckWithAudit(args, deps);

      const call = appendSpy.mock.calls[0]?.[0];
      const payload = call?.payload as Record<string, unknown>;
      expect(payload.result).toBe("blocked");
      expect(payload.rule).toBe("bloctel");
    });

    it("legitimate_interest_undocumented → payload context: { documentedLength, minLength }", async () => {
      const { args, deps } = buildPassingArgs();
      args.contact = buildValidContact({
        consent: {
          legitimateInterest: "trop court", // 10 chars < 20
          optedOut: false,
        },
      });

      await preSendCheckWithAudit(args, deps);

      const call = appendSpy.mock.calls[0]?.[0];
      expect(call?.payload).toEqual({
        result: "blocked",
        code: "legitimate_interest_undocumented",
        rule: "legitimate_interest",
        context: { documentedLength: 10, minLength: 20 },
      });
    });

    it("phone_invalid → payload context: {}", async () => {
      const { args, deps } = buildPassingArgs();
      args.contact = buildValidContact({
        phone: {
          e164: "+33612345678",
          raw: "06 12 34 56 78",
          type: "mobile",
          valid: false, // ← invalide
          lookupAt: Timestamp.fromDate(FIXED_NOW),
        },
      });

      await preSendCheckWithAudit(args, deps);

      const call = appendSpy.mock.calls[0]?.[0];
      expect(call?.payload).toEqual({
        result: "blocked",
        code: "phone_invalid",
        rule: "phone_validity",
        context: {},
      });
    });

    it("phone_voip → payload context: {}", async () => {
      const { args, deps } = buildPassingArgs();
      args.contact = buildValidContact({
        phone: {
          e164: "+33612345678",
          raw: "06 12 34 56 78",
          type: "voip", // ← VoIP refusé
          valid: true,
          lookupAt: Timestamp.fromDate(FIXED_NOW),
        },
      });

      await preSendCheckWithAudit(args, deps);

      const call = appendSpy.mock.calls[0]?.[0];
      expect(call?.payload).toEqual({
        result: "blocked",
        code: "phone_voip",
        rule: "phone_validity",
        context: {},
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Sentinel anti-PII : targetId = hubspotId (PAS phone, PAS email, PAS nom)
  // ───────────────────────────────────────────────────────────────────────

  describe("sentinel anti-PII targetId", () => {
    it("targetId === contact.hubspotId (jamais le téléphone, jamais l'email)", async () => {
      const { args, deps } = buildPassingArgs();
      // Configure un contact dont les PII sont identifiables si elles
      // fuitent.
      args.contact = buildValidContact({
        hubspotId: "hs_unique_internal_id_xyz",
        firstName: "FIRSTNAME_PII",
        lastName: "LASTNAME_PII",
        email: "email-pii@example.com",
        phone: {
          e164: "+33699999999",
          raw: "06 99 99 99 99",
          type: "mobile",
          valid: true,
          lookupAt: Timestamp.fromDate(FIXED_NOW),
        },
      });

      await preSendCheckWithAudit(args, deps);

      const call = appendSpy.mock.calls[0]?.[0];
      expect(call?.targetId).toBe("hs_unique_internal_id_xyz");

      // Sanity : aucun champ du body audit ne contient les PII identifiables.
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain("FIRSTNAME_PII");
      expect(serialized).not.toContain("LASTNAME_PII");
      expect(serialized).not.toContain("email-pii");
      expect(serialized).not.toContain("+33699999999");
      expect(serialized).not.toContain("0699999999");
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Sentinels typage : action/actorId/actorType figés
  // ───────────────────────────────────────────────────────────────────────

  describe("sentinels typage", () => {
    it("action === 'compliance_check', actorId === 'system', actorType === 'system'", async () => {
      const { args, deps } = buildPassingArgs();
      await preSendCheckWithAudit(args, deps);

      const call = appendSpy.mock.calls[0]?.[0];
      expect(call?.action).toBe("compliance_check");
      expect(call?.actorId).toBe("system");
      expect(call?.actorType).toBe("system");
      expect(call?.targetType).toBe("contact");
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // appendAuditLog throw → propagation (compliance > availability)
  // ───────────────────────────────────────────────────────────────────────

  describe("erreur audit propagée (jamais catch silent)", () => {
    it("appendAuditLog throw AuditPiiError → propage (le wrapper NE catch PAS)", async () => {
      const { args, deps } = buildPassingArgs();
      appendSpy.mockRejectedValueOnce(new AuditPiiError({ message: "simulated PII" }));

      await expect(preSendCheckWithAudit(args, deps)).rejects.toBeInstanceOf(AuditPiiError);
    });

    it("appendAuditLog throw erreur quelconque → propage non altérée", async () => {
      const { args, deps } = buildPassingArgs();
      const networkErr = new Error("Firestore I/O timeout");
      appendSpy.mockRejectedValueOnce(networkErr);

      await expect(preSendCheckWithAudit(args, deps)).rejects.toBe(networkErr);
    });

    it("appendAuditLog throw → le caller voit l'erreur AVANT de lire le résultat preSendCheck", async () => {
      // Démonstration : compliance > availability. Si on ne peut PAS
      // logger, on NE PEUT PAS répondre "allowed" au caller — il doit
      // voir l'erreur et fail-stop (Inngest retry selon sa policy).
      const { args, deps } = buildPassingArgs();
      appendSpy.mockRejectedValueOnce(new Error("audit unavailable"));

      let receivedResult = undefined;
      let receivedError: unknown = undefined;
      try {
        receivedResult = await preSendCheckWithAudit(args, deps);
      } catch (e) {
        receivedError = e;
      }

      expect(receivedResult).toBeUndefined(); // jamais retourné
      expect(receivedError).toBeInstanceOf(Error);
      expect((receivedError as Error).message).toBe("audit unavailable");
    });
  });
});
