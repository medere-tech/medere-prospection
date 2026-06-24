// @vitest-environment jsdom

/**
 * Tests `<StatusFilter />` (S10.1.7-M4 — couverture handler + type guard).
 *
 * Couvre :
 *   - render → label "Statut" + trigger ARIA accessible
 *   - handleStatusChange (4 cas) : null / "" / status invalide / status valide
 *   - __isContactStatus_FOR_TESTS : tous les status valides + cas invalides
 */
import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("nuqs", () => ({
  useQueryState: vi.fn(() => [null, vi.fn()]),
}));

import { __isContactStatus_FOR_TESTS, handleStatusChange, StatusFilter } from "./status-filter";

describe("StatusFilter (S10.1.7-M4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("render → label 'Statut' + trigger ARIA accessible", () => {
    render(<StatusFilter />);
    expect(screen.getByText("Statut")).toBeInTheDocument();
    expect(screen.getByLabelText("Filtrer par statut")).toBeInTheDocument();
  });

  describe("handleStatusChange (handler pur)", () => {
    it("value=null → setStatus(null) + onChange(null)", () => {
      const setStatus = vi.fn();
      const onChange = vi.fn();
      handleStatusChange(null, setStatus, onChange);
      expect(setStatus).toHaveBeenCalledWith(null);
      expect(onChange).toHaveBeenCalledWith(null);
    });

    it('value="" (vide) → setStatus(null) + onChange(null)', () => {
      const setStatus = vi.fn();
      const onChange = vi.fn();
      handleStatusChange("", setStatus, onChange);
      expect(setStatus).toHaveBeenCalledWith(null);
      expect(onChange).toHaveBeenCalledWith(null);
    });

    it("value=invalide (ex: 'foo') → setStatus(null) + onChange(null) — type guard runtime bloque le cast aveugle", () => {
      const setStatus = vi.fn();
      const onChange = vi.fn();
      handleStatusChange("foo", setStatus, onChange);
      expect(setStatus).toHaveBeenCalledWith(null);
      expect(onChange).toHaveBeenCalledWith(null);
    });

    it("value=status valide (ex: 'ready') → setStatus('ready') + onChange('ready')", () => {
      const setStatus = vi.fn();
      const onChange = vi.fn();
      handleStatusChange("ready", setStatus, onChange);
      expect(setStatus).toHaveBeenCalledWith("ready");
      expect(onChange).toHaveBeenCalledWith("ready");
    });

    it("onChange absent (optionnel) → ne throw pas", () => {
      const setStatus = vi.fn();
      expect(() => handleStatusChange("ready", setStatus)).not.toThrow();
      expect(setStatus).toHaveBeenCalledWith("ready");
    });
  });

  describe("__isContactStatus_FOR_TESTS (type guard runtime)", () => {
    it("retourne true pour tous les status valides", () => {
      const validStatuses = [
        "pending",
        "enriched",
        "ready",
        "in_conversation",
        "qualified",
        "opted_out",
        "archived",
      ];
      for (const s of validStatuses) {
        expect(__isContactStatus_FOR_TESTS(s)).toBe(true);
      }
    });

    it("retourne false pour les valeurs invalides", () => {
      expect(__isContactStatus_FOR_TESTS("")).toBe(false);
      expect(__isContactStatus_FOR_TESTS("foo")).toBe(false);
      expect(__isContactStatus_FOR_TESTS("READY")).toBe(false); // case-sensitive
      expect(__isContactStatus_FOR_TESTS("ready ")).toBe(false); // trailing space
      expect(__isContactStatus_FOR_TESTS("undefined")).toBe(false);
    });
  });
});
