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
import type { AuditAction, AuditLogInput } from "@/types/audit-log";

import {
  __APP_NAME_FOR_TESTS,
  __getAppByName,
  __resetFirestoreAdminForTests,
  getAdminDb,
} from "./admin";
import { __ACTIONS_FOR_TESTS, __AUDIT_COLLECTION_FOR_TESTS, appendAuditLog } from "./audit-log";

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

// ─────────────────────────────────────────────────────────────────────────────
// Sentinelle S9.1 — anti-drift TS type vs runtime whitelist
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 🔒 SENTINELLE GAP-S9.1 — verrouille l'égalité ensembliste entre
 * `AuditAction` (type TS, `src/types/audit-log.ts`) et `ACTIONS` (whitelist
 * runtime Zod, `src/lib/firestore/audit-log.ts`).
 *
 * Pourquoi un hardcoded `Set<AuditAction>` :
 *   - Un type TS est effacé au compile-time → impossible de comparer
 *     programmatiquement `AuditAction` (type) avec `ACTIONS` (runtime).
 *   - Le hardcoded set typé `Set<AuditAction>` force le dev à éditer
 *     3 endroits cohérents :
 *       (a) le type TS (src/types/audit-log.ts)
 *       (b) la whitelist runtime (src/lib/firestore/audit-log.ts::ACTIONS)
 *       (c) ce hardcoded EXPECTED (ce fichier)
 *     Si l'un des 3 dérive, le build casse — c'est l'objectif explicite.
 *
 * Le typage `ReadonlySet<AuditAction>` côté EXPECTED rend la première
 * ligne de défense : si une string ne fait pas partie de AuditAction,
 * TS refuse au compile-time. Si AuditAction grandit mais pas EXPECTED,
 * l'assertion runtime casse (Set inégal).
 */
const EXPECTED_AUDIT_ACTIONS: ReadonlySet<AuditAction> = new Set<AuditAction>([
  // SMS OUTBOUND
  "sms_sent",
  "sms_failed",
  "sms_provider_dispatched",
  "send_blocked",
  // SMS INBOUND (S9.1 + S9.3.3a + S9.4.1)
  "sms_received",
  "intent_classified",
  "reply_generated",
  "reply_processed",
  "reply_dropped",
  "reply_draft_dropped",
  "long_form_opt_out_candidate",
  // CONVERSATION lifecycle
  "opt_out",
  "handoff",
  "handoff_accepted",
  // CAMPAIGN / ADMIN
  "manual_override",
  "prompt_changed",
  "campaign_started",
  "campaign_paused",
  // DATA
  "bloctel_imported",
  "contact_deleted",
  "contact_anonymized",
  // AUTH
  "login",
  "role_changed",
  // TRANSVERSE
  "compliance_check",
  "status_changed",
]);

