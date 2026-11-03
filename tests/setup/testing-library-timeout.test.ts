// @vitest-environment jsdom

/**
 * Test sentinelle (PR2c tour 2b bloc C bis) — vérifie que le setup
 * global Testing Library `asyncUtilTimeout: 5000` reste appliqué.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi un test dédié
 *
 *   Le réglage vit dans `tests/setup/testing-library-timeout.ts`, chargé
 *   via `setupFiles` dans `vitest.config.ts`. Trois régressions possibles :
 *     1. Quelqu'un retire `setupFiles` de la config vitest.
 *     2. Quelqu'un vide le contenu du fichier setup (ou commente le
 *        `configure(...)`).
 *     3. Un autre `configure({ asyncUtilTimeout: ... })` dans un test
 *        écrase la valeur et oublie de la restaurer.
 *
 *   Dans les 3 cas, `getConfig().asyncUtilTimeout` ne vaudra plus 5000
 *   au moment où CE test tourne → fail explicite au pre-push, lecteur
 *   dirigé immédiatement vers la cause.
 *
 *   Cf. `vitest.config.ts:117-127` pour la raison du réglage (machine
 *   Windows 8 Go, hook pre-push sous charge, pipeline fetch mocké →
 *   setState → re-render qui dépasse 1 s par instants).
 */
import { getConfig } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("Testing Library — setup global (sentinelle PR2c bloc C bis)", () => {
  it("asyncUtilTimeout === 5000 (setupFiles → tests/setup/testing-library-timeout.ts)", () => {
    expect(getConfig().asyncUtilTimeout).toBe(5000);
  });
});
