/**
 * Tests POST /api/admin/send-first-sms (S10.1.4.c).
 *
 * Scope : route handler unit (mocks Clerk + Firestore + Claude + Inngest
 * + audit-log). Vérifie :
 *   - auth/RBAC (200 / 401 / 403)
 *   - sentinelles BodySchema strict (confirm: true, contactId, anti-drift
 *     champs surnuméraires)
 *   - status guards (pending/enriched/ready vs in_conversation/qualified/
 *     opted_out/archived)
 *   - ordre audit AVANT inngest.send (D-c6)
 *   - payload audit PII-free
 *   - propagation 500 si Inngest échoue
 *   - sentinelle anti-divergence preview/send (single source of truth
 *     generateFirstSms) via filesystem grep
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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

// S10.1.9 RATELIMIT-001 : mock le helper pour découpler les tests de route
// du wrapper Upstash. Par défaut (beforeEach) on retourne null = pass-through.
vi.mock("@/lib/security/admin-rate-limit", () => ({
  applyAdminRateLimit: vi.fn(),
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

vi.mock("@/lib/firestore/conversations", async () => {
  const actual = await vi.importActual<typeof import("@/lib/firestore/conversations")>(
    "@/lib/firestore/conversations",
  );
  return {
    ...actual,
    getOrCreateInitialConversation: vi.fn(),
  };
});

vi.mock("@/lib/firestore/audit-log", async () => {
  const actual = await vi.importActual<typeof import("@/lib/firestore/audit-log")>(
    "@/lib/firestore/audit-log",
  );
  return {
    ...actual,
    appendAuditLog: vi.fn(),
  };
});

vi.mock("@/lib/inngest/client", () => ({
  getInngestClient: vi.fn(() => ({
    send: vi.fn(),
  })),
}));

vi.mock("@/lib/utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Imports APRÈS les `vi.mock`.
import { requireRole } from "@/lib/auth/require-role";
import { generateFirstSms } from "@/lib/claude/first-sms-generator";
import { appendAuditLog } from "@/lib/firestore/audit-log";
import { getContact } from "@/lib/firestore/contacts";
import { getOrCreateInitialConversation } from "@/lib/firestore/conversations";
import { getInngestClient } from "@/lib/inngest/client";
import { applyAdminRateLimit } from "@/lib/security/admin-rate-limit";

import { POST } from "./route";

const mockRequireRole = vi.mocked(requireRole);
const mockGenerateFirstSms = vi.mocked(generateFirstSms);
const mockGetContact = vi.mocked(getContact);
const mockGetOrCreate = vi.mocked(getOrCreateInitialConversation);
const mockAppendAuditLog = vi.mocked(appendAuditLog);
const mockGetInngestClient = vi.mocked(getInngestClient);
const mockApplyAdminRateLimit = vi.mocked(applyAdminRateLimit);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function mockPost(body: unknown): NextRequest {
  return new NextRequest("https://medere.example/api/admin/send-first-sms", {
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
  promptVersion: "1.0.1",
  model: "claude-sonnet-4-6",
  temperature: 0.4,
  tokensInput: 500,
  tokensOutput: 80,
  generationDurationMs: 1200,
} as unknown as Awaited<ReturnType<typeof generateFirstSms>>;

function setupInngestSend(returnIds: string[] | null) {
  const mockSend = vi.fn().mockResolvedValue({ ids: returnIds });
  mockGetInngestClient.mockReturnValue({
    send: mockSend,
  } as unknown as ReturnType<typeof getInngestClient>);
  return mockSend;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/send-first-sms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue({
      userId: "user_admin_xxx",
      role: "admin",
      firstName: "Déthié",
      lastName: "Faye",
    });
    // S10.1.9 RATELIMIT-001 : par défaut le rate-limit passe (null = OK).
    mockApplyAdminRateLimit.mockResolvedValue(null);
  });

  describe("rate-limit (S10.1.9 RATELIMIT-001)", () => {
    it("renvoie 429 + Retry-After + body RATE_LIMITED si rate-limit bloque", async () => {
      const { NextResponse } = await import("next/server");
      mockApplyAdminRateLimit.mockResolvedValue(
        NextResponse.json(
          { error: { code: "RATE_LIMITED", message: "Trop de requêtes. Réessayez plus tard." } },
          { status: 429, headers: { "Retry-After": "12" } },
        ),
      );

      const res = await POST(mockPost({ contactId: "hs_test_1", confirm: true }));

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("12");
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("RATE_LIMITED");
      // Court-circuit total : aucun audit posé, aucun Inngest event envoyé.
      expect(mockAppendAuditLog).not.toHaveBeenCalled();
      expect(mockGetContact).not.toHaveBeenCalled();
    });

    it("rate-limit appelé avec le Clerk userId extrait de requireRole", async () => {
      mockGetContact.mockResolvedValue(buildFakeContact({ status: "ready" }));
      mockGenerateFirstSms.mockResolvedValue(FAKE_GENERATION_OK);
      mockGetOrCreate.mockResolvedValue({
        conversationId: "hs_test_1_hubspot-list-200",
        created: true,
      });
      mockAppendAuditLog.mockResolvedValue("audit_doc_xxx");
      setupInngestSend(["evt_abc123"]);

      await POST(mockPost({ contactId: "hs_test_1", confirm: true }));

      expect(mockApplyAdminRateLimit).toHaveBeenCalledWith(expect.anything(), "user_admin_xxx");
    });
  });

  describe("auth + RBAC", () => {
    it("renvoie 202 + jobId + audit posé pour un contact 'ready'", async () => {
      mockGetContact.mockResolvedValue(buildFakeContact({ status: "ready" }));
      mockGenerateFirstSms.mockResolvedValue(FAKE_GENERATION_OK);
      mockGetOrCreate.mockResolvedValue({
        conversationId: "hs_test_1_hubspot-list-200",
        created: true,
      });
      mockAppendAuditLog.mockResolvedValue("audit_doc_xxx");
      setupInngestSend(["evt_abc123"]);

      const res = await POST(mockPost({ contactId: "hs_test_1", confirm: true }));

      expect(res.status).toBe(202);
      const body = (await res.json()) as {
        jobId: string;
        status: string;
        contactId: string;
        smsCharCount: number;
      };
      expect(body.jobId).toBe("evt_abc123");
      expect(body.status).toBe("queued");
      expect(body.contactId).toBe("hs_test_1");
      expect(body.smsCharCount).toBe(FAKE_GENERATION_OK.body.length);
    });

    it("renvoie 401 si UnauthorizedError throw", async () => {
      mockRequireRole.mockRejectedValue(new UnauthorizedError({ message: "no session" }));

      const res = await POST(mockPost({ contactId: "hs_test_1", confirm: true }));

      expect(res.status).toBe(401);
      expect(mockAppendAuditLog).not.toHaveBeenCalled();
    });

    it("renvoie 403 si rôle insuffisant", async () => {
      mockRequireRole.mockRejectedValue(
        new ForbiddenError({ message: "role commercial insufficient" }),
      );

      const res = await POST(mockPost({ contactId: "hs_test_1", confirm: true }));

      expect(res.status).toBe(403);
      expect(mockAppendAuditLog).not.toHaveBeenCalled();
    });
  });

  describe("BodySchema strict (anti-CSRF + anti-drift)", () => {
    it("D-c5 sentinelle confirm:true — body SANS confirm → 400", async () => {
      const res = await POST(mockPost({ contactId: "hs_test_1" }));

      expect(res.status).toBe(400);
      expect(mockGetContact).not.toHaveBeenCalled();
      expect(mockAppendAuditLog).not.toHaveBeenCalled();
    });

    it("D-c5 sentinelle confirm:true — body avec confirm: false → 400", async () => {
      const res = await POST(mockPost({ contactId: "hs_test_1", confirm: false }));

      expect(res.status).toBe(400);
      expect(mockAppendAuditLog).not.toHaveBeenCalled();
    });

    it("D-c4 sentinelle z.strictObject — body avec campaignId surnuméraire → 400 (anti-drift)", async () => {
      // Si un futur dev ajoute campaignId au body sans repenser le drift
      // UI/Firestore, ce test casse. La route DOIT TOUJOURS dériver
      // campaignId de contact.campaignId (D-c4).
      const res = await POST(
        mockPost({
          contactId: "hs_test_1",
          confirm: true,
          campaignId: "hubspot-list-200", // ← surnuméraire, doit être rejeté
        }),
      );

      expect(res.status).toBe(400);
      expect(mockGetContact).not.toHaveBeenCalled();
    });

    it("renvoie 400 si contactId vide", async () => {
      const res = await POST(mockPost({ contactId: "", confirm: true }));
      expect(res.status).toBe(400);
    });

    it("renvoie 400 si contactId > 128 chars (anti-DoS)", async () => {
      const res = await POST(mockPost({ contactId: "x".repeat(129), confirm: true }));
      expect(res.status).toBe(400);
    });

    it("renvoie 400 si body JSON malformé", async () => {
      const req = new NextRequest("https://medere.example/api/admin/send-first-sms", {
        method: "POST",
        body: "{not valid",
        headers: { "content-type": "application/json" },
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });
  });

  describe("contact lookup + status guard", () => {
    it("renvoie 404 si contact introuvable", async () => {
      mockGetContact.mockResolvedValue(null);

      const res = await POST(mockPost({ contactId: "hs_inexistant", confirm: true }));

      expect(res.status).toBe(404);
      expect(mockGenerateFirstSms).not.toHaveBeenCalled();
      expect(mockAppendAuditLog).not.toHaveBeenCalled();
    });

    it.each(["in_conversation", "qualified", "opted_out", "archived"] as const)(
      "renvoie 409 quand status=%s (send non autorisé)",
      async (status) => {
        mockGetContact.mockResolvedValue(buildFakeContact({ status }));

        const res = await POST(mockPost({ contactId: "hs_test_1", confirm: true }));

        expect(res.status).toBe(409);
        expect(mockGenerateFirstSms).not.toHaveBeenCalled();
        expect(mockAppendAuditLog).not.toHaveBeenCalled();
      },
    );

    it.each(["pending", "enriched", "ready"] as const)(
      "renvoie 202 quand status=%s (send autorisé)",
      async (status) => {
        mockGetContact.mockResolvedValue(buildFakeContact({ status }));
        mockGenerateFirstSms.mockResolvedValue(FAKE_GENERATION_OK);
        mockGetOrCreate.mockResolvedValue({
          conversationId: "hs_test_1_hubspot-list-200",
          created: true,
        });
        mockAppendAuditLog.mockResolvedValue("audit_xxx");
        setupInngestSend(["evt_xxx"]);

        const res = await POST(mockPost({ contactId: "hs_test_1", confirm: true }));
        expect(res.status).toBe(202);
      },
    );
  });

  describe("pipeline D-c4 (campaignId dérivé) + D-c6 (audit AVANT inngest)", () => {
    it("D-c4 — campaignId passé à Inngest = contact.campaignId (PAS depuis le body)", async () => {
      const contact = buildFakeContact({
        status: "ready",
        campaignId: "hubspot-list-999",
      });
      mockGetContact.mockResolvedValue(contact);
      mockGenerateFirstSms.mockResolvedValue(FAKE_GENERATION_OK);
      mockGetOrCreate.mockResolvedValue({
        conversationId: "hs_test_1_hubspot-list-999",
        created: true,
      });
      mockAppendAuditLog.mockResolvedValue("audit_xxx");
      const mockSend = setupInngestSend(["evt_xxx"]);

      await POST(mockPost({ contactId: "hs_test_1", confirm: true }));

      // getOrCreate appelé avec le campaignId du contact
      expect(mockGetOrCreate).toHaveBeenCalledWith("hs_test_1", "hubspot-list-999");

      // inngest.send appelé avec campaignId du contact
      const sentEvent = mockSend.mock.calls[0]?.[0] as { data: { campaignId: string } };
      expect(sentEvent.data.campaignId).toBe("hubspot-list-999");
    });

    it("D-c6 — audit appelé AVANT inngest.send (ordre forensic critique)", async () => {
      mockGetContact.mockResolvedValue(buildFakeContact({ status: "ready" }));
      mockGenerateFirstSms.mockResolvedValue(FAKE_GENERATION_OK);
      mockGetOrCreate.mockResolvedValue({
        conversationId: "hs_test_1_hubspot-list-200",
        created: true,
      });

      const callOrder: string[] = [];
      mockAppendAuditLog.mockImplementation(async () => {
        callOrder.push("audit");
        return "audit_xxx";
      });
      const mockSend = vi.fn().mockImplementation(async () => {
        callOrder.push("inngest.send");
        return { ids: ["evt_xxx"] };
      });
      mockGetInngestClient.mockReturnValue({
        send: mockSend,
      } as unknown as ReturnType<typeof getInngestClient>);

      await POST(mockPost({ contactId: "hs_test_1", confirm: true }));

      expect(callOrder).toEqual(["audit", "inngest.send"]);
    });

    it("payload audit PII-free (pas de phone, email, firstName, body brut)", async () => {
      const contact = buildFakeContact({
        status: "ready",
        firstName: "Marie",
        lastName: "Curie",
        email: "secret@cabinet.fr",
        phone: {
          e164: "+33698765432",
          raw: "06 98 76 54 32",
          type: "mobile",
          valid: true,
          lookupAt: Timestamp.now(),
        },
      });
      mockGetContact.mockResolvedValue(contact);
      mockGenerateFirstSms.mockResolvedValue(FAKE_GENERATION_OK);
      mockGetOrCreate.mockResolvedValue({
        conversationId: "hs_test_1_hubspot-list-200",
        created: true,
      });
      mockAppendAuditLog.mockResolvedValue("audit_xxx");
      setupInngestSend(["evt_xxx"]);

      await POST(mockPost({ contactId: "hs_test_1", confirm: true }));

      const auditCall = mockAppendAuditLog.mock.calls[0]?.[0];
      expect(auditCall?.action).toBe("sms_send_initiated_by_admin");
      expect(auditCall?.actorType).toBe("human");
      expect(auditCall?.actorId).toBe("user_admin_xxx");
      expect(auditCall?.targetType).toBe("contact");
      expect(auditCall?.targetId).toBe("hs_test_1");

      // Payload sérialisé NE DOIT contenir AUCUNE PII
      const payloadJson = JSON.stringify(auditCall?.payload);
      expect(payloadJson).not.toContain("+33698765432");
      expect(payloadJson).not.toContain("06 98 76 54 32");
      expect(payloadJson).not.toContain("secret@cabinet.fr");
      expect(payloadJson).not.toContain("Marie");
      expect(payloadJson).not.toContain("Curie");
      expect(payloadJson).not.toContain(FAKE_GENERATION_OK.body);

      // Mais doit contenir les champs forensic attendus (PII-free)
      expect(auditCall?.payload).toMatchObject({
        contactId: "hs_test_1",
        campaignId: "hubspot-list-200",
        conversationId: "hs_test_1_hubspot-list-200",
        smsCharCount: FAKE_GENERATION_OK.body.length,
      });
    });

    it("subset 5 champs vers Claude (pas le Contact entier, pas de phone/email/hubspotId)", async () => {
      const contact = buildFakeContact({
        firstName: "Marie",
        lastName: "Curie",
        civilite: "Dr",
        speciality: "Pédiatre",
        city: "Lyon",
      });
      mockGetContact.mockResolvedValue(contact);
      mockGenerateFirstSms.mockResolvedValue(FAKE_GENERATION_OK);
      mockGetOrCreate.mockResolvedValue({
        conversationId: "hs_test_1_hubspot-list-200",
        created: true,
      });
      mockAppendAuditLog.mockResolvedValue("audit_xxx");
      setupInngestSend(["evt_xxx"]);

      await POST(mockPost({ contactId: "hs_test_1", confirm: true }));

      expect(mockGenerateFirstSms).toHaveBeenCalledWith({
        contact: {
          firstName: "Marie",
          lastName: "Curie",
          civilite: "Dr",
          speciality: "Pédiatre",
          city: "Lyon",
        },
      });
      const callArg = mockGenerateFirstSms.mock.calls[0]?.[0];
      expect(callArg?.contact).not.toHaveProperty("phone");
      expect(callArg?.contact).not.toHaveProperty("email");
      expect(callArg?.contact).not.toHaveProperty("hubspotId");
    });
  });

  describe("propagation erreurs", () => {
    it("renvoie 500 si inngest.send retourne aucun jobId (anomalie)", async () => {
      mockGetContact.mockResolvedValue(buildFakeContact({ status: "ready" }));
      mockGenerateFirstSms.mockResolvedValue(FAKE_GENERATION_OK);
      mockGetOrCreate.mockResolvedValue({
        conversationId: "hs_test_1_hubspot-list-200",
        created: true,
      });
      mockAppendAuditLog.mockResolvedValue("audit_xxx");
      setupInngestSend([]); // retourne ids: [] → jobId null

      const res = await POST(mockPost({ contactId: "hs_test_1", confirm: true }));

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INTERNAL");

      // L'audit reste posé (D-c6 — trace forensic même en cas d'anomalie aval)
      expect(mockAppendAuditLog).toHaveBeenCalledTimes(1);
    });

    it("renvoie 500 générique si inngest.send throw une erreur inattendue", async () => {
      mockGetContact.mockResolvedValue(buildFakeContact({ status: "ready" }));
      mockGenerateFirstSms.mockResolvedValue(FAKE_GENERATION_OK);
      mockGetOrCreate.mockResolvedValue({
        conversationId: "hs_test_1_hubspot-list-200",
        created: true,
      });
      mockAppendAuditLog.mockResolvedValue("audit_xxx");
      const mockSend = vi.fn().mockRejectedValue(new Error("Inngest cloud down"));
      mockGetInngestClient.mockReturnValue({
        send: mockSend,
      } as unknown as ReturnType<typeof getInngestClient>);

      const res = await POST(mockPost({ contactId: "hs_test_1", confirm: true }));

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INTERNAL");
      expect(body.error.message).not.toContain("Inngest cloud down");

      // L'audit reste posé (D-c6)
      expect(mockAppendAuditLog).toHaveBeenCalledTimes(1);
    });

    it("renvoie 500 si generateFirstSms throw — PAS d'audit posé (audit AVANT generate impossible)", async () => {
      mockGetContact.mockResolvedValue(buildFakeContact({ status: "ready" }));
      mockGenerateFirstSms.mockRejectedValue(new Error("Claude API timeout"));

      const res = await POST(mockPost({ contactId: "hs_test_1", confirm: true }));

      expect(res.status).toBe(500);
      expect(mockAppendAuditLog).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Sentinelle anti-divergence preview/send (S10.1.4-FOLLOWUP-SENTINEL-
  // GENERATEFIRSTSMS-001 — recommandation post-merge compliance-auditor
  // S10.1.4.b)
  // ───────────────────────────────────────────────────────────────────────

  describe("sentinelle anti-divergence preview/send (S10.1.4-FOLLOWUP-SENTINEL-GENERATEFIRSTSMS-001)", () => {
    it("generateFirstSms est l'UNIQUE source de génération SMS — exactement 2 call sites prod (preview + send)", () => {
      // Énumère récursivement src/ et compte les fichiers .ts (hors tests,
      // hors .d.ts, hors node_modules) qui importent `generateFirstSms`.
      // Attendu : EXACTEMENT 2 — preview-first-sms/route.ts + send-first-
      // sms/route.ts. Si > 2, drift architectural à arbitrer.
      // Si < 2, refactor cassé.
      const SRC_DIR = join(process.cwd(), "src");
      const IMPORT_PATTERN = /from\s+["']@\/lib\/claude\/first-sms-generator["']/;

      function walk(dir: string): string[] {
        const files: string[] = [];
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          const stat = statSync(full);
          if (stat.isDirectory()) {
            files.push(...walk(full));
          } else if (
            stat.isFile() &&
            full.endsWith(".ts") &&
            !full.endsWith(".test.ts") &&
            !full.endsWith(".d.ts")
          ) {
            files.push(full);
          }
        }
        return files;
      }

      const allFiles = walk(SRC_DIR);
      const importers = allFiles.filter((f) => {
        const content = readFileSync(f, "utf8");
        return IMPORT_PATTERN.test(content);
      });

      // Normalise les chemins pour assertion cross-OS.
      const importerSuffixes = importers
        .map((f) => f.replace(/\\/g, "/"))
        .map((f) => {
          const idx = f.indexOf("/src/");
          return idx >= 0 ? f.slice(idx + 1) : f;
        })
        .sort();

      expect(importerSuffixes).toEqual([
        "src/app/api/admin/preview-first-sms/route.ts",
        "src/app/api/admin/send-first-sms/route.ts",
      ]);
    });
  });
});
