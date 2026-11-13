/**
 * Test EMULATOR bout-en-bout — ajout code-side du suffixe STOP sur les
 * réponses de Léa (feat/reply-stop-suffix).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Scénarios prouvés bout-en-bout
 *
 * (A) Pipeline nominal : SDK Claude simulé renvoie un texte avec "Médéré"
 *     mais SANS "STOP" (conforme au SYSTEM prompt qui interdit à Claude
 *     d'écrire STOP, cf. `generate-reply-interesse.ts:169`). On appelle :
 *       1. Le VRAI `generateReply` (wrapper → `assembleReplyBody` ajoute
 *          le suffixe " STOP." côté code).
 *       2. La VRAIE `addOutboundDraft` (stocke le body final tel quel
 *          dans Firestore, status="draft").
 *       3. La VRAIE `commitDraftToQueued` (re-vérifie compliance 9 règles
 *          DANS une tx, transitionne draft→queued, bumpe les compteurs).
 *     Résultat attendu : `ok: true`, le doc Firestore passe à
 *     `status="queued"`, et le body stocké se termine exactement par
 *     " STOP.". C'est ce que la règle 3 `stop_present` du 12/11 à 14:06
 *     UTC refusait avant cette PR.
 *
 * (B) Non-régression règle 3 : on seed DIRECTEMENT un draft dont le body
 *     contient "Médéré" mais pas "STOP" (on contourne volontairement
 *     `generateReply`, pour prouver que la règle 3 bloque toujours un
 *     draft non conforme). Résultat attendu : `commitDraftToQueued`
 *     renvoie `{ ok: false, failure: { rule: "stop_present", code:
 *     "stop_optout_missing" } }`, le draft reste en Firestore en
 *     `status="draft"`, aucun audit `sms_sent` n'est posé.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Fichiers modèles utilisés
 *
 *   - `tests/firestore/opt-out-chain-no-conversation.test.ts` pour le
 *     `buildFreshContact(id)` (consent B2B cabinet valide, legitimate
 *     interest ≥ 20 chars, bloctel coché, phone mobile valid) et pour le
 *     cycle `fullReset()` + `vi.stubEnv("AUDIT_PII_PEPPER", ...)`.
 *
 *   - `tests/firestore/mark-handoff-contacted.test.ts` pour le pattern
 *     `seedConv(id, overrides)` avec strip explicite des `undefined`
 *     (Admin SDK refuse les undefined dans Firestore).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Déterminisme temporel
 *
 * `FIXED_NOW = 2026-11-10T09:30:00Z` = mardi 10:30 Paris (CET, novembre
 * hors DST → UTC+1). Mardi, pas un jour férié FR (Toussaint 1/11, Armistice
 * 11/11, 10/11 est intercalaire safe). Dans la plage 10h-13h de la règle 7
 * `hours`. Année < `MAX_VERIFIED_HOLIDAYS_YEAR = 2027` (`hours.ts:38`).
 *
 * `lastInboundAt = FIXED_NOW − 1h` → bien dans la fenêtre 48h de
 * `REPLY_INBOUND_RECENCY_HOURS` (`messages.ts:172`).
 */
import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ⚠️ vi.mock DOIT être déclaré AVANT l'import du module testé. On mocke
// le wrapper SDK Claude pour contrôler ce que `generate` renvoie — pas
// d'appel réseau Anthropic depuis les tests.
vi.mock("@/lib/claude/client", () => ({
  generate: vi.fn(),
  // `generateWithTool` n'est pas utilisé par `reply-generator` mais est
  // exporté par le module. On le stub pour éviter un "undefined is not a
  // function" si l'import side-effect le touche.
  generateWithTool: vi.fn(),
}));

import { generate } from "@/lib/claude/client";
import { generateReply } from "@/lib/claude/reply-generator";
import type { GenerateResult } from "@/lib/claude/types";
import { hasOptOut } from "@/lib/compliance/opt-out";
import {
  __APP_NAME_FOR_TESTS,
  __getAppByName,
  __resetFirestoreAdminForTests,
  getAdminDb,
} from "@/lib/firestore/admin";
import { __AUDIT_COLLECTION_FOR_TESTS } from "@/lib/firestore/audit-log";
import { __CONTACTS_COLLECTION_FOR_TESTS } from "@/lib/firestore/contacts";
import { addOutboundDraft } from "@/lib/firestore/messages";
import { commitDraftToQueued } from "@/lib/firestore/send-reply";
import { __resetEnvCacheForTests } from "@/lib/security/env";
import type { Contact } from "@/types/contact";
import type { Conversation } from "@/types/conversation";

