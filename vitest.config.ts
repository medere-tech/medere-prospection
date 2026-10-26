import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * PR1.14.2 — alias `server-only` vers un stub vide pour vitest.
 * Cf. `tests/mocks/server-only.ts` : le package npm `server-only` throw
 * hors contexte Next.js serveur. On neutralise UNIQUEMENT dans cette
 * config vitest (pas dans next.config.ts), donc le build Next.js
 * continue de rejeter tout `"use client"` qui importerait un fichier
 * marqué `import "server-only"` (ex. `src/lib/auth/require-role.ts`).
 */
const serverOnlyStubPath = path.resolve(__dirname, "tests/mocks/server-only.ts");

/**
 * PR2b-1 fix (25c0fd2) — plafond ferme à 2 workers Vitest.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Cause racine prouvée (systematic-debugging Phase 1-3) :
 *
 *   `.husky/pre-push` échouait de façon récurrente sur Windows 8 Go avec
 *   « Failed to start threads worker ... Timeout waiting for worker to
 *    respond ». Les 2 pushs antérieurs tombaient toujours sur les mêmes
 *   fichiers jsdom lourds (preview-dialog, conversations-page-client,
 *   columns, query-provider-wraps-use-query).
 *
 *   Hypothèse H1 (correctif précédent `cpus/2 = 4`) : contention RAM.
 *   → Insuffisant : échecs encore observés machine libérée.
 *
 *   Hypothèse H3 (CONFIRMÉE) : contention `import` CPU + Windows
 *   Defender real-time (vérifié : `Get-MpComputerStatus` →
 *   RealTimeProtectionEnabled=True, OnAccessProtectionEnabled=True ;
 *   ExclusionPath non lisible sans admin). Chaque worker Vitest charge
 *   jsdom + React 19 + base-ui + firebase-admin → ~10-20 s d'import
 *   scanné par l'AV. À 4 workers concurrents, Tinypool tue le worker
 *   qui dépasse son health-check interne.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Mesures (vitest run brut, machine normale avec Chrome actif) :
 *
 *                       baseline (4w)     M3bis (2w)       gain
 *   wall médian         102.3 s            86.7 s           -15 %
 *   import cumulé       256.7 s           109.3 s           -58 %
 *   ratio import/wall   2.51              1.26              /2
 *   .husky/pre-push     2 crashes /2      0 crash /5        ✓
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Décisions non prises par ce patch (volontairement) :
 *   - Exclusion Defender `node_modules\` : décision opérationnelle de
 *     Déthié. Gain estimé additionnel : -20 à -30 % sur import (étude
 *     Microsoft Dev Drive 2024). Non appliqué sans sa validation.
 *   - Augmentation `testTimeout` ou timeout Tinypool : interdit par
 *     consigne, car ne traite pas la cause (contention).
 *   - `isolate: false` : testé, casse 47 tests (mocks partagés entre
 *     fichiers) et ne réduit pas le wall. Rejeté.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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
  resolve: {
    alias: {
      // PR1.14.2 — cf. commentaire `serverOnlyStubPath` en tête de fichier.
      "server-only": serverOnlyStubPath,
    },
  },
  test: {
    globals: true,
    environment: "node",
    passWithNoTests: true,
    unstubEnvs: true,
    pool: "threads",
    // [M3bis] maxWorkers=2 au lieu de cpus/2 (=4 sur 8-core). Réduit
    // la contention de démarrage worker Tinypool sur machines Windows
    // avec Defender real-time (chaque worker Vitest charge jsdom +
    // React 19 + base-ui → ~10-20s d'import scanné par l'AV ; à 4
    // workers simultanés, Tinypool tue le worker qui met trop à
    // signaler "ready").
    maxWorkers: 2,
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
