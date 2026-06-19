/**
 * Tests `seed-runner.ts` (S10.1.3) — DI mocks, pas de Firestore emulator
 * ni d'appel HubSpot réel.
 *
 * Couverture (~35-40 tests) :
 *   - Sentinelles (SEED_BATCH_LIMIT, SEED_MAPPING_VERSION, SEED_RUNNER_OP)
 *   - Happy path 1 page + 100 contacts mappés + créés + audités
 *   - Pagination multi-pages (cursor → cursor → null)
 *   - Page vide (hasMore false immédiat)
 *   - Dry-run : 0 createContact + 0 appendAuditLog
 *   - ValidationError mapper → skip + audit contact_import_skipped
 *   - ConflictError createContact → skip silent + PAS d'audit
 *   - Erreur Firestore (autre que ConflictError) → skip + audit avec
 *     reason=create_failed
 *   - getContactsInList throw ExternalServiceError → propage
 *   - appendAuditLog AuditPiiError → propage
 *   - Idempotence 2 runs successifs sur même liste = même résultats stats
 *     (sauf durationMs)
 *   - Anti-fuite PII : audit payloads ne contiennent JAMAIS firstName/
 *     lastName/phone/email brut
 *   - SeedStats fields cohérents
 *   - campaign_started + campaign_completed bien appelés
 *   - SEED_BATCH_LIMIT propagé à getContactsInList
 */
import { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it, vi } from "vitest";

import type { HubspotContactRaw } from "@/lib/hubspot/contacts";
import { ConflictError, ExternalServiceError, ValidationError } from "@/lib/utils/errors";
import type { Contact } from "@/types/contact";

import {
  processContact,
  runSeed,
  sanitizeListNameForAudit,
  SEED_BATCH_LIMIT,
  SEED_MAPPING_VERSION,
  SEED_RUNNER_OP,
  type SeedRunnerDeps,
} from "./seed-runner";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — fixtures
// ─────────────────────────────────────────────────────────────────────────────

const NOW = Timestamp.fromMillis(1750000000000); // 2025-06-15T...

function makeRawContact(
  idx: number,
  overrides: Partial<HubspotContactRaw> = {},
): HubspotContactRaw {
  return {
    id: `hs_med_${idx}`,
    properties: {
      firstname: `First${idx}`,
      lastname: `Last${idx}`,
      email: null,
      phone: null,
      mobilephone: "0612345678",
      city: "Paris",
      zip: "75001",
      civilite: "Docteur",
      profession: "Médecin",
    },
    ...overrides,
  };
}

