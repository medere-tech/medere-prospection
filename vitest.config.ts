import os from "node:os";

import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

/**
 * S10.1.8 — plafonne les workers vitest à la moitié des coeurs.
 *
 * Défaut Vitest 4 en `pool: "threads"` = `maxWorkers = os.cpus().length`.
 * Sur un poste 8 coeurs / 8 Go RAM (le poste prod chef de projet), 8 threads
 * qui chargent chacun jsdom + React 19 + base-ui (+ firebase-admin pour
 * `preview-dialog.test.tsx`) en `isolate: true` dépassent la RAM dispo quand
 * le reste de l'OS prend déjà ~7 Go (IDE, Chrome, GHD...). Les workers
 * basculent en swap, ne répondent plus au health-check du pool runner, et
 * Vitest log "Failed to start threads worker ... Timeout waiting for worker
 * to respond" sur les fichiers jsdom les plus lourds (observé 5 crashes sur
 * les 8 fichiers `@vitest-environment jsdom` au pre-push du b14fa52).
 *
 * Preuve de la contention même sans crash : ratio import_cumule / wall =
 * ~4x sur 3 runs consecutifs de `.husky/pre-push` -> les 8 workers se
 * contendent CPU et memoire. Reduction a `cpus/2` double la marge RAM par
 * worker (demarrage jsdom ~400-600 Mo) sans toucher a l'isolation ni au
 * testTimeout.
 *
 * NB Vitest 4 : seul `maxWorkers` est exposé au top de `InlineConfig`
 * (pas de `minWorkers` top-level, qui n'existe qu'en forks via
 * `poolOptions.forks` typologiquement cassé). On s'en passe : le pool
 * Tinypool des threads demarre a 0 workers et scale a la demande jusqu'au
 * plafond, donc pas besoin de forcer un `minWorkers`.
 */
const vitestMaxWorkers = Math.max(2, Math.floor(os.cpus().length / 2));

/**
 * Config Vitest "default" — tests qui n'ont PAS besoin de l'emulator.
 * - Forcé en `pool: "threads"` (PR1.14.1) : le défaut Vitest 4 est
 *   `"forks"` et crée des `child_process.spawn` qui échouent par rafales
 *   sur Windows (verrou AV sur `C:\Users\...\node_modules\vitest\` ou
 *   timeout `vitest-pool-runner`). En threads : zéro worker crash observé
 *   sur une suite de 2367 tests (vs 7 crashes en forks).
 * - Utilisée par `npm test`, `npm run test:watch`, et le hook pre-push.
 *
 * Les tests Firestore vivent dans une config SÉPARÉE
 * (`vitest.config.firestore.ts`) parce que les options `pool: "forks"` +
 * `poolOptions.forks.singleFork: true` qu'on veut pour eux ne sont pas
 * typées dans `ProjectConfig` (limite Vitest 4) et imposeraient un cast
 * `as any`. Deux fichiers = zéro any, deux runtimes clairement séparés.
 *
 * Cohérence coverage : les seuils 100% sur lib/compliance/** et
 * lib/security/** restent appliqués par CETTE config (qui couvre ces
 * fichiers). Le seuil 95% sur lib/firestore/** vit dans la config
 * firestore (seul run qui exécute ces fichiers).
 */
export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    globals: true,
    environment: "node",
    passWithNoTests: true,
    unstubEnvs: true,
    pool: "threads",
    // S10.1.8 — cf. commentaire `vitestMaxWorkers` en tête de fichier.
    maxWorkers: vitestMaxWorkers,
    /**
     * S10.1.7 — testTimeout 15s (vs défaut Vitest 4 = 5000ms). Les tests
     * UI React 19 + base-ui imports (DropdownMenu, Tooltip, Dialog) +
     * jsdom env + premier render d'un composant lourd dépassent
     * occasionnellement les 5s en Husky pre-push (pool: threads parallèle
     * sur 50+ fichiers → pression CPU/mémoire). 15s aligné avec
     * hookTimeout défaut + marge de sécurité CI.
     *
     * NB : un test cassé met désormais 15s à fail au lieu de 5s — c'est
     * un trade-off accepté (3 false-negative pre-push S10.1.7 vs gain
     * en stabilité). Si on observe des tests qui durent réellement
     * > 5s en local (pas juste en CI), c'est un signal qu'ils sont à
     * splitter (trop de logique dans un seul test).
     */
    testTimeout: 15_000,
    include: ["tests/**/*.{test,spec}.{ts,tsx}", "src/**/*.{test,spec}.{ts,tsx}"],
    // Les tests Firestore demandent un emulator up — exclus du run par
    // défaut pour ne pas casser `npm test` / pre-push.
    exclude: [
      "src/lib/firestore/**/*.{test,spec}.{ts,tsx}",
      "tests/firestore/**",
      // Tests `firestore.rules` (S6.7) — utilisent `@firebase/rules-unit-testing`
      // qui exige un emulator up + un projectId distinct. Exécutés via
      // `npm run test:firestore-rules` (config dédiée).
      "tests/firestore-rules/**",
      // Specs Playwright (PR1.14.1) — Vitest les ramasserait via le glob
      // `**/*.spec.ts` et planterait sur `test.describe()` (@playwright/test
      // vs @vitest/test différents). Les specs tournent via `npm run test:e2e`.
      "tests/e2e/**",
      "node_modules/**",
      "dist/**",
      ".next/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      // On exclut lib/firestore du périmètre couverture de cette config :
      // ces fichiers ne tournent pas ici, ils seraient marqués 0% à tort.
      exclude: ["src/lib/firestore/**", "tests/firestore/**", "tests/firestore-rules/**"],
      thresholds: {
        lines: 0,
        functions: 0,
        branches: 0,
        statements: 0,
        "src/lib/compliance/**/*.ts": {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        "src/lib/security/**/*.ts": {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        // S7a — wrapper Claude. Baseline 95% (I/O critique).
        "src/lib/claude/**/*.ts": {
          lines: 95,
          functions: 95,
          branches: 95,
          statements: 95,
        },
        // S7a.2 — classifier d'intent + prompt. Compliance critique
        // (ferme GUARD-001, sanction CNIL jusqu'à 20 M€). 100% requis,
        // verrouillé par sentinelles. Toute modif passe par
        // compliance-auditor + prompt-engineer.
        "src/lib/claude/intent-classifier.ts": {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        "src/lib/claude/prompts/**/*.ts": {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        // S7a.3 — wrapper OVH SMS. Baseline 95% (I/O critique, mapping
        // erreurs HTTP/errno/OAuth). Pas de compliance gate (orchestration
        // métier déportée Inngest S8+).
        "src/lib/ovh/**/*.ts": {
          lines: 95,
          functions: 95,
          branches: 95,
          statements: 95,
        },
      },
    },
  },
});
