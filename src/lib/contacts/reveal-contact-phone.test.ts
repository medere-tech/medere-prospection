/**
 * Tests `revealContactPhone` (VUE-CONVERSATION PR3 tour 2a — core logic).
 *
 * Scope : unit test avec mocks sur `getContact`, `getConversation`,
 * `appendAuditLog`. Pas d'emulator — la logique métier est pure
 * orchestration (fetch + predicate + audit + return) et chaque dépendance
 * a sa propre suite emulator-based ailleurs.
 *
 * Couvre les invariants Déthié PR3 Tour 2a Point 1 + Point 5 :
 *
 *   - Droits dans les 2 sens :
 *       • admin OK partout (avec et sans conversationId).
 *       • commercial titulaire (role + slackUserId === conv.handoff.assignedTo) OK.
 *       • commercial sans conversationId → ForbiddenError.
 *       • commercial avec slackUserId ≠ titulaire → ForbiddenError.
 *       • commercial avec slackUserId undefined → ForbiddenError.
 *       • commercial avec conv dont contactId ne match pas → ForbiddenError
 *         (anti-tamper : un titulaire d'une autre conv ne doit pas
 *         pouvoir lire un numéro arbitraire en forgeant un contactId).
 *   - Audit AVANT la réponse :
 *       • si `appendAuditLog` throw, la fonction throw et RIEN n'est
 *         renvoyé au caller (fail-closed strict).
 *       • l'audit est écrit AVANT que le résultat `{ e164, display }`
 *         ne soit retourné (preuve par séquence d'appels mock).
 *   - Audit sans PII :
 *       • payload audit ne contient JAMAIS `e164`, `firstName`,
 *         `lastName`, `email`, `phone`, numéro brut (sentinelle regex
 *         `+33\d` et `0[1-9]`).
 *   - Format FR : `+33612345678` → `06 12 34 56 78`.
 *   - 404 opaque : contact introuvable → NotFoundError SANS audit (ne
 *     révèle pas qu'un contactId existe à un utilisateur non autorisé).
 *   - optedOut remonté dans le résultat (UI affiche un badge si opt-out).
 */
import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ForbiddenError, NotFoundError } from "@/lib/utils/errors";
import type { Contact } from "@/types/contact";
import type { Conversation } from "@/types/conversation";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks (hoistés par Vitest)
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("@/lib/firestore/contacts", () => ({
  getContact: vi.fn(),
}));

vi.mock("@/lib/firestore/conversations", () => ({
  getConversation: vi.fn(),
}));

vi.mock("@/lib/firestore/audit-log", () => ({
  appendAuditLog: vi.fn(),
}));

