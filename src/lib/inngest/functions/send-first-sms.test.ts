import { NonRetriableError } from "inngest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigError, ExternalServiceError, ValidationError } from "@/lib/utils/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks (DOIVENT être déclarés AVANT l'import de send-first-sms).
// vi.mock est hoisted, on peut référencer les imports ci-dessus librement.
// ─────────────────────────────────────────────────────────────────────────────
vi.mock("@/lib/firestore/contacts", () => ({ getContact: vi.fn() }));
vi.mock("@/lib/firestore/conversations", () => ({
  getConversation: vi.fn(),
  conversationDocId: vi.fn((contactId: string, campaignId: string) => `${contactId}_${campaignId}`),
}));
vi.mock("@/lib/firestore/messages", () => ({
  addOutbound: vi.fn(),
  listRecentOutbound: vi.fn(),
}));
// `__ACTIONS_FOR_TESTS` doit garder sa vraie valeur pour la sentinelle.
// On preserve les vrais exports via importActual, on ne mock que `appendAuditLog`.
vi.mock("@/lib/firestore/audit-log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/firestore/audit-log")>();
  return {
    ...actual,
    appendAuditLog: vi.fn(),
  };
});
vi.mock("@/lib/compliance/pre-send-check-with-audit", () => ({
  preSendCheckWithAudit: vi.fn(),
}));
vi.mock("@/lib/ovh/send-sms", () => ({ sendSms: vi.fn() }));
vi.mock("@/lib/security/env", () => ({ getCoreEnv: vi.fn() }));

// Imports AFTER mocks
import { preSendCheckWithAudit } from "@/lib/compliance/pre-send-check-with-audit";
// Cette import sera utilisée directement pour le sentinelle ACTIONS
import { __ACTIONS_FOR_TESTS as ACTIONS_ACTUAL, appendAuditLog } from "@/lib/firestore/audit-log";
import { getContact } from "@/lib/firestore/contacts";
import { getConversation } from "@/lib/firestore/conversations";
import { addOutbound, listRecentOutbound } from "@/lib/firestore/messages";
import { sendSms } from "@/lib/ovh/send-sms";
import { getCoreEnv } from "@/lib/security/env";

import {
  __AUDIT_SENDER_NAME_FOR_TESTS,
  __FUNCTION_ID_FOR_TESTS,
  type InngestHandlerContext,
  sendFirstSms,
  sendFirstSmsHandler,
} from "./send-first-sms";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeFakeContact(overrides: Record<string, unknown> = {}) {
  return {
    hubspotId: "contact-123",
    firstName: "Léa",
    lastName: "Dupont",
    speciality: "dentiste",
    city: "Paris",
    postalCode: "75001",
    phone: {
      e164: "+33775745453",
      raw: "0775745453",
      type: "mobile",
      valid: true,
      lookupAt: { toMillis: () => Date.now() },
    },
    segment: "b2b_cabinet",
    bloctelChecked: false,
    bloctelOptOut: false,
    consent: {
      legitimateInterest: "Prospection commerciale dentaire conforme RGPD article 6.1.f",
      optedOut: false,
    },
    enrichment: { source: "hubspot", enrichedAt: { toMillis: () => Date.now() } },
    status: "ready",
    campaignId: "campaign-xyz",
    createdAt: { toMillis: () => Date.now() },
    updatedAt: { toMillis: () => Date.now() },
    ...overrides,
  };
}

function makeFakeConversation(overrides: Record<string, unknown> = {}) {
  return {
    contactId: "contact-123",
    campaignId: "campaign-xyz",
    messageCount: 0,
    outboundCount: 0,
    inboundCount: 0,
    createdAt: { toMillis: () => Date.now() },
    updatedAt: { toMillis: () => Date.now() },
    ...overrides,
  };
}

