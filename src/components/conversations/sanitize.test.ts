/**
 * Tests sentinelle du journal — PR2b-2 round 3.
 *
 * Objectif : empêcher qu'une `AuditAction` apparaisse en code brut
 * (snake_case) dans l'UI du panneau "Journal". Préviens la régression du
 * défaut où `backfill_conversation_list_fields` et
 * `conversation_denorm_propagated` étaient affichés tels quels.
 *
 * Mutation testing :
 *   - ajouter une action à `ACTIONS` (`audit-log.ts`) + au type
 *     `AuditAction` SANS entrée dans `ACTION_LABELS` → `tsc` casse (type
 *     error "Property 'xxx' is missing in type Record<AuditAction, …>").
 *   - mettre `label: action` (identité) sur une entrée → test
 *     `aucun libellé = code brut` tombe.
 */
import { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";

import { __ACTIONS_FOR_TESTS as ACTIONS_RUNTIME } from "@/lib/firestore/audit-log";
import type { Message } from "@/types/message";

import {
  __ACTION_LABELS_FOR_TESTS as ACTION_LABELS,
  __labelForAction_FOR_TESTS as labelForAction,
  sanitizeAuditEntriesForJournal,
  sanitizeMessageForBubble,
} from "./sanitize";

const SNAKE_CASE_WORD = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/;

describe("journal — libellés d'audit (anti code brut)", () => {
  it("CHAQUE action de ACTIONS runtime a un libellé FR (coverage ensembliste)", () => {
    for (const action of ACTIONS_RUNTIME) {
      // L'entrée EXISTE dans la table (hasOwnProperty défensif).
      expect(
        Object.prototype.hasOwnProperty.call(ACTION_LABELS, action),
        `action "${action}" sans entrée dans ACTION_LABELS`,
      ).toBe(true);
    }
  });

  it("aucun libellé = code brut (jamais un snake_case affiché)", () => {
    for (const action of ACTIONS_RUNTIME) {
      const { label } = labelForAction(action);
      expect(label, `action "${action}" affiche son code brut`).not.toBe(action);
      expect(label, `label de "${action}" contient encore un snake_case`).not.toMatch(
        SNAKE_CASE_WORD,
      );
    }
  });

  it("aucun libellé vide ou whitespace-only", () => {
    for (const action of ACTIONS_RUNTIME) {
      const { label } = labelForAction(action);
      expect(label.trim().length, `label vide pour "${action}"`).toBeGreaterThan(0);
    }
  });

  it("backfill_conversation_list_fields (régression PR2b-2 round 2) a bien un libellé FR", () => {
    const { label } = labelForAction("backfill_conversation_list_fields");
    expect(label).toBe("Rattrapage des champs de liste (admin)");
    expect(label).not.toMatch(/backfill/i);
  });

  it("conversation_denorm_propagated (régression PR2b-2 round 2) a bien un libellé FR", () => {
    const { label } = labelForAction("conversation_denorm_propagated");
    expect(label).toBe("Résumé de conversation mis à jour");
    expect(label).not.toMatch(/denorm|propagated/i);
  });

  it("action inconnue (hors type AuditAction) → libellé générique, JAMAIS le code brut", () => {
    const { label } = labelForAction("some_future_action_not_yet_typed");
    expect(label).toBe("Action enregistrée");
    expect(label).not.toMatch(SNAKE_CASE_WORD);
  });
});

/**
 * Sentinelle PR2c tour 2b bloc C sexies — propagation serveur de
 * `attachedFromOrphan` jusqu'à `MessageProps`.
 *
 * Chaîne complète : Firestore doc → `_parseMessageOrThrow` →
 * `listMessagesInConversation` → `sanitizeMessageForBubble` (ICI) →
 * `MessageProps` → `<MessageBubble>` → mention « Ajouté manuellement
 * depuis un SMS orphelin ».
 *
 * Fix : `MessageSchema` déclare désormais le champ (sinon Zod `.strip()`
 * silencieux). Si quelqu'un l'enlève du schéma OU casse l'allow-list
 * `sanitizeMessageForBubble`, ces tests tombent.
 */
describe("sanitizeMessageForBubble — propagation attachedFromOrphan (sentinelle PR2c bloc C sexies)", () => {
  function makeInbound(extra: Partial<Message> = {}): Message & { messageId: string } {
    return {
      messageId: "msg_test",
      direction: "inbound",
      body: "Bonjour, je prends la plaquette",
      status: "received",
      channel: "sms",
      generatedBy: "human",
      outboundKind: "solicitation",
      createdAt: Timestamp.fromMillis(1_700_000_000_000),
      receivedAt: Timestamp.fromMillis(1_700_000_000_000),
      ...extra,
    } as Message & { messageId: string };
  }

  it("message AVEC attachedFromOrphan → MessageProps porte attachedFromOrphan.phoneMatch", () => {
    const sanitized = sanitizeMessageForBubble(
      makeInbound({
        attachedFromOrphan: { orphanId: "oih_abc", phoneMatch: "match" },
      }),
      null,
    );
    expect(sanitized).not.toBeNull();
    expect(sanitized!.attachedFromOrphan).toEqual({ phoneMatch: "match" });
  });

  it("sanitize NE propage PAS l'orphanId interne (data minimization client)", () => {
    const sanitized = sanitizeMessageForBubble(
      makeInbound({
        attachedFromOrphan: { orphanId: "oih_secret_leak", phoneMatch: "mismatch" },
      }),
      null,
    );
    expect(sanitized!.attachedFromOrphan).toEqual({ phoneMatch: "mismatch" });
    // L'orphanId NE doit JAMAIS atteindre le client.
    expect(JSON.stringify(sanitized)).not.toContain("oih_secret_leak");
    expect(JSON.stringify(sanitized)).not.toContain("orphanId");
  });

  it("message SANS attachedFromOrphan → clef absente dans MessageProps", () => {
    const sanitized = sanitizeMessageForBubble(makeInbound(), null);
    expect(sanitized).not.toBeNull();
    expect(sanitized!.attachedFromOrphan).toBeUndefined();
  });

  it("phoneMatch hors enum → attachedFromOrphan filtré (fail-closed)", () => {
    const sanitized = sanitizeMessageForBubble(
      makeInbound({
        attachedFromOrphan: { orphanId: "oih_x", phoneMatch: "bogus" as never },
      }),
      null,
    );
    expect(sanitized!.attachedFromOrphan).toBeUndefined();
  });
});

/**
 * Sentinelles PR3 tour 2b — filtre « compte test » + résolution noms.
 *
 * On couvre deux invariants brief Déthié :
 *   1. Un viewer réel (`viewerIsTestAccount: false`) NE VOIT PAS les
 *      entrées d'audit dont le payload porte `actorTestAccount: true`
 *      (évite qu'un harnais Playwright pollue le journal d'une conv réelle).
 *   2. Un viewer test (`viewerIsTestAccount: true`) voit tout — c'est son
 *      canal de debug.
 *   3. `actorName` est injecté depuis la map Clerk uniquement pour les
 *      acteurs `human`, remplacé par `"Léa"` / `"Système"` pour `ai` /
 *      `system`, et jamais l'identifiant brut.
 */
describe("sanitizeAuditEntriesForJournal — filtre testAccount + résolution noms (PR3 tour 2b)", () => {
  function makeEntry(
    overrides: Partial<Parameters<typeof sanitizeAuditEntriesForJournal>[0][number]>,
  ): Parameters<typeof sanitizeAuditEntriesForJournal>[0][number] {
    return {
      docId: "aud_x",
      actorId: "clerk_admin_1",
      actorType: "human",
      actorTestAccount: false,
      action: "contact_phone_accessed",
      targetType: "contact",
      targetId: "hs_abc",
      payload: {},
      timestamp: Timestamp.fromMillis(1_700_000_000_000),
      ...overrides,
    } as Parameters<typeof sanitizeAuditEntriesForJournal>[0][number];
  }

  it("viewer réel : les entrées actorTestAccount=true sont MASQUÉES", () => {
    const entries = [
      makeEntry({ docId: "aud_real", payload: { method: "display", actorTestAccount: false } }),
      makeEntry({ docId: "aud_test", payload: { method: "display", actorTestAccount: true } }),
    ];
    const result = sanitizeAuditEntriesForJournal(entries, {
      actorNameByUserId: new Map([["clerk_admin_1", "Déthié Faye"]]),
      viewerIsTestAccount: false,
    });
    expect(result.map((e) => e.docId)).toEqual(["aud_real"]);
  });

  it("viewer testAccount : toutes les entrées restent visibles", () => {
    const entries = [
      makeEntry({ docId: "aud_real", payload: { method: "display", actorTestAccount: false } }),
      makeEntry({ docId: "aud_test", payload: { method: "display", actorTestAccount: true } }),
    ];
    const result = sanitizeAuditEntriesForJournal(entries, {
      actorNameByUserId: new Map(),
      viewerIsTestAccount: true,
    });
    expect(result.map((e) => e.docId)).toEqual(["aud_real", "aud_test"]);
  });

  it("actorName : résolu Clerk pour `human`, « Léa » pour `ai`, « Système » pour `system`", () => {
    const entries = [
      makeEntry({ docId: "aud_h", actorType: "human", actorId: "clerk_x" }),
      makeEntry({ docId: "aud_ai", actorType: "ai", actorId: "sonnet-4-6" }),
      makeEntry({ docId: "aud_sys", actorType: "system", actorId: "inngest" }),
      makeEntry({ docId: "aud_unknown_h", actorType: "human", actorId: "clerk_removed" }),
    ];
    const result = sanitizeAuditEntriesForJournal(entries, {
      actorNameByUserId: new Map([
        ["clerk_x", "Vanessa Rabba"],
        ["clerk_removed", null],
      ]),
      viewerIsTestAccount: true,
    });
    expect(result.find((e) => e.docId === "aud_h")?.actorName).toBe("Vanessa Rabba");
    expect(result.find((e) => e.docId === "aud_ai")?.actorName).toBe("Léa");
    expect(result.find((e) => e.docId === "aud_sys")?.actorName).toBe("Système");
    expect(result.find((e) => e.docId === "aud_unknown_h")?.actorName).toBeNull();
  });

  it("sentinelle anti-régression : les identifiants Clerk/Slack bruts n'apparaissent JAMAIS dans actorName", () => {
    const entries = [makeEntry({ actorId: "user_abc123def456" })];
    const result = sanitizeAuditEntriesForJournal(entries, {
      actorNameByUserId: new Map(),
      viewerIsTestAccount: true,
    });
    expect(result[0]?.actorName).toBeNull();
    // Serialize → pas d'`user_...` ni de `clerk_...` ni de `U[A-Z0-9]{8+}`.
    const json = JSON.stringify(result);
    expect(json).not.toMatch(/user_[A-Za-z0-9]{10,}/);
    expect(json).not.toMatch(/\bU[A-Z0-9]{8,}\b/);
    expect(json).not.toMatch(/clerk_/);
  });
});
