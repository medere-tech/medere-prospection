/**
 * Test emulator bout-en-bout — chaîne opt-out P3' no_conversation
 * (point 1 round 3 PR-NO-DROPPED-SMS).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Scénario prouvé bout-en-bout
 *
 *   1. Seed un contact RÉEL dans l'emulator Firestore (consent.optedOut=false,
 *      jamais sollicité, pas de conversation attachée).
 *   2. Appeler le vrai `markOptedOut(contactId, "sms", { intent: "STOP" })`
 *      SANS conversationId (= cas P3' no_conversation du pipeline).
 *   3. Relire le doc contact : `consent.optedOut === true`, `optedOutAt`
 *      posé (Timestamp), `optedOutChannel === "sms"`.
 *   4. Relire `audit_log/` : trouver une entrée `action: "opt_out"` ciblant
 *      le contactId.
 *   5. Appeler le vrai `preSendCheck(args)` (NON mocké) sur ce contact →
 *      refus avec `rule: "opt_out"`, `code: "opted_out"`.
 *
 * Chaîne complète : SMS STOP (P3') → markOptedOut flip Firestore → doc
 * audit opt_out → pre-send-check refuse first-sms ultérieur.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Propagation HubSpot — PAS faite
 *
 * `src/lib/firestore/contacts.ts:538-647` : `markOptedOut` touche UNIQUEMENT
 * Firestore (`contacts/{id}` + optionnellement `conversations/{id}` +
 * `audit_log`). Aucun appel HubSpot client (`hubspotContactsClient.update`)
 * dans cette fonction ni dans son wrapper amont `process-reply.ts`.
 *
 * Conséquence opérationnelle : la propriété HubSpot `optOut` (ou équivalent)
 * NE sera PAS flip automatiquement. Un hand-off commercial via HubSpot (ou
 * un export Bloctel direct depuis HubSpot) ne verra pas le désabonnement
 * récent. La protection reste côté Médéré Firestore via `preSendCheck`
 * (voir test ci-dessous), mais tout chemin d'envoi externe au pipeline
 * Médéré (dashboard HubSpot manuel) pourrait recontacter un PS désabonné.
 *
 * Pas de code à ajouter dans cette PR (hors scope PR-NO-DROPPED-SMS).
 * Ticket Notion à ouvrir : "propagation HubSpot sur markOptedOut".
 */
import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { preSendCheck } from "@/lib/compliance/pre-send-check";
import {
  __APP_NAME_FOR_TESTS,
  __getAppByName,
  __resetFirestoreAdminForTests,
  getAdminDb,
} from "@/lib/firestore/admin";
import { __AUDIT_COLLECTION_FOR_TESTS } from "@/lib/firestore/audit-log";
import {
  __CONTACTS_COLLECTION_FOR_TESTS,
  getContact,
  markOptedOut,
} from "@/lib/firestore/contacts";
import { __resetEnvCacheForTests } from "@/lib/security/env";
import type { Contact } from "@/types/contact";
import type { Conversation } from "@/types/conversation";

const PEPPER = "a".repeat(64);

function buildFreshContact(id: string): Contact {
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
  };
}

async function fullReset(): Promise<void> {
  vi.restoreAllMocks();
  __resetFirestoreAdminForTests();
  const app = __getAppByName(__APP_NAME_FOR_TESTS);
  if (app) {
    await deleteApp(app);
  }
  __resetEnvCacheForTests();
}

