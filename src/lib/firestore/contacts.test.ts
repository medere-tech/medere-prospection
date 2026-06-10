/**
 * Tests contacts.ts contre l'emulator. Couvre :
 *   - `getContact` : exist + valide / inexistant (null) / corrompu (throw)
 *   - `markOptedOut` : 1er appel / idempotence / atomicité audit
 *                      / contact inexistant / now custom
 *   - `updateContactStatus` : champs autorisés / multi-champs / fields vide
 *                             / atomicité audit / contact inexistant
 *                             / type-level @ts-expect-error sur champs bannis
 */
import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetEnvCacheForTests } from "@/lib/security/env";
import { InternalError, NotFoundError, ValidationError } from "@/lib/utils/errors";
import type { Contact } from "@/types/contact";

import {
  __APP_NAME_FOR_TESTS,
  __getAppByName,
  __resetFirestoreAdminForTests,
  getAdminDb,
} from "./admin";
import { __AUDIT_COLLECTION_FOR_TESTS } from "./audit-log";
import {
  __CONTACTS_COLLECTION_FOR_TESTS,
  getContact,
  getContactByPhone,
  markOptedOut,
  updateContactStatus,
} from "./contacts";

const PEPPER = "a".repeat(64);

/**
 * Helper : seed un contact propre dans l'emulator. Pas d'API publique
 * `createContact` en S6.3 → on écrit direct via Admin SDK.
 */
