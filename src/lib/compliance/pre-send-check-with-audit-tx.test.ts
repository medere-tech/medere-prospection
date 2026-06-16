/**
 * Tests `pre-send-check-with-audit-tx.ts` (S9.4.1).
 *
 * Pattern miroir `pre-send-check-with-audit.test.ts` (S6.6 GUARD-002) avec
 * adaptations pour la divergence d'API :
 *
 *   - `appendAuditLogTx` mocké (pas `appendAuditLog`) — appel synchrone
 *     avec `tx` en 1er argument.
 *   - Branche allowed : assert mock appelé 1× avec `result: "allowed"`.
 *   - Branche blocked : assert mock 0× appelé (audit posé HORS tx par
 *     caller) + throw `ComplianceFailureError`.
 *   - Sentinelle anti-régression : `ComplianceFailureError.noRetry === true`
 *     (distinct `ComplianceConcurrencyError.noRetry === false`).
 *
 * Coverage : toutes les 9 rules + happy path + sentinel structurel
 * "preSendCheck(args) === preSendCheckWithAuditTx(tx, args)" prouvant que
 * le wrapper n'altère pas la logique S5.
 *
 * Tests unitaires (pas emulator) — `tx` mocké. Tests d'atomicité tx
 * réelle (rollback effectif si throw) vivent dans `send-reply.test.ts`
 * (Firestore emulator S9.4.1 étape 5).
 */
import { type Transaction } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as auditLogModule from "@/lib/firestore/audit-log";
import { ComplianceFailureError } from "@/lib/utils/errors";
import type { Contact } from "@/types/contact";

import { preSendCheck, type PreSendCheckArgs, type PreSendCheckDeps } from "./pre-send-check";
import { preSendCheckWithAuditTx } from "./pre-send-check-with-audit-tx";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de seed (in-memory, pas de Firestore)
// ─────────────────────────────────────────────────────────────────────────────

const FIXED_NOW = new Date("2026-05-12T10:00:00Z"); // mardi, 12h Paris (plein dans plage 10-13h)

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

function buildPassingArgs(): {
  args: PreSendCheckArgs;
  deps: Required<PreSendCheckDeps>;
} {
  const contact = buildValidContact();
  return {
    args: {
      contact,
      // Body qui passe les 3 rules content avec les VRAIES impls S4 :
      //   - hasAIDisclosure : matche /(je suis|c'est)\s+Léa/i ✅
      //   - hasOptOut       : "STOP" ✅
      //   - hasAdvertiserIdentification : "Médéré" ✅
      // Important pour le smoke test "wrapper sans deps" qui utilise les
      // vraies impls et exige `result === { ok: true }`.
      message:
        "Bonjour, c'est Léa de Médéré. Une question rapide à vous poser. Répondez STOP pour ne plus recevoir.",
      conversation: { messageCount: 0 },
      recentOutboundMessages: [],
      now: FIXED_NOW,
    },
    deps: {
      hasAIDisclosure: vi.fn(() => true),
      hasOptOut: vi.fn(() => true),
      hasAdvertiserIdentification: vi.fn(() => true),
      canSendMessage: vi.fn(() => ({ allowed: true })),
      isAllowedSendTime: vi.fn(() => ({ allowed: true })),
      canSendB2C: vi.fn(() => ({ allowed: true })),
    },
  };
}

/**
 * Mock `Transaction` minimal — `appendAuditLogTx` n'utilise que `tx.create`
 * en interne (cf. audit-log.ts:227). On le mock vide ; le spy sur
 * `appendAuditLogTx` lui-même capture les appels.
 */
