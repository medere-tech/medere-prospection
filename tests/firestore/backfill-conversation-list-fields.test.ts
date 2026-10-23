/**
 * Tests emulator — logique per-doc du backfill PR2a.
 *
 * Prouve en particulier le **fail-closed** : si UNE lecture
 * (contact OU messages.last OU messages.lastHuman) throw, le résultat
 * contient `readErrors` non vide ET `updates = {}` ET `posed = []`. Le
 * script orchestrateur (`scripts/backfill-conversation-list-fields.mjs`)
 * s'appuie sur cette garantie pour incrémenter `errors` et ne tenter
 * AUCUNE écriture.
 *
 * Approche : injecter un `db` mock qui throw sur UNE lecture précise
 * tout en laissant les autres passer. Chacun des 3 chemins de lecture
 * est couvert.
 */
import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __APP_NAME_FOR_TESTS,
  __getAppByName,
  __resetFirestoreAdminForTests,
  getAdminDb,
} from "@/lib/firestore/admin";
import { computeBackfillUpdatesForConversation } from "@/lib/firestore/backfill-conversation-list-fields";
import { __resetEnvCacheForTests } from "@/lib/security/env";

const PEPPER = "b".repeat(64);

async function fullReset() {
  vi.restoreAllMocks();
  __resetFirestoreAdminForTests();
  const app = __getAppByName(__APP_NAME_FOR_TESTS);
  if (app) await deleteApp(app);
  __resetEnvCacheForTests();
}

/**
 * Construit un faux `convDoc` léger (DocumentSnapshot-like) sans
 * passer par l'emulator — la fonction testée ne lit que `.id` et `.data()`.
 */
function makeConvDoc(id: string, data: Record<string, unknown>) {
  return {
    id,
    data: () => data,
    exists: true,
  } as unknown as FirebaseFirestore.DocumentSnapshot;
}

/**
 * Construit un db mock qui redirige vers l'emulator POUR TOUT, SAUF pour
 * un path précis où il throw. Le path est identifié par
 * `collection(X).doc(Y).collection(Z)...` → une signature textuelle.
 */
function makeDbWithFailureOn(
  realDb: FirebaseFirestore.Firestore,
  shouldFail: (sig: string) => boolean,
): FirebaseFirestore.Firestore {
  function wrapCollection(colRef: FirebaseFirestore.CollectionReference, sig: string) {
    return {
      ...colRef,
      doc: (id: string) => {
        const docRef = colRef.doc(id);
        return wrapDoc(docRef, `${sig}.doc(${id})`);
      },
      where: (field: string, op: string, value: unknown) => {
        const chain = colRef.where(field, op as FirebaseFirestore.WhereFilterOp, value);
        return wrapQuery(chain, `${sig}.where(${field},${op})`);
      },
      orderBy: (field: string, dir?: "asc" | "desc") => {
        const chain = colRef.orderBy(field, dir ?? "asc");
        return wrapQuery(chain, `${sig}.orderBy(${field})`);
      },
      limit: (n: number) => {
        const chain = colRef.limit(n);
        return wrapQuery(chain, `${sig}.limit(${n})`);
      },
      get: async () => {
        if (shouldFail(sig)) throw new Error(`MOCK_FAIL: ${sig}`);
        return colRef.get();
      },
    } as unknown as FirebaseFirestore.CollectionReference;
  }
  function wrapDoc(docRef: FirebaseFirestore.DocumentReference, sig: string) {
    return {
      ...docRef,
      collection: (name: string) => {
        const colRef = docRef.collection(name);
        return wrapCollection(colRef, `${sig}.collection(${name})`);
      },
      get: async () => {
        if (shouldFail(sig)) throw new Error(`MOCK_FAIL: ${sig}`);
        return docRef.get();
      },
    } as unknown as FirebaseFirestore.DocumentReference;
  }
  function wrapQuery(qRef: FirebaseFirestore.Query, sig: string) {
    return {
      ...qRef,
      where: (field: string, op: string, value: unknown) => {
        const chain = qRef.where(field, op as FirebaseFirestore.WhereFilterOp, value);
        return wrapQuery(chain, `${sig}.where(${field},${op})`);
      },
      orderBy: (field: string, dir?: "asc" | "desc") => {
        const chain = qRef.orderBy(field, dir ?? "asc");
        return wrapQuery(chain, `${sig}.orderBy(${field})`);
      },
      limit: (n: number) => {
        const chain = qRef.limit(n);
        return wrapQuery(chain, `${sig}.limit(${n})`);
      },
      get: async () => {
        if (shouldFail(sig)) throw new Error(`MOCK_FAIL: ${sig}`);
        return qRef.get();
      },
    } as unknown as FirebaseFirestore.Query;
  }

  return {
    collection: (name: string) => wrapCollection(realDb.collection(name), `db.collection(${name})`),
  } as unknown as FirebaseFirestore.Firestore;
}

