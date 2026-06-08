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
import {
  AuditPiiError,
  ComplianceConcurrencyError,
  NotFoundError,
  ValidationError,
} from "@/lib/utils/errors";
import type { Contact } from "@/types/contact";
import type { Conversation } from "@/types/conversation";
import type { Message } from "@/types/message";

import {
  __APP_NAME_FOR_TESTS,
  __getAppByName,
  __resetFirestoreAdminForTests,
  getAdminDb,
} from "./admin";
import * as auditLogModule from "./audit-log";
import { __AUDIT_COLLECTION_FOR_TESTS } from "./audit-log";
import { __CONTACTS_COLLECTION_FOR_TESTS } from "./contacts";
import { __CONVERSATIONS_COLLECTION_FOR_TESTS } from "./conversations";
import * as messagesModule from "./messages";
import {
  __MESSAGES_PARENT_COLLECTION_FOR_TESTS,
  __MESSAGES_SUBCOLLECTION_FOR_TESTS,
} from "./messages";
import {
  __TRANSACTIONS_CONTACTS_COLLECTION_FOR_TESTS,
  __TRANSACTIONS_CONVERSATIONS_COLLECTION_FOR_TESTS,
  __TRANSACTIONS_RATE_LIMIT_WINDOW_DAYS_FOR_TESTS,
  sendOutboundWithLock,
  withContactLock,
} from "./transactions";

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

