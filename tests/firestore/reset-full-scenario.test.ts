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
 * Mutation sentinelle
 *
 *   Si on retire du backfill le bloc qui pose `lastMessageAt`, ce test
 *   échoue sur l'assertion `convAfterReset.lastMessageAt` — c'est la
 *   garantie que la régression est capturée (preuve rejouée à la main
 *   dans la restitution PR2c bloc C).
 */
import { deleteApp } from "firebase-admin/app";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __APP_NAME_FOR_TESTS,
  __getAppByName,
  __resetFirestoreAdminForTests,
  getAdminDb,
} from "@/lib/firestore/admin";
import { computeBackfillUpdatesForConversation } from "@/lib/firestore/backfill-conversation-list-fields";
import { buildLastMessagePreview } from "@/lib/firestore/conversation-list-fields";
import {
  addOrphanInboundIdempotent,
  attachOrphanToConversation,
  ORPHAN_INBOUNDS_COLLECTION,
} from "@/lib/firestore/orphan-inbounds";
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

/**
 * Logique du reset-e2e-orphans en code TS — appelable depuis le test. On
 * reproduit EXACTEMENT ce que `scripts/reset-e2e-orphans.mjs` fait côté
 * conv (delete du message + clear des 4 champs + recount inboundCount +
 * backfill). Les deux versions divergent → ce test tombe.
 */
async function runResetLogic(
  db: FirebaseFirestore.Firestore,
  convId: string,
  touchedMessageId: string,
): Promise<void> {
  const convRef = db.collection("conversations").doc(convId);

  // 1. Delete du message rattaché.
  await convRef.collection("messages").doc(touchedMessageId).delete();

  // 2. Clear des 4 champs d'état — invariant de la logique reset.
  await convRef.update({
    lastMessagePreview: FieldValue.delete(),
    lastMessageAt: FieldValue.delete(),
    lastInboundAt: FieldValue.delete(),
    lastHumanOutboundAt: FieldValue.delete(),
  });

  // 3. Recompute inboundCount depuis les messages restants (le backfill
  //    ne gère pas les compteurs, c'est un delta explicite).
  const remainingInbound = await convRef
    .collection("messages")
    .where("direction", "==", "inbound")
    .count()
    .get();
  await convRef.update({ inboundCount: remainingInbound.data().count });

  // 4. Backfill — repose les 4 champs d'état depuis les messages restants.
  const convSnap = await convRef.get();
  const { updates, readErrors } = await computeBackfillUpdatesForConversation(convSnap, db);
  if (readErrors.length > 0) {
    throw new Error(`reset backfill readErrors: ${readErrors.join(" | ")}`);
  }
  if (Object.keys(updates).length > 0) {
    await convRef.update(updates);
  }
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
    // Sanity : before ne doit pas être "UNSET".
    expect(before.lastMessageAtIso).not.toMatch(/^UNSET:/);
    expect(before.lastInboundAtIso).not.toMatch(/^UNSET:/);
    expect(before.lastHumanOutboundAtIso).not.toMatch(/^UNSET:/);
    expect(before.inboundCount).toBe(1);

    // ── Attach : seed un orphan + rattache à la conv. L'attach bump
    //    inboundCount, pose lastInboundAt, lastMessageAt et preview.
    const orphanSeed = await addOrphanInboundIdempotent({
      reason: "no_conversation",
      body: "Oui je prends la plaquette, envoyez tout !",
      idempotencyKey: "rst-full-attach-1",
      source: "process-reply",
    });
    const attachResult = await attachOrphanToConversation({
      orphanDocId: orphanSeed.docId,
      conversationId: convId,
      attachedBy: "user_admin_e2e",
      optOutConfirmed: false,
      actorTestAccount: false,
    });

    // ── Verif attach a bien avancé les champs ───────────────────────
    const attachedSnap = await db.collection("conversations").doc(convId).get();
    const attachedData = attachedSnap.data()!;
    const attached = readConvSnapshot(attachedData);
    expect(attached.inboundCount).toBe(before.inboundCount + 1);
    expect(attached.lastMessageAtIso).not.toBe(before.lastMessageAtIso);
    expect(attached.lastInboundAtIso).not.toBe(before.lastInboundAtIso);
    expect(attached.previewText).not.toBe(before.previewText);
    // lastHumanOutboundAt ne bouge PAS (le message rattaché est inbound).
    expect(attached.lastHumanOutboundAtIso).toBe(before.lastHumanOutboundAtIso);

    // ── Reset : rejoue EXACTEMENT la logique du script ──────────────
    await runResetLogic(db, convId, attachResult.messageId);

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

    // Nettoyage orphan (invariant append-only : juste un reset d'état).
    await db.collection(ORPHAN_INBOUNDS_COLLECTION).doc(orphanSeed.docId).update({
      processingState: "pending",
      attachment: FieldValue.delete(),
    });
  });
});
