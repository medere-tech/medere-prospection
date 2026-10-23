/**
 * Playwright — harnais e2e lecture seule PR1.14.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Discipline
 *
 *   - `E2E_BASE_URL` passé en variable, jamais en dur (préview Vercel ou
 *     branche locale `next dev`). Fail-fast si absent.
 *   - 3 projets viewport : 390x844 (iPhone 13), 768x1024 (iPad portrait),
 *     1440x900 (desktop) — correspond au point 7 du cahier des charges.
 *   - Lecture seule stricte : jamais d'input user-driven qui écrit (STOP
 *     SMS, hand-off, etc.). Les scénarios ouvrent la page, inspectent le
 *     DOM, cliquent sur des éléments **de lecture** uniquement.
 *   - Clerk gère l'auth via `@clerk/testing/playwright` : sign-in via
 *     code OTP figé `424242` (mode test), token stocké dans
 *     `tests/e2e/.auth/*.json` (gitignored).
 *   - `scripts/setup-e2e-clerk-users.mjs --apply` doit avoir été lancé
 *     une fois avant pour provisionner `e2e-commercial` et `e2e-admin`.
 */
import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL;
if (!BASE_URL) {
  throw new Error(
    "E2E_BASE_URL manquant. Exemple :\n" +
      '  E2E_BASE_URL="https://medere-prospection-git-feat-pr1.vercel.app" npm run test:e2e',
  );
}

export default defineConfig({
  testDir: "./tests/e2e",
  // Pas de parallélisme entre workers pour une passe lecture seule contre
  // un déploiement partagé — évite les faux positifs sur le polling.
  workers: 1,
  // Retries 0 : on veut voir le vrai état, pas masquer un flake lecture seule.
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  // Pas de webServer : le harnais tourne contre E2E_BASE_URL (prévisualisation
  // Vercel ou dev local déjà lancé). Évite tout contrôle de la DB en local.
  globalSetup: "./tests/e2e/global.setup.ts",
  use: {
    baseURL: BASE_URL,
    // F-H1 compliance-auditor PR1.14.1 : artefacts Playwright peuvent
    // contenir des quasi-identifiants PS réels (nom + ville + spécialité)
    // si le harnais tourne contre un préview Vercel branché sur Firestore
    // prod. RGPD Art. 32 + 5(1)(c) : minimisation. Décision définitive :
    // zéro video, zéro trace, zéro screenshot — pas de gate conditionnel
    // sur l'URL (fragile si l'URL de prod change). L'opérateur qui a
    // besoin d'un trace pour debugger un flake relance avec `PWDEBUG=1`
    // localement contre un dev lancé en local — JAMAIS en CI partagée.
    screenshot: "off",
    video: "off",
    trace: "off",
    // Les Clerk testing cookies sont stockés par les specs qui en ont besoin.
  },
  projects: [
    {
      name: "mobile-390",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } },
    },
    {
      name: "tablet-768",
      use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 } },
    },
    {
      name: "desktop-1440",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
});