function makeMappedContact(idx: number, campaignId: string): Contact {
  return {
    hubspotId: `hs_med_${idx}`,
    firstName: `First${idx}`,
    lastName: `Last${idx}`,
    civilite: "Dr",
    speciality: "Médecin",
    city: "Paris",
    postalCode: "75001",
    phone: {
      e164: "+33612345678",
      raw: "0612345678",
      type: "mobile",
      valid: true,
      lookupAt: NOW,
    },
    segment: "unknown",
    bloctelChecked: false,
    bloctelOptOut: false,
    consent: {
      legitimateInterest:
        "Intérêt légitime: démarchage SMS B2B PS médico-dentaire MVP Médéré DPC v1",
      optedOut: false,
    },
    enrichment: {
      source: "hubspot",
      enrichedAt: NOW,
    },
    status: "ready",
    campaignId,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeMockDeps(): SeedRunnerDeps {
  return {
    listSmsLists: vi.fn().mockResolvedValue([]),
    getContactsInList: vi
      .fn<SeedRunnerDeps["getContactsInList"]>()
      .mockResolvedValue({ contacts: [], nextCursor: undefined, hasMore: false }),
    mapHubSpotContactToFirestoreContact: vi
      .fn<SeedRunnerDeps["mapHubSpotContactToFirestoreContact"]>()
      .mockImplementation(({ raw, campaignId }) =>
        makeMappedContact(parseInt(raw.id.replace(/^hs_med_/, ""), 10) || 0, campaignId),
      ),
    createContact: vi
      .fn<SeedRunnerDeps["createContact"]>()
      .mockImplementation(async (input) => ({ contactId: input.hubspotId })),
    appendAuditLog: vi.fn<SeedRunnerDeps["appendAuditLog"]>().mockResolvedValue("audit_doc_id_xyz"),
  };
}

const VALID_INPUT = {
  listId: "1234",
  listName: "SMS Dentistes IDF",
  expectedCount: 200,
  campaignId: "hubspot-list-1234",
  dryRun: false,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Sentinelles constantes
// ─────────────────────────────────────────────────────────────────────────────

describe("seed-runner — sentinelles constantes", () => {
  it("SEED_RUNNER_OP === 'seed.run'", () => {
    expect(SEED_RUNNER_OP).toBe("seed.run");
  });

  it("SEED_BATCH_LIMIT === 100 (HubSpot max cohérence)", () => {
    expect(SEED_BATCH_LIMIT).toBe(100);
  });

  it("SEED_MAPPING_VERSION === '1.0.0' (semver initial S10.1.3)", () => {
    expect(SEED_MAPPING_VERSION).toBe("1.0.0");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeListNameForAudit — defense-in-depth T1-2 compliance
// ─────────────────────────────────────────────────────────────────────────────

describe("sanitizeListNameForAudit — anti-PII listName HubSpot", () => {
  it("nom court normal → inchangé", () => {
    expect(sanitizeListNameForAudit("SMS Dentistes IDF")).toBe("SMS Dentistes IDF");
  });

  it("nom > 100 chars → truncate à 100", () => {
    const longName = "x".repeat(150);
    expect(sanitizeListNameForAudit(longName).length).toBe(100);
  });

  it("E.164 dans le nom → remplacé par [REDACTED]", () => {
    expect(sanitizeListNameForAudit("Liste SMS +33612345678")).toBe("Liste SMS [REDACTED]");
  });

  it("téléphone FR national dans le nom → remplacé par [REDACTED]", () => {
    expect(sanitizeListNameForAudit("Liste 0612345678")).toBe("Liste [REDACTED]");
  });

  it("téléphone FR avec espaces → remplacé par [REDACTED]", () => {
    expect(sanitizeListNameForAudit("SMS 06 12 34 56 78")).toBe("SMS [REDACTED]");
  });

  it("email dans le nom → remplacé par [REDACTED]", () => {
    expect(sanitizeListNameForAudit("Liste contact@example.fr")).toBe("Liste [REDACTED]");
  });

  it("multiples PII patterns → tous remplacés", () => {
    expect(sanitizeListNameForAudit("0612345678 + jean@example.fr")).toBe(
      "[REDACTED] + [REDACTED]",
    );
  });

  it("nom vide → vide", () => {
    expect(sanitizeListNameForAudit("")).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runSeed — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("runSeed — happy path 1 page", () => {
  it("3 contacts → 3 created + audits campaign_started/completed + 3 contact_imported_from_hubspot", async () => {
    const deps = makeMockDeps();
    const contacts = [0, 1, 2].map((i) => makeRawContact(i));
    (deps.getContactsInList as ReturnType<typeof vi.fn>).mockResolvedValue({
      contacts,
      nextCursor: undefined,
      hasMore: false,
    });

    const stats = await runSeed(VALID_INPUT, deps);

    expect(stats.createdCount).toBe(3);
    expect(stats.skippedAlreadyExistsCount).toBe(0);
    expect(stats.skippedMapperErrorCount).toBe(0);
    expect(stats.fetchedCount).toBe(3);
    expect(stats.pagesProcessed).toBe(1);

    // 1 campaign_started + 3 contact_imported_from_hubspot + 1 campaign_completed = 5 audits
    expect(deps.appendAuditLog).toHaveBeenCalledTimes(5);
    expect(deps.createContact).toHaveBeenCalledTimes(3);
  });

  it("SeedStats : durationMs > 0, completedAt non-null, startedAt ISO", async () => {
    const deps = makeMockDeps();
    const stats = await runSeed(VALID_INPUT, deps);
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
    expect(stats.completedAt).not.toBeNull();
    expect(stats.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("getContactsInList appelé avec SEED_BATCH_LIMIT", async () => {
    const deps = makeMockDeps();
    await runSeed(VALID_INPUT, deps);
    expect(deps.getContactsInList).toHaveBeenCalledWith(
      "1234",
      expect.objectContaining({ limit: SEED_BATCH_LIMIT }),
    );
  });

  it("campaign_started payload contient {listId, listName, expectedCount, dryRun: false}", async () => {
    const deps = makeMockDeps();
    await runSeed(VALID_INPUT, deps);
    const startedCall = (deps.appendAuditLog as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0].action === "campaign_started",
    );
    expect(startedCall).toBeDefined();
    expect(startedCall![0]).toMatchObject({
      actorId: "system:seed",
      actorType: "system",
      targetType: "campaign",
      targetId: "hubspot-list-1234",
      payload: {
        listId: "1234",
        listName: "SMS Dentistes IDF",
        expectedCount: 200,
        dryRun: false,
      },
    });
  });

  it("campaign_completed payload contient stats finales {createdCount, skippedAlreadyExists, skippedMapperError, durationMs}", async () => {
    const deps = makeMockDeps();
    const contacts = [0, 1].map((i) => makeRawContact(i));
    (deps.getContactsInList as ReturnType<typeof vi.fn>).mockResolvedValue({
      contacts,
      nextCursor: undefined,
      hasMore: false,
    });

    await runSeed(VALID_INPUT, deps);
    const completedCall = (deps.appendAuditLog as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0].action === "campaign_completed",
    );
    expect(completedCall).toBeDefined();
    expect(completedCall![0].payload).toMatchObject({
      listId: "1234",
      createdCount: 2,
      skippedAlreadyExists: 0,
      skippedMapperError: 0,
    });
    expect(completedCall![0].payload.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("contact_imported_from_hubspot payload {listId, mappingVersion, source: 'hubspot'} sans PII", async () => {
    const deps = makeMockDeps();
    (deps.getContactsInList as ReturnType<typeof vi.fn>).mockResolvedValue({
      contacts: [makeRawContact(42)],
      nextCursor: undefined,
      hasMore: false,
    });

    await runSeed(VALID_INPUT, deps);
    const importedCall = (deps.appendAuditLog as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0].action === "contact_imported_from_hubspot",
    );
    expect(importedCall).toBeDefined();
    expect(importedCall![0]).toMatchObject({
      actorType: "system",
      targetType: "contact",
      targetId: "hs_med_42",
      payload: {
        listId: "1234",
        mappingVersion: SEED_MAPPING_VERSION,
        source: "hubspot",
      },
    });
    // 🚨 Sentinelle anti-fuite PII : aucun champ identité PS
    const serialized = JSON.stringify(importedCall![0].payload);
    expect(serialized).not.toContain("First");
    expect(serialized).not.toContain("Last");
    expect(serialized).not.toContain("+33");
    expect(serialized).not.toMatch(/@/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runSeed — pagination multi-pages
// ─────────────────────────────────────────────────────────────────────────────

describe("runSeed — pagination cursor", () => {
  it("2 pages (cursor → undefined) → 200 fetched + 2 pagesProcessed", async () => {
    const deps = makeMockDeps();
    const page1Contacts = Array.from({ length: 100 }, (_, i) => makeRawContact(i));
    const page2Contacts = Array.from({ length: 100 }, (_, i) => makeRawContact(100 + i));

    (deps.getContactsInList as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        contacts: page1Contacts,
        nextCursor: "cursor-page-2",
        hasMore: true,
      })
      .mockResolvedValueOnce({
        contacts: page2Contacts,
        nextCursor: undefined,
        hasMore: false,
      });

    const stats = await runSeed(VALID_INPUT, deps);
    expect(stats.fetchedCount).toBe(200);
    expect(stats.createdCount).toBe(200);
    expect(stats.pagesProcessed).toBe(2);

    // 2e appel propage le cursor
    expect((deps.getContactsInList as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]).toMatchObject({
      cursor: "cursor-page-2",
    });
  });

  it("Page vide immédiate (hasMore false sur page 1) → 0 created + 1 pagesProcessed", async () => {
    const deps = makeMockDeps();
    (deps.getContactsInList as ReturnType<typeof vi.fn>).mockResolvedValue({
      contacts: [],
      nextCursor: undefined,
      hasMore: false,
    });

    const stats = await runSeed(VALID_INPUT, deps);
    expect(stats.fetchedCount).toBe(0);
    expect(stats.createdCount).toBe(0);
    expect(stats.pagesProcessed).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runSeed — dry-run
// ─────────────────────────────────────────────────────────────────────────────

describe("runSeed — dry-run mode", () => {
  it("dry-run : 3 contacts → 3 createdCount mais 0 createContact + 0 appendAuditLog", async () => {
    const deps = makeMockDeps();
    const contacts = [0, 1, 2].map((i) => makeRawContact(i));
    (deps.getContactsInList as ReturnType<typeof vi.fn>).mockResolvedValue({
      contacts,
      nextCursor: undefined,
      hasMore: false,
    });

    const stats = await runSeed({ ...VALID_INPUT, dryRun: true }, deps);
    expect(stats.createdCount).toBe(3); // compte les "créables"
    expect(stats.dryRun).toBe(true);
    expect(deps.createContact).not.toHaveBeenCalled();
    expect(deps.appendAuditLog).not.toHaveBeenCalled();
  });

  it("dry-run : mapper error → skip mais PAS d'audit (pas de write)", async () => {
    const deps = makeMockDeps();
    const contacts = [makeRawContact(0), makeRawContact(99)];
    (deps.getContactsInList as ReturnType<typeof vi.fn>).mockResolvedValue({
      contacts,
      nextCursor: undefined,
      hasMore: false,
    });
    (deps.mapHubSpotContactToFirestoreContact as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(makeMappedContact(0, "hubspot-list-1234"))
      .mockImplementationOnce(() => {
        throw new ValidationError({
          message: "mapper test fail",
          context: { invalidField: "profession", professionFingerprint: "abc12345" },
        });
      });

    const stats = await runSeed({ ...VALID_INPUT, dryRun: true }, deps);
    expect(stats.createdCount).toBe(1);
    expect(stats.skippedMapperErrorCount).toBe(1);
    expect(deps.appendAuditLog).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runSeed — gestion d'erreurs ciblées
// ─────────────────────────────────────────────────────────────────────────────

describe("runSeed — ValidationError mapper", () => {
  it("1 contact mapper fail → skip + audit contact_import_skipped + continue", async () => {
    const deps = makeMockDeps();
    const contacts = [makeRawContact(0), makeRawContact(99), makeRawContact(2)];
    (deps.getContactsInList as ReturnType<typeof vi.fn>).mockResolvedValue({
      contacts,
      nextCursor: undefined,
      hasMore: false,
    });

    (deps.mapHubSpotContactToFirestoreContact as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(makeMappedContact(0, "hubspot-list-1234"))
      .mockImplementationOnce(() => {
        throw new ValidationError({
          message: "mapper test fail",
          context: {
            invalidField: "profession",
            professionFingerprint: "abc12345",
          },
        });
      })
      .mockReturnValueOnce(makeMappedContact(2, "hubspot-list-1234"));

    const stats = await runSeed(VALID_INPUT, deps);
    expect(stats.createdCount).toBe(2);
    expect(stats.skippedMapperErrorCount).toBe(1);

    const skipCall = (deps.appendAuditLog as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0].action === "contact_import_skipped",
    );
    expect(skipCall).toBeDefined();
    expect(skipCall![0].payload).toMatchObject({
      reason: "mapper_failed",
      invalidField: "profession",
      professionFingerprint: "abc12345",
      errorCode: "VALIDATION",
    });
  });

  it("audit contact_import_skipped : targetId = raw.id (hubspotId), pas 'unknown'", async () => {
    const deps = makeMockDeps();
    (deps.getContactsInList as ReturnType<typeof vi.fn>).mockResolvedValue({
      contacts: [makeRawContact(99)],
      nextCursor: undefined,
      hasMore: false,
    });
    (deps.mapHubSpotContactToFirestoreContact as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => {
        throw new ValidationError({
          message: "fail",
          context: { missingField: "phone|mobilephone" },
        });
      },
    );

    await runSeed(VALID_INPUT, deps);
    const skipCall = (deps.appendAuditLog as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0].action === "contact_import_skipped",
    );
    expect(skipCall![0].targetId).toBe("hs_med_99");
  });

  it("audit contact_import_skipped : raw.id vide → targetId fallback 'unknown-hs'", async () => {
    const deps = makeMockDeps();
    const rawWithoutId = { id: "", properties: makeRawContact(0).properties };
    (deps.getContactsInList as ReturnType<typeof vi.fn>).mockResolvedValue({
      contacts: [rawWithoutId],
      nextCursor: undefined,
      hasMore: false,
    });
    (deps.mapHubSpotContactToFirestoreContact as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => {
        throw new ValidationError({
          message: "fail",
          context: { op: "mapHubSpotContact" },
        });
      },
    );

    await runSeed(VALID_INPUT, deps);
    const skipCall = (deps.appendAuditLog as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0].action === "contact_import_skipped",
    );
    expect(skipCall![0].targetId).toBe("unknown-hs");
  });
});

describe("runSeed — ConflictError createContact (idempotence absorb)", () => {
  it("1 contact déjà existant → skip silent + PAS d'audit contact_import_skipped", async () => {
    const deps = makeMockDeps();
    const contacts = [makeRawContact(0), makeRawContact(1)];
    (deps.getContactsInList as ReturnType<typeof vi.fn>).mockResolvedValue({
      contacts,
      nextCursor: undefined,
      hasMore: false,
    });

    (deps.createContact as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => ({ contactId: "hs_med_0" }))
      .mockImplementationOnce(async () => {
        throw new ConflictError({
          message: "createContact: contact already exists for this hubspotId",
          context: {
            op: "createContact",
            reason: "contact_already_exists",
            hubspotId: "hs_med_1",
          },
        });
      });

    const stats = await runSeed(VALID_INPUT, deps);
    expect(stats.createdCount).toBe(1);
    expect(stats.skippedAlreadyExistsCount).toBe(1);
    expect(stats.skippedMapperErrorCount).toBe(0);

    // PAS d'audit contact_import_skipped pour la ConflictError
    const skipCalls = (deps.appendAuditLog as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0].action === "contact_import_skipped",
    );
    expect(skipCalls).toHaveLength(0);

    // MAIS l'audit contact_imported_from_hubspot pour le 1er contact OK
    const importedCalls = (deps.appendAuditLog as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0].action === "contact_imported_from_hubspot",
    );
    expect(importedCalls).toHaveLength(1);
  });
});

describe("runSeed — autre erreur createContact (Firestore quota/timeout)", () => {
  it("erreur inattendue post-mapper → audit contact_import_skipped reason=create_failed + continue", async () => {
    const deps = makeMockDeps();
    (deps.getContactsInList as ReturnType<typeof vi.fn>).mockResolvedValue({
      contacts: [makeRawContact(0), makeRawContact(1)],
      nextCursor: undefined,
      hasMore: false,
    });

    const firestoreErr = new ExternalServiceError({
      message: "Firestore quota exceeded",
      context: { op: "createContact" },
    });
    (deps.createContact as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => {
        throw firestoreErr;
      })
      .mockImplementationOnce(async () => ({ contactId: "hs_med_1" }));

    const stats = await runSeed(VALID_INPUT, deps);
    expect(stats.createdCount).toBe(1);
    expect(stats.skippedMapperErrorCount).toBe(1);

    const skipCall = (deps.appendAuditLog as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0].action === "contact_import_skipped",
    );
    expect(skipCall).toBeDefined();
    expect(skipCall![0].payload).toMatchObject({
      reason: "create_failed",
      errorCode: "EXTERNAL_SERVICE",
      errorKind: "ExternalServiceError",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runSeed — propagation erreurs SDK (anti-absorption silencieuse)
// ─────────────────────────────────────────────────────────────────────────────

describe("runSeed — propagation SDK errors", () => {
  it("getContactsInList throw ExternalServiceError → propage telle quelle", async () => {
    const deps = makeMockDeps();
    (deps.getContactsInList as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ExternalServiceError({
        message: "HubSpot 401",
        context: { op: "getContactsInList" },
      }),
    );

    await expect(runSeed(VALID_INPUT, deps)).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("appendAuditLog throw → propage (anti-corruption forensic)", async () => {
    const deps = makeMockDeps();
    (deps.appendAuditLog as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ExternalServiceError({
        message: "Firestore down",
        context: {},
      }),
    );

    await expect(runSeed(VALID_INPUT, deps)).rejects.toBeInstanceOf(ExternalServiceError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotence — 2 runs successifs sur même liste = même résultats
// ─────────────────────────────────────────────────────────────────────────────

describe("runSeed — idempotence", () => {
  it("2 runs successifs sur même liste = même stats (sauf durationMs)", async () => {
    // 1er run : 2 contacts créés, 0 already_exists
    const deps1 = makeMockDeps();
    const contacts = [makeRawContact(0), makeRawContact(1)];
    (deps1.getContactsInList as ReturnType<typeof vi.fn>).mockResolvedValue({
      contacts,
      nextCursor: undefined,
      hasMore: false,
    });
    const stats1 = await runSeed(VALID_INPUT, deps1);

    // 2e run : tous les contacts existent déjà (ConflictError) → 0 créés, 2 already_exists
    const deps2 = makeMockDeps();
    (deps2.getContactsInList as ReturnType<typeof vi.fn>).mockResolvedValue({
      contacts,
      nextCursor: undefined,
      hasMore: false,
    });
    (deps2.createContact as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new ConflictError({
        message: "exists",
        context: { reason: "contact_already_exists", hubspotId: "x" },
      });
    });
    const stats2 = await runSeed(VALID_INPUT, deps2);

    // Sentinelle idempotence : total processed = total fetched (peu importe la voie)
    expect(stats1.createdCount + stats1.skippedAlreadyExistsCount).toBe(2);
    expect(stats2.createdCount + stats2.skippedAlreadyExistsCount).toBe(2);
    expect(stats2.skippedAlreadyExistsCount).toBe(2);
    expect(stats2.createdCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processContact — tests unitaires isolés
// ─────────────────────────────────────────────────────────────────────────────

describe("processContact — outcomes unitaires", () => {
  it("happy path → outcome 'created' + 1 createContact + 1 audit", async () => {
    const deps = makeMockDeps();
    const raw = makeRawContact(0);
    const outcome = await processContact(raw, "hubspot-list-1234", "1234", deps, false);
    expect(outcome).toBe("created");
    expect(deps.createContact).toHaveBeenCalledTimes(1);
    expect(deps.appendAuditLog).toHaveBeenCalledTimes(1);
  });

  it("ConflictError → outcome 'already_exists' + 0 audit", async () => {
    const deps = makeMockDeps();
    (deps.createContact as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new ConflictError({
        message: "exists",
        context: { reason: "contact_already_exists", hubspotId: "x" },
      });
    });

    const outcome = await processContact(
      makeRawContact(0),
      "hubspot-list-1234",
      "1234",
      deps,
      false,
    );
    expect(outcome).toBe("already_exists");
    expect(deps.appendAuditLog).not.toHaveBeenCalled();
  });

  it("mapper ValidationError → outcome 'skipped_mapper' + 1 audit contact_import_skipped", async () => {
    const deps = makeMockDeps();
    (deps.mapHubSpotContactToFirestoreContact as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => {
        throw new ValidationError({
          message: "fail",
          context: { invalidField: "phone" },
        });
      },
    );

    const outcome = await processContact(
      makeRawContact(0),
      "hubspot-list-1234",
      "1234",
      deps,
      false,
    );
    expect(outcome).toBe("skipped_mapper");
    expect(deps.createContact).not.toHaveBeenCalled();
    expect(deps.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "contact_import_skipped" }),
    );
  });

  it("dry-run + happy path → outcome 'created' + 0 createContact + 0 audit", async () => {
    const deps = makeMockDeps();
    const outcome = await processContact(
      makeRawContact(0),
      "hubspot-list-1234",
      "1234",
      deps,
      true,
    );
    expect(outcome).toBe("created");
    expect(deps.createContact).not.toHaveBeenCalled();
    expect(deps.appendAuditLog).not.toHaveBeenCalled();
  });

  it("autre erreur createContact (Firestore down) → outcome 'skipped_create_error' + audit", async () => {
    const deps = makeMockDeps();
    (deps.createContact as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new ExternalServiceError({
        message: "Firestore down",
        context: {},
      });
    });

    const outcome = await processContact(
      makeRawContact(0),
      "hubspot-list-1234",
      "1234",
      deps,
      false,
    );
    expect(outcome).toBe("skipped_create_error");
    expect(deps.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contact_import_skipped",
        payload: expect.objectContaining({ reason: "create_failed" }),
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Anti-fuite PII — sentinelle exhaustive
// ─────────────────────────────────────────────────────────────────────────────

describe("runSeed — anti-fuite PII (sentinelle critique)", () => {
  it("AUCUN payload audit ne contient firstName/lastName/phone/email brut", async () => {
    const deps = makeMockDeps();
    const contacts = Array.from({ length: 3 }, (_, i) => makeRawContact(i));
    (deps.getContactsInList as ReturnType<typeof vi.fn>).mockResolvedValue({
      contacts,
      nextCursor: undefined,
      hasMore: false,
    });

    await runSeed(VALID_INPUT, deps);

    const allCalls = (deps.appendAuditLog as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of allCalls) {
      const serialized = JSON.stringify(call[0].payload);
      // PII directs
      expect(serialized).not.toContain("First0");
      expect(serialized).not.toContain("Last0");
      expect(serialized).not.toContain("+33612");
      expect(serialized).not.toContain("0612345678");
      expect(serialized).not.toMatch(/[\w.+-]+@[\w-]+\.[\w-]+/);
    }
  });
});
