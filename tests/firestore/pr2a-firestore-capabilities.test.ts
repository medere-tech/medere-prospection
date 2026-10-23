/**
 * Preuve emulator PR2a — capacités Firestore utilisées par les onglets.
 *
 * Objectif (demande Déthié 2026-10-23) : prouver qu'UN SEUL index composite
 * `(status asc, lastMessageAt desc)` sert :
 *
 *   • `where("status","in",[a,b,c]) + orderBy("lastMessageAt","desc")`
 *     + `startAfter(cursor)` + `limit(n)` → pagination intacte, ordre global
 *   • idem avec un `where("assignedTo","==","U...")` ajouté devant
 *     → un seul composite `(assignedTo asc, status asc, lastMessageAt desc)`
 *
 * Et que `!=` et `not-in` fonctionnent (combinés à un `orderBy("status","asc")`
 * requis par Firestore pour les inégalités, puis un `orderBy("lastMessageAt","desc")`).
 *
 * Doc Firebase :
 *   https://firebase.google.com/docs/firestore/query-data/queries#limitations
 *   « Composite indexes support queries that use range/in/not-in filters with
 *     ordering on another field. »
 *
 * ⚠ L'emulator n'applique pas les contraintes de type `MISSING_INDEX` comme
 *   le fait Firestore Cloud, MAIS la sémantique des queries et de la
 *   pagination est strictement identique → la validation applicative (ordre
 *   global, étanchéité des pages, cardinalité) tient. Pour l'index unique
 *   lui-même, le fait établi est documenté par Firebase (lien ci-dessus) +
 *   `firestore.indexes.json` qui ne liste QU'UN composite pour chacun des
 *   patterns prouvés ci-dessous.
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
import { __resetEnvCacheForTests } from "@/lib/security/env";

const COLLECTION = "conversations";
const PEPPER = "b".repeat(64);

async function fullReset() {
  vi.restoreAllMocks();
  __resetFirestoreAdminForTests();
  const app = __getAppByName(__APP_NAME_FOR_TESTS);
  if (app) await deleteApp(app);
  __resetEnvCacheForTests();
}

/**
 * Seed 60 conversations réparties sur les 8 statuts, avec un ordre
 * `lastMessageAt` global décroissant stable (ms = 1_700_000_000_000 - i).
 */
async function seed60() {
  const db = getAdminDb();
  const STATUSES = [
    "active",
    "awaiting_reply",
    "in_dialogue",
    "qualified",
    "handed_off",
    "closed",
    "opted_out",
    "blocked",
  ] as const;
  for (let i = 0; i < 60; i++) {
    const status = STATUSES[i % STATUSES.length]!;
    const ms = 1_700_000_000_000 - i * 1000;
    await db
      .collection(COLLECTION)
      .doc(`c${String(i).padStart(2, "0")}_x`)
      .set({
        contactId: `c${i}`,
        campaignId: "x",
        channel: "sms",
        status,
        intent: "unknown",
        messageCount: 1,
        outboundCount: 1,
        inboundCount: 0,
        followupCount: 0,
        assignedTo: i % 2 === 0 ? "UOWNER01234" : "UOTHER98765",
        lastMessageAt: Timestamp.fromMillis(ms),
        lastInboundAt: Timestamp.fromMillis(ms),
        createdAt: Timestamp.fromMillis(ms - 10_000),
        updatedAt: Timestamp.fromMillis(ms),
      });
  }
}

