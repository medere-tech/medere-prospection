/**
 * Tests `formatRelativeToParis` (PR2b-1 — ex `formatRelative` de columns.tsx).
 *
 * Vérifie le mapping diff → libellé FR aux 5 bornes :
 *   < 1 min  → "à l'instant"
 *   < 1 h    → "il y a N min"
 *   < 24 h   → "il y a N h"
 *   < 7 j    → "il y a N j"
 *   ≥ 7 j    → "jj mois court" via Intl Paris
 */
import { describe, expect, it } from "vitest";

import { formatRelativeToParis } from "./format-paris";

const NOW = new Date("2026-10-26T12:00:00.000Z");

describe("formatRelativeToParis", () => {
  it("< 1 min → 'à l'instant'", () => {
    const d = new Date(NOW.getTime() - 30_000);
    expect(formatRelativeToParis(d, NOW)).toBe("à l'instant");
  });

  it("< 1 h → 'il y a N min'", () => {
    const d = new Date(NOW.getTime() - 5 * 60_000);
    expect(formatRelativeToParis(d, NOW)).toBe("il y a 5 min");
  });

  it("< 24 h → 'il y a N h'", () => {
    const d = new Date(NOW.getTime() - 3 * 3_600_000);
    expect(formatRelativeToParis(d, NOW)).toBe("il y a 3 h");
  });

  it("< 7 j → 'il y a N j'", () => {
    const d = new Date(NOW.getTime() - 3 * 24 * 3_600_000);
    expect(formatRelativeToParis(d, NOW)).toBe("il y a 3 j");
  });

  it("≥ 7 j → date courte Paris (format `N mois.`)", () => {
    const d = new Date("2026-10-15T10:00:00.000Z");
    const out = formatRelativeToParis(d, NOW);
    // Intl FR court : "15 oct." (le format exact peut dépendre de ICU/Node).
    expect(out).toMatch(/^15\s/);
    expect(out).toMatch(/oct/i);
  });

  it("null / undefined / invalide → '—'", () => {
    expect(formatRelativeToParis(null, NOW)).toBe("—");
    expect(formatRelativeToParis(undefined, NOW)).toBe("—");
    expect(formatRelativeToParis("not-a-date", NOW)).toBe("—");
  });

  it("accepte un ISO string et un Date équivalemment", () => {
    const iso = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    expect(formatRelativeToParis(iso, NOW)).toBe("il y a 5 min");
  });

  it("borne stricte : exactement 60s → 'il y a 1 min' (bascule à 60)", () => {
    const d = new Date(NOW.getTime() - 60_000);
    expect(formatRelativeToParis(d, NOW)).toBe("il y a 1 min");
  });

  it("borne stricte : exactement 60min → 'il y a 1 h'", () => {
    const d = new Date(NOW.getTime() - 60 * 60_000);
    expect(formatRelativeToParis(d, NOW)).toBe("il y a 1 h");
  });

  it("borne stricte : exactement 24h → 'il y a 1 j'", () => {
    const d = new Date(NOW.getTime() - 24 * 3_600_000);
    expect(formatRelativeToParis(d, NOW)).toBe("il y a 1 j");
  });

  it("borne stricte : exactement 7 j → bascule en format court", () => {
    const d = new Date(NOW.getTime() - 7 * 24 * 3_600_000);
    const out = formatRelativeToParis(d, NOW);
    expect(out).not.toMatch(/il y a/);
    expect(out).toMatch(/oct/i);
  });
});
