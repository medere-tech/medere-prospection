import { NonRetriableError } from "inngest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ComplianceConcurrencyError,
  ConfigError,
  ExternalServiceError,
  ValidationError,
} from "@/lib/utils/errors";

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
  listRecentOutbound: vi.fn(),
}));
vi.mock("@/lib/firestore/transactions", () => ({
  sendOutboundWithLock: vi.fn(),
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
vi.mock("@/lib/security/env", () => ({ getCoreEnv: vi.fn(), getOvhEnv: vi.fn() }));

// Imports AFTER mocks
import { preSendCheckWithAudit } from "@/lib/compliance/pre-send-check-with-audit";
// Cette import sera utilisée directement pour le sentinelle ACTIONS
import { __ACTIONS_FOR_TESTS as ACTIONS_ACTUAL, appendAuditLog } from "@/lib/firestore/audit-log";
import { getContact } from "@/lib/firestore/contacts";
import { getConversation } from "@/lib/firestore/conversations";
import { listRecentOutbound } from "@/lib/firestore/messages";
import { sendOutboundWithLock } from "@/lib/firestore/transactions";
import { sendSms } from "@/lib/ovh/send-sms";
import { getCoreEnv, getOvhEnv } from "@/lib/security/env";

import {
  __AUDIT_OVH_MESSAGE_ID_DRY_RUN_FOR_TESTS,
  __AUDIT_SENDER_DRY_RUN_FOR_TESTS,
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
  // DEBT-001.5 : sendOutboundWithLock remplace addOutbound + appendAuditLog.
  // Retourne le shape attendu { messageId, auditId } (compose les 2 audits
  // internes — sms_sent + sms_provider_dispatched — atomiquement).
  (sendOutboundWithLock as ReturnType<typeof vi.fn>).mockResolvedValue({
    messageId: "msg-firestore-id-abc123",
    auditId: "audit-id-xyz",
  });
  // appendAuditLog reste utilisé pour l'audit `send_blocked` HORS tx
  // posé après catch ComplianceConcurrencyError.
  (appendAuditLog as ReturnType<typeof vi.fn>).mockResolvedValue("audit-blocked-id");
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

  it("AUDIT_SENDER_DRY_RUN est figé à 'DRY_RUN_SENDER' (littéral neutre, ≠ vrai sender OVH)", () => {
    // Sentinelle INFRA-FIX-AUDIT-SENDER (S8.10) : le littéral utilisé en
    // dry-run NE DOIT PAS ressembler à un sender alphanumérique OVH valide
    // (ex: "MEDERE", "NESF") sous peine d'induire en erreur le forensic
    // Firestore. "DRY_RUN_SENDER" signale explicitement l'absence de
    // dispatch OVH réel.
    expect(__AUDIT_SENDER_DRY_RUN_FOR_TESTS).toBe("DRY_RUN_SENDER");
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
      // Le RETOUR de la function continue d'exposer dry-run-${messageId}
      // pour back-compat S8.4 (PAS le littéral AUDIT_OVH_MESSAGE_ID_DRY_RUN
      // qui va, lui, dans le payload audit).
      expect(result.ovhMessageId).toBe("dry-run-msg-firestore-id-abc123");
      expect(result.auditId).toBe("audit-id-xyz");
    }
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("appelle sendOutboundWithLock avec input shape attendu (channel/generatedBy/externalReceiver)", async () => {
    await sendFirstSmsHandler(makeFakeCtx());
    expect(sendOutboundWithLock).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: "contact-123",
        campaignId: "campaign-xyz",
        conversationId: "contact-123_campaign-xyz",
        input: expect.objectContaining({
          body: expect.any(String),
          channel: "sms",
          generatedBy: "ai",
          externalReceiver: "+33775745453",
        }),
      }),
    );
  });

  it("passe dispatch + expectedRemainingQuota à sendOutboundWithLock (DRY_RUN — sender = DRY_RUN_SENDER, ovhMessageId = DRY_RUN_OVH_MESSAGE_ID)", async () => {
    await sendFirstSmsHandler(makeFakeCtx({ body: "Hello body" }));
    expect(sendOutboundWithLock).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatch: {
          ovhMessageId: __AUDIT_OVH_MESSAGE_ID_DRY_RUN_FOR_TESTS,
          sender: __AUDIT_SENDER_DRY_RUN_FOR_TESTS,
          bodyLength: 10,
          dryRun: true,
          creditsRemoved: 0,
        },
        // recentOutboundMessages mock = [] → expectedRemaining = 3 - 0 = 3.
        expectedRemainingQuota: 3,
      }),
    );
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
    // Mode réel → le step 4 lit getOvhEnv().OVH_SMS_SENDER. Default "MEDERE"
    // ici suffit pour les tests existants ; les sentinelles env-driven
    // ci-dessous overrident avec des valeurs custom.
    (getOvhEnv as ReturnType<typeof vi.fn>).mockReturnValue({
      OVH_SMS_SENDER: "MEDERE",
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

  it("sendOutboundWithLock dispatch contient ovhMessageId réel + dryRun=false + creditsRemoved réel", async () => {
    await sendFirstSmsHandler(makeFakeCtx());
    expect(sendOutboundWithLock).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatch: expect.objectContaining({
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

  it("n'appelle ni sendSms, ni sendOutboundWithLock, ni appendAuditLog (compliance wrapper a déjà loggé)", async () => {
    await sendFirstSmsHandler(makeFakeCtx());
    expect(sendSms).not.toHaveBeenCalled();
    expect(sendOutboundWithLock).not.toHaveBeenCalled();
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

// ─────────────────────────────────────────────────────────────────────────────
// Sentinelles INFRA-FIX-AUDIT-SENDER (S8.10)
//
// Bug initial : `AUDIT_SENDER_NAME = "MEDERE"` hardcoded dans le payload
// audit `sms_provider_dispatched`, alors que la config réelle env peut être
// "NESF" (sender validé MVP) ou autre. Forensic trompeur.
//
// Fix S8.10 (Option A) : env-driven en branche !DRY_RUN, littéral neutre
// "DRY_RUN_SENDER" en dry-run pour ne pas crasher en dev local sans OVH env.
// ─────────────────────────────────────────────────────────────────────────────

describe("Sentinelles INFRA-FIX-AUDIT-SENDER (S8.10, post-DEBT-001.5)", () => {
  it("[S8.10] dispatch.sender reflète env.OVH_SMS_SENDER en mode RÉEL, JAMAIS un littéral hardcoded", async () => {
    // ⚠️ Sentinelle anti-régression : si quelqu'un réintroduit un sender
    // hardcoded au lieu de lire l'env, ce test casse. La valeur "TESTSDR"
    // est choisie volontairement DIFFÉRENTE de "MEDERE" et "NESF" pour
    // détecter un re-hardcoding sur l'une ou l'autre. Post-DEBT-001.5,
    // le sender est passé via `sendOutboundWithLock(args.dispatch.sender)`
    // au lieu de `appendAuditLog(payload.sender)`.
    (getCoreEnv as ReturnType<typeof vi.fn>).mockReturnValue({
      NODE_ENV: "production",
      DRY_RUN_SMS: false,
    });
    (getOvhEnv as ReturnType<typeof vi.fn>).mockReturnValue({
      OVH_SMS_SENDER: "TESTSDR",
    });

    await sendFirstSmsHandler(makeFakeCtx());

    expect(sendOutboundWithLock).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatch: expect.objectContaining({
          sender: "TESTSDR",
        }),
      }),
    );
    // Anti-hardcoding fort : on assert que la valeur env passée triomphe
    // d'éventuelles valeurs littérales que quelqu'un aurait pu réintroduire.
    const dispatchSender = (sendOutboundWithLock as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
      ?.dispatch?.sender;
    expect(dispatchSender).not.toBe("MEDERE");
    expect(dispatchSender).not.toBe("NESF");
  });

  it("[S8.10] N'appelle PAS getOvhEnv() en branche DRY_RUN (garde anti-crash dev local)", async () => {
    // ⚠️ Sentinelle anti-régression : un dev local SANS env OVH set doit
    // pouvoir tourner en dry-run (default DRY_RUN_SMS=true). Si on lit
    // getOvhEnv() en dry-run, ConfigError throw → dev planté inutilement.
    // Le défaut beforeEach() global pose déjà DRY_RUN_SMS=true.
    await sendFirstSmsHandler(makeFakeCtx());
    expect(getOvhEnv).not.toHaveBeenCalled();
  });

  it("[S8.10] En dry-run, le sender forensic est le littéral neutre 'DRY_RUN_SENDER'", async () => {
    // Le littéral DOIT être facilement identifiable côté forensic Firestore
    // pour signaler l'absence de dispatch OVH réel — ≠ d'un vrai sender
    // alphanumérique (max 11 chars OVH).
    await sendFirstSmsHandler(makeFakeCtx());
    expect(sendOutboundWithLock).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatch: expect.objectContaining({
          sender: "DRY_RUN_SENDER",
        }),
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Path race rate-limit (DEBT-001.5) — ComplianceConcurrencyError handling
// ─────────────────────────────────────────────────────────────────────────────

describe("sendFirstSmsHandler — race rate-limit (DEBT-001.5 ComplianceConcurrencyError)", () => {
  // Pré-condition : sendOutboundWithLock throw ComplianceConcurrencyError
  // (la race a été détectée DANS la tx Firestore). Step 4 catch, log audit
  // `send_blocked` HORS tx, puis re-throw pour Inngest retry naturel.
  function setupRaceError() {
    const raceError = new ComplianceConcurrencyError({
      message: "Rate-limit race detected on contact contact-123",
      context: {
        contactId: "contact-123",
        ruleName: "rate_limit_30d",
        attemptedAt: new Date("2026-06-08T10:30:00.000Z"),
        expectedRemainingQuota: 1,
        observedRemainingQuota: 0,
      },
    });
    (sendOutboundWithLock as ReturnType<typeof vi.fn>).mockRejectedValue(raceError);
    return raceError;
  }

  it("re-throw l'erreur (Inngest retry naturel, noRetry=false sur ComplianceConcurrencyError)", async () => {
    setupRaceError();
    await expect(sendFirstSmsHandler(makeFakeCtx())).rejects.toBeInstanceOf(
      ComplianceConcurrencyError,
    );
  });

  it("pose un audit 'send_blocked' AVANT le re-throw (forensic trace de la race)", async () => {
    setupRaceError();
    await expect(sendFirstSmsHandler(makeFakeCtx())).rejects.toThrow();
    // appendAuditLog appelé exactement 1x avec action="send_blocked"
    expect(appendAuditLog).toHaveBeenCalledTimes(1);
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "send_blocked",
        targetType: "contact",
        targetId: "contact-123",
      }),
    );
  });

  it("payload send_blocked contient les 5 champs forensiques (rule, ruleName, quotas, attemptedAt) — anti-PII", async () => {
    setupRaceError();
    await expect(sendFirstSmsHandler(makeFakeCtx())).rejects.toThrow();

    const auditCall = (appendAuditLog as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(auditCall?.payload).toEqual(
      expect.objectContaining({
        rule: "rate_limit_concurrency",
        contactId: "contact-123",
        conversationId: "contact-123_campaign-xyz",
        campaignId: "campaign-xyz",
        ruleName: "rate_limit_30d",
        attemptedAt: "2026-06-08T10:30:00.000Z",
        expectedRemainingQuota: 1,
        observedRemainingQuota: 0,
        dryRun: true, // Default DRY_RUN_SMS=true en beforeEach global.
        ovhMessageIdAttempted: null, // null en dry-run (dispatch.ovhMessageId=null).
      }),
    );

    // Anti-PII : pas de phone (E.164), pas de body content.
    const serialized = JSON.stringify(auditCall);
    expect(serialized).not.toContain("+33775745453");
    expect(serialized).not.toContain("Bonjour, Léa");
  });

  it("ORDRE : audit send_blocked posé AVANT le throw (pas après — sinon retry sans trace)", async () => {
    setupRaceError();
    // On capture l'ordre via timestamps : appendAuditLog mock posé avant
    // que l'erreur ne propage hors du step.run.
    let appendAuditLogResolved = false;
    (appendAuditLog as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      appendAuditLogResolved = true;
      return "audit-blocked-id";
    });

    try {
      await sendFirstSmsHandler(makeFakeCtx());
    } catch {
      // Au moment du catch, l'audit DOIT avoir résolu.
      expect(appendAuditLogResolved).toBe(true);
    }
  });

  it("ne propage PAS l'erreur sous status='sent' ni 'blocked' (le retry Inngest décide)", async () => {
    setupRaceError();
    // L'erreur doit remonter telle quelle pour qu'Inngest retry. PAS de
    // wrap en NonRetriableError (sinon retry désactivé → race perdue à
    // jamais).
    await expect(sendFirstSmsHandler(makeFakeCtx())).rejects.not.toBeInstanceOf(NonRetriableError);
  });

  it("DEBT-001.7 MED-1 : si appendAuditLog(send_blocked) throw, propage la ComplianceConcurrencyError ORIGINALE (pas l'audit fail)", async () => {
    // Sentinelle anti-régression security-reviewer MED-1 : best-effort
    // autour de l'audit `send_blocked`. Si l'audit fail (Firestore I/O
    // transient, AuditPiiError sur payload futur mal posé), la cause
    // racine ComplianceConcurrencyError DOIT remonter à Inngest pour
    // déclencher le retry naturel. Si on remplaçait la pile par l'audit
    // fail, Sentry verrait la mauvaise erreur et le mapping retry-friendly
    // pourrait diverger.
    const raceError = setupRaceError();
    const auditError = new Error("simulated Firestore I/O fail on send_blocked audit");
    (appendAuditLog as ReturnType<typeof vi.fn>).mockRejectedValue(auditError);

    const ctx = makeFakeCtx();
    await expect(sendFirstSmsHandler(ctx)).rejects.toBe(raceError);

    // Le logger.error DOIT avoir tracé l'audit fail pour Sentry (sans PII).
    const errorCalls = (ctx.logger.error as ReturnType<typeof vi.fn>).mock.calls;
    const serialized = JSON.stringify(errorCalls);
    expect(serialized).toContain("failed to write send_blocked audit");
    expect(serialized).toContain("simulated Firestore I/O fail");
    // Anti-PII : pas de phone, pas de body content
    expect(serialized).not.toContain("+33775745453");
    expect(serialized).not.toContain("Bonjour, Léa");
  });
});
