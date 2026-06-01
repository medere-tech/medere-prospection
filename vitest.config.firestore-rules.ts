import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

/**
 * Config Vitest dédiée aux tests `firestore.rules` (S6.7).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi un fichier séparé de `vitest.config.firestore.ts` :
 *
 *   - Les tests rules utilisent `@firebase/rules-unit-testing` qui est
 *     un wrapper du SDK CLIENT Firebase. Mélanger Admin SDK (S6.1-S6.6)
 *     et Client SDK (S6.7 rules) dans le même process Vitest crée des
 *     conflits de namespace (instances Firebase nommées en parallèle).
 *
 *   - `@firebase/rules-unit-testing` namespace par `projectId` —
 *     on utilise `medere-rules-test` (vs `medere-test` pour S6.1-S6.6)
 *     pour isoler les writes des deux suites sur le MÊME emulator
 *     (port 8085). Pas besoin de démarrer un 2e emulator.
 *
 *   - Coverage TS non applicable ici : les rules ne sont pas du
 *     TypeScript, c'est du CEL (Common Expression Language) Firestore.
 *     Le coverage de `firestore.rules` est implicite — chaque
 *     `allow X: if false` est exercé par au moins 1 test qui
 *     `assertFails`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Single-worker (équivalent firestore config S6.1) :
 *
 *   `@firebase/rules-unit-testing` partage l'emulator avec les autres
 *   suites. `testEnv.clearFirestore()` après chaque test garantit
 *   l'isolation entre tests dans CE run, mais on évite la parallélisation
 *   inter-fichiers (`fileParallelism: false`) pour ne pas marcher sur
 *   les seeds des autres tests rules en cours.
 */
export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    globals: true,
    environment: "node",
    passWithNoTests: false,
    unstubEnvs: true,
    include: ["tests/firestore-rules/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["tests/firestore-rules/setup.ts", "node_modules/**"],
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    setupFiles: ["tests/firestore-rules/setup.ts"],
    hookTimeout: 20_000,
    testTimeout: 15_000,
  },
});