describe("computeBackfillUpdatesForConversation (PR2a fail-closed)", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_PII_PEPPER", PEPPER);
    await fullReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fullReset();
  });

  it("happy path (zéro throw) → updates calculés depuis contact et messages", async () => {
    const db = getAdminDb();
    const contactId = "cHP";
    await db.collection("contacts").doc(contactId).set({
      hubspotId: contactId,
      firstName: "Jean",
      lastName: "Dupont",
      civilite: "Dr",
      speciality: "Dentiste",
      city: "Paris",
    });

    const convDoc = makeConvDoc(`${contactId}_cmp`, {
      contactId,
      // Pas de contactDisplayName/Search/Specialty/City : à poser.
      // Pas de lastMessagePreview : à poser depuis messages (vide ici).
    });

    const result = await computeBackfillUpdatesForConversation(convDoc, db);
    expect(result.readErrors).toEqual([]);
    expect(result.posed.sort()).toEqual([
      "contactCity",
      "contactDisplayName",
      "contactNameSearch",
      "contactSpecialty",
    ]);
  });

  it("fail-closed : lecture contact qui throw → readErrors non vide, zéro update, zéro posed", async () => {
    const db = getAdminDb();
    const contactId = "cFail1";
    // Pas de seed contact — on va faire throw le get() via mock.

    const convDoc = makeConvDoc(`${contactId}_cmp`, {
      contactId,
    });

    const dbMock = makeDbWithFailureOn(db, (sig) =>
      sig.startsWith(`db.collection(contacts).doc(${contactId})`),
    );
    const result = await computeBackfillUpdatesForConversation(convDoc, dbMock);
    expect(result.readErrors.length).toBe(1);
    expect(result.readErrors[0]).toMatch(/^contact:/);
    // CRITIQUE : zéro écriture possible sur ce doc.
    expect(result.updates).toEqual({});
    expect(result.posed).toEqual([]);
  });

  it("fail-closed : lecture `messages.last` qui throw → readErrors non vide, zéro update", async () => {
    const db = getAdminDb();
    const contactId = "cFail2";
    await db.collection("contacts").doc(contactId).set({
      hubspotId: contactId,
      firstName: "Jean",
      lastName: "Dupont",
      civilite: "Dr",
      speciality: "Dentiste",
      city: "Paris",
    });
    const convId = `${contactId}_cmp`;
    const convDoc = makeConvDoc(convId, { contactId });

    // Mock : laisse la lecture contact passer, fail sur subcollection messages.
    const dbMock = makeDbWithFailureOn(db, (sig) =>
      sig.includes(`.collection(messages).orderBy(createdAt)`),
    );
    const result = await computeBackfillUpdatesForConversation(convDoc, dbMock);
    expect(result.readErrors.length).toBe(1);
    expect(result.readErrors[0]).toMatch(/^messages\.last:/);
    expect(result.updates).toEqual({});
    expect(result.posed).toEqual([]);
  });

  it("fail-closed : lecture `messages.lastHuman` qui throw → readErrors non vide, zéro update (REGRESSION medere-prospection-mvp dry-run)", async () => {
    // C'est EXACTEMENT la régression observée en prod : la query
    // `where(direction).where(generatedBy).orderBy(createdAt)` échoue
    // avec FAILED_PRECONDITION, mais le `catch(e)` avalait l'erreur et
    // le doc restait marqué `touched`. Désormais : readErrors !== [] →
    // updates = {} → caller fera `errors++, continue`.
    const db = getAdminDb();
    const contactId = "cFail3";
    await db.collection("contacts").doc(contactId).set({
      hubspotId: contactId,
      firstName: "Jean",
      lastName: "Dupont",
      civilite: "Dr",
      speciality: "Dentiste",
      city: "Paris",
    });
    const convId = `${contactId}_cmp`;
    // Seed un dernier message pour que `messages.last` ait du contenu
    // (sinon la 1re query throw aussi — on veut isoler la 2e).
    await db
      .collection("conversations")
      .doc(convId)
      .collection("messages")
      .add({
        direction: "outbound",
        generatedBy: "ai",
        body: "Bonjour, Léa de Médéré.",
        createdAt: Timestamp.fromMillis(1_700_000_000_000),
        status: "sent",
        channel: "sms",
      });

    const convDoc = makeConvDoc(convId, { contactId });

    // Mock : fail UNIQUEMENT sur la query avec `.where(direction,==).where(generatedBy,==)`.
    const dbMock = makeDbWithFailureOn(db, (sig) =>
      sig.includes(".where(direction,==).where(generatedBy,==)"),
    );
    const result = await computeBackfillUpdatesForConversation(convDoc, dbMock);
    expect(result.readErrors.length).toBe(1);
    expect(result.readErrors[0]).toMatch(/^messages\.lastHuman:/);
    // CRITIQUE : même si la lecture contact ET la lecture `messages.last`
    // ont réussi, le fail-closed JETTE tout — zéro écriture partielle.
    expect(result.updates).toEqual({});
    expect(result.posed).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────
  // Mutation : si on retire le `readErrors.length > 0 → return {}`, le
  // test de "zéro update" tombe (les updates partiels passent).
  // ─────────────────────────────────────────────────────────────────

  it("mutation : si fail-closed retiré, les updates partiels fuient — ce test documente le piège", async () => {
    // Ce test ne mute PAS le code (la mutation testing round précédent
    // avait sa propre grille), mais il documente le piège observé :
    // si le `if (readErrors.length > 0) return { posed:[], updates:{}, readErrors }`
    // est retiré, un fail sur `messages.lastHuman` renverrait quand
    // même les updates calculés depuis contact + messages.last. Preuve
    // par absurde : si on simule cet état en relâchant la contrainte,
    // on voit bien que les updates partiels existeraient.
    // Ici on vérifie plutôt l'invariant structurel : readErrors === []
    // ⇔ updates est AUTORISÉ à être non vide.
    const db = getAdminDb();
    const contactId = "cInv";
    await db.collection("contacts").doc(contactId).set({
      hubspotId: contactId,
      firstName: "A",
      lastName: "B",
      civilite: "M.",
      speciality: "Dent",
      city: "Paris",
    });
    const convDoc = makeConvDoc(`${contactId}_cmp`, { contactId });
    const result = await computeBackfillUpdatesForConversation(convDoc, db);
    // Invariant : readErrors vide → updates peut être non vide
    expect(result.readErrors).toEqual([]);
    expect(Object.keys(result.updates).length).toBeGreaterThan(0);
  });
});
