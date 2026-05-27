import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // tsconfigPaths : résout l'alias "@/*". react : pour les tests de composants.
  plugins: [tsconfigPaths(), react()],
  test: {
    globals: true,
    // Environnement node par défaut (logique métier). Pour un test de composant
    // React, ajouter le pragma `// @vitest-environment jsdom` en tête de fichier.
    environment: "node",
    // Permet à `npm test` de passer sur un repo encore sans test (utile pour le
    // hook pre-push tant que lib/compliance & lib/security n'existent pas).
    passWithNoTests: true,
    include: ["tests/**/*.{test,spec}.{ts,tsx}", "src/**/*.{test,spec}.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      thresholds: {
        // Seuils globaux volontairement à 0 (le repo se remplit progressivement).
        lines: 0,
        functions: 0,
        branches: 0,
        statements: 0,
        // 100% STRICT, mais UNIQUEMENT sur les modules critiques (quand ils existeront).
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
