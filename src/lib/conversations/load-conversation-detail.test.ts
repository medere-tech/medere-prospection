/**
 * Tests PR1.14.2 — `computeViewerIsOwner` (fix S5 bug applicatif).
 *
 * Avant le fix : `viewerIsOwner: isAdmin || (…)` — un admin sans
 * slackUserId était faussement marqué owner, cachant la bannière
 * « Mode admin » sur une conv qu'il ne suit pas.
 */
import { describe, expect, it } from "vitest";

import { computeViewerIsOwner } from "./load-conversation-detail";

describe("computeViewerIsOwner — fix S5", () => {
  it("admin SANS slackUserId sur conv assignée → false (jamais owner)", () => {
    expect(computeViewerIsOwner(undefined, "U05UVHGBURX")).toBe(false);
  });

  it("admin avec slackUserId === assignedToSlack → true (vraiment titulaire)", () => {
    expect(computeViewerIsOwner("U05UVHGBURX", "U05UVHGBURX")).toBe(true);
  });

  it("admin avec slackUserId !== assignedToSlack → false (observe une conv d'un autre)", () => {
    expect(computeViewerIsOwner("UAUTRE1234", "U05UVHGBURX")).toBe(false);
  });

  it("admin avec slackUserId sur conv SANS handoff (null) → false", () => {
    expect(computeViewerIsOwner("U05UVHGBURX", null)).toBe(false);
  });

  it("commercial titulaire (slackUserId === assignedToSlack) → true", () => {
    expect(computeViewerIsOwner("UCOMMERCIAL", "UCOMMERCIAL")).toBe(true);
  });

  it("commercial non-titulaire (slackUserId !== assignedToSlack) → false", () => {
    // Ne devrait pas arriver (bloqué 403 en amont), mais fail-safe.
    expect(computeViewerIsOwner("UCOMMERCIAL", "UDIFFERENT")).toBe(false);
  });

  it("viewer undefined + handoff null → false (double absence)", () => {
    expect(computeViewerIsOwner(undefined, null)).toBe(false);
  });

  // SENTINELLE régression S5 — formulation du cas réel qui a cassé.
  it("REGRESSION S5 — e2e-admin (slackUserId undefined) sur A (assignée U05UVHGBURX) → false → bannière Mode admin AFFICHÉE", () => {
    const result = computeViewerIsOwner(undefined, "U05UVHGBURX");
    expect(result, "si true, bannière Mode admin cachée pour un admin non-titulaire (bug S5)").toBe(
      false,
    );
  });
});

/**
 * Durcissement PR1.14.2 (2026-10-23) — règle stricte « deux chaînes non
 * vides et égales ». Les 7 cas listés par Déthié pour verrouiller
 * tout retour accidentel de `true` sur une absence.
 */
describe("computeViewerIsOwner — règle stricte (deux chaînes non vides et égales)", () => {
  it("(undefined, undefined) → false", () => {
    expect(computeViewerIsOwner(undefined, undefined)).toBe(false);
  });
  it("(null, null) → false", () => {
    expect(computeViewerIsOwner(null, null)).toBe(false);
  });
  it("(undefined, null) → false", () => {
    expect(computeViewerIsOwner(undefined, null)).toBe(false);
  });
  it('("", "") → false — PROTÈGE le cas pervers de la double absence stringifiée', () => {
    expect(computeViewerIsOwner("", "")).toBe(false);
  });
  it('(undefined, "U123") → false', () => {
    expect(computeViewerIsOwner(undefined, "U123")).toBe(false);
  });
  it('("U123", null) → false', () => {
    expect(computeViewerIsOwner("U123", null)).toBe(false);
  });
  it('("U123", "U123") → true — SEUL cas qui doit matcher', () => {
    expect(computeViewerIsOwner("U123", "U123")).toBe(true);
  });

  // Compléments défensifs (asymétries)
  it('("", "U123") → false (viewer vide)', () => {
    expect(computeViewerIsOwner("", "U123")).toBe(false);
  });
  it('("U123", "") → false (assigné vide)', () => {
    expect(computeViewerIsOwner("U123", "")).toBe(false);
  });
});
