/**
 * Tests EMULATOR — `listConversations`, `listConversationsByAssignee`,
 * `listUnassignedConversations` (VUE-CONVERSATION PR0.4).
 *
 * Couvre :
 *   - Happy path pour les 3 variantes (filtres status/intent, pagination,
 *     ordre `lastInboundAt desc`).
 *   - Mutation testing sur les filtres critiques (assignedTo, status).
 *   - Garde-fous Zod + regex slackUserId.
 *   - Dénormalisation `assignedTo` écrite par `setHandoff` dans la même tx.
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
import {
  listConversations,
  listConversationsByAssignee,
  listUnassignedConversations,
  setHandoff,
} from "@/lib/firestore/conversations";
import { __resetEnvCacheForTests } from "@/lib/security/env";
import { ValidationError } from "@/lib/utils/errors";

const PEPPER = "b".repeat(64);
const COLLECTION = "conversations";

async function fullReset() {
  vi.restoreAllMocks();
  __resetFirestoreAdminForTests();
  const app = __getAppByName(__APP_NAME_FOR_TESTS);
  if (app) await deleteApp(app);
  __resetEnvCacheForTests();
}

interface SeedConv {
  id: string;
  contactId: string;
  campaignId: string;
  status:
    | "active"
    | "awaiting_reply"
    | "in_dialogue"
    | "qualified"
    | "handed_off"
    | "closed"
    | "opted_out"
    | "blocked";
  intent: "INTERESSE" | "NEUTRE" | "OBJECTION" | "STOP" | "unknown";
  assignedTo: string | null;
  /**
   * `lastInboundMs` reste la clé historique d'entrée du helper (PR0),
   * mais le tri de la liste est désormais sur `lastMessageAt` (PR2a).
   * Par défaut, `lastMessageAt` = `lastInboundMs` (compat PR0) et
   * `inboundCount` = 1 (seed d'une conv qui a reçu au moins un inbound).
   * Pour simuler une conv sortant-seul, passer `onlyOutbound: true` :
   * `lastInboundAt` n'est pas posé, `inboundCount = 0`, `lastMessageAt`
   * reçoit `lastInboundMs` comme horodatage du sortant.
   */
  lastInboundMs: number;
  onlyOutbound?: boolean;
}

async function seedConv(c: SeedConv) {
  const db = getAdminDb();
  const base: Record<string, unknown> = {
    contactId: c.contactId,
    campaignId: c.campaignId,
    channel: "sms",
    status: c.status,
    intent: c.intent,
    messageCount: 1,
    outboundCount: 1,
    followupCount: 0,
    assignedTo: c.assignedTo,
    lastMessageAt: Timestamp.fromMillis(c.lastInboundMs),
    createdAt: Timestamp.fromMillis(c.lastInboundMs - 1000),
    updatedAt: Timestamp.fromMillis(c.lastInboundMs),
  };
  if (c.onlyOutbound) {
    base.inboundCount = 0;
    base.lastOutboundAt = Timestamp.fromMillis(c.lastInboundMs);
  } else {
    base.inboundCount = 1;
    base.lastInboundAt = Timestamp.fromMillis(c.lastInboundMs);
  }
  await db.collection(COLLECTION).doc(c.id).set(base);
}

