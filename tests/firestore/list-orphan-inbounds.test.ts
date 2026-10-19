/**
 * Tests EMULATOR — `listOrphanInbounds` (VUE-CONVERSATION PR0.4).
 *
 * Couvre :
 *   - Ordre `receivedAt desc`.
 *   - Filtres `reason` et `source` (mutation testing sur `reason`).
 *   - Pagination cursor.
 *   - Shape : OrphanInboundDoc + docId.
 *   - Garde-fous.
 */
import { deleteApp } from "firebase-admin/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __APP_NAME_FOR_TESTS,
  __getAppByName,
  __resetFirestoreAdminForTests,
} from "@/lib/firestore/admin";
import { addOrphanInboundIdempotent, listOrphanInbounds } from "@/lib/firestore/orphan-inbounds";
import { __resetEnvCacheForTests } from "@/lib/security/env";
import { ValidationError } from "@/lib/utils/errors";
import type { InboundOnInactiveConversationReason } from "@/types/audit-log";

const PEPPER = "b".repeat(64);

async function fullReset() {
  vi.restoreAllMocks();
  __resetFirestoreAdminForTests();
  const app = __getAppByName(__APP_NAME_FOR_TESTS);
  if (app) await deleteApp(app);
  __resetEnvCacheForTests();
}

async function seedOrphan(
  idempotencyKey: string,
  reason: InboundOnInactiveConversationReason,
  source: "process-reply" | "webhook-ovh-sms" = "process-reply",
  body = "Bonjour, test orphelin",
) {
  await addOrphanInboundIdempotent({
    reason,
    body,
    idempotencyKey,
    source,
    phoneHash: `hph_${idempotencyKey}`,
  });
  await new Promise((r) => setTimeout(r, 2));
}

describe("listOrphanInbounds — persist emulator (VUE-CONVERSATION PR0)", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_PII_PEPPER", PEPPER);
    await fullReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fullReset();
  });

  it("retourne tous les orphelins sans filtre, triés receivedAt desc", async () => {
    await seedOrphan("key1", "unknown_contact");
    await seedOrphan("key2", "parse_failed");
    await seedOrphan("key3", "enqueue_failed");

    const res = await listOrphanInbounds();
    expect(res.orphans).toHaveLength(3);
    // Dernier seed = key3, doit être en premier (desc)
    expect(res.orphans[0]?.idempotencyKey).toBe("key3");
  });

  it("filtre `reason` applique correctement", async () => {
    await seedOrphan("k1", "unknown_contact");
    await seedOrphan("k2", "parse_failed");
    await seedOrphan("k3", "unknown_contact");

    const res = await listOrphanInbounds({ filters: { reason: "unknown_contact" } });
    expect(res.orphans).toHaveLength(2);
    for (const o of res.orphans) expect(o.reason).toBe("unknown_contact");
  });

  it("mutation testing — si on retire le filtre reason, 3 docs sortent au lieu de 2", async () => {
    await seedOrphan("k1", "unknown_contact");
    await seedOrphan("k2", "parse_failed");
    await seedOrphan("k3", "unknown_contact");

    const resFiltered = await listOrphanInbounds({
      filters: { reason: "unknown_contact" },
    });
    expect(resFiltered.orphans).toHaveLength(2);

    const resAll = await listOrphanInbounds();
    expect(resAll.orphans).toHaveLength(3);
  });

  it("filtre `source` applique correctement", async () => {
    await seedOrphan("k1", "unknown_contact", "process-reply");
    await seedOrphan("k2", "parse_failed", "webhook-ovh-sms");

    const res = await listOrphanInbounds({ filters: { source: "webhook-ovh-sms" } });
    expect(res.orphans).toHaveLength(1);
    expect(res.orphans[0]?.source).toBe("webhook-ovh-sms");
  });

  it("pagination cursor", async () => {
    for (let i = 0; i < 5; i++) {
      await seedOrphan(`k_${i}`, "unknown_contact");
    }

    const page1 = await listOrphanInbounds({ limit: 2 });
    expect(page1.orphans).toHaveLength(2);
    expect(page1.hasMore).toBe(true);

    const page2 = await listOrphanInbounds({
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.orphans).toHaveLength(2);
    const ids1 = new Set(page1.orphans.map((o) => o.docId));
    for (const o of page2.orphans) expect(ids1.has(o.docId)).toBe(false);
  });

  it("shape : docId présent + reason + body + receivedAt", async () => {
    await seedOrphan("k_shape", "unknown_contact", "process-reply", "Hello orphelin test");

    const res = await listOrphanInbounds();
    expect(res.orphans).toHaveLength(1);
    const o = res.orphans[0];
    expect(o?.docId).toMatch(/^oih_/);
    expect(o?.reason).toBe("unknown_contact");
    expect(o?.body).toBe("Hello orphelin test");
    expect(o?.source).toBe("process-reply");
    expect(o?.phoneHash).toBe("hph_k_shape");
    expect(o?.receivedAt).toBeDefined();
  });

  it("collection vide → orphans=[], hasMore=false, nextCursor=null", async () => {
    const res = await listOrphanInbounds();
    expect(res.orphans).toEqual([]);
    expect(res.hasMore).toBe(false);
    expect(res.nextCursor).toBeNull();
  });

  it("limit hors bornes → ValidationError", async () => {
    await expect(listOrphanInbounds({ limit: 150 })).rejects.toBeInstanceOf(ValidationError);
    await expect(listOrphanInbounds({ limit: 0 })).rejects.toBeInstanceOf(ValidationError);
  });

  it("cursor inexistant → ValidationError", async () => {
    await seedOrphan("k1", "unknown_contact");
    await expect(listOrphanInbounds({ cursor: "oih_no_such_doc" })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