function buildValidContact(overrides: Partial<Contact> = {}): Contact {
  const now = Timestamp.now();
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

async function seedContact(id: string, overrides: Partial<Contact> = {}): Promise<Contact> {
  const contact = buildValidContact(overrides);
  await getAdminDb().collection(__CONTACTS_COLLECTION_FOR_TESTS).doc(id).set(contact);
  return contact;
}

async function countAuditDocs(): Promise<number> {
  const snap = await getAdminDb().collection(__AUDIT_COLLECTION_FOR_TESTS).get();
  return snap.size;
}

async function fullReset() {
  __resetFirestoreAdminForTests();
  const app = __getAppByName(__APP_NAME_FOR_TESTS);
  if (app) {
    await deleteApp(app);
  }
  __resetEnvCacheForTests();
}

describe("contacts.ts", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_PII_PEPPER", PEPPER);
    await fullReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fullReset();
  });

  // ───────────────────────────────────────────────────────────────────────
  // getContact
  // ───────────────────────────────────────────────────────────────────────

  describe("getContact", () => {
    it("doc présent + Zod valide → renvoie un Contact typé", async () => {
      const seeded = await seedContact("contact_1");
      const got = await getContact("contact_1");
      expect(got).not.toBeNull();
      expect(got?.hubspotId).toBe(seeded.hubspotId);
      expect(got?.phone.e164).toBe("+33612345678");
      expect(got?.status).toBe("ready");
    });

    it("doc inexistant → renvoie null (cas d'absence légitime)", async () => {
      const got = await getContact("contact_does_not_exist");
      expect(got).toBeNull();
    });

    it("doc présent mais corrompu (champ requis manquant) → throw ValidationError", async () => {
      // On écrit un doc qui rate `phone` (requis).
      await getAdminDb()
        .collection(__CONTACTS_COLLECTION_FOR_TESTS)
        .doc("contact_broken")
        .set({ hubspotId: "hs_1" });
      await expect(getContact("contact_broken")).rejects.toBeInstanceOf(ValidationError);
    });

    it("doc présent mais legitimateInterest < 20 chars → throw ValidationError (fail-fast strict)", async () => {
      const broken = buildValidContact({
        consent: {
          legitimateInterest: "trop court",
          optedOut: false,
        },
      });
      await getAdminDb()
        .collection(__CONTACTS_COLLECTION_FOR_TESTS)
        .doc("contact_short_legit")
        .set(broken);
      await expect(getContact("contact_short_legit")).rejects.toBeInstanceOf(ValidationError);
    });

    it("ValidationError porte un context.contactId pour le forensic", async () => {
      await getAdminDb()
        .collection(__CONTACTS_COLLECTION_FOR_TESTS)
        .doc("contact_X")
        .set({ hubspotId: "" }); // empty string → Zod min(1) fail
      try {
        await getContact("contact_X");
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationError);
        const ctx = (e as ValidationError).context as { contactId: string };
        expect(ctx.contactId).toBe("contact_X");
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // getContactByPhone (S9.1)
  // ───────────────────────────────────────────────────────────────────────

  describe("getContactByPhone (S9.1)", () => {
    it("trouve un contact unique par phone.e164 → retourne le Contact parsé", async () => {
      await seedContact("contact_byphone_1", {
        hubspotId: "hs_byphone_1",
        phone: {
          e164: "+33611112222",
          raw: "06 11 11 22 22",
          type: "mobile",
          valid: true,
          lookupAt: Timestamp.now(),
        },
      });
      const got = await getContactByPhone("+33611112222");
      expect(got).not.toBeNull();
      expect(got?.hubspotId).toBe("hs_byphone_1");
      expect(got?.phone.e164).toBe("+33611112222");
    });

    it("aucun contact → retourne null (PAS NotFoundError, cohérent getContact)", async () => {
      // Sentinelle sémantique : null pour absence légitime, identique à
      // getContact. Le caller process-reply (S9.2) traite null en branche
      // "reply_dropped" (PS inconnu).
      const got = await getContactByPhone("+33699999999");
      expect(got).toBeNull();
    });

    it("input format INVALIDE (leading zero après +) → throw ValidationError AVANT query", async () => {
      // Defense-in-depth Q2 brief Déthié S9.1 : régex E.164 STRICTE
      // refuse leading zero. `+0612345678` n'a aucune sémantique ITU-T E.164
      // → ValidationError sans même querier Firestore.
      await expect(getContactByPhone("+0612345678")).rejects.toBeInstanceOf(ValidationError);
    });

    it("input format INVALIDE (national sans +) → throw ValidationError", async () => {
      await expect(getContactByPhone("0612345678")).rejects.toBeInstanceOf(ValidationError);
    });

    it("input format INVALIDE (trop court) → throw ValidationError", async () => {
      await expect(getContactByPhone("+331")).rejects.toBeInstanceOf(ValidationError);
    });

    it("ValidationError contient inputLength mais PAS le téléphone (anti-PII)", async () => {
      try {
        await getContactByPhone("+0612345678");
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationError);
        const ctx = (e as ValidationError).context as { op: string; inputLength: number };
        expect(ctx.op).toBe("getContactByPhone");
        expect(ctx.inputLength).toBe(11);
        // Sentinelle anti-PII : le téléphone ne doit JAMAIS apparaître
        // dans le context sérialisé.
        const serialized = JSON.stringify((e as ValidationError).context);
        expect(serialized).not.toContain("0612345678");
      }
    });

    it("invariant cassé (>1 contact même E.164) → throw InternalError, PAS de phone dans context", async () => {
      // Defense-in-depth Q1 brief Déthié S9.1. On corrompt sciemment la
      // base avec 2 contacts qui partagent le même phone.e164. La fonction
      // doit refuser de choisir arbitrairement.
      const samePhone = {
        e164: "+33611113333",
        raw: "06 11 11 33 33",
        type: "mobile" as const,
        valid: true,
        lookupAt: Timestamp.now(),
      };
      await seedContact("contact_dup_1", { hubspotId: "hs_dup_1", phone: samePhone });
      await seedContact("contact_dup_2", { hubspotId: "hs_dup_2", phone: samePhone });

      try {
        await getContactByPhone("+33611113333");
        expect.fail("should have thrown InternalError");
      } catch (e) {
        expect(e).toBeInstanceOf(InternalError);
        const ctx = (e as InternalError).context as { op: string; count: number };
        expect(ctx.op).toBe("getContactByPhone");
        expect(ctx.count).toBeGreaterThanOrEqual(2);
        // Sentinelle anti-PII renforcée : ni le phone, ni les contactIds
        // (semi-sensibles).
        const serialized = JSON.stringify((e as InternalError).context);
        expect(serialized).not.toContain("0611113333");
        expect(serialized).not.toContain("33611113333");
        expect(serialized).not.toContain("hs_dup_1");
        expect(serialized).not.toContain("hs_dup_2");
      }
    });

    it("doc trouvé mais corrompu (Zod fail) → throw ValidationError forensic contactId", async () => {
      // On contourne le seed normal et on écrit un doc partiel direct.
      // phone.e164 correct (pour matcher la query) mais legitimateInterest
      // trop court → Zod fail au parsing.
      await getAdminDb()
        .collection(__CONTACTS_COLLECTION_FOR_TESTS)
        .doc("contact_byphone_corrupt")
        .set({
          hubspotId: "hs_corrupt",
          phone: {
            e164: "+33611114444",
            raw: "06 11 11 44 44",
            type: "mobile",
            valid: true,
            lookupAt: Timestamp.now(),
          },
          // pas de firstName/lastName/speciality/etc → Zod throw.
        });
      await expect(getContactByPhone("+33611114444")).rejects.toBeInstanceOf(ValidationError);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // markOptedOut
  // ───────────────────────────────────────────────────────────────────────

  describe("markOptedOut", () => {
    it("1er opt-out via SMS → contact updaté + 1 audit dans la MÊME tx", async () => {
      await seedContact("contact_optout_1");
      const before = await countAuditDocs();
      await markOptedOut("contact_optout_1", "sms");

      const contact = await getContact("contact_optout_1");
      expect(contact?.consent.optedOut).toBe(true);
      expect(contact?.consent.optedOutChannel).toBe("sms");
      expect(contact?.consent.optedOutAt).toBeInstanceOf(Timestamp);
      expect(contact?.status).toBe("opted_out");

      const after = await countAuditDocs();
      expect(after).toBe(before + 1);
    });

    it("idempotence : 2e appel même source → no-op (0 nouvel audit)", async () => {
      await seedContact("contact_optout_2");
      await markOptedOut("contact_optout_2", "sms");
      const audits1 = await countAuditDocs();

      await markOptedOut("contact_optout_2", "sms");
      const audits2 = await countAuditDocs();
      expect(audits2).toBe(audits1);
    });

    it("idempotence stricte : 2e appel SOURCE DIFFÉRENTE → no-op aussi (KISS MVP)", async () => {
      await seedContact("contact_optout_3");
      await markOptedOut("contact_optout_3", "sms");
      const audits1 = await countAuditDocs();

      await markOptedOut("contact_optout_3", "dashboard");
      const audits2 = await countAuditDocs();
      expect(audits2).toBe(audits1);

      // Le canal initial reste sms — pas réécrasé par "dashboard".
      const contact = await getContact("contact_optout_3");
      expect(contact?.consent.optedOutChannel).toBe("sms");
    });

    it("contact inexistant → throw NotFoundError", async () => {
      await expect(markOptedOut("contact_ghost", "sms")).rejects.toBeInstanceOf(NotFoundError);
    });

    it("date custom injectée → optedOutAt = date custom", async () => {
      await seedContact("contact_optout_4");
      const customDate = new Date("2026-03-15T10:30:00.000Z");
      await markOptedOut("contact_optout_4", "manual", customDate);

      const contact = await getContact("contact_optout_4");
      expect(contact?.consent.optedOutAt).toBeInstanceOf(Timestamp);
      const tsMs = (contact?.consent.optedOutAt as Timestamp).toMillis();
      expect(tsMs).toBe(customDate.getTime());
    });

    it("audit log contient channel mais PAS le téléphone du contact", async () => {
      await seedContact("contact_optout_5");
      await markOptedOut("contact_optout_5", "dashboard");

      const auditDocs = await getAdminDb().collection(__AUDIT_COLLECTION_FOR_TESTS).get();
      const auditPayloads = auditDocs.docs.map((d) => JSON.stringify(d.data().payload));
      expect(auditPayloads.some((p) => p.includes("dashboard"))).toBe(true);
      // Sentinelle : aucun téléphone dans les payloads audit.
      expect(auditPayloads.every((p) => !p.includes("612345678"))).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // updateContactStatus
  // ───────────────────────────────────────────────────────────────────────

  describe("updateContactStatus", () => {
    it("update status → champ modifié + 1 audit log", async () => {
      await seedContact("contact_status_1", { status: "ready" });
      await updateContactStatus("contact_status_1", { status: "in_conversation" });

      const contact = await getContact("contact_status_1");
      expect(contact?.status).toBe("in_conversation");

      const audits = await getAdminDb().collection(__AUDIT_COLLECTION_FOR_TESTS).get();
      expect(audits.size).toBe(1);
      expect(audits.docs[0]?.data().action).toBe("status_changed");
    });

    it("update assignedTo → champ modifié", async () => {
      await seedContact("contact_status_2");
      await updateContactStatus("contact_status_2", {
        assignedTo: "U05UVHGBURX",
      });

      const contact = await getContact("contact_status_2");
      expect(contact?.assignedTo).toBe("U05UVHGBURX");
    });

    it("update multi-champs → 1 SEUL audit log (1 tx)", async () => {
      await seedContact("contact_status_3");
      await updateContactStatus("contact_status_3", {
        status: "qualified",
        assignedTo: "U01DPF08TQV",
      });

      const audits = await getAdminDb().collection(__AUDIT_COLLECTION_FOR_TESTS).get();
      expect(audits.size).toBe(1);

      // Le payload audit contient les NOMS des champs modifiés (pas les valeurs).
      const payload = audits.docs[0]?.data().payload as { fields: string[] };
      expect(payload.fields.sort()).toEqual(["assignedTo", "status"]);
    });

    it("fields vide ({}) → throw ValidationError AVANT la tx (pas d'audit créé)", async () => {
      await seedContact("contact_status_4");
      const auditsBefore = await countAuditDocs();
      await expect(updateContactStatus("contact_status_4", {})).rejects.toBeInstanceOf(
        ValidationError,
      );
      const auditsAfter = await countAuditDocs();
      expect(auditsAfter).toBe(auditsBefore);
    });

    it("contact inexistant → throw NotFoundError", async () => {
      await expect(
        updateContactStatus("contact_ghost", { status: "ready" }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("updatedAt est bumped à la transaction", async () => {
      const seeded = await seedContact("contact_status_5");
      const initialUpdated = (seeded.updatedAt as Timestamp).toMillis();
      // Petit décalage pour différencier les timestamps.
      await new Promise((r) => setTimeout(r, 20));

      await updateContactStatus("contact_status_5", { status: "archived" });
      const contact = await getContact("contact_status_5");
      const newUpdated = (contact?.updatedAt as Timestamp).toMillis();
      expect(newUpdated).toBeGreaterThan(initialUpdated);
    });

    // ─── Tests TYPE-LEVEL (compile-time defense via @ts-expect-error) ───
    //
    // Pattern S4 rate-limits : `@ts-expect-error` au-dessus d'un statement
    // qui DOIT produire EXACTEMENT 1 erreur TS. Si la ligne compile, le
    // directive est marqué "unused" et le tsc fail. Cela prouve que la
    // whitelist `UpdatableContactFields` est respectée au compile-time.
    //
    // On note volontairement le test `async () => {}` pour pouvoir mettre
    // `await` (cohérence avec les autres tests) mais on n'exécute pas les
    // appels — c'est de la défense compile-time uniquement, le runtime
    // n'est jamais atteint sur la branche `false`.

    it("type-level : phone interdit (identité immuable)", () => {
      const exercise = async () => {
        // @ts-expect-error — phone n'est pas dans UpdatableContactFields
        await updateContactStatus("x", { phone: "+33612345678" });
      };
      // On ne run pas exercise — le test prouve juste la compilation.
      expect(exercise).toBeDefined();
    });

    it("type-level : email interdit (identité immuable)", () => {
      const exercise = async () => {
        // @ts-expect-error — email n'est pas dans UpdatableContactFields
        await updateContactStatus("x", { email: "x@y.fr" });
      };
      expect(exercise).toBeDefined();
    });

    it("type-level : consent interdit (passe par markOptedOut)", () => {
      const exercise = async () => {
        // @ts-expect-error — consent n'est pas dans UpdatableContactFields
        await updateContactStatus("x", { consent: { optedOut: true } });
      };
      expect(exercise).toBeDefined();
    });

    it("type-level : hubspotId interdit (identifiant immuable)", () => {
      const exercise = async () => {
        // @ts-expect-error — hubspotId n'est pas dans UpdatableContactFields
        await updateContactStatus("x", { hubspotId: "hs_new" });
      };
      expect(exercise).toBeDefined();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // appendAuditLogTx — couverture de la variante transactionnelle
  // (les sentinelles PII complètes sont dans audit-log.test.ts)
  // ───────────────────────────────────────────────────────────────────────

  describe("appendAuditLogTx — variante transactionnelle (S6.3.2)", () => {
    it("propage AuditPiiError si le payload contient un téléphone en clair", async () => {
      const { AuditPiiError } = await import("@/lib/utils/errors");
      const { appendAuditLogTx } = await import("./audit-log");

      await expect(
        getAdminDb().runTransaction(async (tx) => {
          appendAuditLogTx(tx, {
            actorId: "system",
            actorType: "system",
            action: "compliance_check",
            targetType: "contact",
            targetId: "x",
            payload: { phone: "+33612345678" },
          });
        }),
      ).rejects.toBeInstanceOf(AuditPiiError);
    });

    it("propage ValidationError si l'action est hors enum", async () => {
      const { appendAuditLogTx } = await import("./audit-log");
      await expect(
        getAdminDb().runTransaction(async (tx) => {
          appendAuditLogTx(tx, {
            actorId: "system",
            actorType: "system",
            // @ts-expect-error - test d'enum invalide
            action: "not_a_real_action",
            targetType: "contact",
            targetId: "x",
            payload: {},
          });
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
