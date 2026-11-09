/**
 * Tests unitaires — calcul de `canMarkContacted` / `canUndoContact` dans
 * `loadConversationDetail` (PR4 B1). Sont vérifiés pour admin / titulaire
 * commercial / non-titulaire / auteur / non-auteur.
 *
 * On ne mocke pas Firestore : on teste directement les prédicats purs
 * exportés par `mark-handoff-contacted.ts` (source unique). La
 * composition `status + handoffContacted + predicate` qui vit dans
 * `loadConversationDetail` est reproduite ici fidèlement — si quelqu'un
 * casse la composition (ex: oublie `handoffContacted === false`), le
 * test de visibilité emulator (`tests/firestore/*`) tombe.
 */
import { describe, expect, it } from "vitest";

import {
  canMarkHandoffContacted,
  canUnmarkHandoffContacted,
  type HandoffContactedActor,
} from "@/lib/conversations/mark-handoff-contacted";

const TITULAIRE = "U_VANESSA";

const ADMIN: HandoffContactedActor = {
  userId: "user_admin",
  role: "admin",
  slackUserId: undefined,
  testAccount: false,
};
const COMMERCIAL_TITULAIRE: HandoffContactedActor = {
  userId: "user_vanessa",
  role: "commercial",
  slackUserId: TITULAIRE,
  testAccount: false,
};
const COMMERCIAL_AUTRE: HandoffContactedActor = {
  userId: "user_autre",
  role: "commercial",
  slackUserId: "U_AUTRE",
  testAccount: false,
};

/**
 * Reproduit la composition exacte de `loadConversationDetail` (PR4 B1) :
 *   canMarkContacted = status === "handed_off"
 *                   AND handoffContacted === false
 *                   AND canMarkHandoffContacted(actor, handoff.assignedTo)
 */
function computeCanMarkContacted(
  actor: HandoffContactedActor,
  status: string,
  handoffContacted: boolean,
  assignedTo: string | undefined,
): boolean {
  return (
    status === "handed_off" &&
    handoffContacted === false &&
    canMarkHandoffContacted(actor, assignedTo)
  );
}

function computeCanUndoContact(
  actor: HandoffContactedActor,
  handoffContacted: boolean,
  contactedBy: string | undefined,
): boolean {
  return handoffContacted === true && canUnmarkHandoffContacted(actor, contactedBy);
}

describe("loadConversationDetail — canMarkContacted (PR4 B1)", () => {
  it("admin + handed_off + non contactée → true", () => {
    expect(computeCanMarkContacted(ADMIN, "handed_off", false, TITULAIRE)).toBe(true);
  });

  it("commercial titulaire + handed_off + non contactée → true", () => {
    expect(computeCanMarkContacted(COMMERCIAL_TITULAIRE, "handed_off", false, TITULAIRE)).toBe(
      true,
    );
  });

  it("commercial non-titulaire + handed_off + non contactée → false", () => {
    expect(computeCanMarkContacted(COMMERCIAL_AUTRE, "handed_off", false, TITULAIRE)).toBe(false);
  });

  it("admin mais conv déjà contactée → false (handoffContacted doit être false)", () => {
    expect(computeCanMarkContacted(ADMIN, "handed_off", true, TITULAIRE)).toBe(false);
  });

  it("admin mais status ≠ handed_off → false", () => {
    expect(computeCanMarkContacted(ADMIN, "active", false, TITULAIRE)).toBe(false);
  });
});

describe("loadConversationDetail — canUndoContact (PR4 B1)", () => {
  const AUTEUR_USER_ID = "user_vanessa";
  const COMMERCIAL_AUTEUR: HandoffContactedActor = {
    userId: AUTEUR_USER_ID,
    role: "commercial",
    slackUserId: TITULAIRE,
    testAccount: false,
  };
  const COMMERCIAL_NON_AUTEUR: HandoffContactedActor = {
    userId: "user_someone_else",
    role: "commercial",
    slackUserId: TITULAIRE,
    testAccount: false,
  };

  it("admin + conv contactée → true (admin peut toujours annuler)", () => {
    expect(computeCanUndoContact(ADMIN, true, AUTEUR_USER_ID)).toBe(true);
  });

  it("auteur du marquage + conv contactée → true", () => {
    expect(computeCanUndoContact(COMMERCIAL_AUTEUR, true, AUTEUR_USER_ID)).toBe(true);
  });

  it("commercial NON auteur + conv contactée → false", () => {
    expect(computeCanUndoContact(COMMERCIAL_NON_AUTEUR, true, AUTEUR_USER_ID)).toBe(false);
  });

  it("conv NON contactée → false même pour admin", () => {
    expect(computeCanUndoContact(ADMIN, false, AUTEUR_USER_ID)).toBe(false);
  });
});