const PEPPER = "d".repeat(64);
const CONVERSATIONS_COLLECTION = "conversations";
const MESSAGES_SUBCOLLECTION = "messages";

/** Mardi 10 nov. 2026, 10:30 Europe/Paris (CET = UTC+1 en novembre). */
const FIXED_NOW = new Date("2026-11-10T09:30:00.000Z");
const ONE_HOUR_MS = 60 * 60 * 1000;

const mockedGenerate = generate as unknown as ReturnType<typeof vi.fn>;

// ─────────────────────────────────────────────────────────────────────────
// Helpers — seeds
// ─────────────────────────────────────────────────────────────────────────

function buildFreshContact(id: string): Contact {
  const now = Timestamp.fromDate(FIXED_NOW);
  return {
    hubspotId: id,
    firstName: "Camille",
    lastName: "Martin",
    civilite: "Dr",
    speciality: "Chirurgien-dentiste",
    city: "Paris",
    postalCode: "75011",
    phone: {
      e164: "+33612345678",
      raw: "06 12 34 56 78",
      type: "mobile",
      valid: true,
      lookupAt: now,
    },
    // b2b_cabinet → `canSendB2C` court-circuite à `{allowed: true}`
    // (`bloctel.ts:69-72`). Pas besoin de Bloctel actif pour ce test.
    segment: "b2b_cabinet",
    bloctelChecked: true,
    bloctelOptOut: false,
    bloctelCheckedAt: now,
    consent: {
      // ≥ 20 chars pour la règle 9 `legitimate_interest` (`pre-send-check.ts:699`).
      legitimateInterest:
        "Contact HubSpot Médéré importé le 2026-11-01, dentiste IDF, intérêt légitime B2B.",
      optedOut: false,
    },
    enrichment: {
      source: "hubspot",
      enrichedAt: now,
    },
    status: "ready",
    campaignId: "dentistes-idf-nov-2026",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Seed une conversation avec `inboundCount: 1` + `messageCount: 2` (donc
 * règle 2 `ai_disclosure` ne tire pas — `messageCount !== 0`) et
 * `lastInboundAt = FIXED_NOW - 1h` (bien dans les 48h de
 * `REPLY_INBOUND_RECENCY_HOURS`). Status `in_dialogue` : la conv est
 * active, un reply est attendu.
 */
async function seedConv(id: string, contactId: string): Promise<void> {
  const now = Timestamp.fromDate(FIXED_NOW);
  const lastInbound = Timestamp.fromMillis(FIXED_NOW.getTime() - ONE_HOUR_MS);
  const doc: Conversation = {
    contactId,
    campaignId: "dentistes-idf-nov-2026",
    channel: "sms",
    status: "in_dialogue",
    intent: "INTERESSE",
    messageCount: 2,
    outboundCount: 1,
    inboundCount: 1,
    firstMessageAt: Timestamp.fromMillis(FIXED_NOW.getTime() - 3 * ONE_HOUR_MS),
    lastMessageAt: lastInbound,
    lastOutboundAt: Timestamp.fromMillis(FIXED_NOW.getTime() - 2 * ONE_HOUR_MS),
    lastInboundAt: lastInbound,
    followupCount: 0,
    handoffContacted: false,
    assignedTo: null,
    createdAt: now,
    updatedAt: now,
  };
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (v !== undefined) clean[k] = v;
  }
  await getAdminDb().collection(CONVERSATIONS_COLLECTION).doc(id).set(clean);
}

/**
 * Seed direct d'un draft (contourne volontairement `generateReply` +
 * `addOutboundDraft`) pour tester la non-régression de la règle 3.
 */
async function seedDirectDraft(
  conversationId: string,
  messageId: string,
  body: string,
): Promise<void> {
  await getAdminDb()
    .collection(CONVERSATIONS_COLLECTION)
    .doc(conversationId)
    .collection(MESSAGES_SUBCOLLECTION)
    .doc(messageId)
    .set({
      direction: "outbound",
      body,
      status: "draft",
      channel: "sms",
      outboundKind: "reply",
      generatedBy: "ai",
      aiModel: "claude-sonnet-4-6",
      aiPromptVersion: "1.0.0",
      aiTemperature: 0.5,
      aiTokens: { input: 100, output: 40 },
      createdAt: Timestamp.fromDate(FIXED_NOW),
    });
}

async function fullReset(): Promise<void> {
  vi.restoreAllMocks();
  mockedGenerate.mockReset();
  __resetFirestoreAdminForTests();
  const app = __getAppByName(__APP_NAME_FOR_TESTS);
  if (app) {
    await deleteApp(app);
  }
  __resetEnvCacheForTests();
}

function makeGenerateResult(text: string): GenerateResult {
  return {
    text,
    usage: { inputTokens: 480, outputTokens: 36 },
    stopReason: "end_turn",
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe("reply STOP suffix — pipeline bout-en-bout sur emulator Firestore", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_PII_PEPPER", PEPPER);
    await fullReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fullReset();
  });

  it("(A) generateReply + addOutboundDraft + commitDraftToQueued → ok, status=queued, body termine par ' STOP.'", async () => {
    // ── (A.1) Seed contact + conversation ─────────────────────────────
    const contactId = "hs_reply_stop_suffix_A";
    const conversationId = `${contactId}_dentistes-idf-nov-2026`;
    await getAdminDb()
      .collection(__CONTACTS_COLLECTION_FOR_TESTS)
      .doc(contactId)
      .set(buildFreshContact(contactId));
    await seedConv(conversationId, contactId);

    // ── (A.2) Mock SDK Claude : renvoie un body avec "Médéré" sans STOP ─
    // Conforme au SYSTEM prompt qui interdit explicitement à Claude
    // d'écrire STOP (cf. `generate-reply-interesse.ts:169`).
    const llmText = "Bonjour Docteur, ravi de votre intérêt pour Médéré. Quelle thématique DPC ?";
    mockedGenerate.mockResolvedValueOnce(makeGenerateResult(llmText));

    // ── (A.3) Appel VRAI generateReply ────────────────────────────────
    const generation = await generateReply({
      intent: "INTERESSE",
      rawMessage: "ça m'intéresse",
      history: [
        { direction: "outbound", body: "Bonjour, assistante virtuelle de Médéré." },
        { direction: "inbound", body: "ça m'intéresse" },
      ],
      contactCivility: "Dr",
    });

    // Preuve 1 : `assembleReplyBody` a bien concaténé " STOP." en aval.
    expect(generation.body).toBe(`${llmText} STOP.`);
    expect(generation.body).toMatch(/ STOP\.$/);
    expect(hasOptOut(generation.body)).toBe(true);

    // ── (A.4) Appel VRAI addOutboundDraft (stocke le body final) ──────
    const draftMessageId = await addOutboundDraft({
      contactId,
      conversationId,
      body: generation.body,
      aiModel: generation.model,
      aiPromptVersion: generation.promptVersion,
      aiTemperature: generation.temperature,
      aiTokensInput: generation.tokensInput,
      aiTokensOutput: generation.tokensOutput,
      aiGenerationDurationMs: generation.generationDurationMs,
      now: FIXED_NOW,
    });
    expect(draftMessageId).toMatch(/^[A-Za-z0-9]{20}$/);

    // Preuve 2 : le body stocké = ce qui va etre verifie + envoye OVH.
    const draftSnap = await getAdminDb()
      .collection(CONVERSATIONS_COLLECTION)
      .doc(conversationId)
      .collection(MESSAGES_SUBCOLLECTION)
      .doc(draftMessageId)
      .get();
    expect(draftSnap.exists).toBe(true);
    const draftBody = draftSnap.get("body") as string;
    expect(draftBody).toBe(`${llmText} STOP.`);
    expect(draftSnap.get("status")).toBe("draft");

    // ── (A.5) Appel VRAI commitDraftToQueued (preSendCheck 9 regles) ──
    const commitResult = await commitDraftToQueued({
      conversationId,
      draftMessageId,
      now: FIXED_NOW,
    });

    // Preuve 3 : regle 3 `stop_present` passe, commit OK.
    expect(commitResult.ok).toBe(true);
    if (!commitResult.ok) {
      throw new Error(
        `expected ok, got blocked rule=${commitResult.failure.rule} code=${commitResult.failure.code}`,
      );
    }
    expect(commitResult.messageId).toBe(draftMessageId);
    expect(commitResult.contactId).toBe(contactId);

    // ── (A.6) Relecture Firestore : doc en queued, body inchange ──────
    const queuedSnap = await getAdminDb()
      .collection(CONVERSATIONS_COLLECTION)
      .doc(conversationId)
      .collection(MESSAGES_SUBCOLLECTION)
      .doc(draftMessageId)
      .get();
    expect(queuedSnap.get("status")).toBe("queued");
    expect(queuedSnap.get("body")).toBe(`${llmText} STOP.`);
    expect(queuedSnap.get("queuedAt")).toBeInstanceOf(Timestamp);

    // Preuve 4 : audit `sms_sent` pose dans la tx (forensic L.34-5 CPCE).
    const smsSentAudits = await getAdminDb()
      .collection(__AUDIT_COLLECTION_FOR_TESTS)
      .where("action", "==", "sms_sent")
      .where("targetId", "==", draftMessageId)
      .get();
    expect(smsSentAudits.size).toBe(1);

    // Preuve 5 : audit `compliance_check (allowed)` pose dans la tx.
    const allowedAudits = await getAdminDb()
      .collection(__AUDIT_COLLECTION_FOR_TESTS)
      .where("action", "==", "compliance_check")
      .where("targetId", "==", contactId)
      .get();
    expect(allowedAudits.size).toBeGreaterThanOrEqual(1);
    const allowedPayload = allowedAudits.docs[0]!.get("payload") as Record<string, unknown>;
    expect(allowedPayload.result).toBe("allowed");
  });

  it("(B) non-regression regle 3 : draft seede SANS STOP -> commitDraftToQueued refuse stop_present (draft reste draft)", async () => {
    // ── (B.1) Seed contact + conversation ─────────────────────────────
    const contactId = "hs_reply_stop_suffix_B";
    const conversationId = `${contactId}_dentistes-idf-nov-2026`;
    await getAdminDb()
      .collection(__CONTACTS_COLLECTION_FOR_TESTS)
      .doc(contactId)
      .set(buildFreshContact(contactId));
    await seedConv(conversationId, contactId);

    // ── (B.2) Seed DIRECT d'un draft avec "Medere" sans STOP ──────────
    // On contourne volontairement `generateReply` (donc `assembleReplyBody`)
    // pour prouver que la regle 3 bloque toujours un draft non conforme.
    const draftMessageId = "draft_without_stop_B";
    const nonCompliantBody = "Bonjour Docteur, formations Médéré DPC prises en charge ANDPC.";
    expect(hasOptOut(nonCompliantBody)).toBe(false); // sanite du seed
    await seedDirectDraft(conversationId, draftMessageId, nonCompliantBody);

    // ── (B.3) Appel VRAI commitDraftToQueued ──────────────────────────
    const commitResult = await commitDraftToQueued({
      conversationId,
      draftMessageId,
      now: FIXED_NOW,
    });

    // Preuve 1 : regle 3 bloque, pas de transition queued.
    expect(commitResult.ok).toBe(false);
    if (commitResult.ok) {
      throw new Error("expected blocked, got ok");
    }
    expect(commitResult.failure.rule).toBe("stop_present");
    expect(commitResult.failure.code).toBe("stop_optout_missing");

    // Preuve 2 : le draft reste en status="draft" (tx rollback atomique).
    const stillDraftSnap = await getAdminDb()
      .collection(CONVERSATIONS_COLLECTION)
      .doc(conversationId)
      .collection(MESSAGES_SUBCOLLECTION)
      .doc(draftMessageId)
      .get();
    expect(stillDraftSnap.exists).toBe(true);
    expect(stillDraftSnap.get("status")).toBe("draft");
    expect(stillDraftSnap.get("body")).toBe(nonCompliantBody);
    expect(stillDraftSnap.get("queuedAt")).toBeUndefined();

    // Preuve 3 : audit `reply_draft_dropped` pose HORS tx (branche
    // blocked, cf. `send-reply.ts:527-569`).
    const droppedAudits = await getAdminDb()
      .collection(__AUDIT_COLLECTION_FOR_TESTS)
      .where("action", "==", "reply_draft_dropped")
      .where("targetId", "==", draftMessageId)
      .get();
    expect(droppedAudits.size).toBe(1);
    const droppedPayload = droppedAudits.docs[0]!.get("payload") as Record<string, unknown>;
    expect(droppedPayload.blockedRule).toBe("stop_present");
    expect(droppedPayload.blockedCode).toBe("stop_optout_missing");

    // Preuve 4 : audit `compliance_check (blocked)` pose HORS tx.
    const blockedAudits = await getAdminDb()
      .collection(__AUDIT_COLLECTION_FOR_TESTS)
      .where("action", "==", "compliance_check")
      .where("targetId", "==", contactId)
      .get();
    expect(blockedAudits.size).toBeGreaterThanOrEqual(1);
    const blockedPayload = blockedAudits.docs[0]!.get("payload") as Record<string, unknown>;
    expect(blockedPayload.result).toBe("blocked");
    expect(blockedPayload.rule).toBe("stop_present");

    // Preuve 5 : AUCUN audit `sms_sent` pose (tx n'a jamais commit).
    const smsSentAudits = await getAdminDb()
      .collection(__AUDIT_COLLECTION_FOR_TESTS)
      .where("action", "==", "sms_sent")
      .where("targetId", "==", draftMessageId)
      .get();
    expect(smsSentAudits.size).toBe(0);
  });
});
