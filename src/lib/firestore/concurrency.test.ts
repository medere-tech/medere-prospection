/**
 * Test d'intégration concurrence Firestore — DEBT-001.6.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * NOTE HISTORIQUE (S6.6 → DEBT-001)
 *
 * L'helper INLINE `attemptSendWithLock` (S6.6) était une preuve de pattern
 * temporaire qui répliquait inline `create message + bump compteurs` dans
 * une tx parente ouverte par `withContactLock` — uniquement parce
 * qu'`addOutbound` (S6.5) démarrait sa propre `runTransaction` et qu'on
 * ne pouvait donc PAS le composer dans une tx existante.
 *
 * DEBT-001 (DEBT-001.1 → .5) a payé la dette :
 *   - `addOutboundInTx` extrait de `addOutbound`           (DEBT-001.2)
 *   - `listRecentOutboundInTx`                             (DEBT-001.2)
 *   - `ComplianceConcurrencyError` retry-friendly          (DEBT-001.1)
 *   - `sendOutboundWithLock` (compose tout en 1 tx)        (DEBT-001.3)
 *
 * Les tests exercent désormais la FONCTION PROD `sendOutboundWithLock`
 * directement — source de vérité du pattern transactionnel. L'helper INLINE
 * a été retiré (suppression du doublon test).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CE QUE CE TEST PROUVE
 *
 *   `sendOutboundWithLock` ferme la race condition N=2 jobs Inngest
 *   concurrents au plafond rate-limit 3/30j by-construction Firestore :
 *
 *     - Pré-condition : 1 contact + 1 conversation + 2 outbound récents
 *       (état "à 1 SMS du plafond").
 *     - 2 appels simultanés (`Promise.allSettled`) tentent chacun l'envoi
 *       du 3e SMS via `sendOutboundWithLock`.
 *     - Attendu : EXACTEMENT 1 fulfilled (commit réussi : message créé,
 *       compteurs bumpés, 2 audits posés) + EXACTEMENT 1 rejected avec
 *       `ComplianceConcurrencyError` (race détectée au commit, tx rollback).
 *     - Le test boucle 10x sur reset complet → si UNE itération révèle
 *       flaky (fulfilled=2 ou fulfilled=0), le pattern atomique a un trou
 *       subtil et on NE COMMIT PAS.
 */
import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetEnvCacheForTests } from "@/lib/security/env";
import { ComplianceConcurrencyError } from "@/lib/utils/errors";
import type { Contact } from "@/types/contact";
import type { Conversation } from "@/types/conversation";
import type { Message } from "@/types/message";

