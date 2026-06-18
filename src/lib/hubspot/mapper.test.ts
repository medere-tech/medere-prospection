/**
 * Tests `mapper.ts` — pure function, pas de mock SDK nécessaire.
 *
 * Couverture : happy path complet, civilite mapping 4 paires + fallback
 * undefined, profession 21-enum + fingerprint anti-PII, phone priorité
 * mobilephone > phone + normalisation E.164 FR, idempotence,
 * sentinelles, anti-fuite PII dans errors.
 */
import { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";

import { CONTACT_SPECIALITY_VALUES } from "@/lib/firestore/contacts";
import { ValidationError } from "@/lib/utils/errors";
import type { Contact } from "@/types/contact";

import type { HubspotContactRaw } from "./contacts";
import {
  HUBSPOT_CIVILITE_MAP,
  HUBSPOT_DEFAULT_LEGITIMATE_INTEREST,
  mapHubSpotContactToFirestoreContact,
} from "./mapper";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const FIXED_NOW = Timestamp.fromMillis(1748524800000); // 2026-05-29T12:00:00Z
const CAMPAIGN_ID = "hubspot-list-1234";

function buildValidRaw(
  overrides: Partial<HubspotContactRaw["properties"]> = {},
): HubspotContactRaw {
  return {
    id: "hs_contact_999",
    properties: {
      firstname: "Jean",
      lastname: "Dupont",
      email: "jean.dupont@cabinet-dentaire.fr",
      phone: "0612345678",
      mobilephone: "0612345678",
      city: "Paris",
      zip: "75001",
      civilite: "Docteur",
      profession: "Chirurgien-dentiste",
      ...overrides,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy path complet
// ─────────────────────────────────────────────────────────────────────────────

describe("mapHubSpotContactToFirestoreContact — happy path", () => {
  it("contact complet → Contact Firestore valide tous champs", () => {
    const raw = buildValidRaw();
    const c = mapHubSpotContactToFirestoreContact({
      raw,
      campaignId: CAMPAIGN_ID,
      now: FIXED_NOW,
    });

    expect(c.hubspotId).toBe("hs_contact_999");
    expect(c.firstName).toBe("Jean");
    expect(c.lastName).toBe("Dupont");
    expect(c.civilite).toBe("Dr");
    expect(c.speciality).toBe("Chirurgien-dentiste");
    expect(c.city).toBe("Paris");
    expect(c.postalCode).toBe("75001");
    expect(c.email).toBe("jean.dupont@cabinet-dentaire.fr");
    expect(c.phone.e164).toBe("+33612345678");
    expect(c.phone.raw).toBe("0612345678");
    expect(c.phone.type).toBe("mobile");
    expect(c.phone.valid).toBe(true);
    expect(c.segment).toBe("unknown");
    expect(c.bloctelChecked).toBe(false);
    expect(c.bloctelOptOut).toBe(false);
    expect(c.consent.legitimateInterest).toBe(HUBSPOT_DEFAULT_LEGITIMATE_INTEREST);
    expect(c.consent.optedOut).toBe(false);
    expect(c.enrichment.source).toBe("hubspot");
    expect(c.enrichment.enrichedAt).toBe(FIXED_NOW);
    expect(c.status).toBe("ready");
    expect(c.campaignId).toBe(CAMPAIGN_ID);
    expect(c.createdAt).toBe(FIXED_NOW);
    expect(c.updatedAt).toBe(FIXED_NOW);
  });

  it("trim les whitespace sur firstname/lastname", () => {
    const raw = buildValidRaw({ firstname: "  Jean  ", lastname: "  Dupont  " });
    const c = mapHubSpotContactToFirestoreContact({
      raw,
      campaignId: CAMPAIGN_ID,
      now: FIXED_NOW,
    });
    expect(c.firstName).toBe("Jean");
    expect(c.lastName).toBe("Dupont");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Civilite — mapping strict + fallback undefined
// ─────────────────────────────────────────────────────────────────────────────

describe("Civilité HubSpot → ContactCivilite", () => {
  it.each([
    ["Docteur", "Dr"],
    ["Professeur", "Pr"],
    ["Monsieur", "M."],
    ["Madame", "Mme"],
  ] as const)("'%s' → '%s'", (hubspot, expected) => {
    const raw = buildValidRaw({ civilite: hubspot });
    const c = mapHubSpotContactToFirestoreContact({
      raw,
      campaignId: CAMPAIGN_ID,
      now: FIXED_NOW,
    });
    expect(c.civilite).toBe(expected);
  });

  it.each(["Mademoiselle", "Maître", "Dr", "M", ""])(
    "valeur non listée '%s' → civilite undefined (pas throw)",
    (value) => {
      const raw = buildValidRaw({ civilite: value });
      const c = mapHubSpotContactToFirestoreContact({
        raw,
        campaignId: CAMPAIGN_ID,
        now: FIXED_NOW,
      });
      expect(c.civilite).toBeUndefined();
    },
  );

  it("civilite null → undefined", () => {
    const raw = buildValidRaw({ civilite: null });
    const c = mapHubSpotContactToFirestoreContact({
      raw,
      campaignId: CAMPAIGN_ID,
      now: FIXED_NOW,
    });
    expect(c.civilite).toBeUndefined();
  });

  it("sentinelle HUBSPOT_CIVILITE_MAP : 4 paires exactes", () => {
    expect(HUBSPOT_CIVILITE_MAP).toEqual({
      Docteur: "Dr",
      Professeur: "Pr",
      Monsieur: "M.",
      Madame: "Mme",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Profession — 21-enum + fingerprint anti-PII
// ─────────────────────────────────────────────────────────────────────────────

describe("Profession HubSpot → speciality 21-enum", () => {
  it.each(CONTACT_SPECIALITY_VALUES)("valeur autorisée '%s' → mappée 1:1", (value) => {
    const raw = buildValidRaw({ profession: value });
    const c = mapHubSpotContactToFirestoreContact({
      raw,
      campaignId: CAMPAIGN_ID,
      now: FIXED_NOW,
    });
    expect(c.speciality).toBe(value);
  });

  it("profession non whitelistée 'Vétérinaire' → ValidationError", () => {
    const raw = buildValidRaw({ profession: "Vétérinaire" });
    expect(() =>
      mapHubSpotContactToFirestoreContact({
        raw,
        campaignId: CAMPAIGN_ID,
        now: FIXED_NOW,
      }),
    ).toThrow(ValidationError);
  });

  it("profession absente (null) → ValidationError", () => {
    const raw = buildValidRaw({ profession: null });
    expect(() =>
      mapHubSpotContactToFirestoreContact({
        raw,
        campaignId: CAMPAIGN_ID,
        now: FIXED_NOW,
      }),
    ).toThrow(ValidationError);
  });

  it("ValidationError fournit professionFingerprint (pas la valeur brute)", () => {
    const SECRET_PROFESSION = "Kinésithérapeute-secret-leaked";
    const raw = buildValidRaw({ profession: SECRET_PROFESSION });
    try {
      mapHubSpotContactToFirestoreContact({
        raw,
        campaignId: CAMPAIGN_ID,
        now: FIXED_NOW,
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      const ctx = (e as ValidationError).context as { professionFingerprint?: string };
      expect(ctx.professionFingerprint).toBeDefined();
      expect(ctx.professionFingerprint).toMatch(/^[0-9a-f]{8}$/);
      // PAS la valeur brute dans le context.
      expect(JSON.stringify(ctx)).not.toContain(SECRET_PROFESSION);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phone — priorité mobilephone > phone + normalisation E.164 FR
// ─────────────────────────────────────────────────────────────────────────────

describe("Phone normalisation", () => {
  it("mobilephone prioritaire sur phone si les deux présents", () => {
    const raw = buildValidRaw({
      mobilephone: "0664508687",
      phone: "0145678901",
    });
    const c = mapHubSpotContactToFirestoreContact({
      raw,
      campaignId: CAMPAIGN_ID,
      now: FIXED_NOW,
    });
    expect(c.phone.e164).toBe("+33664508687");
    expect(c.phone.raw).toBe("0664508687");
  });

  it("phone fallback si mobilephone absent", () => {
    const raw = buildValidRaw({ mobilephone: null, phone: "0145678901" });
    const c = mapHubSpotContactToFirestoreContact({
      raw,
      campaignId: CAMPAIGN_ID,
      now: FIXED_NOW,
    });
    expect(c.phone.e164).toBe("+33145678901");
  });

  it("phone fallback si mobilephone vide", () => {
    const raw = buildValidRaw({ mobilephone: "", phone: "0145678901" });
    const c = mapHubSpotContactToFirestoreContact({
      raw,
      campaignId: CAMPAIGN_ID,
      now: FIXED_NOW,
    });
    expect(c.phone.e164).toBe("+33145678901");
  });

  it.each([
    ["662491290", "+33662491290"], // national sans 0 → +33 prepend
    ["0664508687", "+33664508687"], // national avec 0
    ["+33662491290", "+33662491290"], // déjà E.164
    ["+33 6 62 49 12 90", "+33662491290"], // avec espaces
    ["06.64.50.86.87", "+33664508687"], // avec points
  ])("normalise '%s' → '%s'", (input, expected) => {
    const raw = buildValidRaw({ mobilephone: input, phone: null });
    const c = mapHubSpotContactToFirestoreContact({
      raw,
      campaignId: CAMPAIGN_ID,
      now: FIXED_NOW,
    });
    expect(c.phone.e164).toBe(expected);
  });

  it("phone NI mobilephone → ValidationError", () => {
    const raw = buildValidRaw({ mobilephone: null, phone: null });
    expect(() =>
      mapHubSpotContactToFirestoreContact({
        raw,
        campaignId: CAMPAIGN_ID,
        now: FIXED_NOW,
      }),
    ).toThrow(ValidationError);
  });

  it("phone non normalisable (ex: 'abc') → ValidationError", () => {
    const raw = buildValidRaw({ mobilephone: "abc-not-a-phone" });
    expect(() =>
      mapHubSpotContactToFirestoreContact({
        raw,
        campaignId: CAMPAIGN_ID,
        now: FIXED_NOW,
      }),
    ).toThrow(ValidationError);
  });

  it("ValidationError NE contient PAS le numéro brut (anti-PII)", () => {
    // String volontairement non-parseable par libphonenumber : pas de
    // séquence de chiffres FR-compatible. "abc" ne survit pas au parse.
    const SECRET_PHONE = "totally-secret-not-a-phone-PII-leak";
    const raw = buildValidRaw({ mobilephone: SECRET_PHONE, phone: null });
    try {
      mapHubSpotContactToFirestoreContact({
        raw,
        campaignId: CAMPAIGN_ID,
        now: FIXED_NOW,
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      const ctx = (e as ValidationError).context;
      expect(JSON.stringify(ctx)).not.toContain(SECRET_PHONE);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Required fields — firstname / lastname / hubspotId / campaignId
// ─────────────────────────────────────────────────────────────────────────────

describe("Required fields", () => {
  it("firstname absent → ValidationError sans firstname dans context", () => {
    const SECRET_FIRSTNAME = "Léa-PII-do-not-log";
    const raw = buildValidRaw({ firstname: null });
    try {
      mapHubSpotContactToFirestoreContact({
        raw,
        campaignId: CAMPAIGN_ID,
        now: FIXED_NOW,
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      const ctx = (e as ValidationError).context;
      expect(JSON.stringify(ctx)).not.toContain(SECRET_FIRSTNAME);
    }
  });

  it("firstname vide (only spaces) → ValidationError", () => {
    const raw = buildValidRaw({ firstname: "   " });
    expect(() =>
      mapHubSpotContactToFirestoreContact({
        raw,
        campaignId: CAMPAIGN_ID,
        now: FIXED_NOW,
      }),
    ).toThrow(ValidationError);
  });

  it("lastname absent → ValidationError", () => {
    const raw = buildValidRaw({ lastname: null });
    expect(() =>
      mapHubSpotContactToFirestoreContact({
        raw,
        campaignId: CAMPAIGN_ID,
        now: FIXED_NOW,
      }),
    ).toThrow(ValidationError);
  });

  it("raw.id absent → ValidationError", () => {
    const raw = { ...buildValidRaw(), id: "" };
    expect(() =>
      mapHubSpotContactToFirestoreContact({
        raw,
        campaignId: CAMPAIGN_ID,
        now: FIXED_NOW,
      }),
    ).toThrow(ValidationError);
  });

  it("campaignId vide → ValidationError", () => {
    const raw = buildValidRaw();
    expect(() =>
      mapHubSpotContactToFirestoreContact({
        raw,
        campaignId: "",
        now: FIXED_NOW,
      }),
    ).toThrow(ValidationError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Optional fields
// ─────────────────────────────────────────────────────────────────────────────

describe("Optional fields — email, city, zip", () => {
  it("email absent → undefined dans Contact", () => {
    const raw = buildValidRaw({ email: null });
    const c = mapHubSpotContactToFirestoreContact({
      raw,
      campaignId: CAMPAIGN_ID,
      now: FIXED_NOW,
    });
    expect(c.email).toBeUndefined();
  });

  it("city absent → '' (compatible ContactSchema z.string())", () => {
    const raw = buildValidRaw({ city: null });
    const c = mapHubSpotContactToFirestoreContact({
      raw,
      campaignId: CAMPAIGN_ID,
      now: FIXED_NOW,
    });
    expect(c.city).toBe("");
  });

  it("zip absent → '' (compatible ContactSchema z.string())", () => {
    const raw = buildValidRaw({ zip: null });
    const c = mapHubSpotContactToFirestoreContact({
      raw,
      campaignId: CAMPAIGN_ID,
      now: FIXED_NOW,
    });
    expect(c.postalCode).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure function & idempotence
// ─────────────────────────────────────────────────────────────────────────────

describe("Pure function & idempotence", () => {
  it("idempotence : même raw + campaignId + now → même output", () => {
    const raw = buildValidRaw();
    const c1 = mapHubSpotContactToFirestoreContact({
      raw,
      campaignId: CAMPAIGN_ID,
      now: FIXED_NOW,
    });
    const c2 = mapHubSpotContactToFirestoreContact({
      raw,
      campaignId: CAMPAIGN_ID,
      now: FIXED_NOW,
    });
    expect(c1).toEqual(c2);
  });

  it("pas de mutation du raw input", () => {
    const raw = buildValidRaw();
    const snapshot = JSON.parse(JSON.stringify(raw));
    mapHubSpotContactToFirestoreContact({
      raw,
      campaignId: CAMPAIGN_ID,
      now: FIXED_NOW,
    });
    expect(raw).toEqual(snapshot);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sentinelles
// ─────────────────────────────────────────────────────────────────────────────

describe("Sentinelles mapper.ts", () => {
  it("HUBSPOT_DEFAULT_LEGITIMATE_INTEREST >= 20 chars (invariant RGPD)", () => {
    expect(HUBSPOT_DEFAULT_LEGITIMATE_INTEREST.length).toBeGreaterThanOrEqual(20);
  });

  it("HUBSPOT_DEFAULT_LEGITIMATE_INTEREST contient le terme 'Médéré'", () => {
    expect(HUBSPOT_DEFAULT_LEGITIMATE_INTEREST).toContain("Médéré");
  });

  it("sortie matche shape ContactSchema (parse strict)", async () => {
    // Sentinelle : si ContactSchema évolue, ce test détecte la dérive.
    const { ContactSchema } = await import("@/lib/firestore/contacts");
    const raw = buildValidRaw();
    const c = mapHubSpotContactToFirestoreContact({
      raw,
      campaignId: CAMPAIGN_ID,
      now: FIXED_NOW,
    });
    const result = ContactSchema.safeParse(c);
    expect(result.success).toBe(true);
  });

  it("Contact a tous les champs minimum requis (sentinelle structure)", () => {
    const raw = buildValidRaw();
    const c: Contact = mapHubSpotContactToFirestoreContact({
      raw,
      campaignId: CAMPAIGN_ID,
      now: FIXED_NOW,
    });
    // Vérifie la présence (pas la valeur) de tous les champs Contact.
    expect(c.hubspotId).toBeDefined();
    expect(c.firstName).toBeDefined();
    expect(c.lastName).toBeDefined();
    expect(c.speciality).toBeDefined();
    expect(c.city).toBeDefined();
    expect(c.postalCode).toBeDefined();
    expect(c.phone).toBeDefined();
    expect(c.segment).toBeDefined();
    expect(c.bloctelChecked).toBeDefined();
    expect(c.bloctelOptOut).toBeDefined();
    expect(c.consent).toBeDefined();
    expect(c.enrichment).toBeDefined();
    expect(c.status).toBeDefined();
    expect(c.campaignId).toBeDefined();
    expect(c.createdAt).toBeDefined();
    expect(c.updatedAt).toBeDefined();
  });
});
