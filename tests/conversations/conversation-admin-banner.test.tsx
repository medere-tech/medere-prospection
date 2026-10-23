// @vitest-environment jsdom
/**
 * Tests PR1.14 — bannière « Mode admin » (`ConversationAdminBanner`) et
 * sa règle de visibilité `shouldShowAdminBanner`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Couverture
 *
 *   A. `shouldShowAdminBanner(viewerRole, viewerIsOwner)` — table de
 *      vérité complète (4 cas, dont mutation testing : seul le cas
 *      admin+!isOwner retourne true).
 *   B. `ConversationAdminBanner` isolé — 3 cas rendu :
 *      1. nom résolu présent → "Mode admin : conversation suivie par <nom>."
 *      2. nom null → fallback "...par un autre commercial."
 *      3. accessibilité : role="status" + aria-live="polite"
 *
 * Pourquoi A ET B : la condition est côté parent
 * (`conversation-detail-client.tsx`), le JSX est côté composant. Les
 * tests A protègent la logique (admin & !owner) sans monter React
 * Query ni le wrapper. Les tests B protègent le markup et l'a11y.
 */
import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  ConversationAdminBanner,
  shouldShowAdminBanner,
} from "@/components/conversations/conversation-admin-banner";

afterEach(() => cleanup());

describe("shouldShowAdminBanner — table de vérité (PR1.14)", () => {
  it("admin + !isOwner → true (cas visé : supervision)", () => {
    expect(shouldShowAdminBanner("admin", false)).toBe(true);
  });

  it("admin + isOwner → false (admin sur sa propre conv)", () => {
    expect(shouldShowAdminBanner("admin", true)).toBe(false);
  });

  it("commercial + !isOwner → false (fail-safe : devrait déjà être 403)", () => {
    expect(shouldShowAdminBanner("commercial", false)).toBe(false);
  });

  it("commercial + isOwner → false (cas nominal commercial)", () => {
    expect(shouldShowAdminBanner("commercial", true)).toBe(false);
  });

  it("mutation testing : si on remplace `&&` par `||`, au moins 2 cas échouent", () => {
    // Garde-fou contre une mutation sournoise : la fonction a 4 entrées,
    // 1 doit retourner true, 3 doivent retourner false. Toute mutation
    // qui déplace un des faux vers vrai fait échouer l'un des 3 cas
    // ci-dessus ; toute mutation qui déplace le seul vrai vers faux
    // fait échouer le premier cas. On vérifie ici le compte explicite.
    const combos: Array<["admin" | "commercial", boolean]> = [
      ["admin", false],
      ["admin", true],
      ["commercial", false],
      ["commercial", true],
    ];
    const trueCount = combos.filter(([r, o]) => shouldShowAdminBanner(r, o)).length;
    expect(trueCount, "exactement 1 entrée doit renvoyer true").toBe(1);
  });
});

describe("ConversationAdminBanner — rendu (PR1.14)", () => {
  it("affiche le nom du titulaire quand résolu", () => {
    render(<ConversationAdminBanner assignedToName="Vanessa Rabba" />);
    expect(
      screen.getByText(/conversation suivie par Vanessa Rabba\. Vous voyez tout/),
    ).toBeInTheDocument();
  });

  it("fallback 'un autre commercial' quand le nom n'est pas résolvable", () => {
    render(<ConversationAdminBanner assignedToName={null} />);
    expect(screen.getByText(/conversation suivie par un autre commercial\./)).toBeInTheDocument();
  });

  it("accessibilité : role='status' + aria-live='polite' sur le wrapper", () => {
    render(<ConversationAdminBanner assignedToName="Vanessa Rabba" />);
    const status = screen.getByRole("status");
    expect(status).toBeInTheDocument();
    expect(status.getAttribute("aria-live")).toBe("polite");
  });
});