describe("Firestore capabilities (PR2a preuve emulator)", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_PII_PEPPER", PEPPER);
    await fullReset();
    await seed60();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fullReset();
  });

  it("where('status','in',[...3]) + orderBy('lastMessageAt','desc') + startAfter — un seul composite (status, lastMessageAt desc)", async () => {
    const db = getAdminDb();
    const closedStatuses = ["closed", "opted_out", "blocked"] as const;
    // 60 / 8 statuts × 3 statuts fermés = ~22-23 docs attendus.
    const firstPage = await db
      .collection(COLLECTION)
      .where("status", "in", closedStatuses)
      .orderBy("lastMessageAt", "desc")
      .limit(10)
      .get();
    expect(firstPage.docs).toHaveLength(10);
    // Ordre global : ms strictement décroissants.
    const firstPageMs = firstPage.docs.map((d) => (d.data().lastMessageAt as Timestamp).toMillis());
    for (let i = 1; i < firstPageMs.length; i++) {
      expect(firstPageMs[i]!).toBeLessThan(firstPageMs[i - 1]!);
    }
    // Et tous sont bien dans les 3 statuts.
    for (const d of firstPage.docs) {
      expect(closedStatuses).toContain(d.data().status);
    }

    // Page 2 via startAfter → étanchéité (aucun doc en double, ordre maintenu).
    const cursor = firstPage.docs[firstPage.docs.length - 1]!;
    const secondPage = await db
      .collection(COLLECTION)
      .where("status", "in", closedStatuses)
      .orderBy("lastMessageAt", "desc")
      .startAfter(cursor)
      .limit(10)
      .get();
    const secondPageMs = secondPage.docs.map((d) =>
      (d.data().lastMessageAt as Timestamp).toMillis(),
    );
    // Chaque élément de la page 2 strictement plus ancien que le cursor.
    const cursorMs = (cursor.data().lastMessageAt as Timestamp).toMillis();
    for (const ms of secondPageMs) expect(ms).toBeLessThan(cursorMs);
    // Pas de chevauchement.
    const firstIds = new Set(firstPage.docs.map((d) => d.id));
    for (const d of secondPage.docs) expect(firstIds.has(d.id)).toBe(false);
  });

  it("where('assignedTo','==','U...').where('status','in',[...]) + orderBy('lastMessageAt','desc') — un seul composite (assignedTo, status, lastMessageAt desc)", async () => {
    const db = getAdminDb();
    const openStatuses = ["handed_off", "qualified"] as const;
    const page = await db
      .collection(COLLECTION)
      .where("assignedTo", "==", "UOWNER01234")
      .where("status", "in", openStatuses)
      .orderBy("lastMessageAt", "desc")
      .limit(25)
      .get();
    for (const d of page.docs) {
      expect(d.data().assignedTo).toBe("UOWNER01234");
      expect(openStatuses).toContain(d.data().status);
    }
    // Ordre global strict.
    for (let i = 1; i < page.docs.length; i++) {
      expect((page.docs[i]!.data().lastMessageAt as Timestamp).toMillis()).toBeLessThan(
        (page.docs[i - 1]!.data().lastMessageAt as Timestamp).toMillis(),
      );
    }
  });

  it("where('status','!=','closed') — fonctionne (orderBy sur le champ d'inégalité requis)", async () => {
    const db = getAdminDb();
    // Firestore requiert `orderBy("status")` d'abord pour une inégalité sur status.
    // Puis on peut poursuivre par orderBy("lastMessageAt","desc").
    const snap = await db
      .collection(COLLECTION)
      .where("status", "!=", "closed")
      .orderBy("status", "asc")
      .orderBy("lastMessageAt", "desc")
      .limit(30)
      .get();
    for (const d of snap.docs) expect(d.data().status).not.toBe("closed");
  });

  it("where('status','not-in',[...]) — fonctionne (orderBy sur le champ requis)", async () => {
    const db = getAdminDb();
    const archivedStatuses = ["closed", "opted_out", "blocked"] as const;
    const snap = await db
      .collection(COLLECTION)
      .where("status", "not-in", archivedStatuses)
      .orderBy("status", "asc")
      .orderBy("lastMessageAt", "desc")
      .limit(50)
      .get();
    for (const d of snap.docs) expect(archivedStatuses).not.toContain(d.data().status);
    // Les 5 statuts "actifs" (active, awaiting_reply, in_dialogue, qualified, handed_off)
    // × 60/8 ≈ 7-8 docs chacun = ~37-38 docs attendus (< 50).
    expect(snap.docs.length).toBeGreaterThan(30);
    expect(snap.docs.length).toBeLessThan(50);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PR2a — Preuve /version : updatedAt reflète un changement de statut SANS
// nouveau message (fait structurant de l'endpoint `/api/admin/conversations/version`)
// ─────────────────────────────────────────────────────────────────────────────

import {
  _parseConversationOrThrow,
  listConversations,
  setHandoff,
} from "@/lib/firestore/conversations";
import { addInbound, addOutboundInTx } from "@/lib/firestore/messages";
import { propagateContactDenormToConversations } from "@/lib/firestore/propagate-contact-denorm";

describe("PR2a /version — updatedAt bougé par changement de statut (sans nouveau message)", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_PII_PEPPER", PEPPER);
    await fullReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fullReset();
  });

  it("setHandoff change `updatedAt` mais PAS `lastMessageAt` → la version `updatedAt desc` bouge", async () => {
    const db = getAdminDb();
    const t0 = 1_700_000_000_000;
    await db
      .collection(COLLECTION)
      .doc("conv_status_change")
      .set({
        contactId: "c1",
        campaignId: "x",
        channel: "sms",
        status: "qualified",
        intent: "INTERESSE",
        messageCount: 1,
        outboundCount: 1,
        inboundCount: 1,
        followupCount: 0,
        assignedTo: null,
        lastMessageAt: Timestamp.fromMillis(t0),
        lastInboundAt: Timestamp.fromMillis(t0),
        createdAt: Timestamp.fromMillis(t0 - 10_000),
        updatedAt: Timestamp.fromMillis(t0),
      });

    // Query miroir /version AVANT le changement de statut.
    const beforeSnap = await db.collection(COLLECTION).orderBy("updatedAt", "desc").limit(1).get();
    const beforeTopMs = (beforeSnap.docs[0]!.data().updatedAt as Timestamp).toMillis();
    expect(beforeTopMs).toBe(t0);

    // Changement de statut via setHandoff — ne touche PAS lastMessageAt.
    await setHandoff("conv_status_change", "UALICE123", "Note minimale handoff");

    // Vérifs écriture : status + updatedAt bougent, lastMessageAt reste.
    const docSnap = await db.collection(COLLECTION).doc("conv_status_change").get();
    const data = docSnap.data()!;
    expect(data.status).toBe("handed_off");
    expect((data.lastMessageAt as Timestamp).toMillis()).toBe(t0);
    expect((data.updatedAt as Timestamp).toMillis()).toBeGreaterThan(t0);

    // Query miroir /version APRÈS — la version a bougé (`updatedAt` plus récent).
    const afterSnap = await db.collection(COLLECTION).orderBy("updatedAt", "desc").limit(1).get();
    const afterTopMs = (afterSnap.docs[0]!.data().updatedAt as Timestamp).toMillis();
    expect(afterTopMs).toBeGreaterThan(beforeTopMs);
  });

  it("recherche préfixe + tri `contactNameSearch asc, lastMessageAt desc` + pagination (PR2a)", async () => {
    // Décision retenue : en mode recherche, Firestore impose que la 1re
    // orderBy porte sur le champ en inégalité (`contactNameSearch`). Le
    // tri secondaire reste `lastMessageAt desc`. Compromis assumé :
    // les résultats sont groupés par nom (alphabétique) puis par récence.
    const db = getAdminDb();
    const base = 1_700_000_000_000;
    const docs = [
      { id: "c_dupont_fr", name: "dupont jean", ms: base + 500 },
      { id: "c_dupont_pa", name: "dupont pauline", ms: base + 300 },
      { id: "c_dupond_al", name: "dupond alain", ms: base + 400 },
      { id: "c_durand_cl", name: "durand claire", ms: base + 100 },
      { id: "c_duval_er", name: "duval eric", ms: base + 200 },
      { id: "c_other", name: "martin paul", ms: base + 1_000 }, // hors préfixe
    ];
    for (const d of docs) {
      await db
        .collection(COLLECTION)
        .doc(d.id)
        .set({
          contactId: d.id,
          campaignId: "x",
          channel: "sms",
          status: "active",
          intent: "unknown",
          messageCount: 1,
          outboundCount: 1,
          inboundCount: 0,
          followupCount: 0,
          assignedTo: null,
          contactNameSearch: d.name,
          lastMessageAt: Timestamp.fromMillis(d.ms),
          createdAt: Timestamp.fromMillis(d.ms - 1000),
          updatedAt: Timestamp.fromMillis(d.ms),
        });
    }

    // Page 1 : préfixe "dupo" avec limit 2 (dupond + dupont jean).
    const page1 = await listConversations({
      filters: { contactNameSearch: "dupo" },
      limit: 2,
    });
    const ids1 = page1.conversations.map((c) => c.conversationId);
    // Ordre : contactNameSearch asc PUIS lastMessageAt desc.
    //   dupond alain (base+400)
    //   dupont jean (base+500) — plus récent que dupont pauline donc avant
    expect(ids1).toEqual(["c_dupond_al", "c_dupont_fr"]);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).not.toBeNull();

    // Page 2 via cursor : dupont pauline uniquement (durand/duval hors préfixe "dupo").
    const page2 = await listConversations({
      filters: { contactNameSearch: "dupo" },
      limit: 2,
      cursor: page1.nextCursor!,
    });
    const ids2 = page2.conversations.map((c) => c.conversationId);
    expect(ids2).toEqual(["c_dupont_pa"]);
    expect(page2.hasMore).toBe(false);

    // Pas de chevauchement entre les 2 pages.
    const set1 = new Set(ids1);
    for (const id of ids2) expect(set1.has(id)).toBe(false);

    // `c_other` (martin paul) n'apparaît JAMAIS avec le préfixe "dupo",
    // même s'il a le `lastMessageAt` le plus récent.
    expect([...ids1, ...ids2]).not.toContain("c_other");

    // Préfixe `"du"` plus large : embarque tous les 5 "du..." mais pas
    // martin. Ordre : dupond, dupont jean, dupont pauline (desc par ms),
    // durand, duval → vérifions l'absence de martin et la bonne cardinalité.
    const all = await listConversations({
      filters: { contactNameSearch: "du" },
      limit: 10,
    });
    const ids = all.conversations.map((c) => c.conversationId);
    expect(ids).toHaveLength(5);
    expect(ids).not.toContain("c_other");
  });

  it("propagation contact → conversations : met à jour les 4 champs dénormalisés + bump updatedAt + audit (PR2a)", async () => {
    const db = getAdminDb();
    const t0 = 1_700_000_000_000;
    // 2 conversations attachées au même contact, 1 à un autre contact.
    await db
      .collection(COLLECTION)
      .doc("cXYZ_camp1")
      .set({
        contactId: "cXYZ",
        campaignId: "camp1",
        channel: "sms",
        status: "active",
        intent: "unknown",
        messageCount: 1,
        outboundCount: 1,
        inboundCount: 0,
        followupCount: 0,
        assignedTo: null,
        contactDisplayName: "Dr Ancien Nom",
        contactNameSearch: "ancien nom",
        contactSpecialty: "ancienne specialite",
        contactCity: "Ancienne ville",
        lastMessageAt: Timestamp.fromMillis(t0),
        createdAt: Timestamp.fromMillis(t0 - 10_000),
        updatedAt: Timestamp.fromMillis(t0),
      });
    await db
      .collection(COLLECTION)
      .doc("cXYZ_camp2")
      .set({
        contactId: "cXYZ",
        campaignId: "camp2",
        channel: "sms",
        status: "closed",
        intent: "NEUTRE",
        messageCount: 1,
        outboundCount: 1,
        inboundCount: 0,
        followupCount: 0,
        assignedTo: null,
        contactDisplayName: "Dr Ancien Nom",
        contactNameSearch: "ancien nom",
        contactSpecialty: "ancienne specialite",
        contactCity: "Ancienne ville",
        lastMessageAt: Timestamp.fromMillis(t0),
        createdAt: Timestamp.fromMillis(t0 - 10_000),
        updatedAt: Timestamp.fromMillis(t0),
      });
    await db
      .collection(COLLECTION)
      .doc("cOTHER_camp1")
      .set({
        contactId: "cOTHER",
        campaignId: "camp1",
        channel: "sms",
        status: "active",
        intent: "unknown",
        messageCount: 1,
        outboundCount: 1,
        inboundCount: 0,
        followupCount: 0,
        assignedTo: null,
        contactDisplayName: "Dr Autre Contact",
        contactNameSearch: "autre contact",
        contactSpecialty: "autre specialite",
        contactCity: "Autre ville",
        lastMessageAt: Timestamp.fromMillis(t0),
        createdAt: Timestamp.fromMillis(t0 - 10_000),
        updatedAt: Timestamp.fromMillis(t0),
      });

    const result = await propagateContactDenormToConversations("cXYZ", {
      contactDisplayName: "Dr Nouveau Nom",
      contactNameSearch: "nouveau nom",
      contactSpecialty: "nouvelle specialite",
      contactCity: "Nouvelle ville",
    });

    expect(result.scanned).toBe(2);
    expect(result.updated).toBe(2);

    // Les 2 conversations de cXYZ ont été mises à jour.
    const conv1 = (await db.collection(COLLECTION).doc("cXYZ_camp1").get()).data()!;
    expect(conv1.contactDisplayName).toBe("Dr Nouveau Nom");
    expect(conv1.contactNameSearch).toBe("nouveau nom");
    expect(conv1.contactSpecialty).toBe("nouvelle specialite");
    expect(conv1.contactCity).toBe("Nouvelle ville");
    expect((conv1.updatedAt as Timestamp).toMillis()).toBeGreaterThan(t0);

    const conv2 = (await db.collection(COLLECTION).doc("cXYZ_camp2").get()).data()!;
    expect(conv2.contactDisplayName).toBe("Dr Nouveau Nom");

    // La conv de cOTHER n'a PAS été touchée.
    const other = (await db.collection(COLLECTION).doc("cOTHER_camp1").get()).data()!;
    expect(other.contactDisplayName).toBe("Dr Autre Contact");
    expect((other.updatedAt as Timestamp).toMillis()).toBe(t0);

    // Audit log : 2 entrées `conversation_denorm_propagated` pour cXYZ.
    const auditSnap = await db
      .collection("audit_log")
      .where("action", "==", "conversation_denorm_propagated")
      .get();
    expect(auditSnap.docs).toHaveLength(2);
    // Payload scrubber-safe : contactId + fieldsUpdated noms seulement.
    const payloads = auditSnap.docs.map((d) => d.data().payload);
    for (const p of payloads) {
      expect(p.contactId).toBe("cXYZ");
      expect(Array.isArray(p.fieldsUpdated)).toBe(true);
      // Les 4 champs modifiés présents, aucune valeur en clair.
      expect(new Set(p.fieldsUpdated)).toEqual(
        new Set(["contactDisplayName", "contactNameSearch", "contactSpecialty", "contactCity"]),
      );
    }
  });

  it("propagation idempotente : seconde invocation avec les mêmes valeurs = scanned>0 updated=0", async () => {
    const db = getAdminDb();
    const t0 = 1_700_000_000_000;
    await db
      .collection(COLLECTION)
      .doc("cIDEMP_camp1")
      .set({
        contactId: "cIDEMP",
        campaignId: "camp1",
        channel: "sms",
        status: "active",
        intent: "unknown",
        messageCount: 1,
        outboundCount: 1,
        inboundCount: 0,
        followupCount: 0,
        assignedTo: null,
        contactDisplayName: "Dr Déjà",
        contactNameSearch: "deja",
        contactSpecialty: "deja spec",
        contactCity: "deja ville",
        lastMessageAt: Timestamp.fromMillis(t0),
        createdAt: Timestamp.fromMillis(t0 - 10_000),
        updatedAt: Timestamp.fromMillis(t0),
      });

    const snapshot = {
      contactDisplayName: "Dr Déjà",
      contactNameSearch: "deja",
      contactSpecialty: "deja spec",
      contactCity: "deja ville",
    };

    const first = await propagateContactDenormToConversations("cIDEMP", snapshot);
    expect(first.scanned).toBe(1);
    expect(first.updated).toBe(0);

    // `updatedAt` doit rester inchangé puisqu'aucune diff n'a été détectée.
    const after = (await db.collection(COLLECTION).doc("cIDEMP_camp1").get()).data()!;
    expect((after.updatedAt as Timestamp).toMillis()).toBe(t0);

    // Aucun audit `conversation_denorm_propagated` n'a été posé.
    const auditSnap = await db
      .collection("audit_log")
      .where("action", "==", "conversation_denorm_propagated")
      .where("targetId", "==", "cIDEMP_camp1")
      .get();
    expect(auditSnap.empty).toBe(true);
  });

  /**
   * Helper : seed une conversation active prête à recevoir messages.
   * Les champs sont alignés avec `ConversationSchema`.
   */
  async function seedActiveConv(contactId: string, campaignId: string, t: number) {
    const db = getAdminDb();
    const convId = `${contactId}_${campaignId}`;
    await db
      .collection(COLLECTION)
      .doc(convId)
      .set({
        contactId,
        campaignId,
        channel: "sms",
        status: "active",
        intent: "unknown",
        messageCount: 0,
        outboundCount: 0,
        inboundCount: 0,
        followupCount: 0,
        assignedTo: null,
        createdAt: Timestamp.fromMillis(t - 1000),
        updatedAt: Timestamp.fromMillis(t),
      });
    return convId;
  }

  it("addInbound pose `lastMessagePreview` scrubé + authorKind='contact' (PR2a)", async () => {
    const db = getAdminDb();
    const t0 = 1_700_000_500_000;
    const convId = await seedActiveConv("cIN", "camp", t0);

    await addInbound(convId, {
      body: "Rappelez-moi au 06 12 34 56 78 svp",
      channel: "sms",
      externalId: "ext_in_1",
      externalReceiver: "+33612345678",
    });

    const conv = (await db.collection(COLLECTION).doc(convId).get()).data()!;
    expect(conv.lastMessagePreview).toBeDefined();
    expect(conv.lastMessagePreview.direction).toBe("inbound");
    expect(conv.lastMessagePreview.authorKind).toBe("contact");
    // Scrub appliqué : le numéro FR est remplacé par [PHONE].
    expect(conv.lastMessagePreview.text).not.toMatch(/06 12 34/);
    expect(conv.lastMessagePreview.text).toContain("[PHONE]");
    // Pas de bump `lastHumanOutboundAt` sur un inbound.
    expect(conv.lastHumanOutboundAt).toBeUndefined();
  });

  it("addOutboundInTx avec generatedBy='ai' pose authorKind='ai' et NE touche PAS lastHumanOutboundAt (PR2a — M3)", async () => {
    const db = getAdminDb();
    const t0 = 1_700_000_600_000;
    const convId = await seedActiveConv("cAI", "camp", t0);

    await db.runTransaction(async (tx) => {
      const doc = await tx.get(db.collection(COLLECTION).doc(convId));
      const conv = _parseConversationOrThrow(doc.data(), convId);
      await addOutboundInTx(tx, convId, conv, {
        body: "Bonjour, Léa de Médéré. STOP pour refuser.",
        channel: "sms",
        generatedBy: "ai",
        outboundKind: "solicitation",
        aiModel: "claude-sonnet-4-6",
      });
    });

    const conv = (await db.collection(COLLECTION).doc(convId).get()).data()!;
    expect(conv.lastMessagePreview.direction).toBe("outbound");
    expect(conv.lastMessagePreview.authorKind).toBe("ai");
    // CRITIQUE : un envoi IA ne doit JAMAIS bumper lastHumanOutboundAt.
    // Sinon le signal `waitingForHumanReply` serait toujours false et le
    // commercial ne verrait plus qu'il doit répondre.
    expect(conv.lastHumanOutboundAt).toBeUndefined();
  });

  it("addOutboundInTx avec generatedBy='human' pose authorKind='human' ET bump lastHumanOutboundAt (PR2a)", async () => {
    const db = getAdminDb();
    const t0 = 1_700_000_700_000;
    const convId = await seedActiveConv("cHU", "camp", t0);
    // On seed un inbound d'abord pour pouvoir envoyer un `outboundKind:"reply"`
    // (assertOutboundKindCoherentOrThrow refuse "reply" sans inbound).
    await addInbound(convId, {
      body: "intéressé",
      channel: "sms",
      externalId: "ext_hu_1",
      externalReceiver: "+33612345678",
    });

    await db.runTransaction(async (tx) => {
      const doc = await tx.get(db.collection(COLLECTION).doc(convId));
      const conv = _parseConversationOrThrow(doc.data(), convId);
      await addOutboundInTx(tx, convId, conv, {
        body: "Message envoyé par le commercial.",
        channel: "sms",
        generatedBy: "human",
        outboundKind: "reply",
      });
    });

    const conv = (await db.collection(COLLECTION).doc(convId).get()).data()!;
    expect(conv.lastMessagePreview.authorKind).toBe("human");
    expect(conv.lastHumanOutboundAt).toBeDefined();
    expect((conv.lastHumanOutboundAt as Timestamp).toMillis()).toBeGreaterThan(0);
  });

  it("mutation : si /version triait sur `lastMessageAt`, un setHandoff ne changerait pas la version", async () => {
    // Preuve que le choix `updatedAt desc` (PR2a) est le correctif de la
    // régression `lastMessageAt desc` : avec l'ancien critère, un
    // changement de statut sans nouveau message serait invisible.
    const db = getAdminDb();
    const t0 = 1_700_000_000_000;
    await db
      .collection(COLLECTION)
      .doc("conv_lastmsg_stable")
      .set({
        contactId: "c2",
        campaignId: "x",
        channel: "sms",
        status: "qualified",
        intent: "INTERESSE",
        messageCount: 1,
        outboundCount: 1,
        inboundCount: 1,
        followupCount: 0,
        assignedTo: null,
        lastMessageAt: Timestamp.fromMillis(t0),
        lastInboundAt: Timestamp.fromMillis(t0),
        createdAt: Timestamp.fromMillis(t0 - 10_000),
        updatedAt: Timestamp.fromMillis(t0),
      });

    const beforeMsgSnap = await db
      .collection(COLLECTION)
      .orderBy("lastMessageAt", "desc")
      .limit(1)
      .get();
    const beforeMsgMs = (beforeMsgSnap.docs[0]!.data().lastMessageAt as Timestamp).toMillis();

    await setHandoff("conv_lastmsg_stable", "UALICE123", "Note minimale handoff");

    const afterMsgSnap = await db
      .collection(COLLECTION)
      .orderBy("lastMessageAt", "desc")
      .limit(1)
      .get();
    const afterMsgMs = (afterMsgSnap.docs[0]!.data().lastMessageAt as Timestamp).toMillis();

    // `lastMessageAt` est STABLE → prouve pourquoi `/version` ne peut PAS
    // être basé dessus.
    expect(afterMsgMs).toBe(beforeMsgMs);
  });
});
