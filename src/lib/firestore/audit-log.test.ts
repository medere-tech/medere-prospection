/**
 * Tests audit-log.ts contre l'emulator. Couvre :
 *   - Sentinelles PII (E.164, FR national, email, nested) → throw + 0 doc
 *   - Happy path : Zod ok + payload propre → doc créé + timestamp serveur
 *   - Idempotence : 2 appels → 2 docs distincts
 *   - Zod : action / actorType / champs requis / payload manquant → throw
 *
 * Le setup global `tests/firestore/setup.ts` clear toute la collection
 * entre chaque test → l'assertion "0 doc créé" est triviale via count.
 */
import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetEnvCacheForTests } from "@/lib/security/env";
import { AuditPiiError, ValidationError } from "@/lib/utils/errors";
import type { AuditLogInput } from "@/types/audit-log";

import {
  __APP_NAME_FOR_TESTS,
  __getAppByName,
  __resetFirestoreAdminForTests,
  getAdminDb,
} from "./admin";
import { __AUDIT_COLLECTION_FOR_TESTS, appendAuditLog } from "./audit-log";

const PEPPER = "a".repeat(64);

const validEntry: AuditLogInput = {
  actorId: "system",
  actorType: "system",
  action: "compliance_check",
  targetType: "contact",
  targetId: "contact_abc123",
  payload: {
    result: "allowed",
    rule: "rate_limit",
  },
};

async function fullReset() {
  __resetFirestoreAdminForTests();
  const app = __getAppByName(__APP_NAME_FOR_TESTS);
  if (app) {
    await deleteApp(app);
  }
  __resetEnvCacheForTests();
}

async function countAuditDocs(): Promise<number> {
  const snap = await getAdminDb().collection(__AUDIT_COLLECTION_FOR_TESTS).get();
  return snap.size;
}

