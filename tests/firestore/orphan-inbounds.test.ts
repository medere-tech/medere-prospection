/**
 * Tests emulator — persistance reelle dans `inbound_messages_orphans/`
 * via `addOrphanInboundIdempotent` (PR-NO-DROPPED-SMS).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi ce fichier
 *
 * Les tests unitaires mockent `.create()` et ne touchent pas le SDK Admin.
 * Apres l'extraction du primitif partage `_idempotent.ts`, on verifie :
 *   1. Firestore Admin accepte un write via `addOrphanInboundIdempotent`.
 *   2. docId deterministe (`safeExternalIdHash` prefixe `oih_` + chunking).
 *   3. Idempotence : 2 appels concurrents sur le meme `idempotencyKey`
 *      produisent 1 SEUL document.
 *   4. Shape persistee conforme (receivedAt serverTimestamp, body present,
 *      champs optionnels respectes).
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
  addOrphanInboundIdempotent,
  ORPHAN_INBOUNDS_COLLECTION,
} from "@/lib/firestore/orphan-inbounds";
import { __resetEnvCacheForTests } from "@/lib/security/env";

const PEPPER = "b".repeat(64);

async function fullReset() {
  vi.restoreAllMocks();
  __resetFirestoreAdminForTests();
  const app = __getAppByName(__APP_NAME_FOR_TESTS);
  if (app) {
    await deleteApp(app);
  }
  __resetEnvCacheForTests();
}

describe("inbound_messages_orphans — persist emulator (PR-NO-DROPPED-SMS)", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_PII_PEPPER", PEPPER);
    await fullReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fullReset();
  });

  it("happy path -> created=true, docId prefix oih_, receivedAt Timestamp, body conserve", async () => {
    const result = await addOrphanInboundIdempotent({
      reason: "unknown_contact",
      body: "Bonjour, je souhaite m'inscrire",
      idempotencyKey: "ovh-orphan-happy-001",
      source: "process-reply",
      phoneHash: "hph_abcdef0123456789abcdef0123456789",
    });

    expect(result.created).toBe(true);
    expect(result.docId).toMatch(/^oih_/);

    const snap = await getAdminDb().collection(ORPHAN_INBOUNDS_COLLECTION).doc(result.docId).get();
    expect(snap.exists).toBe(true);
    const data = snap.data();
    if (!data) throw new Error("doc data missing");

    expect(data.reason).toBe("unknown_contact");
    expect(data.body).toBe("Bonjour, je souhaite m'inscrire");
    expect(data.idempotencyKey).toBe("ovh-orphan-happy-001");
    expect(data.source).toBe("process-reply");
    expect(data.phoneHash).toBe("hph_abcdef0123456789abcdef0123456789");
    expect(data.receivedAt).toBeInstanceOf(Timestamp);
  });

  it("2 appels concurrents meme idempotencyKey -> 1 seul doc, 1 gagnant + 1 perdant", async () => {
    const [r1, r2] = await Promise.all([
      addOrphanInboundIdempotent({
        reason: "parse_failed",
        body: "payload-race-A",
        idempotencyKey: "ovh-race-parse-001",
        source: "webhook-ovh-sms",
      }),
      addOrphanInboundIdempotent({
        reason: "parse_failed",
        body: "payload-race-B",
        idempotencyKey: "ovh-race-parse-001",
        source: "webhook-ovh-sms",
      }),
    ]);

    // Meme docId deterministe pour les 2 runs.
    expect(r1.docId).toBe(r2.docId);
    // 1 gagnant + 1 perdant.
    const outcomes = [r1.created, r2.created].sort();
    expect(outcomes).toEqual([false, true]);

    // 1 SEUL doc en base.
    const col = await getAdminDb()
      .collection(ORPHAN_INBOUNDS_COLLECTION)
      .where("idempotencyKey", "==", "ovh-race-parse-001")
      .get();
    expect(col.size).toBe(1);
  });

  it("deuxieme appel apres succes commit -> created=false (retry Inngest)", async () => {
    const r1 = await addOrphanInboundIdempotent({
      reason: "no_conversation",
      body: "Premier appel",
      idempotencyKey: "ovh-retry-001",
      source: "process-reply",
    });
    expect(r1.created).toBe(true);

    const r2 = await addOrphanInboundIdempotent({
      reason: "no_conversation",
      body: "Deuxieme appel (retry)",
      idempotencyKey: "ovh-retry-001",
      source: "process-reply",
    });
    expect(r2.created).toBe(false);
    expect(r2.docId).toBe(r1.docId);

    // Le body n'a PAS ete ecrase (first-write-wins par definition).
    const snap = await getAdminDb().collection(ORPHAN_INBOUNDS_COLLECTION).doc(r1.docId).get();
    expect(snap.data()?.body).toBe("Premier appel");
  });

  it("idempotencyKey vide -> ValidationError sans ecriture", async () => {
    await expect(
      addOrphanInboundIdempotent({
        reason: "parse_failed",
        body: "whatever",
        idempotencyKey: "",
        source: "webhook-ovh-sms",
      }),
    ).rejects.toThrow(/idempotencyKey must be non-empty/);
  });

  it("body > 1600 chars -> tronque a 1600", async () => {
    const longBody = "x".repeat(2500);
    const r = await addOrphanInboundIdempotent({
      reason: "parse_failed",
      body: longBody,
      idempotencyKey: "ovh-long-body-001",
      source: "webhook-ovh-sms",
    });
    const snap = await getAdminDb().collection(ORPHAN_INBOUNDS_COLLECTION).doc(r.docId).get();
    expect((snap.data()?.body as string).length).toBe(1600);
  });

  it("champs optionnels undefined ne sont PAS persistes (shape stricte)", async () => {
    const r = await addOrphanInboundIdempotent({
      reason: "unknown_contact",
      body: "test",
      idempotencyKey: "ovh-no-optional-001",
      source: "process-reply",
    });
    const snap = await getAdminDb().collection(ORPHAN_INBOUNDS_COLLECTION).doc(r.docId).get();
    const data = snap.data();
    if (!data) throw new Error("doc data missing");
    expect(data.phoneHash).toBeUndefined();
    expect(data.contactId).toBeUndefined();
    expect(data.conversationId).toBeUndefined();
    expect(data.wasOptOut).toBeUndefined();
  });
});
