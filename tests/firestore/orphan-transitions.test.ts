/**
 * Tests emulator — transitions `attachOrphanToConversation`,
 * `dismissOrphan`, `reopenOrphan` (PR2c tour 2a).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Objectifs couverture :
 *
 *   1. Transitions atomiques depuis `pending` seulement :
 *      - un double-clic sur `attach` produit UN SEUL message + UN SEUL
 *        audit, le 2e appel throw `OrphanProcessingStateConflict`.
 *      - idem pour `dismiss` (depuis `pending`) et `reopen` (depuis
 *        `dismissed`).
 *   2. `reopen` depuis un état incompatible (`attached`) → conflict.
 *   3. `attach` sur un orphan body vide → `ValidationError`.
 *   4. `phoneMatch` serveur-side : "match" si phoneHash concorde,
 *      "mismatch" si contact a un autre numéro, "not_computable" si
 *      l'un des deux manque.
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
  attachOrphanToConversation,
  computePhoneMatch,
  countOrphanInboundsByState,
  dismissOrphan,
  listOrphanInbounds,
  ORPHAN_INBOUNDS_COLLECTION,
  OrphanProcessingStateConflict,
  OrphanTestFixtureMismatchError,
  reopenOrphan,
} from "@/lib/firestore/orphan-inbounds";
import { __resetEnvCacheForTests } from "@/lib/security/env";
import { ValidationError } from "@/lib/utils/errors";
import { hashPii, safePhoneHash } from "@/lib/utils/pii-detector";

const PEPPER = "c".repeat(64);

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
      // Supprime récursivement les sous-collections (messages).
      await db.recursiveDelete(docRef);
    }
  }
}

async function seedConvAndContact(args: {
  conversationId: string;
  contactId: string;
  phoneE164?: string;
}) {
  const db = getAdminDb();
  const phone = args.phoneE164 ?? "+33600000000";
  const contactDoc: Record<string, unknown> = {
    hubspotId: args.contactId,
    firstName: "Jean",
    lastName: "Dupont",
    speciality: "Chirurgien-dentiste",
    city: "Paris",
    postalCode: "75001",
    phone: {
      e164: phone,
      raw: phone,
      type: "mobile",
      valid: true,
      lookupAt: Timestamp.now(),
    },
    segment: "b2b_cabinet",
    bloctelChecked: false,
    bloctelOptOut: false,
    consent: {
      legitimateInterest: "contact test fixture pour PR2c tour 2a - rattachement manuel",
      optedOut: false,
    },
    enrichment: {
      source: "manual",
      enrichedAt: Timestamp.now(),
    },
    status: "ready",
    campaignId: "hubspot-list-9999",
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  };
  await db.collection("contacts").doc(args.contactId).set(contactDoc);
  await db.collection("conversations").doc(args.conversationId).set({
    contactId: args.contactId,
    campaignId: "hubspot-list-9999",
    channel: "sms",
    status: "active",
    intent: "unknown",
    messageCount: 0,
    outboundCount: 0,
    inboundCount: 0,
    followupCount: 0,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });
}

describe("orphan transitions — emulator (PR2c tour 2a)", () => {
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

  it("attachOrphanToConversation : happy path pending → attached, message créé, audit posé", async () => {
    const seed = await addOrphanInboundIdempotent({
      reason: "unknown_contact",
      body: "Bonjour, je souhaite plus d'infos",
      idempotencyKey: "tx-happy-1",
      source: "process-reply",
    });
    await seedConvAndContact({ conversationId: "c1_hubspot-list-9999", contactId: "c1" });

    const r = await attachOrphanToConversation({
      orphanDocId: seed.docId,
      conversationId: "c1_hubspot-list-9999",
      attachedBy: "user_admin_e2e",
      optOutConfirmed: false,
      actorTestAccount: false,
    });

    expect(r.messageId).toMatch(/^oih_/);
    expect(r.phoneMatch).toBe("not_computable");
    expect(r.wasOptOut).toBe(false);
    expect(r.body).toBe("Bonjour, je souhaite plus d'infos");

    const orphanAfter = await getAdminDb()
      .collection(ORPHAN_INBOUNDS_COLLECTION)
      .doc(seed.docId)
      .get();
    expect(orphanAfter.data()?.processingState).toBe("attached");
    expect(orphanAfter.data()?.attachment?.messageId).toBe(r.messageId);

    const msg = await getAdminDb()
      .collection("conversations")
      .doc("c1_hubspot-list-9999")
      .collection("messages")
      .doc(r.messageId)
      .get();
    expect(msg.exists).toBe(true);
    expect(msg.data()?.attachedFromOrphan?.orphanId).toBe(seed.docId);

    const audits = await getAdminDb()
      .collection("audit_log")
      .where("action", "==", "orphan_attached_to_conversation")
      .get();
    expect(audits.size).toBe(1);
  });

  it("attachOrphanToConversation : double-clic → 2e appel throw ProcessingStateConflict, 1 seul message + 1 seul audit", async () => {
    const seed = await addOrphanInboundIdempotent({
      reason: "unknown_contact",
      body: "msg synthétique",
      idempotencyKey: "tx-doublesclick-1",
      source: "process-reply",
    });
    await seedConvAndContact({ conversationId: "c2_hubspot-list-9999", contactId: "c2" });

    const input = {
      orphanDocId: seed.docId,
      conversationId: "c2_hubspot-list-9999",
      attachedBy: "user_admin_e2e",
      optOutConfirmed: false,
      actorTestAccount: false,
    };

    await attachOrphanToConversation(input);

    await expect(attachOrphanToConversation(input)).rejects.toBeInstanceOf(
      OrphanProcessingStateConflict,
    );

    const messages = await getAdminDb()
      .collection("conversations")
      .doc("c2_hubspot-list-9999")
      .collection("messages")
      .get();
    expect(messages.size).toBe(1);

    const audits = await getAdminDb()
      .collection("audit_log")
      .where("action", "==", "orphan_attached_to_conversation")
      .get();
    expect(audits.size).toBe(1);
  });

  it("attachOrphanToConversation : body vide → ValidationError, aucune écriture", async () => {
    const seed = await addOrphanInboundIdempotent({
      reason: "parse_failed",
      body: "",
      idempotencyKey: "tx-empty-body-1",
      source: "webhook-ovh-sms",
    });
    await seedConvAndContact({ conversationId: "c3_hubspot-list-9999", contactId: "c3" });

    await expect(
      attachOrphanToConversation({
        orphanDocId: seed.docId,
        conversationId: "c3_hubspot-list-9999",
        attachedBy: "user_admin_e2e",
        optOutConfirmed: false,
        actorTestAccount: false,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const orphanAfter = await getAdminDb()
      .collection(ORPHAN_INBOUNDS_COLLECTION)
      .doc(seed.docId)
      .get();
    expect(orphanAfter.data()?.processingState).toBe("pending");
  });

  it("attachOrphanToConversation : phoneMatch='match' quand contact.phone.e164 hash concorde", async () => {
    const phone = "+33612345678";
    const phoneHash = safePhoneHash(phone, hashPii);

    const seed = await addOrphanInboundIdempotent({
      reason: "no_conversation",
      body: "msg synthétique",
      idempotencyKey: "tx-match-1",
      source: "process-reply",
      phoneHash,
    });
    await seedConvAndContact({
      conversationId: "c4_hubspot-list-9999",
      contactId: "c4",
      phoneE164: phone,
    });

    const r = await attachOrphanToConversation({
      orphanDocId: seed.docId,
      conversationId: "c4_hubspot-list-9999",
      attachedBy: "user_admin_e2e",
      optOutConfirmed: false,
      actorTestAccount: false,
    });
    expect(r.phoneMatch).toBe("match");
  });

  it("attachOrphanToConversation : phoneMatch='mismatch' quand numéros diffèrent", async () => {
    const phoneHash = safePhoneHash("+33611111111", hashPii);
    const seed = await addOrphanInboundIdempotent({
      reason: "no_conversation",
      body: "msg synthétique",
      idempotencyKey: "tx-mismatch-1",
      source: "process-reply",
      phoneHash,
    });
    await seedConvAndContact({
      conversationId: "c5_hubspot-list-9999",
      contactId: "c5",
      phoneE164: "+33622222222",
    });

    const r = await attachOrphanToConversation({
      orphanDocId: seed.docId,
      conversationId: "c5_hubspot-list-9999",
      attachedBy: "user_admin_e2e",
      optOutConfirmed: false,
      actorTestAccount: false,
    });
    expect(r.phoneMatch).toBe("mismatch");
  });

  it("dismissOrphan : pending → dismissed, audit posé, 2e appel throw", async () => {
    const seed = await addOrphanInboundIdempotent({
      reason: "unknown_contact",
      body: "spam synthétique",
      idempotencyKey: "tx-dismiss-1",
      source: "process-reply",
    });
    await dismissOrphan({
      orphanDocId: seed.docId,
      dismissReason: "unrelated_or_spam",
      dismissedBy: "user_admin_e2e",
      actorTestAccount: false,
    });
    await expect(
      dismissOrphan({
        orphanDocId: seed.docId,
        dismissReason: "unrelated_or_spam",
        dismissedBy: "user_admin_e2e",
        actorTestAccount: false,
      }),
    ).rejects.toBeInstanceOf(OrphanProcessingStateConflict);

    const orphanAfter = await getAdminDb()
      .collection(ORPHAN_INBOUNDS_COLLECTION)
      .doc(seed.docId)
      .get();
    expect(orphanAfter.data()?.processingState).toBe("dismissed");
    expect(orphanAfter.data()?.dismissal?.reason).toBe("unrelated_or_spam");

    const audits = await getAdminDb()
      .collection("audit_log")
      .where("action", "==", "orphan_dismissed")
      .get();
    expect(audits.size).toBe(1);
  });

  it("reopenOrphan : dismissed → pending OK, attached → conflict", async () => {
    const seedA = await addOrphanInboundIdempotent({
      reason: "unknown_contact",
      body: "msg A",
      idempotencyKey: "tx-reopen-dismissed-1",
      source: "process-reply",
    });
    await dismissOrphan({
      orphanDocId: seedA.docId,
      dismissReason: "sender_not_identifiable",
      dismissedBy: "user_admin_e2e",
      actorTestAccount: false,
    });
    await reopenOrphan({
      orphanDocId: seedA.docId,
      reopenedBy: "user_admin_e2e",
      actorTestAccount: false,
    });
    const afterA = await getAdminDb().collection(ORPHAN_INBOUNDS_COLLECTION).doc(seedA.docId).get();
    expect(afterA.data()?.processingState).toBe("pending");

    // reopen from attached → conflict
    const seedB = await addOrphanInboundIdempotent({
      reason: "unknown_contact",
      body: "msg B",
      idempotencyKey: "tx-reopen-attached-1",
      source: "process-reply",
    });
    await seedConvAndContact({ conversationId: "c6_hubspot-list-9999", contactId: "c6" });
    await attachOrphanToConversation({
      orphanDocId: seedB.docId,
      conversationId: "c6_hubspot-list-9999",
      attachedBy: "user_admin_e2e",
      optOutConfirmed: false,
      actorTestAccount: false,
    });
    await expect(
      reopenOrphan({
        orphanDocId: seedB.docId,
        reopenedBy: "user_admin_e2e",
        actorTestAccount: false,
      }),
    ).rejects.toBeInstanceOf(OrphanProcessingStateConflict);
  });

  it("attachOrphanToConversation : STOP body → opt-out appliqué DANS LA MÊME tx (contact + conv)", async () => {
    const seed = await addOrphanInboundIdempotent({
      reason: "unknown_contact",
      body: "STOP",
      idempotencyKey: "tx-stop-atomic",
      source: "process-reply",
    });
    await seedConvAndContact({ conversationId: "cstop_hubspot-list-9999", contactId: "cstop" });

    const r = await attachOrphanToConversation({
      orphanDocId: seed.docId,
      conversationId: "cstop_hubspot-list-9999",
      attachedBy: "user_admin_e2e",
      // PR2c tour 2b — l'admin répond « Non », mais le détecteur voit STOP :
      // le serveur DOIT ignorer la réponse admin et appliquer l'opt-out
      // (invariant L.34-5 CPCE — un client ne peut JAMAIS annuler un STOP).
      optOutConfirmed: false,
      actorTestAccount: false,
    });

    expect(r.wasOptOut).toBe(true);
    expect(r.optOutDecision).toBe("detector");

    // Opt-out contact posé dans la MÊME tx.
    const contactAfter = await getAdminDb().collection("contacts").doc("cstop").get();
    expect(contactAfter.data()?.consent?.optedOut).toBe(true);
    expect(contactAfter.data()?.status).toBe("opted_out");

    // Opt-out conv posé dans la MÊME tx.
    const convAfter = await getAdminDb()
      .collection("conversations")
      .doc("cstop_hubspot-list-9999")
      .get();
    expect(convAfter.data()?.status).toBe("opted_out");
    expect(convAfter.data()?.intent).toBe("STOP");

    // Audit `opt_out` ET `orphan_attached_to_conversation` posés tous les deux.
    const optAudits = await getAdminDb()
      .collection("audit_log")
      .where("action", "==", "opt_out")
      .get();
    const attachAudits = await getAdminDb()
      .collection("audit_log")
      .where("action", "==", "orphan_attached_to_conversation")
      .get();
    expect(optAudits.size).toBe(1);
    expect(attachAudits.size).toBe(1);
  });

  it("attachOrphanToConversation : body NON-STOP + optOutConfirmed=true (admin_yes) → opt-out appliqué, audit discriminé", async () => {
    const seed = await addOrphanInboundIdempotent({
      reason: "unknown_contact",
      body: "Bonjour, finalement je ne suis pas intéressé par vos services, merci",
      idempotencyKey: "tx-admin-yes-1",
      source: "process-reply",
    });
    await seedConvAndContact({
      conversationId: "cadminyes_hubspot-list-9999",
      contactId: "cadminyes",
    });

    const r = await attachOrphanToConversation({
      orphanDocId: seed.docId,
      conversationId: "cadminyes_hubspot-list-9999",
      attachedBy: "user_admin_e2e",
      optOutConfirmed: true, // admin répond « Oui »
      actorTestAccount: false,
    });

    expect(r.wasOptOut).toBe(true);
    expect(r.optOutDecision).toBe("admin_yes");

    const contactAfter = await getAdminDb().collection("contacts").doc("cadminyes").get();
    expect(contactAfter.data()?.consent?.optedOut).toBe(true);

    // Audit `orphan_attached_to_conversation` → payload discrimine la décision.
    const attachAudits = await getAdminDb()
      .collection("audit_log")
      .where("action", "==", "orphan_attached_to_conversation")
      .get();
    expect(attachAudits.size).toBe(1);
    const payload = attachAudits.docs[0]?.data()?.payload as { optOutDecision?: string };
    expect(payload?.optOutDecision).toBe("admin_yes");
  });

  it("attachOrphanToConversation : body NON-STOP + optOutConfirmed=false → PAS d'opt-out, decision=admin_no", async () => {
    const seed = await addOrphanInboundIdempotent({
      reason: "unknown_contact",
      body: "Bonjour, merci pour l'info",
      idempotencyKey: "tx-admin-no-1",
      source: "process-reply",
    });
    await seedConvAndContact({
      conversationId: "cadminno_hubspot-list-9999",
      contactId: "cadminno",
    });

    const r = await attachOrphanToConversation({
      orphanDocId: seed.docId,
      conversationId: "cadminno_hubspot-list-9999",
      attachedBy: "user_admin_e2e",
      optOutConfirmed: false,
      actorTestAccount: false,
    });

    expect(r.wasOptOut).toBe(false);
    expect(r.optOutDecision).toBe("admin_no");

    const contactAfter = await getAdminDb().collection("contacts").doc("cadminno").get();
    expect(contactAfter.data()?.consent?.optedOut).toBe(false);
  });

  it("attachOrphanToConversation : conv sans contact résolvable → ValidationError, aucune écriture", async () => {
    const seed = await addOrphanInboundIdempotent({
      reason: "no_conversation",
      body: "Message valide",
      idempotencyKey: "tx-conv-no-contact-1",
      source: "process-reply",
    });

    // Seed d'une conv dont le `contactId` pointe un doc contact INEXISTANT :
    // la conv parse OK (contactId non-vide) mais le contact est absent.
    // Scénario réel : contact anonymisé/supprimé après création de la conv.
    await getAdminDb().collection("conversations").doc("cnoc_hubspot-list-9999").set({
      contactId: "ghost-contact-id",
      campaignId: "hubspot-list-9999",
      channel: "sms",
      status: "active",
      intent: "unknown",
      messageCount: 0,
      outboundCount: 0,
      inboundCount: 0,
      followupCount: 0,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });

    await expect(
      attachOrphanToConversation({
        orphanDocId: seed.docId,
        conversationId: "cnoc_hubspot-list-9999",
        attachedBy: "user_admin_e2e",
        optOutConfirmed: false,
        actorTestAccount: false,
      }),
    ).rejects.toThrow(/contact missing for conv/);

    // Preuve d'aucune écriture : orphan reste pending, pas de message, pas d'audit attach.
    const orphanAfter = await getAdminDb()
      .collection(ORPHAN_INBOUNDS_COLLECTION)
      .doc(seed.docId)
      .get();
    expect(orphanAfter.data()?.processingState).toBe("pending");

    const msgs = await getAdminDb()
      .collection("conversations")
      .doc("cnoc_hubspot-list-9999")
      .collection("messages")
      .get();
    expect(msgs.size).toBe(0);

    const audits = await getAdminDb()
      .collection("audit_log")
      .where("action", "==", "orphan_attached_to_conversation")
      .get();
    expect(audits.size).toBe(0);
  });

  it("attachOrphanToConversation : panne simulée APRÈS la tx — attach reste commité (atomique)", async () => {
    // Scenario : le tx attach commit (message + orphan + opt-out éventuel +
    // audits), puis le code post-tx throw (ex: notification Slack qui plante).
    // L'invariant : la tx reste commise, aucune partie n'est perdue.
    // On simule en déclenchant juste après `attachOrphanToConversation`
    // une erreur et en vérifiant que les writes sont bien persistés.
    const seed = await addOrphanInboundIdempotent({
      reason: "unknown_contact",
      body: "STOP",
      idempotencyKey: "tx-post-crash-1",
      source: "process-reply",
    });
    await seedConvAndContact({ conversationId: "ccrash_hubspot-list-9999", contactId: "ccrash" });

    try {
      await attachOrphanToConversation({
        orphanDocId: seed.docId,
        conversationId: "ccrash_hubspot-list-9999",
        attachedBy: "user_admin_e2e",
        optOutConfirmed: false,
        actorTestAccount: false,
      });
      // Simule un crash post-return (ex: Slack notif throw).
      throw new Error("simulated post-tx crash");
    } catch (err) {
      expect((err as Error).message).toBe("simulated post-tx crash");
    }

    // Invariant atomique : la tx a commit AVANT le crash → tout est persisté.
    const orphanAfter = await getAdminDb()
      .collection(ORPHAN_INBOUNDS_COLLECTION)
      .doc(seed.docId)
      .get();
    expect(orphanAfter.data()?.processingState).toBe("attached");

    const contactAfter = await getAdminDb().collection("contacts").doc("ccrash").get();
    expect(contactAfter.data()?.consent?.optedOut).toBe(true);
  });

  it("attachOrphanToConversation : bump counters conv (inboundCount, lastInboundAt, preview)", async () => {
    const seed = await addOrphanInboundIdempotent({
      reason: "unknown_contact",
      body: "Bonjour synthétique — texte d'orphan rattaché",
      idempotencyKey: "tx-counters-1",
      source: "process-reply",
    });
    await seedConvAndContact({
      conversationId: "ccnt_hubspot-list-9999",
      contactId: "ccnt",
    });

    const convBefore = await getAdminDb()
      .collection("conversations")
      .doc("ccnt_hubspot-list-9999")
      .get();
    const beforeInbound = (convBefore.data() as { inboundCount?: number }).inboundCount ?? 0;

    await attachOrphanToConversation({
      orphanDocId: seed.docId,
      conversationId: "ccnt_hubspot-list-9999",
      attachedBy: "user_admin_e2e",
      optOutConfirmed: false,
      actorTestAccount: false,
    });

    const convAfter = await getAdminDb()
      .collection("conversations")
      .doc("ccnt_hubspot-list-9999")
      .get();
    const d = convAfter.data() as {
      inboundCount: number;
      lastInboundAt?: unknown;
      lastMessageAt?: unknown;
      lastMessagePreview?: { text: string };
      updatedAt?: unknown;
    };
    expect(d.inboundCount).toBe(beforeInbound + 1);
    expect(d.lastInboundAt).toBeDefined();
    expect(d.lastMessageAt).toBeDefined();
    expect(d.lastMessagePreview?.text).toContain("Bonjour synthétique");
    expect(d.updatedAt).toBeDefined();
  });

  it("listOrphanInbounds : isTestFixture fail-closed par défaut, les fixtures sont EXCLUES", async () => {
    await addOrphanInboundIdempotent({
      reason: "unknown_contact",
      body: "orphan RÉEL",
      idempotencyKey: "tx-filter-real",
      source: "process-reply",
    });
    await addOrphanInboundIdempotent({
      reason: "unknown_contact",
      body: "orphan FIXTURE",
      idempotencyKey: "tx-filter-fixture",
      source: "process-reply",
      isTestFixture: true,
    });

    // Default (includeTestFixtures: undefined/false) → 1 seul (réel).
    const defaultList = await listOrphanInbounds({});
    expect(defaultList.orphans).toHaveLength(1);
    expect(defaultList.orphans[0]?.body).toBe("orphan RÉEL");
    expect(defaultList.orphans[0]?.isTestFixture).toBe(false);

    // includeTestFixtures: false explicite → 1 (réel seul).
    const explicitFalse = await listOrphanInbounds({ includeTestFixtures: false });
    expect(explicitFalse.orphans).toHaveLength(1);

    // includeTestFixtures: true (testAccount) → les 2.
    const withFixtures = await listOrphanInbounds({ includeTestFixtures: true });
    expect(withFixtures.orphans).toHaveLength(2);

    // Counts : fail-closed par défaut.
    const defaultCounts = await countOrphanInboundsByState();
    expect(defaultCounts.pending).toBe(1);

    const includeCounts = await countOrphanInboundsByState({ includeTestFixtures: true });
    expect(includeCounts.pending).toBe(2);
  });

  it("computePhoneMatch : logique pure (match/mismatch/not_computable)", () => {
    const hashA = safePhoneHash("+33612345678", hashPii);
    const hashB = safePhoneHash("+33622222222", hashPii);
    expect(computePhoneMatch(hashA, "+33612345678")).toBe("match");
    expect(computePhoneMatch(hashA, "+33622222222")).toBe("mismatch");
    expect(computePhoneMatch(undefined, "+33612345678")).toBe("not_computable");
    expect(computePhoneMatch(hashA, undefined)).toBe("not_computable");
    expect(computePhoneMatch("", "+33612345678")).toBe("not_computable");
    expect(computePhoneMatch(hashA, "")).toBe("not_computable");
    expect(computePhoneMatch(hashB, "+33622222222")).toBe("match");
  });

  // ─────────────────────────────────────────────────────────────────────
  // R-1 : garde `isTestFixture` ↔ `actorTestAccount` (post-audit security)
  // ─────────────────────────────────────────────────────────────────────
  //
  // Previews et prod partagent la même base Firestore. Un compte réel
  // ne doit JAMAIS muter un orphan `isTestFixture: true` ; un compte
  // test ne doit JAMAIS muter un orphan réel. La transaction refuse via
  // `OrphanTestFixtureMismatchError` AVANT tout write.
  //
  // Mutation sentinelle : si on retire l'appel à
  // `assertActorMatchesOrphanFixture` dans `attachOrphanToConversation`
  // ou dans `dismissOrphan` / `reopenOrphan`, les tests « rejet » ci-
  // dessous passent sans throw et donc fail.

  it("R-1 attach : orphan réel + actor réel → OK (contrôle positif)", async () => {
    const seed = await addOrphanInboundIdempotent({
      reason: "unknown_contact",
      body: "control positif",
      idempotencyKey: "r1-real-real",
      source: "process-reply",
    });
    await seedConvAndContact({ conversationId: "cr1a_hubspot-list-9999", contactId: "cr1a" });
    const r = await attachOrphanToConversation({
      orphanDocId: seed.docId,
      conversationId: "cr1a_hubspot-list-9999",
      attachedBy: "user_admin_e2e",
      optOutConfirmed: false,
      actorTestAccount: false,
    });
    expect(r.messageId).toMatch(/^oih_/);
  });

  it("R-1 attach : orphan fixture + actor réel → rejet (OrphanTestFixtureMismatchError)", async () => {
    const seed = await addOrphanInboundIdempotent({
      reason: "unknown_contact",
      body: "fixture doc",
      idempotencyKey: "r1-fixture-real",
      source: "process-reply",
      isTestFixture: true,
    });
    await seedConvAndContact({ conversationId: "cr1b_hubspot-list-9999", contactId: "cr1b" });
    await expect(
      attachOrphanToConversation({
        orphanDocId: seed.docId,
        conversationId: "cr1b_hubspot-list-9999",
        attachedBy: "user_admin_e2e",
        optOutConfirmed: false,
        actorTestAccount: false, // compte réel
      }),
    ).rejects.toBeInstanceOf(OrphanTestFixtureMismatchError);
    const after = await getAdminDb().collection(ORPHAN_INBOUNDS_COLLECTION).doc(seed.docId).get();
    expect(after.data()?.processingState).toBe("pending"); // rien écrit
  });

  it("R-1 attach : orphan réel + actor testAccount → rejet", async () => {
    const seed = await addOrphanInboundIdempotent({
      reason: "unknown_contact",
      body: "doc réel",
      idempotencyKey: "r1-real-fixture",
      source: "process-reply",
    });
    await seedConvAndContact({ conversationId: "cr1c_hubspot-list-9999", contactId: "cr1c" });
    await expect(
      attachOrphanToConversation({
        orphanDocId: seed.docId,
        conversationId: "cr1c_hubspot-list-9999",
        attachedBy: "user_admin_e2e",
        optOutConfirmed: false,
        actorTestAccount: true, // compte test
      }),
    ).rejects.toBeInstanceOf(OrphanTestFixtureMismatchError);
    const after = await getAdminDb().collection(ORPHAN_INBOUNDS_COLLECTION).doc(seed.docId).get();
    expect(after.data()?.processingState).toBe("pending");
  });

  it("R-1 attach : orphan fixture + actor testAccount → OK (contrôle positif inverse)", async () => {
    const seed = await addOrphanInboundIdempotent({
      reason: "unknown_contact",
      body: "fixture + testAccount",
      idempotencyKey: "r1-fixture-fixture",
      source: "process-reply",
      isTestFixture: true,
    });
    await seedConvAndContact({ conversationId: "cr1d_hubspot-list-9999", contactId: "cr1d" });
    const r = await attachOrphanToConversation({
      orphanDocId: seed.docId,
      conversationId: "cr1d_hubspot-list-9999",
      attachedBy: "user_admin_e2e",
      optOutConfirmed: false,
      actorTestAccount: true,
    });
    expect(r.messageId).toMatch(/^oih_/);
  });

  it("R-1 dismiss : orphan fixture + actor réel → rejet, rien écrit", async () => {
    const seed = await addOrphanInboundIdempotent({
      reason: "unknown_contact",
      body: "fixture spam",
      idempotencyKey: "r1-dismiss-mismatch",
      source: "process-reply",
      isTestFixture: true,
    });
    await expect(
      dismissOrphan({
        orphanDocId: seed.docId,
        dismissReason: "unrelated_or_spam",
        dismissedBy: "user_admin_e2e",
        actorTestAccount: false,
      }),
    ).rejects.toBeInstanceOf(OrphanTestFixtureMismatchError);
    const after = await getAdminDb().collection(ORPHAN_INBOUNDS_COLLECTION).doc(seed.docId).get();
    expect(after.data()?.processingState).toBe("pending");
  });

  it("R-1 reopen : orphan fixture dismissed + actor réel → rejet", async () => {
    const seed = await addOrphanInboundIdempotent({
      reason: "unknown_contact",
      body: "fixture",
      idempotencyKey: "r1-reopen-mismatch",
      source: "process-reply",
      isTestFixture: true,
    });
    // dismiss côté testAccount pour arriver à l'état "dismissed".
    await dismissOrphan({
      orphanDocId: seed.docId,
      dismissReason: "sender_not_identifiable",
      dismissedBy: "user_admin_e2e",
      actorTestAccount: true,
    });
    await expect(
      reopenOrphan({
        orphanDocId: seed.docId,
        reopenedBy: "user_admin_e2e",
        actorTestAccount: false, // mismatch
      }),
    ).rejects.toBeInstanceOf(OrphanTestFixtureMismatchError);
    const after = await getAdminDb().collection(ORPHAN_INBOUNDS_COLLECTION).doc(seed.docId).get();
    expect(after.data()?.processingState).toBe("dismissed"); // rien bougé
  });
});
