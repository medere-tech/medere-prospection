/**
 * Tests EMULATOR — onglets PR4 `a_traiter` (`handoffContacted==false`) et
 * `contactees` (`handoffContacted==true`).
 *
 * Invariants :
 *   - a_traiter et contactees sont DISJOINTS (aucune conv ne figure dans
 *     les 2 listes simultanément).
 *   - Compteurs exacts par onglet via `countConversations` + `filterForTab`.
 *   - L'onglet `contactees` n'apparaît QUE pour les docs `handed_off`
 *     avec `handoffContacted==true`.
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
import { filterForTab } from "@/lib/firestore/conversation-list-tabs";
import {
  countConversations,
  listConversations,
  type ListConversationsFilters,
} from "@/lib/firestore/conversations";
import { __resetEnvCacheForTests } from "@/lib/security/env";
import type { Conversation, ConversationStatus } from "@/types/conversation";

const PEPPER = "e".repeat(64);

async function fullReset() {
  vi.restoreAllMocks();
  __resetFirestoreAdminForTests();
  const app = __getAppByName(__APP_NAME_FOR_TESTS);
  if (app) await deleteApp(app);
  __resetEnvCacheForTests();
}

async function seedConv(
  id: string,
  status: ConversationStatus,
  handoffContacted: boolean | undefined,
  extra: Partial<Conversation> = {},
): Promise<void> {
  const now = Timestamp.now();
  const doc: Record<string, unknown> = {
    contactId: `contact_${id}`,
    campaignId: "hubspot-list-42",
    channel: "sms",
    status,
    intent: "INTERESSE",
    messageCount: 1,
    outboundCount: 1,
    inboundCount: 0,
    followupCount: 0,
    lastMessageAt: now,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
  if (handoffContacted !== undefined) doc.handoffContacted = handoffContacted;
  await getAdminDb().collection("conversations").doc(id).set(doc);
}

/** Construit les filtres d'un onglet (comme les routes PR4). */
function tabFilters(tab: string): ListConversationsFilters {
  const { statuses, handoffContacted } = filterForTab(tab);
  return {
    ...(statuses && statuses.length > 0 && { statusIn: [...statuses] }),
    ...(handoffContacted !== undefined && { handoffContacted }),
  };
}

describe("onglets a_traiter vs contactees (PR4 — point 6)", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_PII_PEPPER", PEPPER);
    await fullReset();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fullReset();
  });

  async function seedPopulation(): Promise<void> {
    await seedConv("c1_aTraiter", "handed_off", false);
    await seedConv("c2_aTraiter", "handed_off", false);
    await seedConv("c3_aTraiter", "handed_off", false);
    await seedConv("c4_contactee", "handed_off", true);
    await seedConv("c5_contactee", "handed_off", true);
    await seedConv("c6_active", "active", undefined);
    await seedConv("c7_closed", "closed", undefined);
  }

  it("a_traiter et contactees sont DISJOINTS (0 intersection)", async () => {
    await seedPopulation();
    const aTraiter = await listConversations({ limit: 100, filters: tabFilters("a_traiter") });
    const contactees = await listConversations({ limit: 100, filters: tabFilters("contactees") });
    const idsATraiter = new Set(aTraiter.conversations.map((c) => c.conversationId));
    const idsContactees = new Set(contactees.conversations.map((c) => c.conversationId));
    const intersection = [...idsATraiter].filter((id) => idsContactees.has(id));
    expect(intersection).toEqual([]);
    expect(idsATraiter.size).toBe(3);
    expect(idsContactees.size).toBe(2);
  });

  it("compteurs exacts par onglet (PR4 : 5 admin, 4 commercial sans en_cours)", async () => {
    await seedPopulation();
    const assigneeFilter = { kind: "none" as const };

    const aTraiter = await countConversations({
      filters: tabFilters("a_traiter"),
      assigneeFilter,
    });
    const contactees = await countConversations({
      filters: tabFilters("contactees"),
      assigneeFilter,
    });
    const enCours = await countConversations({ filters: tabFilters("en_cours"), assigneeFilter });
    const cloturees = await countConversations({
      filters: tabFilters("cloturees"),
      assigneeFilter,
    });
    const toutes = await countConversations({ filters: tabFilters("toutes"), assigneeFilter });

    expect(aTraiter).toBe(3);
    expect(contactees).toBe(2);
    expect(enCours).toBe(1);
    expect(cloturees).toBe(1);
    expect(toutes).toBe(7);
    expect(aTraiter + contactees).toBe(5); // les 5 handed_off
  });

  it("contactees ne prend QUE les docs `handed_off`+`handoffContacted==true`", async () => {
    // Doc avec `handoffContacted=true` mais `status=active` (impossible
    // en pratique, mais prouve que le filtre composite est bien
    // 2-dimensionnel, pas juste une dimension `handoffContacted`).
    await seedConv("edge_active_contacted_true", "active", true);
    await seedConv("edge_handed_off_true", "handed_off", true);
    const contactees = await listConversations({ limit: 100, filters: tabFilters("contactees") });
    const ids = contactees.conversations.map((c) => c.conversationId);
    expect(ids).toEqual(["edge_handed_off_true"]);
  });
});