function fakeTx(): Transaction {
  return {
    create: vi.fn(),
  } as unknown as Transaction;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe("preSendCheckWithAuditTx", () => {
  let appendTxSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // appendAuditLogTx est synchrone (string return) → mockReturnValue
    appendTxSpy = vi.spyOn(auditLogModule, "appendAuditLogTx").mockReturnValue("audit-id-stub");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Sentinel structurel — wrapper N'ALTÈRE JAMAIS la logique S5
  // ───────────────────────────────────────────────────────────────────────

  describe("sentinel structurel — pas d'altération logique S5", () => {
    it("ok=true : preSendCheck retourne ok → wrapper retourne {ok: true}", () => {
      const { args, deps } = buildPassingArgs();
      const tx = fakeTx();

      const pureResult = preSendCheck(args, deps);
      const txResult = preSendCheckWithAuditTx(tx, args, deps);

      expect(pureResult.ok).toBe(true);
      expect(txResult).toEqual({ ok: true });
    });

    it("ok=false : preSendCheck retourne blocked → wrapper throw ComplianceFailureError", () => {
      const { args, deps } = buildPassingArgs();
      const tx = fakeTx();
      args.recentOutboundMessages = [
        { direction: "outbound", sentAt: new Date(FIXED_NOW.getTime() - 1 * 86400_000) },
        { direction: "outbound", sentAt: new Date(FIXED_NOW.getTime() - 2 * 86400_000) },
        { direction: "outbound", sentAt: new Date(FIXED_NOW.getTime() - 3 * 86400_000) },
      ];
      deps.canSendMessage = vi.fn(() => ({
        allowed: false,
        reason: "Plafond 3/30j",
      }));

      const pureResult = preSendCheck(args, deps);
      expect(pureResult.ok).toBe(false);

      expect(() => preSendCheckWithAuditTx(tx, args, deps)).toThrow(ComplianceFailureError);
    });

    it("le wrapper PASSE deps tel quel à preSendCheck (injection préservée)", () => {
      const { args, deps } = buildPassingArgs();
      const tx = fakeTx();

      preSendCheckWithAuditTx(tx, args, deps);

      expect(deps.hasAIDisclosure).toHaveBeenCalled();
      expect(deps.hasOptOut).toHaveBeenCalled();
      expect(deps.hasAdvertiserIdentification).toHaveBeenCalled();
      expect(deps.canSendMessage).toHaveBeenCalled();
      expect(deps.isAllowedSendTime).toHaveBeenCalled();
      expect(deps.canSendB2C).toHaveBeenCalled();
    });

    it("wrapper sans deps → preSendCheck utilise les vraies impls S4 (smoke test)", () => {
      const { args } = buildPassingArgs();
      const tx = fakeTx();

      const result = preSendCheckWithAuditTx(tx, args);
      expect(result).toEqual({ ok: true });
      expect(appendTxSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Branche allowed — audit DANS tx
  // ───────────────────────────────────────────────────────────────────────

  describe("branche allowed", () => {
    it("audit avec payload { result: 'allowed' } UNIQUEMENT, posé DANS tx", () => {
      const { args, deps } = buildPassingArgs();
      const tx = fakeTx();

      const result = preSendCheckWithAuditTx(tx, args, deps);

      expect(result).toEqual({ ok: true });
      expect(appendTxSpy).toHaveBeenCalledTimes(1);

      // 1er arg = la tx fournie (preuve : audit DANS la tx parente)
      expect(appendTxSpy.mock.calls[0]?.[0]).toBe(tx);

      // 2ème arg = le payload audit
      const entry = appendTxSpy.mock.calls[0]?.[1];
      expect(entry?.action).toBe("compliance_check");
      expect(entry?.actorId).toBe("system");
      expect(entry?.actorType).toBe("system");
      expect(entry?.targetType).toBe("contact");
      expect(entry?.targetId).toBe("hs_abc123");
      expect(entry?.payload).toEqual({ result: "allowed" });
    });

    it("PAS de code/rule/context dans payload allowed (objet minimal)", () => {
      const { args, deps } = buildPassingArgs();
      const tx = fakeTx();
      preSendCheckWithAuditTx(tx, args, deps);

      const entry = appendTxSpy.mock.calls[0]?.[1];
      expect(entry?.payload).not.toHaveProperty("code");
      expect(entry?.payload).not.toHaveProperty("rule");
      expect(entry?.payload).not.toHaveProperty("context");
    });

    it("targetId === contact.hubspotId (sentinel anti-PII)", () => {
      const { args, deps } = buildPassingArgs();
      const tx = fakeTx();
      // Contact avec PII identifiables
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

      preSendCheckWithAuditTx(tx, args, deps);

      const entry = appendTxSpy.mock.calls[0]?.[1];
      expect(entry?.targetId).toBe("hs_unique_internal_id_xyz");

      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain("FIRSTNAME_PII");
      expect(serialized).not.toContain("LASTNAME_PII");
      expect(serialized).not.toContain("email-pii");
      expect(serialized).not.toContain("+33699999999");
      expect(serialized).not.toContain("0699999999");
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Branche blocked × chaque rule — throw + 0 audit
  // ───────────────────────────────────────────────────────────────────────

  describe("branche blocked — throw ComplianceFailureError + 0 audit DANS tx", () => {
    it("opted_out → throw + context.rule='opt_out' + context.code='opted_out'", () => {
      const { args, deps } = buildPassingArgs();
      const tx = fakeTx();
      args.contact = buildValidContact({
        consent: {
          legitimateInterest: args.contact.consent.legitimateInterest,
          optedOut: true,
          optedOutAt: Timestamp.fromDate(FIXED_NOW),
          optedOutChannel: "sms",
        },
      });

      try {
        preSendCheckWithAuditTx(tx, args, deps);
        expect.fail("should have thrown ComplianceFailureError");
      } catch (e) {
        expect(e).toBeInstanceOf(ComplianceFailureError);
        const err = e as ComplianceFailureError;
        expect(err.context.rule).toBe("opt_out");
        expect(err.context.code).toBe("opted_out");
        expect(err.context.failureContext).toEqual({});
      }
      expect(appendTxSpy).not.toHaveBeenCalled();
    });

    it("ai_disclosure_missing → throw + context.rule='ai_disclosure'", () => {
      const { args, deps } = buildPassingArgs();
      const tx = fakeTx();
      deps.hasAIDisclosure = vi.fn(() => false);
      args.conversation = { messageCount: 0 };

      try {
        preSendCheckWithAuditTx(tx, args, deps);
        expect.fail("should have thrown");
      } catch (e) {
        const err = e as ComplianceFailureError;
        expect(err.context.rule).toBe("ai_disclosure");
        expect(err.context.code).toBe("ai_disclosure_missing");
      }
      expect(appendTxSpy).not.toHaveBeenCalled();
    });

    it("stop_optout_missing → throw + context.rule='stop_present'", () => {
      const { args, deps } = buildPassingArgs();
      const tx = fakeTx();
      deps.hasOptOut = vi.fn(() => false);

      try {
        preSendCheckWithAuditTx(tx, args, deps);
        expect.fail("should have thrown");
      } catch (e) {
        const err = e as ComplianceFailureError;
        expect(err.context.rule).toBe("stop_present");
        expect(err.context.code).toBe("stop_optout_missing");
      }
      expect(appendTxSpy).not.toHaveBeenCalled();
    });

    it("advertiser_identification_missing → throw + rule='advertiser_identification'", () => {
      const { args, deps } = buildPassingArgs();
      const tx = fakeTx();
      deps.hasAdvertiserIdentification = vi.fn(() => false);

      try {
        preSendCheckWithAuditTx(tx, args, deps);
        expect.fail("should have thrown");
      } catch (e) {
        const err = e as ComplianceFailureError;
        expect(err.context.rule).toBe("advertiser_identification");
      }
      expect(appendTxSpy).not.toHaveBeenCalled();
    });

    it("rate_limit_exceeded → throw + failureContext { count, maxAllowed, windowDays }", () => {
      const { args, deps } = buildPassingArgs();
      const tx = fakeTx();
      args.recentOutboundMessages = [
        { direction: "outbound", sentAt: new Date(FIXED_NOW.getTime() - 1 * 86400_000) },
        { direction: "outbound", sentAt: new Date(FIXED_NOW.getTime() - 2 * 86400_000) },
        { direction: "outbound", sentAt: new Date(FIXED_NOW.getTime() - 3 * 86400_000) },
      ];
      deps.canSendMessage = vi.fn(() => ({ allowed: false, reason: "Plafond 3/30j" }));

      try {
        preSendCheckWithAuditTx(tx, args, deps);
        expect.fail("should have thrown");
      } catch (e) {
        const err = e as ComplianceFailureError;
        expect(err.context.rule).toBe("rate_limit");
        expect(err.context.code).toBe("rate_limit_exceeded");
        expect(err.context.failureContext).toEqual({
          count: 3,
          maxAllowed: 3,
          windowDays: 30,
        });
      }
      expect(appendTxSpy).not.toHaveBeenCalled();
    });

    it("outside_hours → throw + failureContext { hour, minute, weekday }", () => {
      const { args, deps } = buildPassingArgs();
      const tx = fakeTx();
      args.now = new Date("2026-05-12T20:00:00Z"); // mardi 22h Paris
      deps.isAllowedSendTime = vi.fn(() => ({
        allowed: false,
        reason: "Hors plage L-V 10-13h / 14-20h",
      }));

      try {
        preSendCheckWithAuditTx(tx, args, deps);
        expect.fail("should have thrown");
      } catch (e) {
        const err = e as ComplianceFailureError;
        expect(err.context.rule).toBe("hours");
        expect(err.context.code).toBe("outside_hours");
        const fc = err.context.failureContext as { hour: number; minute: number; weekday: number };
        expect(fc.hour).toBe(22);
        expect(fc.weekday).toBe(2);
      }
      expect(appendTxSpy).not.toHaveBeenCalled();
    });

    it("bloctel_not_checked → throw + context.rule='bloctel'", () => {
      const { args, deps } = buildPassingArgs();
      const tx = fakeTx();
      deps.canSendB2C = vi.fn(() => ({
        allowed: false,
        reason: "Bloctel non vérifié",
      }));

      try {
        preSendCheckWithAuditTx(tx, args, deps);
        expect.fail("should have thrown");
      } catch (e) {
        const err = e as ComplianceFailureError;
        expect(err.context.rule).toBe("bloctel");
      }
      expect(appendTxSpy).not.toHaveBeenCalled();
    });

    it("legitimate_interest_undocumented → throw + failureContext { documentedLength, minLength }", () => {
      const { args, deps } = buildPassingArgs();
      const tx = fakeTx();
      args.contact = buildValidContact({
        consent: {
          legitimateInterest: "trop court", // 10 chars < 20
          optedOut: false,
        },
      });

      try {
        preSendCheckWithAuditTx(tx, args, deps);
        expect.fail("should have thrown");
      } catch (e) {
        const err = e as ComplianceFailureError;
        expect(err.context.rule).toBe("legitimate_interest");
        expect(err.context.code).toBe("legitimate_interest_undocumented");
        expect(err.context.failureContext).toEqual({
          documentedLength: 10,
          minLength: 20,
        });
      }
      expect(appendTxSpy).not.toHaveBeenCalled();
    });

    it("phone_invalid → throw + context.rule='phone_validity'", () => {
      const { args, deps } = buildPassingArgs();
      const tx = fakeTx();
      args.contact = buildValidContact({
        phone: {
          e164: "+33612345678",
          raw: "06 12 34 56 78",
          type: "mobile",
          valid: false,
          lookupAt: Timestamp.fromDate(FIXED_NOW),
        },
      });

      try {
        preSendCheckWithAuditTx(tx, args, deps);
        expect.fail("should have thrown");
      } catch (e) {
        const err = e as ComplianceFailureError;
        expect(err.context.rule).toBe("phone_validity");
        expect(err.context.code).toBe("phone_invalid");
      }
      expect(appendTxSpy).not.toHaveBeenCalled();
    });

    it("phone_voip → throw + context.rule='phone_validity' code='phone_voip'", () => {
      const { args, deps } = buildPassingArgs();
      const tx = fakeTx();
      args.contact = buildValidContact({
        phone: {
          e164: "+33612345678",
          raw: "06 12 34 56 78",
          type: "voip",
          valid: true,
          lookupAt: Timestamp.fromDate(FIXED_NOW),
        },
      });

      try {
        preSendCheckWithAuditTx(tx, args, deps);
        expect.fail("should have thrown");
      } catch (e) {
        const err = e as ComplianceFailureError;
        expect(err.context.rule).toBe("phone_validity");
        expect(err.context.code).toBe("phone_voip");
      }
      expect(appendTxSpy).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Sentinels classe d'erreur — ComplianceFailureError noRetry=true
  // ───────────────────────────────────────────────────────────────────────

  describe("ComplianceFailureError — sentinels classe", () => {
    it("ComplianceFailureError.noRetry === true (distinct ComplianceConcurrencyError noRetry=false)", () => {
      const { args, deps } = buildPassingArgs();
      const tx = fakeTx();
      args.contact = buildValidContact({
        consent: {
          legitimateInterest: args.contact.consent.legitimateInterest,
          optedOut: true,
          optedOutAt: Timestamp.fromDate(FIXED_NOW),
          optedOutChannel: "sms",
        },
      });

      try {
        preSendCheckWithAuditTx(tx, args, deps);
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ComplianceFailureError);
        const err = e as ComplianceFailureError;
        // Sentinel forensique : un refus compliance stable NE DOIT PAS
        // retry (distinct ComplianceConcurrencyError race-friendly).
        expect(err.noRetry).toBe(true);
      }
    });

    it("ComplianceFailureError.code === 'COMPLIANCE_BLOCKED' (hérité ComplianceError)", () => {
      const { args, deps } = buildPassingArgs();
      const tx = fakeTx();
      deps.hasOptOut = vi.fn(() => false);

      try {
        preSendCheckWithAuditTx(tx, args, deps);
        expect.fail("should have thrown");
      } catch (e) {
        const err = e as ComplianceFailureError;
        expect(err.code).toBe("COMPLIANCE_BLOCKED");
        expect(err.statusCode).toBe(422);
      }
    });

    it("ComplianceFailureError clientMessage === 'Envoi non autorisé.' (hérité)", () => {
      const { args, deps } = buildPassingArgs();
      const tx = fakeTx();
      deps.hasOptOut = vi.fn(() => false);

      try {
        preSendCheckWithAuditTx(tx, args, deps);
        expect.fail("should have thrown");
      } catch (e) {
        const err = e as ComplianceFailureError;
        expect(err.clientMessage).toBe("Envoi non autorisé.");
      }
    });

    it("err.context contient { rule, code, failureContext } — payload complet pour caller", () => {
      const { args, deps } = buildPassingArgs();
      const tx = fakeTx();
      args.recentOutboundMessages = [
        { direction: "outbound", sentAt: new Date(FIXED_NOW.getTime() - 1 * 86400_000) },
        { direction: "outbound", sentAt: new Date(FIXED_NOW.getTime() - 2 * 86400_000) },
        { direction: "outbound", sentAt: new Date(FIXED_NOW.getTime() - 3 * 86400_000) },
      ];
      deps.canSendMessage = vi.fn(() => ({ allowed: false, reason: "Plafond" }));

      try {
        preSendCheckWithAuditTx(tx, args, deps);
        expect.fail("should have thrown");
      } catch (e) {
        const err = e as ComplianceFailureError;
        // Le caller commitDraftToQueued utilise ces 3 champs pour
        // construire le payload `reply_draft_dropped` HORS tx.
        expect(err.context).toHaveProperty("rule");
        expect(err.context).toHaveProperty("code");
        expect(err.context).toHaveProperty("failureContext");
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // appendAuditLogTx throw → propagation (compliance > availability)
  // ───────────────────────────────────────────────────────────────────────

  describe("erreur appendAuditLogTx propagée (jamais catch silent)", () => {
    it("appendAuditLogTx throw → propage (le wrapper NE catch PAS en allowed)", () => {
      const { args, deps } = buildPassingArgs();
      const tx = fakeTx();
      const ioErr = new Error("Firestore I/O timeout in tx");
      appendTxSpy.mockImplementationOnce(() => {
        throw ioErr;
      });

      expect(() => preSendCheckWithAuditTx(tx, args, deps)).toThrow(ioErr);
    });
  });
});