describe("ACTIONS whitelist — sentinelle anti-drift TS ↔ runtime (S9.1)", () => {
  it("égalité ensembliste : __ACTIONS_FOR_TESTS === EXPECTED_AUDIT_ACTIONS", () => {
    // Si un dev ajoute une action côté types/audit-log.ts sans la mirorer
    // côté lib/firestore/audit-log.ts (ou inversement), ce test casse.
    // L'opérateur Set préserve l'identité de chaque string indépendamment
    // de l'ordre dans la définition.
    const runtimeSet = new Set(__ACTIONS_FOR_TESTS);
    expect(runtimeSet).toEqual(EXPECTED_AUDIT_ACTIONS);
  });

  it("nombre d'actions correspond (sanity check)", () => {
    expect(__ACTIONS_FOR_TESTS.length).toBe(EXPECTED_AUDIT_ACTIONS.size);
  });

  it("contient les 3 actions inbound S9.1 (sentinelles dédiées)", () => {
    // Verrouillage spécifique pour repérer un revert/squash accidentel
    // des 3 ajouts S9.1.
    expect(EXPECTED_AUDIT_ACTIONS.has("intent_classified")).toBe(true);
    expect(EXPECTED_AUDIT_ACTIONS.has("reply_processed")).toBe(true);
    expect(EXPECTED_AUDIT_ACTIONS.has("reply_dropped")).toBe(true);
  });

  it("contient l'action S9.3.3a `reply_generated` (sentinelle dédiée)", () => {
    // Verrouillage spécifique pour repérer un revert/squash accidentel
    // de l'ajout S9.3.3a (stockage draft IA). Si retiré, le pipeline
    // process-reply step 8 (S9.3.3b) ne pourra plus poser cet audit.
    expect(EXPECTED_AUDIT_ACTIONS.has("reply_generated")).toBe(true);
  });

  it("contient l'action S9.4.1 `reply_draft_dropped` (sentinelle dédiée)", () => {
    // Verrouillage spécifique pour repérer un revert/squash accidentel
    // de l'ajout S9.4.1 (rejet draft par preSendCheckWithAuditTx). Si
    // retiré, `commitDraftToQueued` ne pourra plus poser cet audit en
    // branche blocked → trou forensique consent drift.
    expect(EXPECTED_AUDIT_ACTIONS.has("reply_draft_dropped")).toBe(true);
  });
});

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

    it("le message d'erreur indique explicitement 'safePhoneHash()' (guidance dev, fix HIGH-1 S9.2.1)", async () => {
      const tainted: AuditLogInput = {
        ...validEntry,
        payload: { p: "+33612345678" },
      };
      try {
        await appendAuditLog(tainted);
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(AuditPiiError);
        // Pointe le dev vers la BONNE primitive : safePhoneHash (préfixe
        // + chunking → scrubber-safe). `hashPii` brut a ~0.3% de
        // collision sur RE_FR_NATIONAL (cf. JSDoc hashPii).
        expect((e as Error).message).toContain("safePhoneHash()");
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

// ─────────────────────────────────────────────────────────────────────────────
// S9.3.3b — Sentinelle NIT-1 anti-PII payload reply_generated
//
// 🚨 LOW-4 compliance-auditor S9.3.2 + NIT-1 compliance-auditor S9.3.3a :
// "ne JAMAIS persister result.text dans audit_log.payload.reply_generated".
// Le body draft est stocké DANS messages/{draftMessageId} (forensic L.34-5
// CPCE par doc Message), JAMAIS dans audit_log.payload (historisation
// événement SANS contenu).
//
// LIMITATION HONNÊTE — Sentinelle TS @ts-expect-error NON LIVRÉE :
// `ReplyGeneratedPayload` (src/types/audit-log.ts) expose une index
// signature `readonly [k: string]: unknown` nécessaire à l'assignation à
// `AuditLogInput.payload: Record<string, unknown>` (TS limitation). Cette
// index signature accepte n'importe quelle clé (y compris "body") — donc
// `@ts-expect-error` sur `body: "leak"` ne fonctionnerait PAS. Trace :
// follow-up Notion `S9.4-AUDIT-STRICT-PAYLOAD-SCHEMAS-001` (validation
// Zod stricte par action retire l'index signature et restaure le typage
// strict compile-time).
//
// La sentinelle RUNTIME ci-dessous reste le filet de sécurité actif :
// si un caller bypass `as any` un body contenant un téléphone E.164 /
// FR national / email, le scrubber `detectPiiInPayload` (S6.2) attrape
// et `appendAuditLog` throw `AuditPiiError` → rollback Firestore.
// ─────────────────────────────────────────────────────────────────────────────

describe("S9.3.3b — sentinelle NIT-1 reply_generated anti-PII (defense-in-depth)", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_PII_PEPPER", PEPPER);
    await fullReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fullReset();
  });

  it("body contenant un E.164 dans payload reply_generated → AuditPiiError + 0 doc créé", async () => {
    // 🔒 Sentinelle defense-in-depth : si un caller bypass via `as any`
    // un payload contenant un body qui leak un téléphone E.164, le
    // scrubber attrape et REFUSE l'écriture.
    const payloadWithLeakedPhone = {
      contactId: "ct_test",
      conversationId: "cv_test",
      draftMessageId: "msg_test",
      intent: "INTERESSE",
      promptVersion: "1.0.0",
      model: "claude-sonnet-4-6",
      temperature: 0.5,
      tokensInput: 100,
      tokensOutput: 50,
      bodyLength: 60,
      generationDurationMs: 500,
      // 🚨 INTERDIT — un body LLM qui aurait miroiré un téléphone du PS.
      body: "Bonjour, mon numéro de mobile est +33612345678 si besoin",
    };

    await expect(
      appendAuditLog({
        actorId: "system",
        actorType: "system",
        action: "reply_generated",
        targetType: "message",
        targetId: "msg_test",
        payload: payloadWithLeakedPhone,
      }),
    ).rejects.toBeInstanceOf(AuditPiiError);

    // 0 doc créé (refus = pas d'écriture partielle).
    expect(await countAuditDocs()).toBe(0);
  });

  it("body contenant un FR national dans payload reply_generated → AuditPiiError + 0 doc créé", async () => {
    // Variant FR national — 10 chiffres `0[1-9]\d{8}` (anti-bypass strip).
    const payloadWithLeakedFRNational = {
      contactId: "ct_test_fr",
      conversationId: "cv_test_fr",
      draftMessageId: "msg_test_fr",
      intent: "OBJECTION",
      promptVersion: "1.0.0",
      model: "claude-sonnet-4-6",
      temperature: 0.5,
      tokensInput: 100,
      tokensOutput: 50,
      bodyLength: 50,
      generationDurationMs: 500,
      body: "Mon numéro 0612345678 si rappel possible",
    };

    await expect(
      appendAuditLog({
        actorId: "system",
        actorType: "system",
        action: "reply_generated",
        targetType: "message",
        targetId: "msg_test_fr",
        payload: payloadWithLeakedFRNational,
      }),
    ).rejects.toBeInstanceOf(AuditPiiError);

    expect(await countAuditDocs()).toBe(0);
  });

  it("body contenant un email dans payload reply_generated → AuditPiiError + 0 doc créé", async () => {
    const payloadWithLeakedEmail = {
      contactId: "ct_test_em",
      conversationId: "cv_test_em",
      draftMessageId: "msg_test_em",
      intent: "NEUTRE",
      promptVersion: "1.0.0",
      model: "claude-sonnet-4-6",
      temperature: 0.5,
      tokensInput: 100,
      tokensOutput: 50,
      bodyLength: 45,
      generationDurationMs: 500,
      body: "Contactez-moi sur contact@cabinet-medecin.fr",
    };

    await expect(
      appendAuditLog({
        actorId: "system",
        actorType: "system",
        action: "reply_generated",
        targetType: "message",
        targetId: "msg_test_em",
        payload: payloadWithLeakedEmail,
      }),
    ).rejects.toBeInstanceOf(AuditPiiError);

    expect(await countAuditDocs()).toBe(0);
  });

  it("payload reply_generated CONFORME (sans body, scrubber-safe) → succès + doc créé", async () => {
    // Sentinelle baseline : le payload légitime du pipeline S9.3.3b
    // (cf. process-reply.ts:881) est accepté. Si ce test casse, c'est
    // qu'un faux positif scrubber a été introduit.
    const validPayload = {
      contactId: "hs_dent_paris_01",
      conversationId: "hs_dent_paris_01_dentistes-idf-mai-2026",
      draftMessageId: "draft_FirestoreAutoId20",
      intent: "INTERESSE",
      promptVersion: "1.0.0",
      model: "claude-sonnet-4-6",
      temperature: 0.5,
      tokensInput: 540,
      tokensOutput: 38,
      bodyLength: 95,
      generationDurationMs: 1234,
    };

    const docId = await appendAuditLog({
      actorId: "system",
      actorType: "system",
      action: "reply_generated",
      targetType: "message",
      targetId: "draft_FirestoreAutoId20",
      payload: validPayload,
    });

    expect(docId).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(await countAuditDocs()).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S9.4.1 — Sentinelle anti-PII payload reply_draft_dropped
//
// 🚨 Pattern miroir S9.3.3b reply_generated. Le payload reply_draft_dropped
// est posé HORS tx en best-effort par `commitDraftToQueued` après rollback.
// Defense-in-depth scrubber : si un caller bypass `as any` une valeur
// `blockedContext` contenant un téléphone E.164 / FR national / email,
// `detectPiiInPayload` (S6.2) attrape et `appendAuditLog` throw
// `AuditPiiError` → 0 doc créé.
//
// LIMITATION IDENTIQUE S9.3.3b : `ReplyDraftDroppedPayload` expose une
// index signature `readonly [k: string]: unknown` nécessaire à
// l'assignation à `AuditLogInput.payload: Record<string, unknown>` (TS
// limitation). Cette index signature accepte n'importe quelle clé. Trace
// follow-up partagée : `S9.4-AUDIT-STRICT-PAYLOAD-SCHEMAS-001` (validation
// Zod stricte par action retire l'index signature au compile-time).
// ─────────────────────────────────────────────────────────────────────────────

describe("S9.4.1 — sentinelle reply_draft_dropped anti-PII (defense-in-depth)", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_PII_PEPPER", PEPPER);
    await fullReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fullReset();
  });

  it("blockedContext avec E.164 → AuditPiiError + 0 doc créé", async () => {
    // Cas anormal : un dev bypass via `as any` un blockedContext qui
    // contient un téléphone E.164. Le scrubber attrape.
    const payloadWithLeakedPhone = {
      contactId: "ct_test",
      conversationId: "cv_test",
      draftMessageId: "msg_test",
      blockedRule: "rate_limit",
      blockedCode: "rate_limit_exceeded",
      // 🚨 INTERDIT — blockedContext ne devrait JAMAIS contenir de PII (la
      // discriminated union FERMÉE de pre-send-check.ts l'exclut au
      // compile-time, mais defense-in-depth runtime).
      blockedContext: { contactPhone: "+33612345678", count: 3 },
    };

    await expect(
      appendAuditLog({
        actorId: "system",
        actorType: "system",
        action: "reply_draft_dropped",
        targetType: "message",
        targetId: "msg_test",
        payload: payloadWithLeakedPhone,
      }),
    ).rejects.toBeInstanceOf(AuditPiiError);

    expect(await countAuditDocs()).toBe(0);
  });

  it("blockedContext avec FR national → AuditPiiError + 0 doc créé", async () => {
    const payloadWithLeakedFRNational = {
      contactId: "ct_test_fr",
      conversationId: "cv_test_fr",
      draftMessageId: "msg_test_fr",
      blockedRule: "phone_validity",
      blockedCode: "phone_invalid",
      blockedContext: { phone: "0612345678" },
    };

    await expect(
      appendAuditLog({
        actorId: "system",
        actorType: "system",
        action: "reply_draft_dropped",
        targetType: "message",
        targetId: "msg_test_fr",
        payload: payloadWithLeakedFRNational,
      }),
    ).rejects.toBeInstanceOf(AuditPiiError);

    expect(await countAuditDocs()).toBe(0);
  });

  it("blockedContext avec email → AuditPiiError + 0 doc créé", async () => {
    const payloadWithLeakedEmail = {
      contactId: "ct_test_em",
      conversationId: "cv_test_em",
      draftMessageId: "msg_test_em",
      blockedRule: "opt_out",
      blockedCode: "opted_out",
      blockedContext: { reportedEmail: "ps@cabinet.fr" },
    };

    await expect(
      appendAuditLog({
        actorId: "system",
        actorType: "system",
        action: "reply_draft_dropped",
        targetType: "message",
        targetId: "msg_test_em",
        payload: payloadWithLeakedEmail,
      }),
    ).rejects.toBeInstanceOf(AuditPiiError);

    expect(await countAuditDocs()).toBe(0);
  });

  it("payload reply_draft_dropped CONFORME (rule rate_limit + context typé) → succès + doc créé", async () => {
    // Sentinelle baseline : payload légitime posé par commitDraftToQueued
    // en branche blocked. La discriminated union FERMÉE de S5 garantit
    // que blockedContext ne contient que des nombres/strings non-PII.
    const validPayload = {
      contactId: "hs_dent_paris_01",
      conversationId: "hs_dent_paris_01_dentistes-idf-mai-2026",
      draftMessageId: "draft_FirestoreAutoId20",
      blockedRule: "rate_limit",
      blockedCode: "rate_limit_exceeded",
      blockedContext: { count: 3, maxAllowed: 3, windowDays: 30 },
    };

    const docId = await appendAuditLog({
      actorId: "system",
      actorType: "system",
      action: "reply_draft_dropped",
      targetType: "message",
      targetId: "draft_FirestoreAutoId20",
      payload: validPayload,
    });

    expect(docId).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(await countAuditDocs()).toBe(1);
  });

  it("payload reply_draft_dropped avec blockedRule hours + context isoDate → succès", async () => {
    // Variante avec blockedContext `{isoDate}` (rule "hours" → "holiday").
    // Vérifie qu'une string ISO YYYY-MM-DD passe le scrubber (pas de
    // false positive sur les dates).
    const validPayload = {
      contactId: "hs_med_idf_42",
      conversationId: "hs_med_idf_42_medecins-mai-2026",
      draftMessageId: "draft_AutoId4Holiday",
      blockedRule: "hours",
      blockedCode: "holiday",
      blockedContext: { isoDate: "2026-05-21" },
    };

    const docId = await appendAuditLog({
      actorId: "system",
      actorType: "system",
      action: "reply_draft_dropped",
      targetType: "message",
      targetId: "draft_AutoId4Holiday",
      payload: validPayload,
    });

    expect(docId).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(await countAuditDocs()).toBe(1);
  });
});
