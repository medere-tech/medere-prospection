import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

/**
 * Config Vitest "default" — tests qui n'ont PAS besoin de l'emulator.
 * - Tourne en `pool: threads` (défaut Vitest), parallèle, rapide.
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
    include: ["tests/**/*.{test,spec}.{ts,tsx}", "src/**/*.{test,spec}.{ts,tsx}"],
    // Les tests Firestore demandent un emulator up — exclus du run par
    // défaut pour ne pas casser `npm test` / pre-push.
    exclude: [
      "src/lib/firestore/**/*.{test,spec}.{ts,tsx}",
      "tests/firestore/**",
      "node_modules/**",
      "dist/**",
      ".next/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      // On exclut lib/firestore du périmètre couverture de cette config :
      // ces fichiers ne tournent pas ici, ils seraient marqués 0% à tort.
      exclude: ["src/lib/firestore/**", "tests/firestore/**"],
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
      },
    },
  },
});
