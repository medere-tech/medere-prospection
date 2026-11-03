/**
 * Test emulator — scénario complet de reset-e2e-orphans (PR2c tour 2b bloc C).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Invariant protégé
 *
 *   Après qu'une fixture a été rattachée à une conversation puis réinitialisée
 *   par la logique de `scripts/reset-e2e-orphans.mjs`, les 4 champs d'état de
 *   la liste admin + `inboundCount` doivent être STRICTEMENT ÉGAUX à leurs
 *   valeurs d'avant le rattachement :
 *     - `lastMessageAt`
 *     - `lastInboundAt`
 *     - `lastMessagePreview` (direction, authorKind, text, at)
 *     - `lastHumanOutboundAt`
 *     - `inboundCount`
 *
 *   Avant le fix PR2c bloc C, `computeBackfillUpdatesForConversation` ne
 *   reposait QUE `lastMessagePreview` et `lastHumanOutboundAt`. Le reset
 *   effaçait `lastMessageAt` et `lastInboundAt` SANS les reposer → la conv
 *   quittait la liste admin (orderBy desc sur `lastMessageAt`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Zéro duplication
 *
 *   PR2c tour 2b bloc C quater : ce test importe désormais le module
 *   `src/lib/firestore/reset-e2e-orphans-core.ts` qui porte TOUTE la
 *   logique de reset (scan + prédiction + garde + écriture). Le script
 *   `scripts/reset-e2e-orphans.mjs` importe le même module — la logique
 *   vit à UN seul endroit.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Mutations sentinelles
 *
 *   1. Si on retire du backfill le bloc qui pose `lastMessageAt`, ce
 *      test échoue sur `expect(after).toEqual(before)` → régression
 *      PR2c bloc C initial capturée.
 *   2. Si on retire le `throw` de `assertSafeReset`, le test unitaire
 *      « assertSafeReset lève sur prediction.abort posé » échoue
 *      immédiatement → régression PR2c bloc C quater capturée.
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
import { buildLastMessagePreview } from "@/lib/firestore/conversation-list-fields";
import {
  addOrphanInboundIdempotent,
  attachOrphanToConversation,
  ORPHAN_INBOUNDS_COLLECTION,
} from "@/lib/firestore/orphan-inbounds";
import {
  applyResetWrites,
  assertSafeReset,
  predictConvStateAfterReset,
  type ResetPrediction,
  scanFixturesForReset,
} from "@/lib/firestore/reset-e2e-orphans-core";
import { __resetEnvCacheForTests } from "@/lib/security/env";

const PEPPER = "d".repeat(64);

async function fullReset() {
  vi.restoreAllMocks();
  __resetFirestoreAdminForTests();
  const app = __getAppByName(__APP_NAME_FOR_TESTS);
  if (app) await deleteApp(app);
  __resetEnvCacheForTests();
}

async function clearEmulator() {
  const db = getAdminDb();
  const collections = ["inbound_messages_orphans", "conversations", "contacts", "audit_log"];
  for (const name of collections) {
    const snap = await db.collection(name).listDocuments();
    for (const docRef of snap) {
      await db.recursiveDelete(docRef);
    }
  }
}

/**
 * Shape "snapshot" des 5 champs testés — sérialisée en ISO/number pour
 * `toEqual` strict (Timestamp ne compare pas par valeur par défaut).
 */
interface ConvSnapshot {
  lastMessageAtIso: string;
  lastInboundAtIso: string;
  lastHumanOutboundAtIso: string;
  previewText: string;
  previewDirection: string;
  previewAuthorKind: string;
  previewAtIso: string;
  inboundCount: number;
}

function readConvSnapshot(data: Record<string, unknown>): ConvSnapshot {
  const t = (v: unknown): string =>
    v instanceof Timestamp ? v.toDate().toISOString() : `UNSET:${String(v)}`;
  const preview = data.lastMessagePreview as
    | { direction: string; authorKind: string; text: string; at: Timestamp }
    | undefined;
  return {
    lastMessageAtIso: t(data.lastMessageAt),
    lastInboundAtIso: t(data.lastInboundAt),
    lastHumanOutboundAtIso: t(data.lastHumanOutboundAt),
    previewText: preview?.text ?? "UNSET",
    previewDirection: preview?.direction ?? "UNSET",
    previewAuthorKind: preview?.authorKind ?? "UNSET",
    previewAtIso: preview?.at ? t(preview.at) : "UNSET",
    inboundCount: typeof data.inboundCount === "number" ? data.inboundCount : -1,
  };
}