vi.mock("@/lib/utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Imports APRÈS les `vi.mock` (hoist Vitest).
import { appendAuditLog } from "@/lib/firestore/audit-log";
import { getContact } from "@/lib/firestore/contacts";
import { getConversation } from "@/lib/firestore/conversations";

import {
  formatFrenchPhoneForDisplay,
  revealContactPhone,
  type RevealContactPhoneActor,
} from "./reveal-contact-phone";

const mockGetContact = vi.mocked(getContact);
const mockGetConversation = vi.mocked(getConversation);
const mockAppendAuditLog = vi.mocked(appendAuditLog);

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures minimales
// ─────────────────────────────────────────────────────────────────────────────

function fakeContact(overrides: Partial<Contact> = {}): Contact {
  const now = Timestamp.now();
  return {
    hubspotId: "hs_abc",
    firstName: "Jean",
    lastName: "Dupont",
    civilite: "Dr",
    speciality: "Chirurgien-dentiste",
    city: "Paris",
    postalCode: "75001",
    email: "jean.dupont@cabinet-test.fr",
    phone: {
      e164: "+33612345678",
      raw: "0612345678",
      type: "mobile",
      valid: true,
      lookupAt: now,
    },
    segment: "b2b_cabinet",
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

function fakeConversation(overrides: Partial<Conversation> = {}): Conversation {
  const now = Timestamp.now();
  // Cast `as Conversation` : la fonction testée NE LIT QUE `contactId` et
  // `handoff.assignedTo`. On évite d'énumérer les ~20 champs required
  // d'un vrai doc Firestore pour ne pas détourner l'attention du test.
  return {
    contactId: "hs_abc",
    campaignId: "hubspot-list-200",
    channel: "sms",
    status: "in_dialogue",
    intent: "unknown",
    messageCount: 2,
    inboundCount: 1,
    outboundCount: 1,
    followupCount: 0,
    assignedTo: "U_TITULAIRE",
    handoff: {
      assignedTo: "U_TITULAIRE",
      assignedAt: now,
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Conversation;
}

const adminActor: RevealContactPhoneActor = {
  userId: "clerk_admin",
  role: "admin",
  slackUserId: undefined,
  testAccount: false,
};

const commercialTitulaireActor: RevealContactPhoneActor = {
  userId: "clerk_commercial_1",
  role: "commercial",
  slackUserId: "U_TITULAIRE",
  testAccount: false,
};

const commercialAutreActor: RevealContactPhoneActor = {
  userId: "clerk_commercial_2",
  role: "commercial",
  slackUserId: "U_AUTRE",
  testAccount: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// formatFrenchPhoneForDisplay (helper pur, pas de mock)
// ─────────────────────────────────────────────────────────────────────────────

describe("formatFrenchPhoneForDisplay", () => {
  it("E.164 FR mobile → format `0X XX XX XX XX`", () => {
    expect(formatFrenchPhoneForDisplay("+33612345678")).toBe("06 12 34 56 78");
  });

  it("E.164 FR fixe → format `0X XX XX XX XX`", () => {
    expect(formatFrenchPhoneForDisplay("+33145678901")).toBe("01 45 67 89 01");
  });

  it("E.164 non-FR → retourné tel quel (défense en profondeur)", () => {
    expect(formatFrenchPhoneForDisplay("+14155552671")).toBe("+14155552671");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// revealContactPhone — droits + audit + fail-closed
// ─────────────────────────────────────────────────────────────────────────────

describe("revealContactPhone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Défaut : audit succeeds (ré-override cas par cas).
    mockAppendAuditLog.mockResolvedValue("audit_id_123");
  });

  describe("droits — admin", () => {
    it("admin SANS conversationId → OK (page `/admin/contacts`)", async () => {
      mockGetContact.mockResolvedValue(fakeContact());

      const res = await revealContactPhone({
        actor: adminActor,
        contactId: "hs_abc",
        method: "display",
      });

      expect(res.e164).toBe("+33612345678");
      expect(res.display).toBe("06 12 34 56 78");
      expect(res.optedOut).toBe(false);
      // `getConversation` JAMAIS appelé pour un admin sans conv.
      expect(mockGetConversation).not.toHaveBeenCalled();
    });

    it("admin AVEC conversationId → OK (page conversation)", async () => {
      mockGetContact.mockResolvedValue(fakeContact());
      // Même si on fournit conversationId, admin bypass la check titulaire.
      // `getConversation` ne doit PAS être appelé pour admin.

      const res = await revealContactPhone({
        actor: adminActor,
        contactId: "hs_abc",
        conversationId: "hs_abc_hubspot-list-200",
        method: "copy",
      });

      expect(res.e164).toBe("+33612345678");
      expect(mockGetConversation).not.toHaveBeenCalled();
    });
  });

  describe("droits — commercial", () => {
    it("commercial titulaire (slackUserId === conv.handoff.assignedTo) → OK", async () => {
      mockGetContact.mockResolvedValue(fakeContact());
      mockGetConversation.mockResolvedValue(fakeConversation());

      const res = await revealContactPhone({
        actor: commercialTitulaireActor,
        contactId: "hs_abc",
        conversationId: "hs_abc_hubspot-list-200",
        method: "call",
      });

      expect(res.e164).toBe("+33612345678");
      expect(mockGetConversation).toHaveBeenCalledWith("hs_abc_hubspot-list-200");
    });

    it("commercial SANS conversationId → ForbiddenError + pas d'audit", async () => {
      mockGetContact.mockResolvedValue(fakeContact());

      await expect(
        revealContactPhone({
          actor: commercialTitulaireActor,
          contactId: "hs_abc",
          method: "display",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      expect(mockAppendAuditLog).not.toHaveBeenCalled();
    });

    it("commercial avec slackUserId ≠ titulaire → ForbiddenError + pas d'audit", async () => {
      mockGetContact.mockResolvedValue(fakeContact());
      mockGetConversation.mockResolvedValue(fakeConversation());

      await expect(
        revealContactPhone({
          actor: commercialAutreActor,
          contactId: "hs_abc",
          conversationId: "hs_abc_hubspot-list-200",
          method: "display",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      expect(mockAppendAuditLog).not.toHaveBeenCalled();
    });

    it("commercial avec slackUserId undefined → ForbiddenError + pas d'audit", async () => {
      mockGetContact.mockResolvedValue(fakeContact());
      mockGetConversation.mockResolvedValue(fakeConversation());

      await expect(
        revealContactPhone({
          actor: {
            ...commercialTitulaireActor,
            slackUserId: undefined,
          },
          contactId: "hs_abc",
          conversationId: "hs_abc_hubspot-list-200",
          method: "display",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      expect(mockAppendAuditLog).not.toHaveBeenCalled();
    });

    it("anti-tamper : conv.contactId ≠ input.contactId → ForbiddenError + pas d'audit", async () => {
      // Un commercial titulaire d'une autre conv forge un contactId
      // différent dans sa requête → la logique doit refuser.
      mockGetContact.mockResolvedValue(fakeContact({ hubspotId: "hs_victime" }));
      mockGetConversation.mockResolvedValue(fakeConversation({ contactId: "hs_abc" }));

      await expect(
        revealContactPhone({
          actor: commercialTitulaireActor,
          contactId: "hs_victime", // ← forge
          conversationId: "hs_abc_hubspot-list-200",
          method: "display",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      expect(mockAppendAuditLog).not.toHaveBeenCalled();
    });
  });

  describe("404 opaque", () => {
    it("contact introuvable → NotFoundError + pas d'audit", async () => {
      mockGetContact.mockResolvedValue(null);

      await expect(
        revealContactPhone({
          actor: adminActor,
          contactId: "hs_absent",
          method: "display",
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      expect(mockAppendAuditLog).not.toHaveBeenCalled();
    });

    it("conv introuvable (commercial) → NotFoundError + pas d'audit", async () => {
      mockGetContact.mockResolvedValue(fakeContact());
      mockGetConversation.mockResolvedValue(null);

      await expect(
        revealContactPhone({
          actor: commercialTitulaireActor,
          contactId: "hs_abc",
          conversationId: "conv_absente",
          method: "display",
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      expect(mockAppendAuditLog).not.toHaveBeenCalled();
    });
  });

  describe("audit — ordre + PII-free", () => {
    it("audit écrit AVANT que la fonction renvoie (fail-closed strict)", async () => {
      // Si appendAuditLog throw, la fonction DOIT throw sans renvoyer le numéro.
      mockGetContact.mockResolvedValue(fakeContact());
      mockAppendAuditLog.mockRejectedValue(new Error("Firestore unavailable"));

      await expect(
        revealContactPhone({
          actor: adminActor,
          contactId: "hs_abc",
          method: "display",
        }),
      ).rejects.toThrow("Firestore unavailable");
    });

    it("payload audit NE CONTIENT PAS d'E.164 ni de PII contact", async () => {
      mockGetContact.mockResolvedValue(fakeContact());

      await revealContactPhone({
        actor: adminActor,
        contactId: "hs_abc",
        method: "display",
      });

      expect(mockAppendAuditLog).toHaveBeenCalledTimes(1);
      const call = mockAppendAuditLog.mock.calls[0]?.[0];
      expect(call).toBeDefined();
      const payloadJson = JSON.stringify(call?.payload ?? {});

      // Pas de numéro E.164 ni de numéro FR national.
      expect(payloadJson).not.toMatch(/\+33\d/);
      expect(payloadJson).not.toMatch(/0[1-9]\d{8}/);
      // Pas de nom / prénom / email ni "phone" en clef.
      expect(payloadJson).not.toContain("Jean");
      expect(payloadJson).not.toContain("Dupont");
      expect(payloadJson).not.toContain("jean.dupont");
      expect(payloadJson).not.toMatch(/"phone"\s*:/);
      // La structure attendue (method + contactId + actorTestAccount).
      expect(call?.payload).toMatchObject({
        method: "display",
        contactId: "hs_abc",
        actorTestAccount: false,
      });
      // Pas de `conversationId` quand input ne le fournit pas (admin liste).
      expect((call?.payload as Record<string, unknown>).conversationId).toBeUndefined();
    });

    it("payload audit expose `conversationId` quand il est fourni", async () => {
      mockGetContact.mockResolvedValue(fakeContact());

      await revealContactPhone({
        actor: adminActor,
        contactId: "hs_abc",
        conversationId: "hs_abc_hubspot-list-200",
        method: "copy",
      });

      const call = mockAppendAuditLog.mock.calls[0]?.[0];
      expect(call?.payload).toMatchObject({
        method: "copy",
        contactId: "hs_abc",
        conversationId: "hs_abc_hubspot-list-200",
        actorTestAccount: false,
      });
    });

    it("payload audit forwarde `actorTestAccount` depuis le claim Clerk", async () => {
      mockGetContact.mockResolvedValue(fakeContact());

      await revealContactPhone({
        actor: { ...adminActor, testAccount: true },
        contactId: "hs_abc",
        method: "call",
      });

      const call = mockAppendAuditLog.mock.calls[0]?.[0];
      expect((call?.payload as Record<string, unknown>).actorTestAccount).toBe(true);
    });
  });

  describe("résultat", () => {
    it("optedOut remonté quand `contact.consent.optedOut === true`", async () => {
      mockGetContact.mockResolvedValue(
        fakeContact({
          consent: {
            legitimateInterest: "doc",
            optedOut: true,
            optedOutAt: Timestamp.now(),
          },
        }),
      );

      const res = await revealContactPhone({
        actor: adminActor,
        contactId: "hs_abc",
        method: "display",
      });

      expect(res.optedOut).toBe(true);
    });
  });
});