describe("appendAuditLog", () => {
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
  // Sentinelles PII
  // ───────────────────────────────────────────────────────────────────────

  describe("sentinelles PII — refuse l'écriture", () => {
    it("phone E.164 en clair → throw AuditPiiError + AUCUN doc créé", async () => {
      const tainted: AuditLogInput = {
        ...validEntry,
        payload: { phone: "+33612345678" },
      };
      await expect(appendAuditLog(tainted)).rejects.toBeInstanceOf(AuditPiiError);
      expect(await countAuditDocs()).toBe(0);
    });

    it("phone FR national en clair → throw AuditPiiError + AUCUN doc créé", async () => {
      const tainted: AuditLogInput = {
        ...validEntry,
        payload: { telephone: "0612345678" },
      };
      await expect(appendAuditLog(tainted)).rejects.toBeInstanceOf(AuditPiiError);
      expect(await countAuditDocs()).toBe(0);
    });

    it("email en clair → throw AuditPiiError + AUCUN doc créé", async () => {
      const tainted: AuditLogInput = {
        ...validEntry,
        payload: { contact: "dr.dupont@cabinet.fr" },
      };
      await expect(appendAuditLog(tainted)).rejects.toBeInstanceOf(AuditPiiError);
      expect(await countAuditDocs()).toBe(0);
    });

    it("PII nested (objet imbriqué) → throw AuditPiiError + AUCUN doc créé", async () => {
      const tainted: AuditLogInput = {
        ...validEntry,
        payload: {
          metadata: { recipient: { phone: "+33612345678" } },
        },
      };
      await expect(appendAuditLog(tainted)).rejects.toBeInstanceOf(AuditPiiError);
      expect(await countAuditDocs()).toBe(0);
    });

    it("le message d'erreur indique explicitement 'hashPii()' (guidance dev)", async () => {
      const tainted: AuditLogInput = {
        ...validEntry,
        payload: { p: "+33612345678" },
      };
      try {
        await appendAuditLog(tainted);
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(AuditPiiError);
        expect((e as Error).message).toContain("hashPii()");
      }
    });

    it("le context.violations est sanitisé (path + kind + sample = '[redacted]' constant)", async () => {
      const tainted: AuditLogInput = {
        ...validEntry,
        payload: { p: "+33612345678" },
      };
      try {
        await appendAuditLog(tainted);
        expect.fail("should have thrown");
      } catch (e) {
        const err = e as AuditPiiError;
        const ctx = err.context as { violations: unknown[] };
        expect(Array.isArray(ctx.violations)).toBe(true);
        expect(ctx.violations.length).toBeGreaterThan(0);
        // Aucune valeur d'origine dans le contexte sérialisé.
        const serialized = JSON.stringify(err.context);
        expect(serialized).not.toContain("612345678");
        expect(serialized).not.toContain("+33612345678");
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Happy path
  // ───────────────────────────────────────────────────────────────────────

  describe("happy path", () => {
    it("payload propre → doc créé, retourne docId Firestore", async () => {
      const docId = await appendAuditLog(validEntry);
      expect(typeof docId).toBe("string");
      expect(docId.length).toBeGreaterThan(0);
      expect(await countAuditDocs()).toBe(1);
    });

    it("le timestamp est posé côté serveur (Timestamp Firestore, pas un Date JS)", async () => {
      const before = Date.now();
      const docId = await appendAuditLog(validEntry);
      const after = Date.now();

      const doc = await getAdminDb().collection(__AUDIT_COLLECTION_FOR_TESTS).doc(docId).get();
      const data = doc.data();
      expect(data?.timestamp).toBeInstanceOf(Timestamp);

      const tsMs = (data?.timestamp as Timestamp).toMillis();
      expect(tsMs).toBeGreaterThanOrEqual(before);
      expect(tsMs).toBeLessThanOrEqual(after + 5_000);
    });

    it("l'entrée persiste les champs exacts (actorId, action, payload)", async () => {
      const docId = await appendAuditLog(validEntry);
      const doc = await getAdminDb().collection(__AUDIT_COLLECTION_FOR_TESTS).doc(docId).get();
      const data = doc.data();
      expect(data?.actorId).toBe(validEntry.actorId);
      expect(data?.action).toBe(validEntry.action);
      expect(data?.payload).toEqual(validEntry.payload);
      expect(data?.targetType).toBe(validEntry.targetType);
    });

    it("idempotence : 2 appels successifs → 2 docs distincts", async () => {
      const id1 = await appendAuditLog(validEntry);
      const id2 = await appendAuditLog(validEntry);
      expect(id1).not.toBe(id2);
      expect(await countAuditDocs()).toBe(2);
    });

    it("ipAddress et userAgent sont optionnels (omis → écriture OK)", async () => {
      const docId = await appendAuditLog(validEntry);
      const doc = await getAdminDb().collection(__AUDIT_COLLECTION_FOR_TESTS).doc(docId).get();
      const data = doc.data();
      expect(data?.ipAddress).toBeUndefined();
      expect(data?.userAgent).toBeUndefined();
    });

    it("ipAddress et userAgent persistés s'ils sont fournis", async () => {
      const docId = await appendAuditLog({
        ...validEntry,
        ipAddress: "203.0.113.42",
        userAgent: "Mozilla/5.0 (compat; MedereBot/1.0)",
      });
      const doc = await getAdminDb().collection(__AUDIT_COLLECTION_FOR_TESTS).doc(docId).get();
      const data = doc.data();
      expect(data?.ipAddress).toBe("203.0.113.42");
      expect(data?.userAgent).toContain("MedereBot");
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Zod — validation structurelle
  // ───────────────────────────────────────────────────────────────────────

  describe("Zod — validation structurelle", () => {
    it("action hors enum → throw ValidationError + 0 doc", async () => {
      const bad = {
        ...validEntry,
        action: "not_a_real_action",
      } as unknown as AuditLogInput;
      await expect(appendAuditLog(bad)).rejects.toBeInstanceOf(ValidationError);
      expect(await countAuditDocs()).toBe(0);
    });

    it("actorType hors enum → throw ValidationError + 0 doc", async () => {
      const bad = {
        ...validEntry,
        actorType: "alien",
      } as unknown as AuditLogInput;
      await expect(appendAuditLog(bad)).rejects.toBeInstanceOf(ValidationError);
      expect(await countAuditDocs()).toBe(0);
    });

    it("actorId vide → throw ValidationError", async () => {
      const bad = { ...validEntry, actorId: "" };
      await expect(appendAuditLog(bad)).rejects.toBeInstanceOf(ValidationError);
    });

    it("targetId vide → throw ValidationError", async () => {
      const bad = { ...validEntry, targetId: "" };
      await expect(appendAuditLog(bad)).rejects.toBeInstanceOf(ValidationError);
    });

    it("payload manquant → throw ValidationError", async () => {
      const bad = { ...validEntry } as Partial<AuditLogInput>;
      delete bad.payload;
      await expect(appendAuditLog(bad as AuditLogInput)).rejects.toBeInstanceOf(ValidationError);
    });

    it("ValidationError porte un context.issues avec les paths invalides", async () => {
      const bad = {
        ...validEntry,
        actorType: "alien",
        action: "not_a_real_action",
      } as unknown as AuditLogInput;
      try {
        await appendAuditLog(bad);
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationError);
        const ctx = (e as ValidationError).context as {
          issues: { path: string; code: string }[];
        };
        const paths = ctx.issues.map((i) => i.path);
        expect(paths).toContain("actorType");
        expect(paths).toContain("action");
      }
    });
  });
});
