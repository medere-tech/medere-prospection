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