describe("listConversations* — persist emulator (VUE-CONVERSATION PR0)", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_PII_PEPPER", PEPPER);
    await fullReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fullReset();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // listConversations (sans filtre assignedTo)
  // ─────────────────────────────────────────────────────────────────────────

  it("listConversations — ordre lastMessageAt desc (PR2a)", async () => {
    await seedConv({
      id: "c1_x",
      contactId: "c1",
      campaignId: "x",
      status: "in_dialogue",
      intent: "INTERESSE",
      assignedTo: "UALICE123",
      lastInboundMs: 1_700_000_300_000,
    });
    await seedConv({
      id: "c2_x",
      contactId: "c2",
      campaignId: "x",
      status: "in_dialogue",
      intent: "NEUTRE",
      assignedTo: null,
      lastInboundMs: 1_700_000_100_000,
    });
    await seedConv({
      id: "c3_x",
      contactId: "c3",
      campaignId: "x",
      status: "closed",
      intent: "STOP",
      assignedTo: null,
      lastInboundMs: 1_700_000_200_000,
    });

    const res = await listConversations();
    expect(res.conversations.map((c) => c.conversationId)).toEqual(["c1_x", "c3_x", "c2_x"]);
    expect(res.hasMore).toBe(false);
    expect(res.nextCursor).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PR2a — preuve que le tri `lastMessageAt desc` embarque les sortant-seul
  // ─────────────────────────────────────────────────────────────────────────

  it("PR2a — conversation sans aucun inbound (sortant-seul) apparaît", async () => {
    // Avant PR2a (tri `lastInboundAt desc`), ce doc aurait été invisible
    // car `lastInboundAt` est absent → Firestore l'exclut d'un `orderBy`.
    // Après PR2a (tri `lastMessageAt desc`), il apparaît : `lastMessageAt`
    // est bumpé à CHAQUE message, dont le premier sortant.
    await seedConv({
      id: "c_outbound_only",
      contactId: "cOO",
      campaignId: "x",
      status: "active",
      intent: "unknown",
      assignedTo: null,
      lastInboundMs: 1_700_000_050_000,
      onlyOutbound: true,
    });
    await seedConv({
      id: "c_with_inbound",
      contactId: "cWI",
      campaignId: "x",
      status: "in_dialogue",
      intent: "INTERESSE",
      assignedTo: null,
      lastInboundMs: 1_700_000_200_000,
    });

    const res = await listConversations();
    const ids = res.conversations.map((c) => c.conversationId);
    // Les 2 docs apparaissent, dans l'ordre `lastMessageAt desc`.
    expect(ids).toEqual(["c_with_inbound", "c_outbound_only"]);
  });

  it("PR2a — mutation : si on remet `orderBy('lastInboundAt','desc')` les sortant-seul disparaissent", async () => {
    // Documente le piège : si quelqu'un rebranche l'ordering sur
    // `lastInboundAt`, le doc sortant-seul (sans `lastInboundAt`) sera
    // exclu silencieusement par Firestore → régression invisible.
    // On vérifie ici qu'une query directe sur `lastInboundAt` perd le doc,
    // ce qui prouve que notre choix `lastMessageAt` est bien le correctif.
    await seedConv({
      id: "c_outbound_only",
      contactId: "cOO",
      campaignId: "x",
      status: "active",
      intent: "unknown",
      assignedTo: null,
      lastInboundMs: 1_700_000_050_000,
      onlyOutbound: true,
    });
    const db = getAdminDb();
    const legacySnap = await db
      .collection(COLLECTION)
      .orderBy("lastInboundAt", "desc")
      .limit(10)
      .get();
    expect(legacySnap.docs.map((d) => d.id)).not.toContain("c_outbound_only");

    // Avec le tri PR2a (via la fonction publique), le doc est bien là.
    const pr2a = await listConversations();
    expect(pr2a.conversations.map((c) => c.conversationId)).toContain("c_outbound_only");
  });

  it("listConversations — filtre status", async () => {
    await seedConv({
      id: "c1_x",
      contactId: "c1",
      campaignId: "x",
      status: "in_dialogue",
      intent: "INTERESSE",
      assignedTo: null,
      lastInboundMs: 2_000_000_000_000,
    });
    await seedConv({
      id: "c2_x",
      contactId: "c2",
      campaignId: "x",
      status: "closed",
      intent: "STOP",
      assignedTo: null,
      lastInboundMs: 2_000_000_100_000,
    });

    const res = await listConversations({ filters: { status: "in_dialogue" } });
    expect(res.conversations.map((c) => c.conversationId)).toEqual(["c1_x"]);
  });

  // PR2b-1 — ancien test `filtre intent + status combinés` retiré :
  // `filters.intent` n'est plus accepté par `ListConversationsFiltersSchema`
  // (aucun caller ne l'utilisait, aucun index composite ne le soutenait).

  it("listConversations — pagination cursor", async () => {
    for (let i = 0; i < 5; i++) {
      await seedConv({
        id: `c${i}_x`,
        contactId: `c${i}`,
        campaignId: "x",
        status: "in_dialogue",
        intent: "INTERESSE",
        assignedTo: null,
        lastInboundMs: 1_700_000_000_000 + i * 1000,
      });
    }

    const page1 = await listConversations({ limit: 2 });
    expect(page1.conversations).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listConversations({ limit: 2, cursor: page1.nextCursor ?? undefined });
    expect(page2.conversations).toHaveLength(2);
    // Vérifier que les ids des 2 pages ne se chevauchent pas
    const idsPage1 = new Set(page1.conversations.map((c) => c.conversationId));
    for (const c of page2.conversations) {
      expect(idsPage1.has(c.conversationId)).toBe(false);
    }
  });

  it("listConversations — Zod refuse limit hors bornes", async () => {
    await expect(listConversations({ limit: 101 })).rejects.toBeInstanceOf(ValidationError);
    await expect(listConversations({ limit: 0 })).rejects.toBeInstanceOf(ValidationError);
  });

  it("listConversations — cursor inexistant → ValidationError", async () => {
    await expect(listConversations({ cursor: "no_such_conversation_id" })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // listConversationsByAssignee
  // ─────────────────────────────────────────────────────────────────────────

  it("listConversationsByAssignee — ne retourne QUE les conversations du slackUserId", async () => {
    await seedConv({
      id: "c1_x",
      contactId: "c1",
      campaignId: "x",
      status: "in_dialogue",
      intent: "INTERESSE",
      assignedTo: "UALICE123",
      lastInboundMs: 1_700_000_300_000,
    });
    await seedConv({
      id: "c2_x",
      contactId: "c2",
      campaignId: "x",
      status: "in_dialogue",
      intent: "INTERESSE",
      assignedTo: "UBOB45678",
      lastInboundMs: 1_700_000_200_000,
    });
    await seedConv({
      id: "c3_x",
      contactId: "c3",
      campaignId: "x",
      status: "in_dialogue",
      intent: "INTERESSE",
      assignedTo: null,
      lastInboundMs: 1_700_000_100_000,
    });

    const res = await listConversationsByAssignee("UALICE123");
    expect(res.conversations.map((c) => c.conversationId)).toEqual(["c1_x"]);
  });

  it("listConversationsByAssignee — mutation : si on retire le filtre assignedTo, le test échoue", async () => {
    // Mutation testing : on vérifie que le filtre `assignedTo` est bien
    // appliqué. Si on l'enlève (mutation du code), ce test échoue car on
    // récupère aussi la conv de Bob.
    await seedConv({
      id: "c_alice",
      contactId: "a",
      campaignId: "x",
      status: "in_dialogue",
      intent: "INTERESSE",
      assignedTo: "UALICE123",
      lastInboundMs: 1_700_000_000_000,
    });
    await seedConv({
      id: "c_bob",
      contactId: "b",
      campaignId: "x",
      status: "in_dialogue",
      intent: "INTERESSE",
      assignedTo: "UBOB45678",
      lastInboundMs: 1_700_000_100_000,
    });

    const resAlice = await listConversationsByAssignee("UALICE123");
    expect(resAlice.conversations).toHaveLength(1);
    expect(resAlice.conversations[0]?.conversationId).toBe("c_alice");
  });

  it("listConversationsByAssignee — slackUserId mal formé rejeté par assertSlackUserId", async () => {
    await expect(listConversationsByAssignee("notaslackid")).rejects.toThrow();
    await expect(listConversationsByAssignee("")).rejects.toThrow();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // listUnassignedConversations
  // ─────────────────────────────────────────────────────────────────────────

  it("listUnassignedConversations — ne retourne QUE assignedTo === null", async () => {
    await seedConv({
      id: "c1_x",
      contactId: "c1",
      campaignId: "x",
      status: "in_dialogue",
      intent: "INTERESSE",
      assignedTo: "UALICE123",
      lastInboundMs: 1_700_000_300_000,
    });
    await seedConv({
      id: "c2_x",
      contactId: "c2",
      campaignId: "x",
      status: "in_dialogue",
      intent: "INTERESSE",
      assignedTo: null,
      lastInboundMs: 1_700_000_200_000,
    });

    const res = await listUnassignedConversations();
    expect(res.conversations.map((c) => c.conversationId)).toEqual(["c2_x"]);
  });

  it("listUnassignedConversations — docs legacy sans assignedTo invisible (contrat null explicite)", async () => {
    // Un doc legacy sans champ `assignedTo` du tout ne doit PAS apparaître.
    const db = getAdminDb();
    await db
      .collection(COLLECTION)
      .doc("legacy_x")
      .set({
        contactId: "legacy",
        campaignId: "x",
        channel: "sms",
        status: "in_dialogue",
        intent: "INTERESSE",
        messageCount: 1,
        outboundCount: 1,
        inboundCount: 1,
        followupCount: 0,
        // PAS d'assignedTo
        lastInboundAt: Timestamp.fromMillis(1_700_000_000_000),
        createdAt: Timestamp.fromMillis(1_700_000_000_000),
        updatedAt: Timestamp.fromMillis(1_700_000_000_000),
      });

    const res = await listUnassignedConversations();
    expect(res.conversations).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Dénormalisation : setHandoff écrit les deux champs dans la MÊME tx
  // ─────────────────────────────────────────────────────────────────────────

  it("setHandoff — écrit assignedTo racine ET handoff.assignedTo dans la MÊME tx", async () => {
    const db = getAdminDb();
    await db
      .collection(COLLECTION)
      .doc("conv_handoff_test")
      .set({
        contactId: "c_h",
        campaignId: "x",
        channel: "sms",
        status: "qualified",
        intent: "INTERESSE",
        messageCount: 1,
        outboundCount: 1,
        inboundCount: 1,
        followupCount: 0,
        assignedTo: null,
        // PR2a : la liste trie sur `lastMessageAt` → le seed doit le poser
        // sinon le doc est exclu de l'orderBy (Firestore filtre les docs
        // dont le champ est absent).
        lastMessageAt: Timestamp.fromMillis(1_700_000_000_000),
        lastInboundAt: Timestamp.fromMillis(1_700_000_000_000),
        createdAt: Timestamp.fromMillis(1_700_000_000_000),
        updatedAt: Timestamp.fromMillis(1_700_000_000_000),
      });

    await setHandoff("conv_handoff_test", "UALICE123", "Note minimale pour test handoff");

    const snap = await db.collection(COLLECTION).doc("conv_handoff_test").get();
    const data = snap.data();
    expect(data?.assignedTo).toBe("UALICE123");
    expect(data?.handoff?.assignedTo).toBe("UALICE123");
    expect(data?.status).toBe("handed_off");

    // Désormais apparaît dans listConversationsByAssignee
    const res = await listConversationsByAssignee("UALICE123");
    expect(res.conversations.map((c) => c.conversationId)).toContain("conv_handoff_test");

    // Et plus dans listUnassignedConversations
    const resU = await listUnassignedConversations();
    expect(resU.conversations.map((c) => c.conversationId)).not.toContain("conv_handoff_test");
  });
});
