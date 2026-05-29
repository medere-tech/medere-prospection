import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

/**
 * Config Vitest dédiée aux tests Firestore (parlent à l'emulator local).
 *
 * Pourquoi un fichier séparé du root :
 *   - Permet une config strict (`fileParallelism: false`, `maxWorkers: 1`)
 *     qui ne s'applique qu'aux tests Firestore, sans contaminer la perf
 *     du run par défaut.
 *
 * Pourquoi un seul worker (équivalent du legacy `singleFork: true`) :
 *   - L'emulator est UN process partagé. Plusieurs workers Vitest qui
 *     lancent `clearFirestore` (DELETE REST) en parallèle créent des
 *     race conditions (un worker clear pendant qu'un autre seed → tests
 *     flaky). Un seul worker élimine la classe entière de bugs.
 *   - Vitest 4 a supprimé `poolOptions` (breaking change). Le pattern
 *     `pool: forks` + `poolOptions.forks.singleFork: true` (Vitest 3)
 *     devient `pool: forks` + `fileParallelism: false` + `maxWorkers: 1`.
 *     Cf. node_modules/vitest/dist/chunks/reporters.d.* lignes 2843+.
 *
 * Coverage : seul ce run touche lib/firestore/**, donc le seuil 95% vit
 * ici. Le wrapper pre-send-check-with-audit (S6.6) restera lui sous
 * lib/compliance/ et héritera donc du seuil 100% de la config root.
 */
export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    globals: true,
    environment: "node",
    passWithNoTests: false,
    unstubEnvs: true,
    include: [
      "src/lib/firestore/**/*.{test,spec}.{ts,tsx}",
      "tests/firestore/**/*.{test,spec}.{ts,tsx}",
    ],
    exclude: ["tests/firestore/setup.ts", "node_modules/**"],
    pool: "forks",
    // Vitest 4 — équivalent du legacy `poolOptions.forks.singleFork: true`.
    fileParallelism: false,
    maxWorkers: 1,
    setupFiles: ["tests/firestore/setup.ts"],
    hookTimeout: 20_000,
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/lib/firestore/**/*.ts"],
      exclude: ["src/lib/firestore/**/*.{test,spec}.ts", "src/lib/firestore/index.ts"],
      thresholds: {
        "src/lib/firestore/**/*.ts": {
          lines: 95,
          functions: 95,
          branches: 95,
          statements: 95,
        },
      },
    },
  },
});
