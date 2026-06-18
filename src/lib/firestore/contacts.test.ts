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
import { ConflictError, InternalError, NotFoundError, ValidationError } from "@/lib/utils/errors";
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
  CONTACT_STATUS_VALUES,
  createContact,
  getContact,
  getContactByPhone,
  LIST_CONTACTS_DEFAULT_LIMIT,
  LIST_CONTACTS_MAX_LIMIT,
  listContacts,
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
    speciality: "Chirurgien-dentiste",
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

    it("date custom injectée via options.now → optedOutAt = date custom", async () => {
      await seedContact("contact_optout_4");
      const customDate = new Date("2026-03-15T10:30:00.000Z");
      // Signature évolutive S9.2.2.1 : `now` passe via `options.now`
      // (ancien 3e arg `now: Date` migré vers `options: { now?: Date }`).
      await markOptedOut("contact_optout_4", "manual", { now: customDate });

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
  // markOptedOut — variante étendue S9.2.2.1 (options.conversationId)
  // ───────────────────────────────────────────────────────────────────────

  describe("markOptedOut — variante étendue S9.2.2.1 (conversationId)", () => {
    const CONV_COLL = "conversations";

    /** Helper local — seed une conversation valide pour les tests opt-out. */
    async function seedConv(
      id: string,
      overrides: {
        status?:
          | "active"
          | "awaiting_reply"
          | "in_dialogue"
          | "qualified"
          | "handed_off"
          | "closed"
          | "opted_out"
          | "blocked";
        intent?: "INTERESSE" | "OBJECTION" | "NEUTRE" | "STOP" | "unknown";
        contactId?: string;
        campaignId?: string;
      } = {},
    ): Promise<void> {
      const now = Timestamp.now();
      await getAdminDb()
        .collection(CONV_COLL)
        .doc(id)
        .set({
          contactId: overrides.contactId ?? "contact_ext_1",
          campaignId: overrides.campaignId ?? "campaign_x",
          channel: "sms",
          status: overrides.status ?? "awaiting_reply",
          intent: overrides.intent ?? "unknown",
          messageCount: 1,
          outboundCount: 1,
          inboundCount: 0,
          followupCount: 0,
          createdAt: now,
          updatedAt: now,
        });
    }

    it("conversationId fourni → update contact + update conv atomique (intent=STOP, status=opted_out)", async () => {
      await seedContact("contact_ext_1");
      await seedConv("conv_ext_1", { contactId: "contact_ext_1" });

      await markOptedOut("contact_ext_1", "sms", {
        conversationId: "conv_ext_1",
        intent: "STOP",
      });

      const contact = await getContact("contact_ext_1");
      expect(contact?.consent.optedOut).toBe(true);
      expect(contact?.status).toBe("opted_out");

      const convDoc = await getAdminDb().collection(CONV_COLL).doc("conv_ext_1").get();
      const conv = convDoc.data() as { intent: string; status: string };
      expect(conv.intent).toBe("STOP");
      expect(conv.status).toBe("opted_out");
    });

    it("conv en handed_off → throw ValidationError, contact NON mis à jour (atomicité)", async () => {
      await seedContact("contact_ext_2");
      await seedConv("conv_ext_2", {
        contactId: "contact_ext_2",
        status: "handed_off",
      });

      await expect(
        markOptedOut("contact_ext_2", "sms", {
          conversationId: "conv_ext_2",
          intent: "STOP",
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      // Atomicité : la guard transition rollback la tx → contact intact.
      const contact = await getContact("contact_ext_2");
      expect(contact?.consent.optedOut).toBe(false);
      expect(contact?.status).toBe("ready");
    });

    it("contact + conv déjà à l'état final → no-op total (0 nouvel audit)", async () => {
      // Seed un contact déjà opted_out + une conv déjà intent=STOP/status=opted_out.
      const now = Timestamp.now();
      await seedContact("contact_ext_3", {
        status: "opted_out",
        consent: {
          legitimateInterest:
            "Contact HubSpot Médéré importé le 2026-05-29, dentiste IDF, opt-in B2B.",
          optedOut: true,
          optedOutAt: now,
          optedOutChannel: "sms",
        },
      });
      await seedConv("conv_ext_3", {
        contactId: "contact_ext_3",
        status: "opted_out",
        intent: "STOP",
      });

      const auditsBefore = await countAuditDocs();
      await markOptedOut("contact_ext_3", "sms", {
        conversationId: "conv_ext_3",
        intent: "STOP",
      });
      const auditsAfter = await countAuditDocs();

      expect(auditsAfter).toBe(auditsBefore); // No-op total
    });

    it("contact déjà opt-out MAIS conv désync → update conv seul + audit avec reason=sync_conversation", async () => {
      // Scénario : un ancien run a marqué le contact opt-out sans synchroniser
      // la conv (cas legacy pré-S9.2.2.1). Le nouvel appel doit rattraper
      // la cohérence + poser un audit forensic distinct.
      const now = Timestamp.now();
      await seedContact("contact_ext_4", {
        status: "opted_out",
        consent: {
          legitimateInterest:
            "Contact HubSpot Médéré importé le 2026-05-29, dentiste IDF, opt-in B2B.",
          optedOut: true,
          optedOutAt: now,
          optedOutChannel: "sms",
        },
      });
      await seedConv("conv_ext_4", {
        contactId: "contact_ext_4",
        status: "in_dialogue", // ← pas opted_out (désync)
        intent: "INTERESSE",
      });

      const auditsBefore = await countAuditDocs();
      await markOptedOut("contact_ext_4", "sms", {
        conversationId: "conv_ext_4",
        intent: "STOP",
      });
      const auditsAfter = await countAuditDocs();

      // 1 audit posé pour le rattrapage forensic.
      expect(auditsAfter).toBe(auditsBefore + 1);

      const convDoc = await getAdminDb().collection(CONV_COLL).doc("conv_ext_4").get();
      const conv = convDoc.data() as { intent: string; status: string };
      expect(conv.intent).toBe("STOP");
      expect(conv.status).toBe("opted_out");

      // Sentinelle forensic : payload contient conversationId + reason.
      const auditDocs = await getAdminDb().collection(__AUDIT_COLLECTION_FOR_TESTS).get();
      const lastAudit = auditDocs.docs[auditDocs.docs.length - 1]?.data() as {
        action: string;
        payload: { channel: string; conversationId?: string; reason?: string };
      };
      expect(lastAudit.action).toBe("opt_out");
      expect(lastAudit.payload.conversationId).toBe("conv_ext_4");
      expect(lastAudit.payload.reason).toBe("sync_conversation");
    });

    it("payload audit contient conversationId si fourni (sentinelle forensic)", async () => {
      await seedContact("contact_ext_5");
      await seedConv("conv_ext_5", { contactId: "contact_ext_5" });

      await markOptedOut("contact_ext_5", "sms", {
        conversationId: "conv_ext_5",
        intent: "STOP",
      });

      const auditDocs = await getAdminDb().collection(__AUDIT_COLLECTION_FOR_TESTS).get();
      const lastAudit = auditDocs.docs[auditDocs.docs.length - 1]?.data() as {
        payload: { channel: string; conversationId?: string };
      };
      expect(lastAudit.payload.channel).toBe("sms");
      expect(lastAudit.payload.conversationId).toBe("conv_ext_5");
    });

    it("conversationId fourni mais conv inexistante → throw NotFoundError, contact NON mis à jour", async () => {
      await seedContact("contact_ext_6");

      await expect(
        markOptedOut("contact_ext_6", "sms", {
          conversationId: "conv_ghost",
          intent: "STOP",
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      // Atomicité : tx rollback → contact intact.
      const contact = await getContact("contact_ext_6");
      expect(contact?.consent.optedOut).toBe(false);
    });

    it("sans conversationId → comportement strictement identique à pré-S9.2.2.1 (rétrocompat)", async () => {
      // Sentinelle anti-régression : appel sans options se comporte comme avant.
      // Aucune lecture de conversation, aucune mention de conversationId dans audit.
      await seedContact("contact_ext_7");
      await markOptedOut("contact_ext_7", "sms");

      const contact = await getContact("contact_ext_7");
      expect(contact?.consent.optedOut).toBe(true);
      expect(contact?.status).toBe("opted_out");

      const auditDocs = await getAdminDb().collection(__AUDIT_COLLECTION_FOR_TESTS).get();
      const lastAudit = auditDocs.docs[auditDocs.docs.length - 1]?.data() as {
        payload: { channel: string; conversationId?: string; reason?: string };
      };
      expect(lastAudit.payload.channel).toBe("sms");
      // Sentinelle : pas de conversationId dans le payload quand options omis.
      expect(lastAudit.payload.conversationId).toBeUndefined();
      expect(lastAudit.payload.reason).toBeUndefined();
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

  // ───────────────────────────────────────────────────────────────────────
  // listContacts (S10.1.2.c)
  // ───────────────────────────────────────────────────────────────────────

  describe("listContacts (S10.1.2.c)", () => {
    /**
     * Seed N contacts avec status/campaignId paramétrables. createdAt
     * espacés de 1 seconde pour valider le tri DESC déterministe.
     */
    async function seedContacts(
      count: number,
      opts: {
        status?: Contact["status"];
        campaignId?: string;
        idPrefix?: string;
        baseTimeMs?: number;
      } = {},
    ): Promise<string[]> {
      const status = opts.status ?? "ready";
      const campaignId = opts.campaignId ?? "mvp-200-dentistes-idf";
      const idPrefix = opts.idPrefix ?? "hs_list";
      const baseTimeMs = opts.baseTimeMs ?? Date.now();
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const id = `${idPrefix}_${i}`;
        const ts = Timestamp.fromMillis(baseTimeMs + i * 1000);
        const contact = buildValidContact({
          hubspotId: id,
          status,
          campaignId,
          createdAt: ts,
          updatedAt: ts,
        });
        await getAdminDb().collection(__CONTACTS_COLLECTION_FOR_TESTS).doc(id).set(contact);
        ids.push(id);
      }
      return ids;
    }

    it("filtre status=ready + campaignId=X → retourne les bons contacts", async () => {
      await seedContacts(5, { status: "ready", campaignId: "campA" });
      await seedContacts(3, {
        status: "ready",
        campaignId: "campB",
        idPrefix: "hs_listB",
      });
      const res = await listContacts({
        filters: { status: "ready", campaignId: "campA" },
      });
      expect(res.contacts).toHaveLength(5);
      expect(res.contacts.every((c) => c.campaignId === "campA")).toBe(true);
      expect(res.hasMore).toBe(false);
      expect(res.nextCursor).toBeNull();
    });

    it("filtre status=ready SANS campaignId → retourne tous statuses ready toutes campagnes", async () => {
      await seedContacts(3, { status: "ready", campaignId: "campA" });
      await seedContacts(2, {
        status: "ready",
        campaignId: "campB",
        idPrefix: "hs_listB",
      });
      const res = await listContacts({ filters: { status: "ready" } });
      expect(res.contacts).toHaveLength(5);
      expect(res.contacts.every((c) => c.status === "ready")).toBe(true);
    });

    it("filtre status=opted_out → retourne 0 si aucun contact opted_out (cas filtré)", async () => {
      await seedContacts(5, { status: "ready" });
      const res = await listContacts({ filters: { status: "opted_out" } });
      expect(res.contacts).toEqual([]);
      expect(res.hasMore).toBe(false);
      expect(res.nextCursor).toBeNull();
    });

    it("default status = 'ready' quand filters.status absent", async () => {
      await seedContacts(3, { status: "ready" });
      await seedContacts(2, {
        status: "archived",
        idPrefix: "hs_listArch",
      });
      const res = await listContacts({});
      expect(res.contacts).toHaveLength(3);
      expect(res.contacts.every((c) => c.status === "ready")).toBe(true);
    });

    it("tri createdAt DESC → le plus récent en premier", async () => {
      const baseTimeMs = Date.now();
      await seedContacts(5, { baseTimeMs });
      const res = await listContacts({});
      // Indices 0..4 ont createdAt croissant. DESC → index 4 doit être en tête.
      expect(res.contacts[0]!.hubspotId).toBe("hs_list_4");
      expect(res.contacts[4]!.hubspotId).toBe("hs_list_0");
    });

    it("limit=10 + cursor → pagination cohérente (page 1 → page 2 pas de doublon)", async () => {
      await seedContacts(25);
      const page1 = await listContacts({ limit: 10 });
      expect(page1.contacts).toHaveLength(10);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await listContacts({
        limit: 10,
        cursor: page1.nextCursor!,
      });
      expect(page2.contacts).toHaveLength(10);
      expect(page2.hasMore).toBe(true);

      const ids1 = new Set(page1.contacts.map((c) => c.hubspotId));
      const ids2 = page2.contacts.map((c) => c.hubspotId);
      expect(ids2.every((id) => !ids1.has(id))).toBe(true);

      const page3 = await listContacts({
        limit: 10,
        cursor: page2.nextCursor!,
      });
      expect(page3.contacts).toHaveLength(5);
      expect(page3.hasMore).toBe(false);
      expect(page3.nextCursor).toBeNull();
    });

    it("limit > LIST_CONTACTS_MAX_LIMIT → ValidationError (anti-DoS)", async () => {
      await expect(listContacts({ limit: 200 })).rejects.toBeInstanceOf(ValidationError);
      await expect(listContacts({ limit: LIST_CONTACTS_MAX_LIMIT + 1 })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it("limit = LIST_CONTACTS_MAX_LIMIT → accepté (borne incluse)", async () => {
      await seedContacts(5);
      const res = await listContacts({ limit: LIST_CONTACTS_MAX_LIMIT });
      expect(res.contacts).toHaveLength(5);
    });

    it("limit < 1 → ValidationError", async () => {
      await expect(listContacts({ limit: 0 })).rejects.toBeInstanceOf(ValidationError);
      await expect(listContacts({ limit: -1 })).rejects.toBeInstanceOf(ValidationError);
    });

    it("status non whitelisté (anti-bypass) → ValidationError AVANT query", async () => {
      await expect(
        // @ts-expect-error - sentinelle anti-bypass enum status
        listContacts({ filters: { status: "foo" } }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        // @ts-expect-error - sentinelle anti-bypass : "superadmin" pas dans l'enum
        listContacts({ filters: { status: "superadmin" } }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("cursor inexistant → ValidationError (pas de fall-through silencieux page 1)", async () => {
      await seedContacts(3);
      await expect(listContacts({ cursor: "hs_does_not_exist" })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it("aucun résultat → {contacts: [], nextCursor: null, hasMore: false}", async () => {
      const res = await listContacts({ filters: { status: "ready" } });
      expect(res.contacts).toEqual([]);
      expect(res.nextCursor).toBeNull();
      expect(res.hasMore).toBe(false);
    });

    it("default limit = LIST_CONTACTS_DEFAULT_LIMIT quand omis", async () => {
      await seedContacts(LIST_CONTACTS_DEFAULT_LIMIT + 5);
      const res = await listContacts({});
      expect(res.contacts).toHaveLength(LIST_CONTACTS_DEFAULT_LIMIT);
      expect(res.hasMore).toBe(true);
    });

    it("ValidationError forensic NE contient JAMAIS le cursor brut (semi-sensible)", async () => {
      const SECRET_CURSOR = "hs_NEVER_LOG_THIS_ID";
      try {
        await listContacts({ cursor: SECRET_CURSOR });
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationError);
        const ctx = (e as ValidationError).context;
        expect(JSON.stringify(ctx)).not.toContain(SECRET_CURSOR);
      }
    });

    it("sentinelle CONTACT_SPECIALITY_VALUES.length === 21 (verrou anti-drift HubSpot)", async () => {
      // Toute modif de la liste (ajout/retrait d'une spécialité) doit
      // venir de HubSpot CRM Médéré, donc passer par Déthié → ce test
      // attrape la dérive silencieuse.
      const { CONTACT_SPECIALITY_VALUES } = await import("./contacts");
      expect(CONTACT_SPECIALITY_VALUES.length).toBe(21);
    });

    it("sentinelle CONTACT_STATUS_VALUES aligné sur ContactSchema.shape.status", () => {
      // Garde le contrat : si ContactSchema.shape.status évolue, ce test
      // attrape la dérive et force le dev à reviewer les impacts UI.
      expect(CONTACT_STATUS_VALUES).toEqual([
        "pending",
        "enriched",
        "ready",
        "in_conversation",
        "qualified",
        "opted_out",
        "archived",
      ]);
    });

    it("sentinelle LIST_CONTACTS_DEFAULT_LIMIT = 50 + MAX = 100 (verrouillé)", () => {
      expect(LIST_CONTACTS_DEFAULT_LIMIT).toBe(50);
      expect(LIST_CONTACTS_MAX_LIMIT).toBe(100);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // createContact (S10.1.2.c)
  // ───────────────────────────────────────────────────────────────────────

  describe("createContact (S10.1.2.c)", () => {
    it("happy path → persiste le doc avec tous champs + retourne contactId = hubspotId", async () => {
      const input = buildValidContact({ hubspotId: "hs_create_1" });
      const res = await createContact(input);
      expect(res.contactId).toBe("hs_create_1");

      const persisted = await getContact("hs_create_1");
      expect(persisted).not.toBeNull();
      expect(persisted?.firstName).toBe(input.firstName);
      expect(persisted?.phone.e164).toBe(input.phone.e164);
      expect(persisted?.status).toBe(input.status);
      expect(persisted?.campaignId).toBe(input.campaignId);
    });

    it("idempotence : 2x createContact même hubspotId → 2e throw ConflictError", async () => {
      const input = buildValidContact({ hubspotId: "hs_idem_1" });
      await createContact(input);
      await expect(createContact(input)).rejects.toBeInstanceOf(ConflictError);
    });

    it("ConflictError porte context.reason = 'contact_already_exists' + hubspotId", async () => {
      const input = buildValidContact({ hubspotId: "hs_idem_2" });
      await createContact(input);
      try {
        await createContact(input);
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ConflictError);
        const ctx = (e as ConflictError).context as {
          reason: string;
          hubspotId: string;
        };
        expect(ctx.reason).toBe("contact_already_exists");
        expect(ctx.hubspotId).toBe("hs_idem_2");
      }
    });

    it("firstName vide → ValidationError (Zod min(1))", async () => {
      const input = buildValidContact({
        hubspotId: "hs_bad_firstname",
        firstName: "",
      });
      await expect(createContact(input)).rejects.toBeInstanceOf(ValidationError);
    });

    it("phone.e164 invalide (sans +) → ValidationError", async () => {
      const input = buildValidContact({
        hubspotId: "hs_bad_phone",
        phone: {
          e164: "0612345678",
          raw: "06 12 34 56 78",
          type: "mobile",
          valid: true,
          lookupAt: Timestamp.now(),
        },
      });
      await expect(createContact(input)).rejects.toBeInstanceOf(ValidationError);
    });

    it("speciality non whitelistée → ValidationError", async () => {
      const input = buildValidContact({
        hubspotId: "hs_bad_speciality",
        // @ts-expect-error - test d'enum invalide
        speciality: "kine",
      });
      await expect(createContact(input)).rejects.toBeInstanceOf(ValidationError);
    });

    it("consent.legitimateInterest < 20 chars → ValidationError (invariant RGPD)", async () => {
      const input = buildValidContact({
        hubspotId: "hs_bad_legit",
        consent: {
          legitimateInterest: "trop court",
          optedOut: false,
        },
      });
      await expect(createContact(input)).rejects.toBeInstanceOf(ValidationError);
    });

    it("createdAt + updatedAt override serveur (anti-spoofing backdate)", async () => {
      // Caller tente de backdate à -100 jours pour bypasser rate limit.
      const backdated = Timestamp.fromMillis(Date.now() - 100 * 24 * 60 * 60 * 1000);
      const input = buildValidContact({
        hubspotId: "hs_backdate",
        createdAt: backdated,
        updatedAt: backdated,
      });

      const beforeMs = Date.now();
      await createContact(input);
      const persisted = await getContact("hs_backdate");
      const createdAtMs = (persisted!.createdAt as Timestamp).toMillis();

      // Le createdAt persisté doit être ≥ beforeMs (override serveur),
      // et clairement PAS le timestamp backdated.
      expect(createdAtMs).toBeGreaterThanOrEqual(beforeMs);
      expect(createdAtMs).not.toBe(backdated.toMillis());
    });

    it("hubspotId vide → ValidationError (min(1))", async () => {
      const input = buildValidContact({ hubspotId: "" });
      await expect(createContact(input)).rejects.toBeInstanceOf(ValidationError);
    });

    it("ValidationError forensic ne contient JAMAIS phone/email/nom brut", async () => {
      const SECRET_PHONE = "+33799988877";
      const input = buildValidContact({
        hubspotId: "hs_pii_leak_check",
        firstName: "", // déclenche ValidationError
        phone: {
          e164: SECRET_PHONE,
          raw: "07 99 98 88 77",
          type: "mobile",
          valid: true,
          lookupAt: Timestamp.now(),
        },
      });
      try {
        await createContact(input);
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationError);
        const ctx = (e as ValidationError).context;
        const serialized = JSON.stringify(ctx);
        expect(serialized).not.toContain(SECRET_PHONE);
        expect(serialized).not.toContain("07 99 98 88 77");
      }
    });
  });
});
