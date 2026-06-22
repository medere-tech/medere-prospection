/**
 * Tests GET /api/admin/contacts (S10.1.4.a).
 *
 * Scope : route handler unit (mocks Clerk + Firestore wrapper). Vérifie le
 * branchement auth/authz, la validation Zod stricte, et les 2 sentinelles
 * d'arbitrages Déthié (D1 default status="ready", D2 phone EN CLAIR).
 *
 * On NE teste PAS `requireRole` ni `listContacts` ici (chacun a son propre
 * test suite). On teste UNIQUEMENT la glue de la route.
 */
import { Timestamp } from "firebase-admin/firestore";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ForbiddenError, UnauthorizedError, ValidationError } from "@/lib/utils/errors";
import type { Contact } from "@/types/contact";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(),
}));

/**
 * `vi.importActual` préserve `CONTACT_STATUS_VALUES`, `LIST_CONTACTS_*` —
 * sinon le `z.enum(CONTACT_STATUS_VALUES)` au top-level de `route.ts`
 * recevrait `undefined` et le module crasherait à l'import.
 */
vi.mock("@/lib/firestore/contacts", async () => {
  const actual = await vi.importActual<typeof import("@/lib/firestore/contacts")>(
    "@/lib/firestore/contacts",
  );
  return {
    ...actual,
    listContacts: vi.fn(),
  };
});

