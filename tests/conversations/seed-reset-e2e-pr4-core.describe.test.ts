/**
 * Tests unit pures — `describeSeedResult` / `describeSeedDecision`.
 *
 * Sentinelle : couvre CHAQUE cas discriminé de `SeedResult` et
 * `SeedDecision`. Mutation (retirer un `case`) → ce fichier tombe.
 *
 * Runs en projet défaut (pas d'emulator nécessaire — fonctions pures).
 */
import { describe, expect, it } from "vitest";

import {
  describeSeedDecision,
  describeSeedResult,
  type SeedDecision,
  type SeedResult,
} from "@/lib/firestore/seed-reset-e2e-pr4-core";

describe("describeSeedResult — couverture SeedResult", () => {
  it('kind: "created" → exitCode 0 + message "Conv créée."', () => {
    const r: SeedResult = { kind: "created" };
    const out = describeSeedResult(r);
    expect(out.exitCode).toBe(0);
    expect(out.lines.join("\n")).toMatch(/Conv créée/);
  });

  it('kind: "already-complete" → exitCode 0 + message "déjà complète"', () => {
    const r: SeedResult = { kind: "already-complete" };
    const out = describeSeedResult(r);
    expect(out.exitCode).toBe(0);
    expect(out.lines.join("\n")).toMatch(/déjà (seedée et )?complète/i);
  });

  it('kind: "already-incomplete" → exitCode 1 + liste des issues préfixée "-"', () => {
    const r: SeedResult = {
      kind: "already-incomplete",
      issues: ["lastMessageAt absent", "schema:handoff.assignedTo (invalid_type)"],
    };
    const out = describeSeedResult(r);
    expect(out.exitCode).toBe(1);
    const txt = out.lines.join("\n");
    expect(txt).toMatch(/INCOMPLÈTE/);
    expect(txt).toMatch(/- lastMessageAt absent/);
    expect(txt).toMatch(/- schema:handoff\.assignedTo \(invalid_type\)/);
  });

  it('kind: "already-incomplete" avec issues vides → exitCode 1 mais pas de ligne de bullet', () => {
    // Cas dégénéré (ne devrait pas se produire — checkSeedCompleteness
    // retourne forcément au moins 1 issue si complete=false) mais le
    // helper ne doit pas planter.
    const r: SeedResult = { kind: "already-incomplete", issues: [] };
    const out = describeSeedResult(r);
    expect(out.exitCode).toBe(1);
    expect(out.lines.filter((l) => l.startsWith("      -"))).toEqual([]);
  });
});

describe("describeSeedDecision — couverture SeedDecision", () => {
  it('kind: "will-create" → exitCode 0 + message "Conv absente"', () => {
    const d: SeedDecision = { kind: "will-create" };
    const out = describeSeedDecision(d);
    expect(out.exitCode).toBe(0);
    expect(out.lines.join("\n")).toMatch(/Conv absente/);
  });

  it('kind: "already-exists" + complete:true → exitCode 0 + "complète"', () => {
    const d: SeedDecision = {
      kind: "already-exists",
      currentStatus: "handed_off",
      completeness: { complete: true, issues: [] },
    };
    const out = describeSeedDecision(d);
    expect(out.exitCode).toBe(0);
    const txt = out.lines.join("\n");
    expect(txt).toMatch(/status=handed_off/);
    expect(txt).toMatch(/complète/i);
  });

  it('kind: "already-exists" + complete:false → exitCode 1 + liste des issues', () => {
    const d: SeedDecision = {
      kind: "already-exists",
      currentStatus: "handed_off",
      completeness: {
        complete: false,
        issues: ["lastMessageAt absent", "handoff.assignedTo invalide"],
      },
    };
    const out = describeSeedDecision(d);
    expect(out.exitCode).toBe(1);
    const txt = out.lines.join("\n");
    expect(txt).toMatch(/INCOMPLÈTE/);
    expect(txt).toMatch(/- lastMessageAt absent/);
    expect(txt).toMatch(/- handoff\.assignedTo invalide/);
  });
});