describe("reset-e2e-orphans — scénario complet (PR2c tour 2b bloc C)", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_PII_PEPPER", PEPPER);
    await fullReset();
    await clearEmulator();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fullReset();
  });

  it("conv réelle + attach + reset ⇒ les 5 champs STRICTEMENT égaux à avant", async () => {
    const db = getAdminDb();
    const convId = "crst_hubspot-list-9999";
    const contactId = "crst";
    const idempotencyKey = "rst-full-attach-1";

    // ── Seed contact ────────────────────────────────────────────────
    await db
      .collection("contacts")
      .doc(contactId)
      .set({
        hubspotId: contactId,
        firstName: "Jean",
        lastName: "Dupont",
        civilite: "Dr",
        speciality: "Chirurgien-dentiste",
        city: "Paris",
        postalCode: "75001",
        phone: {
          e164: "+33600000000",
          raw: "+33600000000",
          type: "mobile",
          valid: true,
          lookupAt: Timestamp.now(),
        },
        segment: "b2b_cabinet",
        bloctelChecked: false,
        bloctelOptOut: false,
        consent: {
          legitimateInterest: "contact test reset full scenario",
          optedOut: false,
        },
        enrichment: { source: "manual", enrichedAt: Timestamp.now() },
        status: "ready",
        campaignId: "hubspot-list-9999",
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      });

    // ── Seed 3 messages pré-rattachement avec des createdAt FIGÉS ─────
    //    inbound #1 (plus ancien) → outbound ai → outbound human (plus récent).
    //    Le dernier message = outbound human, donc `lastMessageAt =
    //    lastHumanOutboundAt`.
    const t1 = Timestamp.fromMillis(1_700_000_000_000);
    const t2 = Timestamp.fromMillis(1_700_000_060_000);
    const t3 = Timestamp.fromMillis(1_700_000_120_000);
    const inboundBodyBefore = "Bonjour, pouvez-vous me rappeler le prix ?";

    await db
      .collection("conversations")
      .doc(convId)
      .collection("messages")
      .doc("msg_1_inbound")
      .set({
        direction: "inbound",
        body: inboundBodyBefore,
        createdAt: t1,
        status: "received",
        channel: "sms",
      });
    await db.collection("conversations").doc(convId).collection("messages").doc("msg_2_ai").set({
      direction: "outbound",
      generatedBy: "ai",
      body: "Bonjour Dr Dupont, Léa de Médéré. Je vous rappelle…",
      createdAt: t2,
      status: "sent",
      channel: "sms",
    });
    const humanOutboundBody = "Merci Dr, voici la plaquette.";
    await db.collection("conversations").doc(convId).collection("messages").doc("msg_3_human").set({
      direction: "outbound",
      generatedBy: "human",
      body: humanOutboundBody,
      createdAt: t3,
      status: "sent",
      channel: "sms",
    });

    // ── Seed la conv avec les 4 champs d'état comme ils auraient été posés
    //    au fil de l'eau — on les reconstruit à la main pour que `before`
    //    reflète l'état canonique attendu.
    await db
      .collection("conversations")
      .doc(convId)
      .set({
        contactId,
        campaignId: "hubspot-list-9999",
        channel: "sms",
        status: "active",
        intent: "unknown",
        messageCount: 3,
        outboundCount: 2,
        inboundCount: 1,
        followupCount: 0,
        lastMessageAt: t3,
        lastInboundAt: t1,
        lastHumanOutboundAt: t3,
        lastMessagePreview: buildLastMessagePreview({
          direction: "outbound",
          authorKind: "human",
          text: humanOutboundBody,
          at: t3,
        }),
        createdAt: Timestamp.fromMillis(1_699_999_000_000),
        updatedAt: t3,
      });

    // ── Capture `before` ─────────────────────────────────────────────
    const beforeSnap = await db.collection("conversations").doc(convId).get();
    const before = readConvSnapshot(beforeSnap.data()!);
    expect(before.lastMessageAtIso).not.toMatch(/^UNSET:/);
    expect(before.lastInboundAtIso).not.toMatch(/^UNSET:/);
    expect(before.lastHumanOutboundAtIso).not.toMatch(/^UNSET:/);
    expect(before.inboundCount).toBe(1);

    // ── Attach : seed un orphan FIXTURE (isTestFixture=true) + rattache
    //    via un compte test. L'attach bump inboundCount, pose
    //    lastInboundAt, lastMessageAt et preview.
    const orphanSeed = await addOrphanInboundIdempotent({
      reason: "no_conversation",
      body: "Oui je prends la plaquette, envoyez tout !",
      idempotencyKey,
      source: "process-reply",
      isTestFixture: true,
    });
    const attachResult = await attachOrphanToConversation({
      orphanDocId: orphanSeed.docId,
      conversationId: convId,
      attachedBy: "user_admin_e2e",
      optOutConfirmed: false,
      actorTestAccount: true, // garde R-1 : fixture ↔ testAccount
    });

    // ── Verif attach a bien avancé les champs ───────────────────────
    const attachedSnap = await db.collection("conversations").doc(convId).get();
    const attached = readConvSnapshot(attachedSnap.data()!);
    expect(attached.inboundCount).toBe(before.inboundCount + 1);
    expect(attached.lastMessageAtIso).not.toBe(before.lastMessageAtIso);
    expect(attached.lastInboundAtIso).not.toBe(before.lastInboundAtIso);
    expect(attached.previewText).not.toBe(before.previewText);
    // lastHumanOutboundAt ne bouge PAS (le message rattaché est inbound).
    expect(attached.lastHumanOutboundAtIso).toBe(before.lastHumanOutboundAtIso);

    // ── Reset : SCAN → PREDICT → ASSERT SAFE → APPLY
    //    Toute cette logique vit dans `reset-e2e-orphans-core.ts` et est
    //    partagée avec le script CLI — zéro duplication côté test.
    const scan = await scanFixturesForReset(db, convId, [idempotencyKey]);
    expect(scan.refusedCount).toBe(0);
    expect(scan.touchedOrphans).toHaveLength(1);
    expect(scan.touchedMessages).toHaveLength(1);
    expect(scan.touchedMessages[0]!.messageId).toBe(attachResult.messageId);

    const prediction = await predictConvStateAfterReset(db, convId, scan.touchedMessages);
    expect(prediction.abort).toBeNull();
    assertSafeReset(prediction);

    await applyResetWrites({
      db,
      convId,
      touchedOrphans: scan.touchedOrphans,
      touchedMessages: scan.touchedMessages,
    });

    // ── Verif STRICTE égalité avec `before` ────────────────────────
    const afterSnap = await db.collection("conversations").doc(convId).get();
    const after = readConvSnapshot(afterSnap.data()!);
    expect(after).toEqual(before);

    // Et le message rattaché est bien supprimé (invariant du reset).
    const msgSnap = await db
      .collection("conversations")
      .doc(convId)
      .collection("messages")
      .doc(attachResult.messageId)
      .get();
    expect(msgSnap.exists).toBe(false);

    // L'orphan est bien revenu en pending (invariant append-only).
    const orphanAfter = await db.collection(ORPHAN_INBOUNDS_COLLECTION).doc(orphanSeed.docId).get();
    expect(orphanAfter.data()?.processingState).toBe("pending");
    expect(orphanAfter.data()?.attachment).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────────────
  // PR2c tour 2b bloc C septies — conv avec un INBOUND marqué `duplicate`
  // + un INBOUND `abandoned`. `conv.inboundCount` reflète déjà le cleanup
  // (duplicate/abandoned exclus). Après attach + reset :
  //   - inboundCount STRICT = valeur d'avant (invariant pipeline).
  //   - lastInboundAt pointe sur le reçu actif, PAS sur le duplicate.
  // Mutation sentinelle : si on rebascule `applyResetWrites` sur un
  // recomptage brut `.where("direction","==","inbound").count()`, ce test
  // tombe parce que le recomptage ramène duplicate + abandoned.
  // ─────────────────────────────────────────────────────────────────────
  it("conv avec inbound duplicate + abandoned ⇒ inboundCount préservé STRICT après reset (sentinelle recomptage)", async () => {
    const db = getAdminDb();
    const convId = "crst_dup_hubspot-list-9999";
    const contactId = "crstdup";
    const idempotencyKey = "rst-dup-attach-1";

    // Seed contact minimal (le reset ne lit pas ces champs mais la conv les requiert).
    await db
      .collection("contacts")
      .doc(contactId)
      .set({
        hubspotId: contactId,
        firstName: "Jean",
        lastName: "Dupont",
        civilite: "Dr",
        speciality: "Chirurgien-dentiste",
        city: "Paris",
        postalCode: "75001",
        phone: {
          e164: "+33600000000",
          raw: "+33600000000",
          type: "mobile",
          valid: true,
          lookupAt: Timestamp.now(),
        },
        segment: "b2b_cabinet",
        bloctelChecked: false,
        bloctelOptOut: false,
        consent: { legitimateInterest: "test duplicate inbound", optedOut: false },
        enrichment: { source: "manual", enrichedAt: Timestamp.now() },
        status: "ready",
        campaignId: "hubspot-list-9999",
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      });

    // Seed messages :
    //   t1  : inbound "received" (actif)   ← lastInboundAt pointe ici
    //   t2  : inbound "duplicate"          ← exclu par pipeline cleanup
    //   t3  : inbound "abandoned"          ← exclu par pipeline cleanup
    //   t4  : outbound ai "sent"
    const t1 = Timestamp.fromMillis(1_700_000_000_000);
    const t2 = Timestamp.fromMillis(1_700_000_060_000);
    const t3 = Timestamp.fromMillis(1_700_000_120_000);
    const t4 = Timestamp.fromMillis(1_700_000_180_000);
    const activeInboundBody = "Bonjour, je suis intéressé.";

    const msgs = db.collection("conversations").doc(convId).collection("messages");
    await msgs.doc("m1_in_received").set({
      direction: "inbound",
      body: activeInboundBody,
      createdAt: t1,
      status: "received",
      channel: "sms",
    });
    await msgs.doc("m2_in_duplicate").set({
      direction: "inbound",
      body: "Doublon du 16/10 — exclu par close-duplicate-inbound",
      createdAt: t2,
      status: "duplicate",
      duplicateOf: "m1_in_received",
      channel: "sms",
    });
    await msgs.doc("m3_in_abandoned").set({
      direction: "inbound",
      body: "Inbound abandonné (hypothétique cleanup manuel)",
      createdAt: t3,
      status: "abandoned",
      channel: "sms",
    });
    await msgs.doc("m4_out_ai").set({
      direction: "outbound",
      generatedBy: "ai",
      body: "Bonjour Dr Dupont…",
      createdAt: t4,
      status: "sent",
      channel: "sms",
    });

    // Seed conv : inboundCount = 1 (reflet du cleanup), lastInboundAt = t1.
    // lastMessageAt = t4 (dernier message, outbound ai).
    await db
      .collection("conversations")
      .doc(convId)
      .set({
        contactId,
        campaignId: "hubspot-list-9999",
        channel: "sms",
        status: "active",
        intent: "unknown",
        messageCount: 4,
        outboundCount: 1,
        inboundCount: 1,
        followupCount: 0,
        lastMessageAt: t4,
        lastInboundAt: t1,
        lastMessagePreview: buildLastMessagePreview({
          direction: "outbound",
          authorKind: "ai",
          text: "Bonjour Dr Dupont…",
          at: t4,
        }),
        createdAt: Timestamp.fromMillis(1_699_999_000_000),
        updatedAt: t4,
      });

    const beforeSnap = await db.collection("conversations").doc(convId).get();
    const before = readConvSnapshot(beforeSnap.data()!);
    expect(before.inboundCount).toBe(1);
    expect(before.lastInboundAtIso).toBe(t1.toDate().toISOString());

    // Attach : bump inboundCount à 2 (via `_bumpConversationCountersTx`).
    const orphanSeed = await addOrphanInboundIdempotent({
      reason: "no_conversation",
      body: "SEED test duplicate",
      idempotencyKey,
      source: "process-reply",
      isTestFixture: true,
    });
    await attachOrphanToConversation({
      orphanDocId: orphanSeed.docId,
      conversationId: convId,
      attachedBy: "user_admin_e2e",
      optOutConfirmed: false,
      actorTestAccount: true,
    });

    const attachedSnap = await db.collection("conversations").doc(convId).get();
    expect(attachedSnap.data()?.inboundCount).toBe(2);

    // Reset : INVERSE EXACT du bump → inboundCount doit redevenir 1.
    const scan = await scanFixturesForReset(db, convId, [idempotencyKey]);
    const prediction = await predictConvStateAfterReset(db, convId, scan.touchedMessages);
    // 🔒 Preuve directe : la prédiction utilise `current - touchedInbound`,
    // JAMAIS `.count()` brut. Un recomptage brut ramènerait 2+1-1 = 2 (il
    // compterait duplicate + abandoned + received − attachMsg) → régression
    // du cleanup antérieur.
    expect(prediction.predicted?.inboundCount).toBe(1);
    expect(prediction.predicted?.lastInboundAt?.toDate().toISOString()).toBe(
      t1.toDate().toISOString(),
    );
    assertSafeReset(prediction);

    await applyResetWrites({
      db,
      convId,
      touchedOrphans: scan.touchedOrphans,
      touchedMessages: scan.touchedMessages,
    });

    const after = readConvSnapshot(
      (await db.collection("conversations").doc(convId).get()).data()!,
    );
    // STRICT : inboundCount reste à 1 (pas 2, pas 3). lastInboundAt =
    // t1 (le reçu actif), pas t2 (duplicate) ni t3 (abandoned).
    expect(after.inboundCount).toBe(1);
    expect(after.lastInboundAtIso).toBe(t1.toDate().toISOString());
    // lastMessageAt reste t4 (outbound ai actif, pas touché).
    expect(after.lastMessageAtIso).toBe(t4.toDate().toISOString());
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Mutation sentinelle unitaire — garde `assertSafeReset`
// ─────────────────────────────────────────────────────────────────────────

describe("assertSafeReset — garde fail-closed (sentinelle PR2c bloc C quater)", () => {
  it("lève sur prediction.abort posé — si on retire ce throw du module, ce test tombe", () => {
    // Mutation réelle : commenter la ligne `if (prediction.abort !== null)
    // throw ...` dans `reset-e2e-orphans-core.ts::assertSafeReset`
    // et ce test échoue immédiatement.
    const prediction: ResetPrediction = {
      current: {
        lastMessageAt: null,
        lastInboundAt: null,
        lastMessagePreview: null,
        lastHumanOutboundAt: null,
        inboundCount: null,
      },
      predicted: null,
      abort: "aucun message restant avec `createdAt: Timestamp` exploitable (test sentinelle)",
    };
    expect(() => assertSafeReset(prediction)).toThrow(/aucun message restant/);
  });

  it("ne lève pas sur prediction.abort === null (contrôle positif)", () => {
    const ts = Timestamp.fromMillis(1_700_000_000_000);
    const prediction: ResetPrediction = {
      current: {
        lastMessageAt: ts,
        lastInboundAt: ts,
        lastMessagePreview: null,
        lastHumanOutboundAt: ts,
        inboundCount: 1,
      },
      predicted: {
        lastMessageAt: ts,
        lastInboundAt: ts,
        lastMessagePreview: null,
        lastHumanOutboundAt: ts,
        inboundCount: 1,
      },
      abort: null,
    };
    expect(() => assertSafeReset(prediction)).not.toThrow();
  });
});
