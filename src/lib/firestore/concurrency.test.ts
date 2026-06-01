/**
 * Test d'intégration concurrence Firestore — GUARD-002 (S6.6).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CE QUE CE TEST PROUVE
 *
 *   Le pattern `withContactLock` + re-check `canSendMessage` DANS la tx
 *   (avec historique re-lu via `tx.get(query)`) ferme la race condition
 *   N=2 jobs Inngest concurrents au plafond rate-limit 3/30j :
 *
 *     - Pré-condition : 1 contact + 1 conversation + 2 outbound récents
 *       (état "à 1 SMS du plafond").
 *     - 2 jobs simultanés (`Promise.all`) tentent chacun l'envoi du 3e SMS.
 *     - Attendu : EXACTEMENT 1 commit réussit (3e message créé), EXACTEMENT
 *       1 throw `rate_limit_race`.
 *     - Le test boucle 10x sur reset complet → si UNE itération révèle
 *       flaky (oks=2 ou oks=0), le pattern de concurrence est cassé.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * POURQUOI INLINE et pas via `addOutbound` (S6.5)
 *
 *   `addOutbound` (S6.5) démarre sa PROPRE `runTransaction`. Firestore
 *   refuse les transactions imbriquées dans le SDK admin. Le helper
 *   `attemptSendWithLock` ci-dessous réplique INLINE la logique
 *   `create message + bump compteurs` pour pouvoir tout poser dans la
 *   tx parente ouverte par `withContactLock`.
 *
 *   Dette : en S7, extraire `addOutboundInTx(tx, conv, input)` propre
 *   depuis `messages.ts` pour que le code prod (Inngest `send-sms`)
 *   n'ait pas à dupliquer. PAS un fix urgent S6.6 (le code prod
 *   n'existe pas encore).
 */
import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { canSendMessage, type OutboundMessageRecord } from "@/lib/compliance/rate-limits";
import { __resetEnvCacheForTests } from "@/lib/security/env";
import type { Contact } from "@/types/contact";
import type { Conversation } from "@/types/conversation";
import type { Message } from "@/types/message";

import {
  __APP_NAME_FOR_TESTS,
  __getAppByName,
  __resetFirestoreAdminForTests,
  getAdminDb,
} from "./admin";
import { __AUDIT_COLLECTION_FOR_TESTS, appendAuditLog } from "./audit-log";
import { __CONTACTS_COLLECTION_FOR_TESTS } from "./contacts";
import {
  __CONVERSATIONS_COLLECTION_FOR_TESTS,
  _bumpConversationCountersTx,
  _parseConversationOrThrow,
} from "./conversations";
import {
  __MESSAGES_PARENT_COLLECTION_FOR_TESTS,
  __MESSAGES_SUBCOLLECTION_FOR_TESTS,
} from "./messages";
import { withContactLock } from "./transactions";

const PEPPER = "a".repeat(64);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de seed
// ─────────────────────────────────────────────────────────────────────────────