// Logger silencieux — pas de pollution stdout durant les tests.
vi.mock("@/lib/utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Imports APRÈS les `vi.mock` (hoist Vitest pris en compte).
import { requireRole } from "@/lib/auth/require-role";
import {
  LIST_CONTACTS_DEFAULT_LIMIT,
  LIST_CONTACTS_MAX_LIMIT,
  listContacts,
} from "@/lib/firestore/contacts";

import { GET } from "./route";

const mockRequireRole = vi.mocked(requireRole);
const mockListContacts = vi.mocked(listContacts);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function mockReq(searchParams: Record<string, string> = {}): NextRequest {
  const url = new URL("https://medere.example/api/admin/contacts");
  for (const [k, v] of Object.entries(searchParams)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url);
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

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/admin/contacts", () => {
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
    it("renvoie 200 avec les contacts quand admin auth OK", async () => {
      mockListContacts.mockResolvedValue({
        contacts: [
          buildFakeContact({ hubspotId: "hs_a" }),
          buildFakeContact({ hubspotId: "hs_b" }),
        ],
        nextCursor: "hs_b",
        hasMore: true,
      });

      const res = await GET(mockReq());

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        contacts: Contact[];
        nextCursor: string | null;
        hasMore: boolean;
      };
      expect(body.contacts).toHaveLength(2);
      expect(body.nextCursor).toBe("hs_b");
      expect(body.hasMore).toBe(true);
    });

    it("renvoie 401 si Clerk session absente (UnauthorizedError)", async () => {
      mockRequireRole.mockRejectedValue(
        new UnauthorizedError({ message: "requireRole: no userId" }),
      );

      const res = await GET(mockReq());

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("UNAUTHORIZED");
      expect(mockListContacts).not.toHaveBeenCalled();
    });

    it("renvoie 403 si rôle insuffisant (ForbiddenError)", async () => {
      mockRequireRole.mockRejectedValue(
        new ForbiddenError({
          message: "requireRole: role commercial insufficient for admin",
        }),
      );

      const res = await GET(mockReq());

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("FORBIDDEN");
      expect(mockListContacts).not.toHaveBeenCalled();
    });
  });

  describe("validation Zod (anti-injection)", () => {
    it("renvoie 400 si limit > LIST_CONTACTS_MAX_LIMIT", async () => {
      const res = await GET(mockReq({ limit: String(LIST_CONTACTS_MAX_LIMIT + 1) }));

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string }; issues: unknown[] };
      expect(body.error.code).toBe("VALIDATION");
      expect(Array.isArray(body.issues)).toBe(true);
      expect(mockListContacts).not.toHaveBeenCalled();
    });

    it("renvoie 400 si limit non numérique", async () => {
      const res = await GET(mockReq({ limit: "abc" }));
      expect(res.status).toBe(400);
    });

    it("renvoie 400 si limit < 1", async () => {
      const res = await GET(mockReq({ limit: "0" }));
      expect(res.status).toBe(400);
    });

    it("renvoie 400 si campaignId ne match pas le pattern ^hubspot-list-\\d+$", async () => {
      const res = await GET(mockReq({ campaignId: "BAD;DROP TABLE" }));

      expect(res.status).toBe(400);
      expect(mockListContacts).not.toHaveBeenCalled();
    });

    it("accepte un campaignId conforme (hubspot-list-12345)", async () => {
      mockListContacts.mockResolvedValue({ contacts: [], nextCursor: null, hasMore: false });

      const res = await GET(mockReq({ campaignId: "hubspot-list-12345" }));

      expect(res.status).toBe(200);
      expect(mockListContacts).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: expect.objectContaining({ campaignId: "hubspot-list-12345" }),
        }),
      );
    });

    it("renvoie 400 si status hors enum CONTACT_STATUS_VALUES", async () => {
      const res = await GET(mockReq({ status: "first_sms_queued" }));

      expect(res.status).toBe(400);
      expect(mockListContacts).not.toHaveBeenCalled();
    });

    it("accepte tous les status de l'enum CONTACT_STATUS_VALUES", async () => {
      mockListContacts.mockResolvedValue({ contacts: [], nextCursor: null, hasMore: false });

      for (const status of [
        "pending",
        "enriched",
        "ready",
        "in_conversation",
        "qualified",
        "opted_out",
        "archived",
      ] as const) {
        const res = await GET(mockReq({ status }));
        expect(res.status).toBe(200);
      }
    });
  });

  describe("sentinelles arbitrages Déthié", () => {
    it("D1 — status DEFAULT 'ready' appliqué côté route quand non fourni", async () => {
      mockListContacts.mockResolvedValue({ contacts: [], nextCursor: null, hasMore: false });

      await GET(mockReq());

      expect(mockListContacts).toHaveBeenCalledTimes(1);
      expect(mockListContacts).toHaveBeenCalledWith({
        filters: { status: "ready", campaignId: undefined },
        cursor: undefined,
        limit: LIST_CONTACTS_DEFAULT_LIMIT,
      });
    });

    it("D1 — status passé EXPLICITEMENT à listContacts (pas filters.status undefined)", async () => {
      mockListContacts.mockResolvedValue({ contacts: [], nextCursor: null, hasMore: false });

      await GET(mockReq({ status: "in_conversation" }));

      const callArg = mockListContacts.mock.calls[0]?.[0];
      expect(callArg?.filters?.status).toBe("in_conversation");
    });

    it("D2 — phone retourné EN CLAIR (e164 + raw) — pas de maskPhone backend", async () => {
      mockListContacts.mockResolvedValue({
        contacts: [buildFakeContact()],
        nextCursor: null,
        hasMore: false,
      });

      const res = await GET(mockReq());
      const bodyText = await res.text();

      // E.164 complet présent.
      expect(bodyText).toContain("+33612345678");
      // Forme raw présente.
      expect(bodyText).toContain("06 12 34 56 78");
      // Aucun masquage `*` appliqué.
      expect(bodyText).not.toContain("***");
    });
  });

  describe("propagation erreurs", () => {
    it("renvoie 400 si listContacts throw ValidationError (cursor stale)", async () => {
      mockListContacts.mockRejectedValue(
        new ValidationError({
          message: "listContacts: cursor refers to a non-existent contact",
        }),
      );

      const res = await GET(mockReq({ cursor: "hs_deleted_xxx" }));

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION");
    });

    it("renvoie 500 générique si listContacts throw une erreur inattendue", async () => {
      mockListContacts.mockRejectedValue(new Error("Firestore unavailable"));

      const res = await GET(mockReq());

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INTERNAL");
      // Pas de fuite du message technique côté wire.
      expect(body.error.message).not.toContain("Firestore unavailable");
    });
  });

  describe("transmission filtres → listContacts", () => {
    it("transmet cursor + limit + filters complets quand fournis", async () => {
      mockListContacts.mockResolvedValue({ contacts: [], nextCursor: null, hasMore: false });

      await GET(
        mockReq({
          status: "in_conversation",
          campaignId: "hubspot-list-200",
          limit: "25",
          cursor: "hs_cursor_xxx",
        }),
      );

      expect(mockListContacts).toHaveBeenCalledWith({
        filters: { status: "in_conversation", campaignId: "hubspot-list-200" },
        cursor: "hs_cursor_xxx",
        limit: 25,
      });
    });
  });
});
