import { describe, expect, it, vi } from "vitest";

import {
  __FUNCTION_ID_FOR_TESTS,
  __NOT_IMPLEMENTED_REASON_FOR_TESTS,
  processReply,
  processReplyHandler,
  type ProcessReplyHandlerContext,
} from "./process-reply";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeFakeCtx(
  overrides: { phone?: string; body?: string; ovhMessageId?: string } = {},
): ProcessReplyHandlerContext {
  return {
    event: {
      id: "evt-reply-test-1",
      name: "medere/sms.reply.received",
      data: {
        phone: overrides.phone ?? "+33775745453",
        body: overrides.body ?? "Bonjour, oui je suis intéressé.",
        ovhMessageId: overrides.ovhMessageId ?? "ovh-msg-789",
      },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sentinelles structurelles
// ─────────────────────────────────────────────────────────────────────────────

describe("Sentinelles structurelles process-reply (INFRA-SMS-001)", () => {
  it("FUNCTION_ID est figé à 'process-reply'", () => {
    // Modifier cet ID = nouvelle function côté Inngest cloud + perte
    // d'historique d'exécution.
    expect(__FUNCTION_ID_FOR_TESTS).toBe("process-reply");
  });

  it("NOT_IMPLEMENTED_REASON est figé à 'inbound_pending_INFRA_SMS_001'", () => {
    // Sentinelle : ce code de blocage est référencé par les scripts de
    // test et le ticket Notion INFRA-SMS-001. Le modifier silencieusement
    // casserait la traçabilité.
    expect(__NOT_IMPLEMENTED_REASON_FOR_TESTS).toBe("inbound_pending_INFRA_SMS_001");
  });

  it("retries === 0 (stub ne doit JAMAIS retry)", () => {
    // Un retry serait inutile (la cause n'est pas transitoire — feature
    // non livrée). Retirer ce 0 sans implémentation réelle = boucle.
    const opts = (processReply as unknown as { opts: { retries?: number } }).opts;
    expect(opts.retries).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Comportement du handler
// ─────────────────────────────────────────────────────────────────────────────

describe("processReplyHandler — stub contract", () => {
  it("retourne { status: 'not_implemented', reason } sans crash", async () => {
    const ctx = makeFakeCtx();
    const result = await processReplyHandler(ctx);

    expect(result.status).toBe("not_implemented");
    expect(result.reason).toBe("inbound_pending_INFRA_SMS_001");
    expect(typeof result.note).toBe("string");
    expect(result.note.length).toBeGreaterThan(0);
  });

  it("référence Notion INFRA-SMS-001 dans la note (forensic traçable)", () => {
    return processReplyHandler(makeFakeCtx()).then((result) => {
      expect(result.note).toContain("INFRA-SMS-001");
    });
  });

  it("ne throw PAS même avec des inputs vides ou bizarres", async () => {
    const ctx = makeFakeCtx({ phone: "", body: "", ovhMessageId: "" });
    // PAS de validation Zod côté handler — c'est Inngest qui valide via
    // `smsReplyReceived.schema` AVANT d'invoquer le handler. Le stub
    // accepte donc n'importe quoi sans throw.
    await expect(processReplyHandler(ctx)).resolves.toBeDefined();
  });

  it("ne logue NI body, NI phone, NI ovhMessageId (anti-PII inbound)", async () => {
    const ctx = makeFakeCtx({
      phone: "+33775745453",
      body: "Mon numéro perso est 0612345678",
      ovhMessageId: "ovh-secret-123",
    });
    await processReplyHandler(ctx);

    const calls = (ctx.logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain("+33775745453");
    expect(serialized).not.toContain("0612345678");
    expect(serialized).not.toContain("Mon numéro perso");
    expect(serialized).not.toContain("ovh-secret-123");
  });

  it("logue uniquement eventId + name (forensic identifiable sans PII)", async () => {
    const ctx = makeFakeCtx();
    await processReplyHandler(ctx);

    const calls = (ctx.logger.info as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const firstCall = calls[0];
    // [message, structuredContext] - on regarde le 2ème argument
    const structured = firstCall?.[1] as { eventId?: string; name?: string } | undefined;
    expect(structured?.eventId).toBe("evt-reply-test-1");
    expect(structured?.name).toBe("medere/sms.reply.received");
  });
});