describe("Point 1 PR-NO-DROPPED-SMS R3 — chaine opt-out P3' no_conversation", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_PII_PEPPER", PEPPER);
    await fullReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fullReset();
  });

  it("contact sans conversation + markOptedOut(sms) -> flip Firestore + audit opt_out + preSendCheck refuse first-sms", async () => {
    // ── (1) Seed contact RÉEL — jamais sollicite, pas de conv ──────────
    const contactId = "hs_opt_out_chain_proof";
    const seeded = buildFreshContact(contactId);
    await getAdminDb().collection(__CONTACTS_COLLECTION_FOR_TESTS).doc(contactId).set(seeded);

    // ── (2) Appel REEL markOptedOut sans conversationId ────────────────
    await markOptedOut(contactId, "sms", { intent: "STOP" });

    // ── (3) Relire contact : consent.optedOut=true + optedOutAt + channel
    const flipped = await getContact(contactId);
    expect(flipped).not.toBeNull();
    if (flipped === null) throw new Error("contact disparu");
    expect(flipped.consent.optedOut).toBe(true);
    // optedOutAt pose par markOptedOut (contacts.ts:610).
    expect(flipped.consent.optedOutAt).toBeInstanceOf(Timestamp);
    // optedOutChannel pose par markOptedOut (contacts.ts:611).
    expect(flipped.consent.optedOutChannel).toBe("sms");
    // Status contact bascule a "opted_out" (contacts.ts:608).
    expect(flipped.status).toBe("opted_out");

    // ── (4) Relire audit_log : trouver `opt_out` cible contactId ───────
    const auditSnap = await getAdminDb()
      .collection(__AUDIT_COLLECTION_FOR_TESTS)
      .where("action", "==", "opt_out")
      .where("targetId", "==", contactId)
      .get();
    expect(auditSnap.size).toBeGreaterThanOrEqual(1);
    // Payload audit : channel sms, pas de conversationId (P3' no_conv).
    const auditDoc = auditSnap.docs[0]!;
    const payload = auditDoc.get("payload") as Record<string, unknown>;
    expect(payload.channel).toBe("sms");
    // Pas de conversationId dans le payload (cas P3' no_conv : flip
    // contact seulement sans toucher a aucune conv).
    expect(payload.conversationId).toBeUndefined();

    // ── (5) preSendCheck REEL (non mocke) sur ce contact flip ──────────
    // Simule un envoi first-sms ulterieur vers ce contact apres la PR
    // (ex: nouvelle campagne). preSendCheck doit refuser rule="opt_out".
    const freshConversation: Pick<Conversation, "messageCount"> = {
      messageCount: 0,
    };
    const result = preSendCheck({
      contact: flipped,
      conversation: freshConversation,
      message:
        "Bonjour Dr Dupont, je suis Lea, assistante virtuelle de Medere. Repondez STOP pour ne plus recevoir.",
      recentOutboundMessages: [],
      outboundKind: "solicitation",
    });

    // Preuve chaine complete : le PS ne sera plus sollicite.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.rule).toBe("opt_out");
      expect(result.failure.code).toBe("opted_out");
    }
  });

  it("markOptedOut sans conversationId sur contact DEJA opt -> no-op total (idempotence)", async () => {
    // Sentinelle inverse Finding 3 : si contact deja opt-out, markOptedOut
    // ne reecrit RIEN (contacts.ts:600-602 "no-op total"). L'audit cote
    // handleInactiveInbound passe par un chemin different
    // (`opt_out alreadyOptedOut:true` pose explicitement par le pipeline
    // process-reply.ts P3', pas par markOptedOut).
    const contactId = "hs_already_opt_proof";
    const seeded = buildFreshContact(contactId);
    const now = Timestamp.now();
    seeded.consent = {
      ...seeded.consent,
      optedOut: true,
      optedOutAt: now,
      optedOutChannel: "sms",
    };
    seeded.status = "opted_out";
    await getAdminDb().collection(__CONTACTS_COLLECTION_FOR_TESTS).doc(contactId).set(seeded);

    const auditBefore = await getAdminDb()
      .collection(__AUDIT_COLLECTION_FOR_TESTS)
      .where("action", "==", "opt_out")
      .where("targetId", "==", contactId)
      .get();
    const auditBeforeSize = auditBefore.size;

    // Appel markOptedOut sur contact deja opt -> no-op total attendu.
    await markOptedOut(contactId, "sms", { intent: "STOP" });

    // Audit non duplique (no-op total, contacts.ts:600-602).
    const auditAfter = await getAdminDb()
      .collection(__AUDIT_COLLECTION_FOR_TESTS)
      .where("action", "==", "opt_out")
      .where("targetId", "==", contactId)
      .get();
    expect(auditAfter.size).toBe(auditBeforeSize);

    // preSendCheck refuse quand meme.
    const flipped = await getContact(contactId);
    if (flipped === null) throw new Error("contact disparu");
    const result = preSendCheck({
      contact: flipped,
      conversation: { messageCount: 0 },
      message: "test",
      recentOutboundMessages: [],
      outboundKind: "solicitation",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.rule).toBe("opt_out");
    }
  });
});