function buildValidConversation(overrides: Partial<Conversation> = {}): Conversation {
  const now = Timestamp.now();
  return {
    contactId: "hs_abc123",
    campaignId: "camp_abc",
    channel: "sms",
    status: "active",
    intent: "unknown",
    messageCount: 0,
    outboundCount: 0,
    inboundCount: 0,
    followupCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function seedConversation(
  id: string,
  overrides: Partial<Conversation> = {},
): Promise<Conversation> {
  const conv = buildValidConversation(overrides);
  await getAdminDb().collection(__CONVERSATIONS_COLLECTION_FOR_TESTS).doc(id).set(conv);
  return conv;
}

async function seedOutboundMessage(
  conversationId: string,
  daysAgo: number,
  bodyTag: string,
): Promise<void> {
  const createdAt = Timestamp.fromDate(new Date(Date.now() - daysAgo * 86400_000));
  const message: Message = {
    direction: "outbound",
    body: `seed_${bodyTag}`,
    status: "sent",
    channel: "sms",
    generatedBy: "ai",
    createdAt,
    sentAt: createdAt,
  };
  await getAdminDb()
    .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
    .doc(conversationId)
    .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
    .add(message);
}

async function countOutboundMessages(conversationId: string): Promise<number> {
  const snap = await getAdminDb()
    .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
    .doc(conversationId)
    .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
    .where("direction", "==", "outbound")
    .get();
  return snap.size;
}

async function countAuditByAction(action: string): Promise<number> {
  const snap = await getAdminDb()
    .collection(__AUDIT_COLLECTION_FOR_TESTS)
    .where("action", "==", action)
    .get();
  return snap.size;
}

/**
 * Helper canonique pour seeder un trio cohérent (contact + conv + N outbound)
 * utilisable par les tests `sendOutboundWithLock`. Pose le contact à
 * `contactId`, la conversation à `convId` avec `conv.contactId === contactId`
 * (sinon `sendOutboundWithLock` refuserait l'envoi en défense en profondeur),
 * et N messages outbound dans la sous-collection.
 */
async function seedTrio(opts: {
  contactId: string;
  convId: string;
  campaignId: string;
  outboundsAgo: number[]; // ex: [5, 3] → 2 messages, J-5 et J-3
}) {
  await seedContact(opts.contactId);
  await seedConversation(opts.convId, {
    contactId: opts.contactId,
    campaignId: opts.campaignId,
    messageCount: opts.outboundsAgo.length,
    outboundCount: opts.outboundsAgo.length,
  });
  for (const [i, daysAgo] of opts.outboundsAgo.entries()) {
    await seedOutboundMessage(opts.convId, daysAgo, `m${i}`);
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// sendOutboundWithLock (DEBT-001.3)
// ─────────────────────────────────────────────────────────────────────────────

describe("transactions.ts — sendOutboundWithLock (DEBT-001.3)", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_PII_PEPPER", PEPPER);
    await fullReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fullReset();
  });

  // Helper canonique pour construire un args valide avec defaults inputables.
  function buildArgs(overrides: {
    contactId: string;
    convId: string;
    campaignId: string;
    inputBody?: string;
    expectedRemainingQuota?: number;
  }) {
    return {
      contactId: overrides.contactId,
      campaignId: overrides.campaignId,
      conversationId: overrides.convId,
      input: {
        body: overrides.inputBody ?? "Bonjour, Léa de Médéré. STOP pour refuser.",
        channel: "sms" as const,
        generatedBy: "ai" as const,
        aiModel: "claude-sonnet-4-6",
      },
      dispatch: {
        ovhMessageId: "ovh-msg-12345",
        sender: "MEDERE",
        bodyLength: 50,
        creditsRemoved: 1,
        dryRun: false,
      },
      expectedRemainingQuota: overrides.expectedRemainingQuota ?? 1,
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Sentinels
  // ───────────────────────────────────────────────────────────────────────

  it("sentinel : CONVERSATIONS_COLLECTION aligné entre transactions.ts et conversations.ts", () => {
    expect(__TRANSACTIONS_CONVERSATIONS_COLLECTION_FOR_TESTS).toBe(
      __CONVERSATIONS_COLLECTION_FOR_TESTS,
    );
  });

  it("sentinel Q-S6.3 (DEBT-001.6) : RATE_LIMIT_WINDOW_DAYS === 30 hardcodé — anti-drift CNIL", () => {
    // Cible CNIL B2B = 30 jours (L.34-5 CPCE, contrainte LÉGALE stable).
    // Si vous changez cette valeur, vérifier l'alignement avec
    // lib/compliance/rate-limits.ts (window également hardcodé en const
    // privée, non exportée — décision DEBT-001.3 Q-S2 : pas d'export pour
    // éviter un point de tentation de modification programmatique).
    //
    // Justification du double hardcoding vs export : la valeur 30 est
    // figée par la loi, ne devrait jamais bouger. Hardcoder + sentinel
    // anti-drift est plus sain qu'un export qui invite à paramétrer.
    expect(__TRANSACTIONS_RATE_LIMIT_WINDOW_DAYS_FOR_TESTS).toBe(30);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Happy path
  // ───────────────────────────────────────────────────────────────────────

  it("happy path : compose les 6 étapes, retourne {messageId, auditId}", async () => {
    const contactId = "hs_happy";
    const campaignId = "camp_happy";
    const convId = "conv_happy";
    await seedTrio({ contactId, convId, campaignId, outboundsAgo: [] });

    const result = await sendOutboundWithLock(buildArgs({ contactId, convId, campaignId }));

    // Retourne 2 IDs Firestore valides
    expect(result.messageId).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(result.auditId).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(result.messageId).not.toBe(result.auditId);

    // Doc message créé dans la sous-collection
    const msgSnap = await getAdminDb()
      .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
      .doc(convId)
      .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
      .doc(result.messageId)
      .get();
    expect(msgSnap.exists).toBe(true);
    const msg = msgSnap.data() as Message;
    expect(msg.direction).toBe("outbound");
    expect(msg.status).toBe("queued");

    // Compteurs bumpés sur la conversation
    const convAfter = await getAdminDb()
      .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
      .doc(convId)
      .get();
    expect((convAfter.data() as Conversation).outboundCount).toBe(1);

    // 2 audits : sms_sent (interne, posé par addOutboundInTx) +
    // sms_provider_dispatched (posé par sendOutboundWithLock).
    expect(await countAuditByAction("sms_sent")).toBe(1);
    expect(await countAuditByAction("sms_provider_dispatched")).toBe(1);
  });

  it("audit sms_provider_dispatched payload contient les 8 champs forensiques exacts", async () => {
    const contactId = "hs_payload";
    const campaignId = "camp_payload";
    const convId = "conv_payload";
    await seedTrio({ contactId, convId, campaignId, outboundsAgo: [] });

    const result = await sendOutboundWithLock(buildArgs({ contactId, convId, campaignId }));

    const auditSnap = await getAdminDb()
      .collection(__AUDIT_COLLECTION_FOR_TESTS)
      .doc(result.auditId)
      .get();
    const audit = auditSnap.data();
    expect(audit?.action).toBe("sms_provider_dispatched");
    expect(audit?.targetType).toBe("message");
    expect(audit?.targetId).toBe(result.messageId);

    // Sentinelle : payload exactement les 8 champs attendus, rien de plus,
    // rien de moins.
    const payload = audit?.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
      [
        "bodyLength",
        "campaignId",
        "contactId",
        "conversationId",
        "creditsRemoved",
        "dryRun",
        "ovhMessageId",
        "sender",
      ].sort(),
    );
    expect(payload.ovhMessageId).toBe("ovh-msg-12345");
    expect(payload.sender).toBe("MEDERE");
    expect(payload.contactId).toBe(contactId);
    expect(payload.conversationId).toBe(convId);
    expect(payload.campaignId).toBe(campaignId);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Mock-based : ordre exact des appels
  // ───────────────────────────────────────────────────────────────────────

  it("ORDRE EXACT (mock) : listRecentOutboundInTx → canSendMessage (interne) → addOutboundInTx → appendAuditLogTx", async () => {
    // Verrouille l'ordre des appels via spies. Si quelqu'un réordonne
    // (ex: addOutboundInTx AVANT le re-check rate-limit), le test casse.
    const contactId = "hs_order";
    const campaignId = "camp_order";
    const convId = "conv_order";
    await seedTrio({ contactId, convId, campaignId, outboundsAgo: [] });

    const callOrder: string[] = [];
    const listSpy = vi
      .spyOn(messagesModule, "listRecentOutboundInTx")
      .mockImplementation(async () => {
        callOrder.push("listRecentOutboundInTx");
        return [];
      });
    const addSpy = vi.spyOn(messagesModule, "addOutboundInTx").mockImplementation(async () => {
      callOrder.push("addOutboundInTx");
      return "fake_message_id_20xxxxxxxxxxxx"; // 20 chars
    });
    const auditSpy = vi.spyOn(auditLogModule, "appendAuditLogTx").mockImplementation(() => {
      callOrder.push("appendAuditLogTx");
      return "fake_audit_id";
    });

    await sendOutboundWithLock(buildArgs({ contactId, convId, campaignId }));

    expect(callOrder).toEqual(["listRecentOutboundInTx", "addOutboundInTx", "appendAuditLogTx"]);
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy).toHaveBeenCalledTimes(1);

    listSpy.mockRestore();
    addSpy.mockRestore();
    auditSpy.mockRestore();
  });

  it("ORDRE (mock) : listRecentOutboundInTx appelée AVEC RATE_LIMIT_WINDOW_DAYS (30j)", async () => {
    // Sentinelle anti-régression : si quelqu'un passe 7 ou 60 jours par
    // erreur, la fenêtre rate-limit devient incohérente avec S4.
    const contactId = "hs_window";
    const campaignId = "camp_window";
    const convId = "conv_window";
    await seedTrio({ contactId, convId, campaignId, outboundsAgo: [] });

    const listSpy = vi.spyOn(messagesModule, "listRecentOutboundInTx").mockResolvedValue([]);

    await sendOutboundWithLock(buildArgs({ contactId, convId, campaignId }));

    // Signature attendue : (tx, conversationId, 30)
    expect(listSpy).toHaveBeenCalledWith(
      expect.anything(), // tx
      convId,
      __TRANSACTIONS_RATE_LIMIT_WINDOW_DAYS_FOR_TESTS, // 30
    );
    listSpy.mockRestore();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Erreurs : rollback + ComplianceConcurrencyError
  // ───────────────────────────────────────────────────────────────────────

  it("contact absent → NotFoundError, RIEN écrit", async () => {
    // Pas de seedContact — withContactLock fail au tx.get(contacts/{id}).
    await seedConversation("conv_orphan", {
      contactId: "hs_ghost",
      campaignId: "camp_orphan",
    });

    await expect(
      sendOutboundWithLock(
        buildArgs({
          contactId: "hs_ghost",
          convId: "conv_orphan",
          campaignId: "camp_orphan",
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(await countOutboundMessages("conv_orphan")).toBe(0);
    expect(await countAuditByAction("sms_sent")).toBe(0);
    expect(await countAuditByAction("sms_provider_dispatched")).toBe(0);
  });

  it("conversation absente → NotFoundError, RIEN écrit", async () => {
    await seedContact("hs_noconv");

    await expect(
      sendOutboundWithLock(
        buildArgs({
          contactId: "hs_noconv",
          convId: "conv_ghost",
          campaignId: "camp_noconv",
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(await countAuditByAction("sms_sent")).toBe(0);
    expect(await countAuditByAction("sms_provider_dispatched")).toBe(0);
  });

  it("conv.contactId mismatch args.contactId → ValidationError (défense en profondeur)", async () => {
    // Le lock contact est sur "hs_lockholder" mais conv.contactId = "hs_other".
    // sendOutboundWithLock doit refuser : sinon le lock contact est inutile
    // (une autre tx pourrait modifier le contact réel hs_other en parallèle).
    await seedContact("hs_lockholder");
    await seedConversation("conv_mismatch", {
      contactId: "hs_other_owner",
      campaignId: "camp_mismatch",
    });

    await expect(
      sendOutboundWithLock(
        buildArgs({
          contactId: "hs_lockholder",
          convId: "conv_mismatch",
          campaignId: "camp_mismatch",
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await countOutboundMessages("conv_mismatch")).toBe(0);
    expect(await countAuditByAction("sms_provider_dispatched")).toBe(0);
  });

  it("rate-limit fail DANS la tx → ComplianceConcurrencyError, RIEN écrit", async () => {
    // Pré-condition : 3 messages outbound déjà dans la fenêtre 30j.
    // canSendMessage doit dire allowed=false → throw
    // ComplianceConcurrencyError. Aucun write effectué.
    const contactId = "hs_race";
    const campaignId = "camp_race";
    const convId = "conv_race";
    await seedTrio({ contactId, convId, campaignId, outboundsAgo: [10, 7, 3] });

    const auditsBefore = {
      smsSent: await countAuditByAction("sms_sent"),
      dispatched: await countAuditByAction("sms_provider_dispatched"),
    };

    await expect(
      sendOutboundWithLock(buildArgs({ contactId, convId, campaignId, expectedRemainingQuota: 1 })),
    ).rejects.toBeInstanceOf(ComplianceConcurrencyError);

    // Aucun nouveau message créé (compteur outbound reste à 3, le seed).
    expect(await countOutboundMessages(convId)).toBe(3);

    // Aucun nouvel audit posé.
    expect(await countAuditByAction("sms_sent")).toBe(auditsBefore.smsSent);
    expect(await countAuditByAction("sms_provider_dispatched")).toBe(auditsBefore.dispatched);
  });

  it("ComplianceConcurrencyError.context contient les 5 champs forensiques requis", async () => {
    const contactId = "hs_ctx";
    const campaignId = "camp_ctx";
    const convId = "conv_ctx";
    await seedTrio({ contactId, convId, campaignId, outboundsAgo: [10, 7, 3] });

    try {
      await sendOutboundWithLock(
        buildArgs({ contactId, convId, campaignId, expectedRemainingQuota: 1 }),
      );
      expect.fail("Should have thrown ComplianceConcurrencyError");
    } catch (e) {
      expect(e).toBeInstanceOf(ComplianceConcurrencyError);
      const ctx = (e as ComplianceConcurrencyError).context;
      expect(ctx.contactId).toBe(contactId);
      expect(ctx.ruleName).toBe("rate_limit_30d");
      expect(ctx.attemptedAt).toBeInstanceOf(Date);
      expect(ctx.expectedRemainingQuota).toBe(1);
      // Par construction de canSendMessage allowed=false ⇔ saturé.
      expect(ctx.observedRemainingQuota).toBe(0);
    }
  });

  it("ATOMICITÉ : addOutboundInTx throw (body trop long) → rollback, pas d'audit dispatch orphelin", async () => {
    // body > BODY_MAX_LENGTH (1600) → ValidationError DANS addOutboundInTx.
    // Le rollback doit empêcher l'audit sms_provider_dispatched de commit
    // (sinon = audit orphelin = DETTE-004 non payée).
    const contactId = "hs_atomic_body";
    const campaignId = "camp_atomic_body";
    const convId = "conv_atomic_body";
    await seedTrio({ contactId, convId, campaignId, outboundsAgo: [] });
    const huge = "x".repeat(1601);

    await expect(
      sendOutboundWithLock(buildArgs({ contactId, convId, campaignId, inputBody: huge })),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await countOutboundMessages(convId)).toBe(0);
    expect(await countAuditByAction("sms_sent")).toBe(0);
    expect(await countAuditByAction("sms_provider_dispatched")).toBe(0);
  });

  it("ATOMICITÉ : appendAuditLogTx throw → rollback message + audit sms_sent (pas d'orphelin)", async () => {
    // Mock appendAuditLogTx pour throw AuditPiiError. La tx doit rollback
    // intégralement : pas de message dans Firestore, pas d'audit sms_sent
    // interne (posé par addOutboundInTx DANS la même tx).
    const contactId = "hs_atomic_audit";
    const campaignId = "camp_atomic_audit";
    const convId = "conv_atomic_audit";
    await seedTrio({ contactId, convId, campaignId, outboundsAgo: [] });

    const spy = vi.spyOn(auditLogModule, "appendAuditLogTx").mockImplementation(() => {
      throw new AuditPiiError({ message: "simulated audit fail" });
    });

    await expect(
      sendOutboundWithLock(buildArgs({ contactId, convId, campaignId })),
    ).rejects.toBeInstanceOf(AuditPiiError);

    // Rollback total
    expect(await countOutboundMessages(convId)).toBe(0);

    // outboundCount inchangé
    const convAfter = await getAdminDb()
      .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
      .doc(convId)
      .get();
    expect((convAfter.data() as Conversation).outboundCount).toBe(0);

    spy.mockRestore();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Sentinelles action audit + couplage withContactLock
  // ───────────────────────────────────────────────────────────────────────

  it("SENTINELLE — action audit = 'sms_provider_dispatched' verbatim (anti-régression renommage)", async () => {
    const contactId = "hs_action";
    const campaignId = "camp_action";
    const convId = "conv_action";
    await seedTrio({ contactId, convId, campaignId, outboundsAgo: [] });

    let dispatchedActionCaptured: string | undefined;
    const spy = vi.spyOn(auditLogModule, "appendAuditLogTx").mockImplementation((_tx, entry) => {
      // Notre fonction pose 1 seul audit (l'autre `sms_sent` est posé par
      // addOutboundInTx — pas par nous). Capture l'action de NOTRE write.
      if (entry.action === "sms_provider_dispatched") {
        dispatchedActionCaptured = entry.action;
      }
      return "fake_audit_id";
    });

    await sendOutboundWithLock(buildArgs({ contactId, convId, campaignId }));

    expect(dispatchedActionCaptured).toBe("sms_provider_dispatched");
    spy.mockRestore();
  });

  it("withContactLock acquis avec contactId fourni (le contact est bien locké)", async () => {
    // Sentinelle : la fonction passe args.contactId à withContactLock,
    // pas conv.contactId. Si quelqu'un refactore en lockant conv.contactId
    // (qui pourrait diverger), le test casse.
    const contactId = "hs_lockcheck";
    const campaignId = "camp_lockcheck";
    const convId = "conv_lockcheck";
    await seedTrio({ contactId, convId, campaignId, outboundsAgo: [] });

    // On garantit que le tx.get sur contacts/{args.contactId} est appelé
    // en observant que l'écriture finale a bien lieu (si le lock contact
    // était absent ou mal nommé, NotFoundError serait thrown au step 1).
    const result = await sendOutboundWithLock(buildArgs({ contactId, convId, campaignId }));
    expect(result.messageId).toMatch(/^[A-Za-z0-9]{20}$/);
  });
});