function buildValidContact(id: string, overrides: Partial<Contact> = {}): Contact {
  const now = Timestamp.now();
  return {
    hubspotId: id,
    firstName: "Jean",
    lastName: "Dupont",
    civilite: "Dr",
    speciality: "dentiste",
    city: "Paris",
    postalCode: "75001",
    phone: {
      e164: "+33612345678",
      raw: "06 12 34 56 78",
      type: "mobile",
      valid: true,
      lookupAt: now,
    },
    segment: "b2b_cabinet",
    bloctelChecked: true,
    bloctelOptOut: false,
    consent: {
      legitimateInterest: "Contact HubSpot Médéré importé le 2026-05-29, dentiste IDF, opt-in B2B.",
      optedOut: false,
    },
    enrichment: {
      source: "hubspot",
      enrichedAt: now,
    },
    status: "ready",
    campaignId: "dentistes-idf-mai-2026",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildValidConversation(overrides: Partial<Conversation> = {}): Conversation {
  const now = Timestamp.now();
  return {
    contactId: "c_race",
    campaignId: "camp_race",
    channel: "sms",
    status: "in_dialogue",
    intent: "unknown",
    messageCount: 2,
    outboundCount: 2,
    inboundCount: 0,
    followupCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function seedContact(id: string): Promise<void> {
  await getAdminDb().collection(__CONTACTS_COLLECTION_FOR_TESTS).doc(id).set(buildValidContact(id));
}

async function seedConversation(id: string, overrides: Partial<Conversation> = {}): Promise<void> {
  await getAdminDb()
    .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
    .doc(id)
    .set(buildValidConversation(overrides));
}

async function seedOutboundMessage(
  conversationId: string,
  daysAgo: number,
  bodyTag: string,
): Promise<void> {
  const createdAt = Timestamp.fromDate(new Date(Date.now() - daysAgo * 86400_000));
  const message: Message = {
    direction: "outbound",
    body: `seed_${bodyTag}`,
    status: "sent",
    channel: "sms",
    generatedBy: "ai",
    createdAt,
    sentAt: createdAt,
  };
  await getAdminDb()
    .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
    .doc(conversationId)
    .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
    .add(message);
}

async function countOutboundMessages(conversationId: string): Promise<number> {
  const snap = await getAdminDb()
    .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
    .doc(conversationId)
    .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS)
    .where("direction", "==", "outbound")
    .get();
  return snap.size;
}

async function countAuditByAction(action: string): Promise<number> {
  const snap = await getAdminDb()
    .collection(__AUDIT_COLLECTION_FOR_TESTS)
    .where("action", "==", action)
    .get();
  return snap.size;
}

async function fullReset() {
  vi.restoreAllMocks();
  __resetFirestoreAdminForTests();
  const app = __getAppByName(__APP_NAME_FOR_TESTS);
  if (app) {
    await deleteApp(app);
  }
  __resetEnvCacheForTests();
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper attemptSendWithLock (INLINE — pattern S7 simulé)
// ─────────────────────────────────────────────────────────────────────────────

type AttemptResult = { ok: true; messageId: string } | { ok: false; reason: "rate_limit_race" };

/**
 * Simule l'envoi atomique d'un SMS avec lock + re-check rate-limit DANS
 * la tx. Pattern de référence pour S7 (Inngest `send-sms`).
 *
 *   1. `withContactLock(contactId, fn)` ouvre la tx avec lock sur le contact
 *   2. fn fait `tx.get(query messages outbound 30j)` — read set verrouillé
 *   3. fn `canSendMessage(records)` re-checked DANS la tx
 *   4. fn throw `rate_limit_race` si fail → tx rollback
 *   5. fn create message + bump compteurs DANS la tx (INLINE addOutbound)
 *   6. catch externe distingue race vs autre erreur, log audit `send_blocked`
 */
async function attemptSendWithLock(
  contactId: string,
  conversationId: string,
  bodyTag: string,
): Promise<AttemptResult> {
  try {
    const messageId = await withContactLock(contactId, async (tx, contact) => {
      // ── 0. Re-check opt-out DANS la tx (défense en profondeur) ────────
      // Le contact peut avoir opté-out entre le check HORS tx et le commit
      // (autre webhook OVH "STOP" arrivé en parallèle, action manuelle
      // dashboard, etc.). Le test concurrence actuel n'exerce PAS ce
      // chemin (consent.optedOut === false en seed), mais le helper
      // doit l'embarquer pour refléter le pattern S7 attendu.
      /* v8 ignore next 3 */
      if (contact.consent.optedOut) {
        throw new Error("opted_out_race");
      }

      // ── 1. Lecture historique DANS la tx (read set verrouillé) ────────
      const subRef = getAdminDb()
        .collection(__MESSAGES_PARENT_COLLECTION_FOR_TESTS)
        .doc(conversationId)
        .collection(__MESSAGES_SUBCOLLECTION_FOR_TESTS);
      const fromTs = Timestamp.fromDate(new Date(Date.now() - 30 * 86400_000));
      const recentSnap = await tx.get(
        subRef
          .where("direction", "==", "outbound")
          .where("createdAt", ">=", fromTs)
          .orderBy("createdAt", "desc"),
      );
      const records: OutboundMessageRecord[] = recentSnap.docs.map((d) => {
        const data = d.data();
        return {
          direction: "outbound",
          sentAt: (data.sentAt ?? data.createdAt) as Timestamp,
        };
      });

      // ── 2. Re-check rate-limit DANS la tx ─────────────────────────────
      const rateOk = canSendMessage(records);
      if (!rateOk.allowed) {
        throw new Error("rate_limit_race");
      }

      // ── 3. Lecture + parse conversation DANS la tx ────────────────────
      const convRef = getAdminDb()
        .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
        .doc(conversationId);
      const convDoc = await tx.get(convRef);
      const conv = _parseConversationOrThrow(convDoc.data(), conversationId);

      // ── 4. Create message INLINE (pattern S7, extraction propre future)─
      const messageRef = subRef.doc();
      const now = Timestamp.now();
      tx.create(messageRef, {
        direction: "outbound",
        body: `attempt_${bodyTag}`,
        status: "queued",
        channel: "sms",
        generatedBy: "ai",
        createdAt: now,
      } satisfies Message);

      // ── 5. Bump compteurs via helper partagé S6.5 ─────────────────────
      _bumpConversationCountersTx(tx, convRef, conv, "outbound", now);

      return messageRef.id;
    });
    return { ok: true, messageId };
  } catch (e) {
    if (e instanceof Error && e.message === "rate_limit_race") {
      // Pattern S7 : log audit `send_blocked` HORS tx pour le caller
      // qui a perdu la race. Permet le suivi forensique des collisions.
      await appendAuditLog({
        actorId: "system",
        actorType: "system",
        action: "send_blocked",
        targetType: "contact",
        targetId: contactId,
        payload: { reason: "rate_limit_race" },
      });
      return { ok: false, reason: "rate_limit_race" };
    }
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe("concurrency.test — GUARD-002 (S6.6)", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_PII_PEPPER", PEPPER);
    await fullReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fullReset();
  });

  it("2 jobs simultanés au plafond rate-limit 3/30j → exactement 1 passe, 1 bloqué (10 itérations consécutives, ZERO flaky)", async () => {
    const ITERATIONS = 10;

    // Note design : on n'a PAS de helper `clearFirestore` (la base
    // emulator persiste pendant tout le run vitest). Pour éviter que
    // les itérations se polluent mutuellement (les messages seedés de
    // l'iter N restent visibles à l'iter N+1 → la query "outbound 30j"
    // retournerait 5 messages au lieu de 2 → les 2 jobs throw
    // rate_limit_race immédiatement → 0 succès observés), on isole
    // chaque itération via des IDs uniques (`c_race_iter${i}` etc.).
    // Pattern identique aux autres tests S6 (conv_inc_1, conv_inc_2…).
    // Pour les audits qui sont cumulés globalement, on track le count
    // AVANT/APRÈS chaque itération et vérifie le delta = 1.

    for (let i = 0; i < ITERATIONS; i++) {
      const contactId = `c_race_iter${i}`;
      const conversationId = `c_race_iter${i}_camp`;

      // Pré-condition : contact + conversation + 2 outbound récents
      // (état "à 1 SMS du plafond").
      await seedContact(contactId);
      await seedConversation(conversationId, {
        contactId,
        campaignId: `camp_iter${i}`,
        messageCount: 2,
        outboundCount: 2,
      });
      await seedOutboundMessage(conversationId, 5, `iter${i}_m1`);
      await seedOutboundMessage(conversationId, 3, `iter${i}_m2`);

      // Snapshot audits cumulés AVANT (pour assertion différentielle).
      const sendBlockedBefore = await countAuditByAction("send_blocked");

      // Race condition : 2 jobs simultanés tentent le 3e SMS.
      const [a, b] = await Promise.all([
        attemptSendWithLock(contactId, conversationId, `iter${i}_jobA`),
        attemptSendWithLock(contactId, conversationId, `iter${i}_jobB`),
      ]);

      // ── Vérification STRICTE ────────────────────────────────────────
      const results = [a, b];
      const oks = results.filter((r) => r.ok).length;
      const races = results.filter((r) => !r.ok && r.reason === "rate_limit_race").length;

      expect(oks, `iteration ${i}: exactement 1 succès attendu`).toBe(1);
      expect(races, `iteration ${i}: exactement 1 race attendu`).toBe(1);

      // Exactement 3 messages outbound dans la sous-collection ISOLÉE
      // de cette itération (2 seeds + 1 ajouté par le gagnant).
      const totalOutbound = await countOutboundMessages(conversationId);
      expect(totalOutbound, `iteration ${i}: 3 outbound attendus`).toBe(3);

      // Conversation.outboundCount bumpé de 1 (de 2 à 3).
      const convAfter = await getAdminDb()
        .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
        .doc(conversationId)
        .get();
      const conv = convAfter.data() as Conversation;
      expect(conv.outboundCount, `iteration ${i}: outboundCount === 3`).toBe(3);
      expect(conv.messageCount, `iteration ${i}: messageCount === 3`).toBe(3);

      // Exactement +1 audit send_blocked (logué par le perdant dans le
      // catch externe). Pas d'audits sms_sent ici car on a inline
      // tx.create du message — pas appendAuditLogTx (volontaire,
      // pattern S6.5 vs S7 différents).
      const sendBlockedAfter = await countAuditByAction("send_blocked");
      expect(sendBlockedAfter - sendBlockedBefore, `iteration ${i}: +1 audit send_blocked`).toBe(1);
    }
  }, 60_000); // timeout étendu pour 10 itérations × 2 jobs Firestore
});
