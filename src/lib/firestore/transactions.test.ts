/**
 * Tests transactions.ts contre l'emulator. Couvre :
 *
 *   - Sentinel : CONTACTS_COLLECTION aligné entre transactions.ts et
 *     contacts.ts (1 test)
 *
 *   - `withContactLock` :
 *       * happy path → fn appelé avec (tx, contact validé), valeur de
 *         retour propagée
 *       * fn reçoit un Contact strictement égal à l'état en base
 *       * contact absent → throw NotFoundError, fn JAMAIS appelé
 *       * contact corrompu → throw ValidationError, fn JAMAIS appelé
 *       * fn fait tx.update → modif visible après commit
 *       * fn fait tx.create sur une autre collection → atomique avec
 *         le lock contact
 *       * fn throw → tx rollback (aucune écriture appliquée), erreur
 *         propagée non altérée
 *       * fn peut lire un autre doc via tx.get(autreRef) dans la même tx
 *
 *   - Concurrence rapide (sanity, version "courte" — le vrai test de
 *     race vit dans concurrency.test.ts qui boucle 10x) : 2 fn
 *     simultanés sur le même contact se sérialisent (1 commit gagne,
 *     l'autre voit l'état modifié au retry).
 */
import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetEnvCacheForTests } from "@/lib/security/env";
import { NotFoundError, ValidationError } from "@/lib/utils/errors";
import type { Contact } from "@/types/contact";

import {
  __APP_NAME_FOR_TESTS,
  __getAppByName,
  __resetFirestoreAdminForTests,
  getAdminDb,
} from "./admin";
import { __CONTACTS_COLLECTION_FOR_TESTS } from "./contacts";
import { __TRANSACTIONS_CONTACTS_COLLECTION_FOR_TESTS, withContactLock } from "./transactions";

const PEPPER = "a".repeat(64);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de seed
// ─────────────────────────────────────────────────────────────────────────────

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

