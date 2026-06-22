/**
 * Tests POST /api/admin/preview-first-sms (S10.1.4.b).
 *
 * Scope : route handler unit (mocks Clerk + Firestore + Claude + preSendCheck).
 * Vérifie auth/authz, validation Zod, status guards (D-b1), exclusion
 * `humanReason` de la response (D-b3), anti-leak phone dans le reasoning.
 */
import { Timestamp } from "firebase-admin/firestore";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ForbiddenError, UnauthorizedError } from "@/lib/utils/errors";
import type { Contact } from "@/types/contact";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(),
}));

vi.mock("@/lib/claude/first-sms-generator", () => ({
  generateFirstSms: vi.fn(),
}));

vi.mock("@/lib/firestore/contacts", async () => {
  const actual = await vi.importActual<typeof import("@/lib/firestore/contacts")>(
    "@/lib/firestore/contacts",
  );
  return {
    ...actual,
    getContact: vi.fn(),
  };
});

vi.mock("@/lib/compliance/pre-send-check", async () => {
  const actual = await vi.importActual<typeof import("@/lib/compliance/pre-send-check")>(
    "@/lib/compliance/pre-send-check",
  );
  return {
    ...actual,
    preSendCheck: vi.fn(),
  };
});

vi.mock("@/lib/utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Imports APRÈS les `vi.mock` (hoist Vitest).
import { requireRole } from "@/lib/auth/require-role";
import { generateFirstSms } from "@/lib/claude/first-sms-generator";
import { preSendCheck } from "@/lib/compliance/pre-send-check";
import { getContact } from "@/lib/firestore/contacts";

import { POST } from "./route";

const mockRequireRole = vi.mocked(requireRole);
const mockGenerateFirstSms = vi.mocked(generateFirstSms);
const mockGetContact = vi.mocked(getContact);
const mockPreSendCheck = vi.mocked(preSendCheck);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function mockPost(body: unknown): NextRequest {
  return new NextRequest("https://medere.example/api/admin/preview-first-sms", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function buildFakeContact(overrides: Partial<Contact> = {}): Contact {
  const now = Timestamp.now();
  return {
    hubspotId: "hs_test_1",
    firstName: "Jean",
    lastName: "Dupont",
    civilite: "Dr",
    speciality: "Chirurgien-dentiste",
    city: "Paris",
    postalCode: "75001",
    email: "jean.dupont@cabinet-test.fr",
    phone: {
      e164: "+33612345678",
      raw: "06 12 34 56 78",
      type: "mobile",
      valid: true,
      lookupAt: now,
    },
    segment: "b2c_mobile_perso",
    bloctelChecked: true,
    bloctelOptOut: false,
    consent: {
      legitimateInterest: "Prospection B2B intérêt légitime documenté",
      optedOut: false,
    },
    enrichment: { source: "hubspot", enrichedAt: now },
    status: "ready",
    campaignId: "hubspot-list-200",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const FAKE_GENERATION_OK = {
  body: "Bonjour Dr Dupont, Léa de Médéré. Court SMS de test. STOP pour ne plus recevoir.",
  reasoning: "Court, vouvoiement, mention IA, mention Médéré, STOP présent.",
  promptVersion: "1.0.1",
  model: "claude-sonnet-4-6",
  temperature: 0.4,
  tokensInput: 500,
  tokensOutput: 80,
  generationDurationMs: 1200,
} as unknown as Awaited<ReturnType<typeof generateFirstSms>>;

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/preview-first-sms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue({
      userId: "user_admin_xxx",
      role: "admin",
      firstName: "Déthié",
      lastName: "Faye",
    });
  });

  describe("auth + RBAC", () => {
    it("renvoie 200 + smsBody + reasoning + check OK pour un contact 'ready'", async () => {
      mockGetContact.mockResolvedValue(buildFakeContact({ status: "ready" }));
      mockGenerateFirstSms.mockResolvedValue(FAKE_GENERATION_OK);
      mockPreSendCheck.mockReturnValue({ ok: true });

      const res = await POST(mockPost({ contactId: "hs_test_1" }));

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        smsBody: string;
        reasoning: string;
        charCount: number;
        preSendCheckPassed: boolean;
      };
      expect(body.smsBody).toBe(FAKE_GENERATION_OK.body);
      expect(body.reasoning).toBe(FAKE_GENERATION_OK.reasoning);
      expect(body.charCount).toBe(FAKE_GENERATION_OK.body.length);
      expect(body.preSendCheckPassed).toBe(true);
    });

    it("renvoie 401 si UnauthorizedError throw", async () => {
      mockRequireRole.mockRejectedValue(new UnauthorizedError({ message: "no session" }));

      const res = await POST(mockPost({ contactId: "hs_test_1" }));

      expect(res.status).toBe(401);
      expect(mockGetContact).not.toHaveBeenCalled();
      expect(mockGenerateFirstSms).not.toHaveBeenCalled();
    });

    it("renvoie 403 si rôle insuffisant", async () => {
      mockRequireRole.mockRejectedValue(
        new ForbiddenError({ message: "role commercial insufficient" }),
      );

      const res = await POST(mockPost({ contactId: "hs_test_1" }));

      expect(res.status).toBe(403);
      expect(mockGenerateFirstSms).not.toHaveBeenCalled();
    });
  });

  describe("validation Zod body", () => {
    it("renvoie 400 si contactId vide", async () => {
      const res = await POST(mockPost({ contactId: "" }));
      expect(res.status).toBe(400);
      expect(mockGetContact).not.toHaveBeenCalled();
    });

    it("renvoie 400 si contactId > 128 chars (anti-DoS)", async () => {
      const res = await POST(mockPost({ contactId: "x".repeat(129) }));
      expect(res.status).toBe(400);
    });

    it("renvoie 400 si contactId absent du body", async () => {
      const res = await POST(mockPost({}));
      expect(res.status).toBe(400);
    });

    it("renvoie 400 si body JSON malformé", async () => {
      const req = new NextRequest("https://medere.example/api/admin/preview-first-sms", {
        method: "POST",
        body: "{not valid json",
        headers: { "content-type": "application/json" },
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });
  });

  describe("contact lookup", () => {
    it("renvoie 404 si contact introuvable", async () => {
      mockGetContact.mockResolvedValue(null);

      const res = await POST(mockPost({ contactId: "hs_inexistant" }));

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("NOT_FOUND");
      expect(mockGenerateFirstSms).not.toHaveBeenCalled();
    });
  });

  describe("status guard (D-b1)", () => {
    it.each(["in_conversation", "qualified", "opted_out", "archived"] as const)(
      "renvoie 409 quand status=%s (preview non autorisé)",
      async (status) => {
        mockGetContact.mockResolvedValue(buildFakeContact({ status }));

        const res = await POST(mockPost({ contactId: "hs_test_1" }));

        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("CONFLICT");
        expect(mockGenerateFirstSms).not.toHaveBeenCalled();
      },
    );

    it.each(["pending", "enriched", "ready"] as const)(
      "renvoie 200 quand status=%s (preview autorisé)",
      async (status) => {
        mockGetContact.mockResolvedValue(buildFakeContact({ status }));
        mockGenerateFirstSms.mockResolvedValue(FAKE_GENERATION_OK);
        mockPreSendCheck.mockReturnValue({ ok: true });

        const res = await POST(mockPost({ contactId: "hs_test_1" }));

        expect(res.status).toBe(200);
        expect(mockGenerateFirstSms).toHaveBeenCalledTimes(1);
      },
    );
  });

  describe("generation Claude", () => {
    it("passe le subset FirstSmsContact (pas le Contact entier) à generateFirstSms", async () => {
      const contact = buildFakeContact({
        firstName: "Marie",
        lastName: "Curie",
        civilite: "Dr",
        speciality: "Pédiatre",
        city: "Lyon",
      });
      mockGetContact.mockResolvedValue(contact);
      mockGenerateFirstSms.mockResolvedValue(FAKE_GENERATION_OK);
      mockPreSendCheck.mockReturnValue({ ok: true });

      await POST(mockPost({ contactId: "hs_test_1" }));

      expect(mockGenerateFirstSms).toHaveBeenCalledWith({
        contact: {
          firstName: "Marie",
          lastName: "Curie",
          civilite: "Dr",
          speciality: "Pédiatre",
          city: "Lyon",
        },
      });
      // Aucun champ PII supplémentaire passé à Claude.
      const callArg = mockGenerateFirstSms.mock.calls[0]?.[0];
      expect(callArg?.contact).not.toHaveProperty("phone");
      expect(callArg?.contact).not.toHaveProperty("email");
      expect(callArg?.contact).not.toHaveProperty("hubspotId");
    });

    it("renvoie 500 générique si generateFirstSms throw une erreur inattendue", async () => {
      mockGetContact.mockResolvedValue(buildFakeContact({ status: "ready" }));
      mockGenerateFirstSms.mockRejectedValue(new Error("Claude API timeout"));

      const res = await POST(mockPost({ contactId: "hs_test_1" }));

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INTERNAL");
      expect(body.error.message).not.toContain("Claude API timeout");
    });
  });

  describe("preSendCheck (D-b2 dry-run)", () => {
    it("appelle preSendCheck avec recentOutboundMessages=[] et messageCount=0 (preview 1er SMS)", async () => {
      const contact = buildFakeContact({ status: "ready" });
      mockGetContact.mockResolvedValue(contact);
      mockGenerateFirstSms.mockResolvedValue(FAKE_GENERATION_OK);
      mockPreSendCheck.mockReturnValue({ ok: true });

      await POST(mockPost({ contactId: "hs_test_1" }));

      expect(mockPreSendCheck).toHaveBeenCalledWith({
        contact,
        message: FAKE_GENERATION_OK.body,
        conversation: { messageCount: 0 },
        recentOutboundMessages: [],
      });
    });

    it("renvoie preSendCheckPassed=false + code + rule quand check fail", async () => {
      mockGetContact.mockResolvedValue(buildFakeContact({ status: "ready" }));
      mockGenerateFirstSms.mockResolvedValue(FAKE_GENERATION_OK);
      mockPreSendCheck.mockReturnValue({
        ok: false,
        failure: {
          code: "bloctel_not_checked",
          rule: "bloctel",
          humanReason: "Vérification Bloctel manquante ou incohérente",
          context: {},
        },
      });

      const res = await POST(mockPost({ contactId: "hs_test_1" }));

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        preSendCheckPassed: boolean;
        preSendCheckCode?: string;
        preSendCheckRule?: string;
      };
      expect(body.preSendCheckPassed).toBe(false);
      expect(body.preSendCheckCode).toBe("bloctel_not_checked");
      expect(body.preSendCheckRule).toBe("bloctel");
    });

    it("D-b3 — humanReason JAMAIS exposé dans la response (server-only)", async () => {
      const PII_HINT = "Vérification Bloctel manquante";
      mockGetContact.mockResolvedValue(buildFakeContact({ status: "ready" }));
      mockGenerateFirstSms.mockResolvedValue(FAKE_GENERATION_OK);
      mockPreSendCheck.mockReturnValue({
        ok: false,
        failure: {
          code: "bloctel_not_checked",
          rule: "bloctel",
          humanReason: PII_HINT,
          context: {},
        },
      });

      const res = await POST(mockPost({ contactId: "hs_test_1" }));
      const bodyText = await res.text();

      // humanReason ne doit JAMAIS apparaître côté wire.
      expect(bodyText).not.toContain(PII_HINT);
      expect(bodyText).not.toContain("humanReason");
    });
  });

  describe("anti-leak PII", () => {
    it("response ne contient PAS le phone du contact (E.164 ni raw)", async () => {
      const contact = buildFakeContact({
        status: "ready",
        phone: {
          e164: "+33698765432",
          raw: "06 98 76 54 32",
          type: "mobile",
          valid: true,
          lookupAt: Timestamp.now(),
        },
      });
      mockGetContact.mockResolvedValue(contact);
      mockGenerateFirstSms.mockResolvedValue({
        ...FAKE_GENERATION_OK,
        body: "Bonjour Dr Dupont, Léa de Médéré. STOP pour ne plus recevoir.",
        reasoning: "Court, vouvoiement, IA mentionnée.",
      });
      mockPreSendCheck.mockReturnValue({ ok: true });

      const res = await POST(mockPost({ contactId: "hs_test_1" }));
      const bodyText = await res.text();

      expect(bodyText).not.toContain("+33698765432");
      expect(bodyText).not.toContain("06 98 76 54 32");
    });

    it("response ne contient PAS l'email du contact", async () => {
      const contact = buildFakeContact({
        status: "ready",
        email: "secret@cabinet-test.fr",
      });
      mockGetContact.mockResolvedValue(contact);
      mockGenerateFirstSms.mockResolvedValue(FAKE_GENERATION_OK);
      mockPreSendCheck.mockReturnValue({ ok: true });

      const res = await POST(mockPost({ contactId: "hs_test_1" }));
      const bodyText = await res.text();

      expect(bodyText).not.toContain("secret@cabinet-test.fr");
    });
  });
});