import {
  __APP_NAME_FOR_TESTS,
  __getAppByName,
  __resetFirestoreAdminForTests,
  getAdminDb,
} from "./admin";
import { __AUDIT_COLLECTION_FOR_TESTS } from "./audit-log";
import { __CONTACTS_COLLECTION_FOR_TESTS } from "./contacts";
import { __CONVERSATIONS_COLLECTION_FOR_TESTS } from "./conversations";
import {
  __MESSAGES_PARENT_COLLECTION_FOR_TESTS,
  __MESSAGES_SUBCOLLECTION_FOR_TESTS,
} from "./messages";
import { sendOutboundWithLock } from "./transactions";

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
    speciality: "Chirurgien-dentiste",
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
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe("sendOutboundWithLock — race resilience 10 iterations (DEBT-001.6)", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_PII_PEPPER", PEPPER);
    await fullReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fullReset();
  });

  it("2 appels simultanés au plafond rate-limit 3/30j → exactement 1 succès + 1 ComplianceConcurrencyError (10 itérations, ZERO flaky)", async () => {
    const ITERATIONS = 10;

    // Note design : on n'a PAS de helper `clearFirestore` (la base
    // emulator persiste pendant tout le run vitest). Pour éviter que
    // les itérations se polluent mutuellement, on isole chaque itération
    // via des IDs uniques (`c_race_iter${i}` etc.). Pour les audits
    // cumulés globalement, on track le count AVANT/APRÈS et vérifie
    // les deltas.

    for (let i = 0; i < ITERATIONS; i++) {
      const contactId = `c_race_iter${i}`;
      const campaignId = `camp_iter${i}`;
      const conversationId = `${contactId}_${campaignId}`;

      // Pré-condition : contact + conv + 2 outbound récents (état
      // "à 1 SMS du plafond"). conv.contactId/campaignId DOIVENT matcher
      // car sendOutboundWithLock vérifie en défense en profondeur.
      await seedContact(contactId);
      await seedConversation(conversationId, {
        contactId,
        campaignId,
        messageCount: 2,
        outboundCount: 2,
      });
      await seedOutboundMessage(conversationId, 5, `iter${i}_m1`);
      await seedOutboundMessage(conversationId, 3, `iter${i}_m2`);

      // Snapshot audits cumulés AVANT (assertion différentielle).
      const auditsBefore = {
        smsSent: await countAuditByAction("sms_sent"),
        dispatched: await countAuditByAction("sms_provider_dispatched"),
      };

      // Race : 2 appels simultanés tentent le 3e SMS via sendOutboundWithLock.
      // Promise.allSettled (pas Promise.all) car 1 des 2 va throw
      // ComplianceConcurrencyError — on veut récupérer les 2 résultats.
      const buildArgs = (bodyTag: string) => ({
        contactId,
        campaignId,
        conversationId,
        input: {
          body: `Race attempt ${bodyTag} — STOP pour refuser. Léa IA Médéré.`,
          channel: "sms" as const,
          generatedBy: "ai" as const,
        },
        dispatch: {
          ovhMessageId: `ovh-iter${i}-${bodyTag}`,
          sender: "MEDERE",
          bodyLength: 60,
          creditsRemoved: 1,
          dryRun: false,
        },
        // Pre-check HORS tx aurait dit "1 place dispo" (3 - 2 outbounds).
        expectedRemainingQuota: 1,
      });

      const [a, b] = await Promise.allSettled([
        sendOutboundWithLock(buildArgs("A")),
        sendOutboundWithLock(buildArgs("B")),
      ]);

      // ── Vérification STRICTE par itération ─────────────────────────────
      const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
      const rejected = [a, b].filter((r) => r.status === "rejected");

      expect(fulfilled.length, `iteration ${i}: exactement 1 fulfilled attendu`).toBe(1);
      expect(rejected.length, `iteration ${i}: exactement 1 rejected attendu`).toBe(1);

      // Le rejected DOIT être ComplianceConcurrencyError (PAS une autre erreur).
      // C'est CE qui prouve que la fonction prod détecte bien la race au
      // re-check rate-limit DANS la tx — pas un autre type d'erreur générique.
      const rejection = rejected[0];
      if (rejection?.status === "rejected") {
        expect(
          rejection.reason,
          `iteration ${i}: la rejection DOIT être ComplianceConcurrencyError`,
        ).toBeInstanceOf(ComplianceConcurrencyError);
        // Context forensique 5 champs (DEBT-001.1 contract).
        const err = rejection.reason as ComplianceConcurrencyError;
        expect(err.context.contactId).toBe(contactId);
        expect(err.context.ruleName).toBe("rate_limit_30d");
        expect(err.context.observedRemainingQuota).toBe(0);
      }

      // ── État Firestore final : 3 outbound (pas 4), pas plus ───────────
      // 2 seeds + 1 créé par le gagnant. Le perdant a rollback intégralement.
      const totalOutbound = await countOutboundMessages(conversationId);
      expect(totalOutbound, `iteration ${i}: 3 outbound attendus (2 seeds + 1 winner)`).toBe(3);

      // Compteurs conversation bumpés exactement de 1 (de 2 à 3).
      const convAfter = await getAdminDb()
        .collection(__CONVERSATIONS_COLLECTION_FOR_TESTS)
        .doc(conversationId)
        .get();
      const conv = convAfter.data() as Conversation;
      expect(conv.outboundCount, `iteration ${i}: outboundCount === 3`).toBe(3);
      expect(conv.messageCount, `iteration ${i}: messageCount === 3`).toBe(3);

      // ── Audits cumulés : +1 sms_sent + 1 sms_provider_dispatched ──────
      // Tous deux posés par le gagnant DANS la tx atomique (DETTE-004
      // payée). Le perdant a rollback → 0 audit du côté perdant.
      const auditsAfter = {
        smsSent: await countAuditByAction("sms_sent"),
        dispatched: await countAuditByAction("sms_provider_dispatched"),
      };
      expect(
        auditsAfter.smsSent - auditsBefore.smsSent,
        `iteration ${i}: +1 audit sms_sent (winner addOutboundInTx)`,
      ).toBe(1);
      expect(
        auditsAfter.dispatched - auditsBefore.dispatched,
        `iteration ${i}: +1 audit sms_provider_dispatched (winner only)`,
      ).toBe(1);
    }
  }, 60_000); // timeout étendu pour 10 itérations × 2 appels Firestore

  // ───────────────────────────────────────────────────────────────────────
  // PR-PER-CONTACT — race CROSS-CONVERSATION (même PS, 2 campagnes)
  // ───────────────────────────────────────────────────────────────────────

  it("🔴 CROSS-CONVERSATION : même contact, 2 conversations, 2 envois simultanés au plafond → exactement 1 succès + 1 ComplianceConcurrencyError (10 itérations, ZERO flaky)", async () => {
    // ─────────────────────────────────────────────────────────────────────
    // CE QUE CE TEST PROUVE — et ce qu'il aurait laissé passer AVANT
    //
    // Le docId conversation est composite `${contactId}_${campaignId}` :
    // un PS enrôlé dans 2 campagnes possède 2 conversations, donc 2
    // sous-collections `messages` DISTINCTES.
    //
    // AVANT (comptage scopé conversationId) : l'appel A lisait la conv X
    // (1 outbound), l'appel B lisait la conv Y (1 outbound). Chacun voyait
    // "1 < 3", chacun validait, et les deux écrivaient dans des
    // sous-collections différentes — donc AUCUN conflit Firestore ne les
    // départageait. Résultat : 4 SMS au même PS. Le test mono-conversation
    // ci-dessus ne pouvait PAS le détecter (ses 2 appels se battaient sur
    // la MÊME sous-collection).
    //
    // APRÈS (comptage scopé contactId) : les 2 tx lisent la query
    // `conversations.where(contactId==)` ET les messages des DEUX
    // conversations → read sets partagés → le commit du perdant est rejeté
    // par Firestore, sa tx retry, relit 3 outbounds, et `canSendMessage`
    // refuse → ComplianceConcurrencyError.
    //
    // Si quelqu'un re-scope le comptage sur la conversation, ce test
    // produit 2 fulfilled et 4 outbounds → il DOIT casser.
    // ─────────────────────────────────────────────────────────────────────
    const ITERATIONS = 10;

    for (let i = 0; i < ITERATIONS; i++) {
      const contactId = `c_xconv_iter${i}`;
      const campaignX = `campX_iter${i}`;
      const campaignY = `campY_iter${i}`;
      const convX = `${contactId}_${campaignX}`;
      const convY = `${contactId}_${campaignY}`;

      // Pré-condition : 1 contact, 2 conversations, 1 outbound récent dans
      // CHACUNE → 2 sollicitations au total pour ce PS = "à 1 SMS du
      // plafond" à l'échelle de la PERSONNE (invisible si on compte par
      // conversation : chacune n'en montre qu'1).
      await seedContact(contactId);
      await seedConversation(convX, {
        contactId,
        campaignId: campaignX,
        messageCount: 1,
        outboundCount: 1,
      });
      await seedConversation(convY, {
        contactId,
        campaignId: campaignY,
        messageCount: 1,
        outboundCount: 1,
      });
      await seedOutboundMessage(convX, 5, `iter${i}_x1`);
      await seedOutboundMessage(convY, 3, `iter${i}_y1`);

      const buildArgs = (campaignId: string, conversationId: string, bodyTag: string) => ({
        contactId,
        campaignId,
        conversationId,
        input: {
          body: `Race ${bodyTag} — STOP pour refuser. Léa IA Médéré.`,
          channel: "sms" as const,
          generatedBy: "ai" as const,
        },
        dispatch: {
          ovhMessageId: `ovh-xconv-${i}-${bodyTag}`,
          sender: "MEDERE",
          bodyLength: 60,
          creditsRemoved: 1,
          dryRun: false,
        },
        // Pre-check per-contact HORS tx aurait dit "1 place dispo" (3 - 2).
        expectedRemainingQuota: 1,
      });

      // 🚨 Les 2 appels ciblent des CONVERSATIONS DIFFÉRENTES du même contact.
      const [a, b] = await Promise.allSettled([
        sendOutboundWithLock(buildArgs(campaignX, convX, "X")),
        sendOutboundWithLock(buildArgs(campaignY, convY, "Y")),
      ]);

      const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
      const rejected = [a, b].filter((r) => r.status === "rejected");

      expect(fulfilled.length, `iteration ${i}: exactement 1 fulfilled attendu`).toBe(1);
      expect(rejected.length, `iteration ${i}: exactement 1 rejected attendu`).toBe(1);

      const rejection = rejected[0];
      if (rejection?.status === "rejected") {
        expect(
          rejection.reason,
          `iteration ${i}: la rejection DOIT être ComplianceConcurrencyError`,
        ).toBeInstanceOf(ComplianceConcurrencyError);
        const err = rejection.reason as ComplianceConcurrencyError;
        expect(err.context.contactId).toBe(contactId);
        expect(err.context.ruleName).toBe("rate_limit_30d");
        expect(err.context.observedRemainingQuota).toBe(0);
      }

      // ── État final : 3 outbound POUR LE CONTACT (2 seeds + 1 winner) ──
      // C'est l'assertion qui compte : le total est per-PERSONNE, réparti
      // sur les 2 conversations. Avant la PR : 4.
      const totalForContact =
        (await countOutboundMessages(convX)) + (await countOutboundMessages(convY));
      expect(
        totalForContact,
        `iteration ${i}: 3 outbound attendus pour le CONTACT (toutes campagnes)`,
      ).toBe(3);
    }
  }, 60_000);

  it("🔒 PLAFOND PER-CONTACT : 3 outbounds répartis sur 2 conversations → le 4e (3e conversation) est refusé", async () => {
    // Preuve directe (sans course) que le comptage est bien per-personne :
    // aucune des 3 conversations ne dépasse individuellement le plafond,
    // mais le CONTACT est déjà à 3/3. Un 4e envoi, même sur une campagne
    // toute neuve, doit être refusé.
    const contactId = "c_percontact_cap";
    const convA = `${contactId}_campA`;
    const convB = `${contactId}_campB`;
    const convC = `${contactId}_campC`;

    await seedContact(contactId);
    await seedConversation(convA, {
      contactId,
      campaignId: "campA",
      messageCount: 2,
      outboundCount: 2,
    });
    await seedConversation(convB, {
      contactId,
      campaignId: "campB",
      messageCount: 1,
      outboundCount: 1,
    });
    await seedConversation(convC, {
      contactId,
      campaignId: "campC",
      messageCount: 0,
      outboundCount: 0,
    });

    // 2 sollicitations dans A + 1 dans B = 3 pour le PS. Aucune conv seule
    // n'atteint le plafond → per-conversation, l'envoi passerait.
    await seedOutboundMessage(convA, 10, "a1");
    await seedOutboundMessage(convA, 6, "a2");
    await seedOutboundMessage(convB, 2, "b1");

    await expect(
      sendOutboundWithLock({
        contactId,
        campaignId: "campC",
        conversationId: convC,
        input: {
          body: "4e SMS — STOP pour refuser. Léa IA Médéré.",
          channel: "sms",
          generatedBy: "ai",
        },
        dispatch: {
          ovhMessageId: "ovh-percontact-cap",
          sender: "MEDERE",
          bodyLength: 60,
          creditsRemoved: 1,
          dryRun: false,
        },
        // Le pré-check per-contact HORS tx aurait déjà vu 3/3 → 0 place.
        expectedRemainingQuota: 0,
      }),
    ).rejects.toBeInstanceOf(ComplianceConcurrencyError);

    // Rollback intégral : aucun message créé dans la 3e conversation.
    expect(await countOutboundMessages(convC)).toBe(0);
    // Et les conversations sources sont intactes.
    expect(await countOutboundMessages(convA)).toBe(2);
    expect(await countOutboundMessages(convB)).toBe(1);
  });
});
