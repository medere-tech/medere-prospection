/**
 * Tests EMULATOR — `listAuditLogByTarget` (VUE-CONVERSATION PR0.4).
 *
 * Couvre :
 *   - Filtre `targetType + targetId`.
 *   - Ordre `timestamp desc` (plus récent en haut).
 *   - Pagination cursor.
 *   - Shape complète + `docId` ajouté.
 *   - Garde-fous (targetId vide, limit hors bornes, cursor inexistant).
 */
import { deleteApp } from "firebase-admin/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __APP_NAME_FOR_TESTS,
  __getAppByName,
  __resetFirestoreAdminForTests,
} from "@/lib/firestore/admin";
import { appendAuditLog, listAuditLogByTarget } from "@/lib/firestore/audit-log";
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

async function seedAudit(action: string, targetType: string, targetId: string) {
  await appendAuditLog({
    actorId: "U05UVHGBURX",
    actorType: "human",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    action: action as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    targetType: targetType as any,
    targetId,
    payload: { note: "test" },
  });
  // Petit délai pour garantir des timestamps distincts (Firestore server
  // time a une résolution milliseconde — serveur réel). L'emulator
  // supporte les timestamps strictement croissants même sans sleep.
  await new Promise((r) => setTimeout(r, 2));
}

describe("listAuditLogByTarget — persist emulator (VUE-CONVERSATION PR0)", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_PII_PEPPER", PEPPER);
    await fullReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fullReset();
  });

  it("filtre targetType + targetId correctement", async () => {
    await seedAudit("handoff", "conversation", "conv_A");
    await seedAudit("sms_sent", "conversation", "conv_A");
    await seedAudit("handoff", "conversation", "conv_B"); // autre cible
    await seedAudit("contact_created", "contact", "cnt_A"); // autre type

    const res = await listAuditLogByTarget({
      targetType: "conversation",
      targetId: "conv_A",
    });
    expect(res.entries).toHaveLength(2);
    expect(res.entries.map((e) => e.action).sort()).toEqual(["handoff", "sms_sent"]);
  });

  it("mutation — ne retourne que la cible filtrée (si le filtre saute, conv_B apparaît)", async () => {
    await seedAudit("handoff", "conversation", "conv_A");
    await seedAudit("handoff", "conversation", "conv_B");

    const res = await listAuditLogByTarget({
      targetType: "conversation",
      targetId: "conv_A",
    });
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]?.targetId).toBe("conv_A");
  });

  it("ordre timestamp desc (plus récent en haut)", async () => {
    await seedAudit("handoff", "conversation", "conv_X");
    await seedAudit("sms_sent", "conversation", "conv_X");
    await seedAudit("opt_out", "conversation", "conv_X");

    const res = await listAuditLogByTarget({
      targetType: "conversation",
      targetId: "conv_X",
    });
    // Dernier seed = opt_out, doit être en premier
    expect(res.entries[0]?.action).toBe("opt_out");
    expect(res.entries[res.entries.length - 1]?.action).toBe("handoff");
  });

  it("pagination cursor", async () => {
    for (let i = 0; i < 5; i++) {
      await seedAudit("compliance_check", "conversation", "conv_P");
    }

    const page1 = await listAuditLogByTarget({
      targetType: "conversation",
      targetId: "conv_P",
      limit: 2,
    });
    expect(page1.entries).toHaveLength(2);
    expect(page1.hasMore).toBe(true);

    const page2 = await listAuditLogByTarget({
      targetType: "conversation",
      targetId: "conv_P",
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.entries).toHaveLength(2);
    const ids1 = new Set(page1.entries.map((e) => e.docId));
    for (const e of page2.entries) expect(ids1.has(e.docId)).toBe(false);
  });

  it("shape complète : docId + tous les champs AuditLog", async () => {
    await seedAudit("handoff", "conversation", "conv_S");
    const res = await listAuditLogByTarget({
      targetType: "conversation",
      targetId: "conv_S",
    });
    expect(res.entries).toHaveLength(1);
    const e = res.entries[0];
    expect(e?.docId).toBeTruthy();
    expect(e?.action).toBe("handoff");
    expect(e?.targetType).toBe("conversation");
    expect(e?.targetId).toBe("conv_S");
    expect(e?.actorType).toBe("human");
    expect(e?.actorId).toBe("U05UVHGBURX");
    expect(e?.timestamp).toBeDefined();
  });

  it("targetId vide → ValidationError", async () => {
    await expect(
      listAuditLogByTarget({ targetType: "conversation", targetId: "" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("limit hors bornes → ValidationError", async () => {
    await expect(
      listAuditLogByTarget({ targetType: "conversation", targetId: "x", limit: 150 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      listAuditLogByTarget({ targetType: "conversation", targetId: "x", limit: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("cursor inexistant → ValidationError", async () => {
    await seedAudit("handoff", "conversation", "conv_Z");
    await expect(
      listAuditLogByTarget({
        targetType: "conversation",
        targetId: "conv_Z",
        cursor: "no_such_audit",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