function makeFakeCtx(
  overrides: {
    contactId?: string;
    campaignId?: string;
    body?: string;
  } = {},
): InngestHandlerContext {
  const stepRun = vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn());
  return {
    event: {
      id: "evt-test-1",
      name: "medere/sms.send-first.requested",
      data: {
        contactId: overrides.contactId ?? "contact-123",
        campaignId: overrides.campaignId ?? "campaign-xyz",
        body:
          overrides.body ?? "Bonjour, Léa, assistante IA de Médéré. Pour vous désinscrire : STOP.",
      },
    },
    step: { run: stepRun as never },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults : env dry-run, contact/conv présents, recent vide, check ok
  (getCoreEnv as ReturnType<typeof vi.fn>).mockReturnValue({
    NODE_ENV: "test",
    DRY_RUN_SMS: true,
  });
  (getContact as ReturnType<typeof vi.fn>).mockResolvedValue(makeFakeContact());
  (getConversation as ReturnType<typeof vi.fn>).mockResolvedValue(makeFakeConversation());
  (listRecentOutbound as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (preSendCheckWithAudit as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
  (addOutbound as ReturnType<typeof vi.fn>).mockResolvedValue("msg-firestore-id-abc123");
  (appendAuditLog as ReturnType<typeof vi.fn>).mockResolvedValue("audit-id-xyz");
  (sendSms as ReturnType<typeof vi.fn>).mockResolvedValue({
    messageIds: ["111222333444"],
    creditsRemoved: 1,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Sentinelles structurelles — GF3 + ACTIONS + constantes
// ─────────────────────────────────────────────────────────────────────────────

describe("Sentinelles structurelles (GF3 + INFRA-DETTE-001)", () => {
  it("[GF3] concurrency.key === 'event.data.contactId'", () => {
    // ⚠️ Sentinelle anti-régression : INFRA-DETTE-001. Cette config est CE
    // qui sérialise les jobs concurrents sur le même contactId et ferme la
    // race rate-limit (3 SMS / 30j) en l'absence de withContactLock S6.6.
    // Retirer cette ligne sans payer la dette = race ouverte.
    const opts = (sendFirstSms as unknown as { opts: { concurrency?: { key?: string } } }).opts;
    expect(opts.concurrency).toBeDefined();
    expect(opts.concurrency?.key).toBe("event.data.contactId");
  });

  it("[GF3] concurrency.limit === 1", () => {
    const opts = (sendFirstSms as unknown as { opts: { concurrency?: { limit?: number } } }).opts;
    expect(opts.concurrency?.limit).toBe(1);
  });

  it("FUNCTION_ID est figé à 'send-first-sms'", () => {
    // Modifier cet ID = nouvelle function côté Inngest cloud + perte
    // d'historique d'exécution.
    expect(__FUNCTION_ID_FOR_TESTS).toBe("send-first-sms");
  });

  it("AUDIT_SENDER_NAME est figé à 'MEDERE'", () => {
    // Aligné CLAUDE.md > Sender alphanumérique cible : MEDERE.
    expect(__AUDIT_SENDER_NAME_FOR_TESTS).toBe("MEDERE");
  });

  it("ACTIONS contient 'sms_provider_dispatched' (audit-log whitelist)", () => {
    // Sentinelle : si quelqu'un retire cette action de la whitelist,
    // Zod refuserait l'écriture du step 4 → loop d'erreurs.
    expect(ACTIONS_ACTUAL).toBeDefined();
    expect(ACTIONS_ACTUAL).toContain("sms_provider_dispatched");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline 4 steps — happy paths
// ─────────────────────────────────────────────────────────────────────────────

describe("sendFirstSmsHandler — happy path DRY_RUN", () => {
  it("retourne status='sent' + dryRun=true sans appeler OVH", async () => {
    const ctx = makeFakeCtx();
    const result = await sendFirstSmsHandler(ctx);

    expect(result.status).toBe("sent");
    if (result.status === "sent") {
      expect(result.dryRun).toBe(true);
      expect(result.messageId).toBe("msg-firestore-id-abc123");
      expect(result.ovhMessageId).toBe("dry-run-msg-firestore-id-abc123");
      expect(result.auditId).toBe("audit-id-xyz");
    }
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("appelle addOutbound avec channel='sms', generatedBy='ai', externalReceiver=phone.e164", async () => {
    await sendFirstSmsHandler(makeFakeCtx());
    expect(addOutbound).toHaveBeenCalledWith(
      "contact-123_campaign-xyz",
      expect.objectContaining({
        body: expect.any(String),
        channel: "sms",
        generatedBy: "ai",
        externalReceiver: "+33775745453",
      }),
    );
  });

  it("pose un audit 'sms_provider_dispatched' avec payload zéro-PII et dryRun=true", async () => {
    await sendFirstSmsHandler(makeFakeCtx({ body: "Hello body" }));
    expect(appendAuditLog).toHaveBeenCalledWith({
      actorId: "system",
      actorType: "system",
      action: "sms_provider_dispatched",
      targetType: "message",
      targetId: "msg-firestore-id-abc123",
      payload: {
        ovhMessageId: "dry-run-msg-firestore-id-abc123",
        conversationId: "contact-123_campaign-xyz",
        contactId: "contact-123",
        campaignId: "campaign-xyz",
        sender: "MEDERE",
        bodyLength: 10,
        dryRun: true,
        creditsRemoved: 0,
      },
    });
  });

  it("ne logue ni phone, ni body content dans le log info DRY_RUN", async () => {
    const ctx = makeFakeCtx({ body: "secret-body-content-123" });
    await sendFirstSmsHandler(ctx);
    const calls = (ctx.logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain("+33775745453");
    expect(serialized).not.toContain("secret-body-content-123");
  });
});

describe("sendFirstSmsHandler — happy path RÉEL (DRY_RUN=false)", () => {
  beforeEach(() => {
    (getCoreEnv as ReturnType<typeof vi.fn>).mockReturnValue({
      NODE_ENV: "production",
      DRY_RUN_SMS: false,
    });
  });

  it("appelle sendSms avec phone.e164 et message=body", async () => {
    await sendFirstSmsHandler(makeFakeCtx({ body: "Bonjour Léa" }));
    expect(sendSms).toHaveBeenCalledWith({
      receivers: ["+33775745453"],
      message: "Bonjour Léa",
    });
  });

  it("retourne ovhMessageId réel + dryRun=false", async () => {
    const result = await sendFirstSmsHandler(makeFakeCtx());
    expect(result.status).toBe("sent");
    if (result.status === "sent") {
      expect(result.dryRun).toBe(false);
      expect(result.ovhMessageId).toBe("111222333444");
    }
  });

  it("audit payload contient dryRun=false + creditsRemoved réel", async () => {
    await sendFirstSmsHandler(makeFakeCtx());
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sms_provider_dispatched",
        payload: expect.objectContaining({
          ovhMessageId: "111222333444",
          dryRun: false,
          creditsRemoved: 1,
        }),
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Compliance blocked
// ─────────────────────────────────────────────────────────────────────────────

describe("sendFirstSmsHandler — compliance blocked", () => {
  beforeEach(() => {
    (preSendCheckWithAudit as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      failure: {
        code: "opted_out",
        rule: "opt_out",
        humanReason: "Contact a opt-out",
        context: {},
      },
    });
  });

  it("retourne status='blocked' avec code + rule", async () => {
    const result = await sendFirstSmsHandler(makeFakeCtx());
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.code).toBe("opted_out");
      expect(result.rule).toBe("opt_out");
    }
  });

  it("n'appelle ni sendSms, ni addOutbound, ni appendAuditLog (compliance wrapper a déjà loggé)", async () => {
    await sendFirstSmsHandler(makeFakeCtx());
    expect(sendSms).not.toHaveBeenCalled();
    expect(addOutbound).not.toHaveBeenCalled();
    expect(appendAuditLog).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Erreurs amont : contact / conversation absents
// ─────────────────────────────────────────────────────────────────────────────

describe("sendFirstSmsHandler — erreurs config (NonRetriable)", () => {
  it("throw NonRetriableError si contact absent", async () => {
    (getContact as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(sendFirstSmsHandler(makeFakeCtx())).rejects.toBeInstanceOf(NonRetriableError);
  });

  it("throw NonRetriableError si conversation absente", async () => {
    (getConversation as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(sendFirstSmsHandler(makeFakeCtx())).rejects.toBeInstanceOf(NonRetriableError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Erreurs OVH : retry policy
// ─────────────────────────────────────────────────────────────────────────────

describe("sendFirstSmsHandler — erreurs OVH (mode RÉEL)", () => {
  beforeEach(() => {
    (getCoreEnv as ReturnType<typeof vi.fn>).mockReturnValue({
      NODE_ENV: "production",
      DRY_RUN_SMS: false,
    });
  });

  it("ConfigError OVH (4xx auth) → wrap NonRetriableError", async () => {
    (sendSms as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ConfigError({ message: "OVH 401", context: { status: 401 } }),
    );
    await expect(sendFirstSmsHandler(makeFakeCtx())).rejects.toBeInstanceOf(NonRetriableError);
  });

  it("ValidationError OVH (invalid receiver) → wrap NonRetriableError", async () => {
    (sendSms as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ValidationError({ message: "invalid phone", context: {} }),
    );
    await expect(sendFirstSmsHandler(makeFakeCtx())).rejects.toBeInstanceOf(NonRetriableError);
  });

  it("ExternalServiceError OVH (5xx) → propage native (retryable)", async () => {
    const original = new ExternalServiceError({
      message: "OVH 503",
      context: { status: 503 },
    });
    (sendSms as ReturnType<typeof vi.fn>).mockRejectedValue(original);
    await expect(sendFirstSmsHandler(makeFakeCtx())).rejects.toBe(original);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Order of execution — pipeline strict
// ─────────────────────────────────────────────────────────────────────────────

describe("sendFirstSmsHandler — ordre du pipeline 4 steps", () => {
  it("ouvre exactement 4 step.run() avec les noms attendus en happy path", async () => {
    const ctx = makeFakeCtx();
    await sendFirstSmsHandler(ctx);

    const stepRun = ctx.step.run as ReturnType<typeof vi.fn>;
    const names = stepRun.mock.calls.map((c) => c[0]);
    expect(names).toEqual([
      "get-contact-and-history",
      "compliance-pre-send-check",
      "ovh-send",
      "record-outbound-message",
    ]);
  });

  it("s'arrête après step 2 en cas de compliance blocked (pas de step 3/4)", async () => {
    (preSendCheckWithAudit as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      failure: { code: "rate_limit_exceeded", rule: "rate_limit", humanReason: "...", context: {} },
    });
    const ctx = makeFakeCtx();
    await sendFirstSmsHandler(ctx);

    const stepRun = ctx.step.run as ReturnType<typeof vi.fn>;
    const names = stepRun.mock.calls.map((c) => c[0]);
    expect(names).toEqual(["get-contact-and-history", "compliance-pre-send-check"]);
  });
});