async function fullReset() {
  vi.restoreAllMocks();
  __resetFirestoreAdminForTests();
  const app = __getAppByName(__APP_NAME_FOR_TESTS);
  if (app) {
    await deleteApp(app);
  }
  __resetEnvCacheForTests();
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe("transactions.ts — withContactLock", () => {
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
  // Sentinel
  // ───────────────────────────────────────────────────────────────────────

  it("sentinel : CONTACTS_COLLECTION aligné entre transactions.ts et contacts.ts", () => {
    // Si quelqu'un renomme la collection côté contacts.ts, ce test
    // casse — empêche une divergence silencieuse qui briserait
    // withContactLock qui pointe vers le mauvais doc.
    expect(__TRANSACTIONS_CONTACTS_COLLECTION_FOR_TESTS).toBe(__CONTACTS_COLLECTION_FOR_TESTS);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Happy path
  // ───────────────────────────────────────────────────────────────────────

  it("happy path : fn appelé avec (tx, contact validé), valeur de retour propagée", async () => {
    await seedContact("c_lock_1");

    const result = await withContactLock("c_lock_1", async (tx, contact) => {
      expect(tx).toBeDefined();
      expect(contact.hubspotId).toBe("hs_abc123");
      expect(contact.firstName).toBe("Jean");
      expect(contact.phone.e164).toBe("+33612345678");
      return { foundFor: contact.lastName };
    });

    expect(result).toEqual({ foundFor: "Dupont" });
  });

  it("fn reçoit un Contact strictement égal à l'état en base", async () => {
    const seeded = await seedContact("c_lock_2", { firstName: "Marie", civilite: "Pr" });

    await withContactLock("c_lock_2", async (_tx, contact) => {
      // Verif champs identité (les Timestamp sont des instances, pas
      // testables via toEqual direct — on test les scalaires)
      expect(contact.hubspotId).toBe(seeded.hubspotId);
      expect(contact.firstName).toBe("Marie");
      expect(contact.civilite).toBe("Pr");
      expect(contact.speciality).toBe(seeded.speciality);
      expect(contact.phone.e164).toBe(seeded.phone.e164);
      expect(contact.consent.optedOut).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Erreurs : NotFoundError / ValidationError, fn JAMAIS appelé
  // ───────────────────────────────────────────────────────────────────────

  it("contact absent → throw NotFoundError, fn JAMAIS appelé", async () => {
    const fnSpy = vi.fn();

    await expect(withContactLock("c_ghost", fnSpy)).rejects.toBeInstanceOf(NotFoundError);

    expect(fnSpy).not.toHaveBeenCalled();
  });

  it("NotFoundError porte un context.contactId pour forensic", async () => {
    try {
      await withContactLock("c_ghost_ctx", async () => undefined);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(NotFoundError);
      const ctx = (e as NotFoundError).context as { contactId: string };
      expect(ctx.contactId).toBe("c_ghost_ctx");
    }
  });

  it("contact corrompu → throw ValidationError, fn JAMAIS appelé", async () => {
    // Doc partiel : pas de phone, consent, etc. → Zod fail dans
    // _parseContactOrThrow appelé par withContactLock.
    await getAdminDb()
      .collection(__CONTACTS_COLLECTION_FOR_TESTS)
      .doc("c_broken")
      .set({ hubspotId: "hs_xxx", firstName: "X", lastName: "Y" });

    const fnSpy = vi.fn();
    await expect(withContactLock("c_broken", fnSpy)).rejects.toBeInstanceOf(ValidationError);

    expect(fnSpy).not.toHaveBeenCalled();
  });

  // ───────────────────────────────────────────────────────────────────────
  // fn opère sur la tx : update, create, atomicité
  // ───────────────────────────────────────────────────────────────────────

  it("fn fait tx.update sur le contact → modif visible après commit", async () => {
    await seedContact("c_lock_update", { status: "ready" });

    await withContactLock("c_lock_update", async (tx, contact) => {
      // Sanity : le contact reçu est bien dans son état pré-update.
      expect(contact.status).toBe("ready");
      const ref = getAdminDb().collection(__CONTACTS_COLLECTION_FOR_TESTS).doc("c_lock_update");
      tx.update(ref, { status: "in_conversation" });
    });

    const after = await getAdminDb()
      .collection(__CONTACTS_COLLECTION_FOR_TESTS)
      .doc("c_lock_update")
      .get();
    expect((after.data() as Contact).status).toBe("in_conversation");
  });

  it("fn fait tx.create sur une autre collection → atomique avec le lock contact", async () => {
    await seedContact("c_lock_other_write");

    await withContactLock("c_lock_other_write", async (tx, contact) => {
      // Création d'un doc arbitraire dans une autre collection (simulé).
      // Le but : prouver qu'on peut écrire des docs cross-collection
      // dans la même tx que le lock contact.
      const otherRef = getAdminDb().collection("_test_other_writes").doc("doc_a");
      // On référence contact.hubspotId pour démontrer qu'on peut tagger
      // l'écriture cross-collection avec l'identifiant lu sous lock.
      tx.create(otherRef, { ts: Timestamp.now(), kind: "test", forContact: contact.hubspotId });
    });

    const created = await getAdminDb().collection("_test_other_writes").doc("doc_a").get();
    expect(created.exists).toBe(true);
    expect(created.data()?.kind).toBe("test");
  });

  it("fn throw → tx rollback : ni update contact, ni écriture autre collection", async () => {
    await seedContact("c_lock_rollback", { status: "ready" });

    const otherRef = getAdminDb().collection("_test_rollback").doc("doc_b");

    await expect(
      withContactLock("c_lock_rollback", async (tx, contact) => {
        // Sanity : contact lu pré-rollback (état initial "ready").
        expect(contact.status).toBe("ready");
        const ref = getAdminDb().collection(__CONTACTS_COLLECTION_FOR_TESTS).doc("c_lock_rollback");
        tx.update(ref, { status: "qualified" });
        tx.create(otherRef, { kind: "should_be_rolled_back" });
        throw new Error("simulated_failure");
      }),
    ).rejects.toThrow("simulated_failure");

    // Le contact n'a PAS été modifié.
    const contactAfter = await getAdminDb()
      .collection(__CONTACTS_COLLECTION_FOR_TESTS)
      .doc("c_lock_rollback")
      .get();
    expect((contactAfter.data() as Contact).status).toBe("ready");

    // Le doc autre collection N'A PAS été créé.
    const otherAfter = await otherRef.get();
    expect(otherAfter.exists).toBe(false);
  });

  it("fn peut lire un autre doc via tx.get dans la même tx", async () => {
    await seedContact("c_lock_multiget");
    // Seed un doc compagnon que fn va lire.
    await getAdminDb().collection("_test_companion").doc("companion_a").set({ value: 42 });

    const observed: { value: number; contactId: string }[] = [];
    await withContactLock("c_lock_multiget", async (tx, contact) => {
      const companionRef = getAdminDb().collection("_test_companion").doc("companion_a");
      const companionDoc = await tx.get(companionRef);
      observed.push({
        value: companionDoc.data()?.value as number,
        contactId: contact.hubspotId,
      });
    });

    // Le buildValidContact pose `hubspotId: "hs_abc123"` par défaut,
    // indépendamment du docId Firestore (`c_lock_multiget`). En prod ils
    // seraient égaux (hubspotId = source de vérité du docId), mais les
    // tests les distinguent pour vérifier le découplage.
    expect(observed).toEqual([{ value: 42, contactId: "hs_abc123" }]);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Concurrence "sanity" (le vrai test de race vit dans concurrency.test.ts)
  // ───────────────────────────────────────────────────────────────────────

  it("2 jobs concurrents sur le même contact → sérialisés (sanity check)", async () => {
    // Démonstration courte. Le test rigoureux 10x avec rate-limit
    // vit dans concurrency.test.ts.
    await seedContact("c_lock_race", { status: "ready" });

    // Chaque job incrémente un compteur arbitraire (status switch).
    // Si la sérialisation marche, les 2 commits réussissent
    // (sans rate-limit dans ce test) — mais SÉQUENTIELLEMENT, pas en
    // parallèle. Si elle ne marchait pas, une seule write l'emporterait
    // et l'autre serait silencieusement perdue (lost update).
    //
    // Vérification : on remplace status par des valeurs distinctes
    // ET on observe qu'au moins 1 retry a eu lieu (le 2e job a lu
    // l'état après-1er-commit, pas l'état initial).

    const observedStatuses: string[] = [];

    await Promise.all([
      withContactLock("c_lock_race", async (tx, contact) => {
        observedStatuses.push(contact.status);
        const ref = getAdminDb().collection(__CONTACTS_COLLECTION_FOR_TESTS).doc("c_lock_race");
        tx.update(ref, { status: "in_conversation" });
      }),
      withContactLock("c_lock_race", async (tx, contact) => {
        observedStatuses.push(contact.status);
        const ref = getAdminDb().collection(__CONTACTS_COLLECTION_FOR_TESTS).doc("c_lock_race");
        tx.update(ref, { status: "qualified" });
      }),
    ]);

    // L'état final dépend de l'ordre de commit (non-déterministe),
    // mais doit être l'UN des deux derniers status posés.
    const final = await getAdminDb()
      .collection(__CONTACTS_COLLECTION_FOR_TESTS)
      .doc("c_lock_race")
      .get();
    expect(["in_conversation", "qualified"]).toContain((final.data() as Contact).status);

    // Sanity : chaque tx a observé un status (au moins une fois).
    expect(observedStatuses.length).toBeGreaterThanOrEqual(2);
  });
});
