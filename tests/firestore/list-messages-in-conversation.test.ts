/**
 * Tests EMULATOR — `listMessagesInConversation` (VUE-CONVERSATION PR0.4).
 *
 * Couvre :
 *   - Exclusion `duplicate` (critique, mutation testing).
 *   - Inclusion `abandoned` + `draft` (contrairement à `listRecentMessages`).
 *   - Ordre asc/desc.
 *   - Pagination cursor.
 *   - Shape complète + `messageId` ajouté.
 *   - Validation input (limit hors bornes, cursor inexistant, conversationId vide).
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
import { listMessagesInConversation } from "@/lib/firestore/messages";
import { __resetEnvCacheForTests } from "@/lib/security/env";
import { ValidationError } from "@/lib/utils/errors";

const PEPPER = "b".repeat(64);

async function fullReset() {
  vi.restoreAllMocks();
  __resetFirestoreAdminForTests();
  const app = __getAppByName(__APP_NAME_FOR_TESTS);
  if (app) await deleteApp(app);
  __resetEnvCacheForTests();
}

async function seedMessage(
  conversationId: string,
  messageId: string,
  data: Record<string, unknown>,
) {
  await getAdminDb()
    .collection("conversations")
    .doc(conversationId)
    .collection("messages")
    .doc(messageId)
    .set(data);
}

const BASE_OUTBOUND = (createdAtMs: number, status: string) => ({
  direction: "outbound",
  status,
  channel: "sms",
  body: "Bonjour, test",
  outboundKind: "solicitation",
  generatedBy: "ai",
  aiModel: "claude-sonnet-4-6",
  aiPromptVersion: "1.0.0",
  aiTemperature: 0.3,
  aiTokens: { input: 10, output: 20 },
  cost: 5,
  createdAt: Timestamp.fromMillis(createdAtMs),
  externalReceiver: "+33612349876",
});

const BASE_INBOUND = (createdAtMs: number) => ({
  direction: "inbound",
  status: "received",
  channel: "sms",
  body: "Réponse PS",
  generatedBy: "human",
  createdAt: Timestamp.fromMillis(createdAtMs),
  externalReceiver: "+33612349876",
});

describe("listMessagesInConversation — persist emulator (VUE-CONVERSATION PR0)", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_PII_PEPPER", PEPPER);
    await fullReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fullReset();
  });

  it("exclut status=duplicate (critique) et inclut abandoned + draft", async () => {
    const convId = "c_dup_test";
    await seedMessage(convId, "m_sent", BASE_OUTBOUND(1_700_000_100_000, "sent"));
    await seedMessage(convId, "m_abandoned", {
      ...BASE_OUTBOUND(1_700_000_200_000, "abandoned"),
      abandonedAt: Timestamp.fromMillis(1_700_000_250_000),
      abandonReason: "stale_pre_launch_test_cleanup",
    });
    await seedMessage(convId, "m_duplicate", {
      ...BASE_INBOUND(1_700_000_300_000),
      status: "duplicate",
      duplicateOf: "m_received",
    });
    await seedMessage(convId, "m_received", BASE_INBOUND(1_700_000_400_000));
    await seedMessage(convId, "m_draft", BASE_OUTBOUND(1_700_000_500_000, "draft"));

    const res = await listMessagesInConversation({ conversationId: convId });
    const ids = res.messages.map((m) => m.messageId);
    expect(ids).toContain("m_sent");
    expect(ids).toContain("m_abandoned");
    expect(ids).toContain("m_received");
    expect(ids).toContain("m_draft");
    expect(ids).not.toContain("m_duplicate");
  });

  it("mutation testing — si on retire le filtre duplicate, le doc apparaît", async () => {
    // Sentinelle anti-régression : vérifie que `duplicate` est bien filtré.
    const convId = "c_mut_test";
    await seedMessage(convId, "m_received", BASE_INBOUND(1_700_000_100_000));
    await seedMessage(convId, "m_dup", {
      ...BASE_INBOUND(1_700_000_200_000),
      status: "duplicate",
      duplicateOf: "m_received",
    });

    const res = await listMessagesInConversation({ conversationId: convId });
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0]?.messageId).toBe("m_received");
  });

  it("ordre asc par défaut (chronologique croissant, fil de chat)", async () => {
    const convId = "c_order";
    await seedMessage(convId, "m_old", BASE_INBOUND(1_700_000_100_000));
    await seedMessage(convId, "m_mid", BASE_INBOUND(1_700_000_200_000));
    await seedMessage(convId, "m_new", BASE_INBOUND(1_700_000_300_000));

    const res = await listMessagesInConversation({ conversationId: convId });
    expect(res.messages.map((m) => m.messageId)).toEqual(["m_old", "m_mid", "m_new"]);
  });

  it("ordre desc explicite", async () => {
    const convId = "c_order_desc";
    await seedMessage(convId, "m_old", BASE_INBOUND(1_700_000_100_000));
    await seedMessage(convId, "m_mid", BASE_INBOUND(1_700_000_200_000));
    await seedMessage(convId, "m_new", BASE_INBOUND(1_700_000_300_000));

    const res = await listMessagesInConversation({ conversationId: convId, order: "desc" });
    expect(res.messages.map((m) => m.messageId)).toEqual(["m_new", "m_mid", "m_old"]);
  });

  it("pagination cursor", async () => {
    const convId = "c_paginate";
    for (let i = 0; i < 5; i++) {
      await seedMessage(convId, `m_${i}`, BASE_INBOUND(1_700_000_000_000 + i * 1000));
    }

    const page1 = await listMessagesInConversation({ conversationId: convId, limit: 2 });
    expect(page1.messages).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listMessagesInConversation({
      conversationId: convId,
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.messages).toHaveLength(2);
    const ids1 = new Set(page1.messages.map((m) => m.messageId));
    for (const m of page2.messages) expect(ids1.has(m.messageId)).toBe(false);
  });

  it("shape complète : messageId + tous les champs du Message", async () => {
    const convId = "c_shape";
    await seedMessage(convId, "m_outbound", BASE_OUTBOUND(1_700_000_100_000, "sent"));

    const res = await listMessagesInConversation({ conversationId: convId });
    expect(res.messages).toHaveLength(1);
    const msg = res.messages[0];
    expect(msg?.messageId).toBe("m_outbound");
    expect(msg?.direction).toBe("outbound");
    expect(msg?.status).toBe("sent");
    expect(msg?.body).toBe("Bonjour, test");
    expect(msg?.generatedBy).toBe("ai");
    expect(msg?.outboundKind).toBe("solicitation");
  });

  it("conversationId vide → ValidationError", async () => {
    await expect(listMessagesInConversation({ conversationId: "" })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("limit hors bornes → ValidationError", async () => {
    await expect(
      listMessagesInConversation({ conversationId: "x", limit: 300 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      listMessagesInConversation({ conversationId: "x", limit: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("cursor inexistant → ValidationError", async () => {
    const convId = "c_cursor_fail";
    await seedMessage(convId, "m1", BASE_INBOUND(1_700_000_000_000));
    await expect(
      listMessagesInConversation({ conversationId: convId, cursor: "no_such_msg" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("conversation vide → messages=[], hasMore=false, nextCursor=null", async () => {
    const res = await listMessagesInConversation({ conversationId: "c_empty" });
    expect(res.messages).toEqual([]);
    expect(res.hasMore).toBe(false);
    expect(res.nextCursor).toBeNull();
  });
});
