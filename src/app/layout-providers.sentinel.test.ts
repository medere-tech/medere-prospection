/**
 * Sentinelle anti-régression S10.1.11-NUQS-ADAPTER-001.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rationale (bug runtime S10.1.11) :
 *
 *   `src/app/admin/contacts/contacts-page-client.tsx` utilise `useQueryState`
 *   de `nuqs` (URL state pour filters/cursor — décision arbitrage B2 S10.1.5).
 *   nuqs **REQUIERT** un `<NuqsAdapter>` parent au runtime, sinon throw :
 *
 *     "[nuqs] nuqs requires an adapter to work with your framework"
 *     → page blanche, /admin/contacts cassée.
 *
 *   Le bug a échappé à toute la suite UI parce que **tous les tests UI
 *   mockent `nuqs`** (`vi.mock("nuqs", ...)`), donc l'absence d'adapter
 *   dans le root layout n'a jamais été détectée par Vitest.
 *
 *   Mitigation : NuqsAdapter wiré dans `src/app/layout.tsx` (root layout,
 *   placement A.3 — wrappant `{children}` ET `<Toaster>`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Ce que cette sentinelle verrouille :
 *
 *   1. L'import nommé `NuqsAdapter` depuis `"nuqs/adapters/next/app"`
 *      (chemin Next.js App Router — distinct de `nuqs/adapters/next/pages`
 *      pour Pages Router).
 *   2. La présence de la balise JSX `<NuqsAdapter>` dans le root layout.
 *
 *   Si quelqu'un remove le wrapper (refactor, simplification accidentelle),
 *   ce test ÉCHOUE clairement avec un message qui rappelle la cause du bug
 *   original — pas de page blanche silencieuse en prod.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi un test filesystem et pas un test render ? :
 *
 *   - `src/app/layout.tsx` est un Server Component qui mount ClerkProvider,
 *     fonts Google, etc. — pénible à rendre en jsdom (besoin de mock SSR
 *     complet, des fonts, du middleware Clerk).
 *   - La sentinelle vérifie la STRUCTURE du fichier source (présence d'un
 *     import + d'une balise JSX), pas son comportement runtime. C'est
 *     exactement ce qu'on veut : un test filesystem zero-dep, ~10 ms, qui
 *     coupe la régression à la racine.
 *   - Pattern aligné avec `src/lib/security/no-cause-leak.sentinel.test.ts`
 *     (S10.1.7) — convention projet pour les anti-régressions structurelles.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = join(__dirname, "..", "..");
const LAYOUT_PATH = join(REPO_ROOT, "src", "app", "layout.tsx");

/**
 * Pattern import — accepte les variations de formatage Prettier (espaces,
 * import individuel ou groupé). Le chemin canonique pour Next.js App Router
 * est `nuqs/adapters/next/app` (vs `/pages` pour Pages Router).
 *
 * 🔒 Ne PAS élargir au matching `from "nuqs"` brut : `useQueryState` est
 * importé depuis `"nuqs"` (racine) côté composants client, mais le
 * `NuqsAdapter` doit OBLIGATOIREMENT venir du sous-import `/adapters/next/app`
 * (typage correct + bundle correct pour App Router).
 */
const NUQS_ADAPTER_IMPORT_PATTERN =
  /import\s*\{[^}]*\bNuqsAdapter\b[^}]*\}\s*from\s*["']nuqs\/adapters\/next\/app["']/;

/** Pattern JSX — accepte les attributs/props éventuels sur la balise. */
const NUQS_ADAPTER_JSX_PATTERN = /<NuqsAdapter(\s|>)/;

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Sentinelle NuqsAdapter dans root layout (S10.1.11-NUQS-ADAPTER-001)", () => {
  it("src/app/layout.tsx existe et est lisible (sanity)", () => {
    // Sanity check : si le fichier disparaît (refactor de layout, etc.),
    // les 2 assertions suivantes seraient vacuously true → faux négatif
    // dangereux (sentinelle qui passe sans rien vérifier).
    const content = readFileSync(LAYOUT_PATH, "utf-8");
    expect(content.length).toBeGreaterThan(0);
  });

  it("importe `NuqsAdapter` depuis `nuqs/adapters/next/app`", () => {
    const content = readFileSync(LAYOUT_PATH, "utf-8");
    if (!NUQS_ADAPTER_IMPORT_PATTERN.test(content)) {
      throw new Error(
        [
          "Sentinelle S10.1.11-NUQS-ADAPTER-001 — import manquant.",
          "",
          "`src/app/layout.tsx` doit importer NuqsAdapter :",
          '  import { NuqsAdapter } from "nuqs/adapters/next/app";',
          "",
          "Rationale : src/app/admin/contacts/contacts-page-client.tsx utilise",
          "`useQueryState` de nuqs, qui REQUIERT un <NuqsAdapter> parent. Sans",
          'cet import + wrapper, nuqs throw au runtime : "[nuqs] nuqs requires an',
          'adapter to work with your framework" → /admin/contacts cassée.',
          "",
          "Les tests UI mockent nuqs → ne couvrent PAS l'absence d'adapter.",
          "Cf. bug runtime S10.1.11.",
        ].join("\n"),
      );
    }
  });

  it("wrappe les children avec une balise JSX `<NuqsAdapter>`", () => {
    const content = readFileSync(LAYOUT_PATH, "utf-8");
    if (!NUQS_ADAPTER_JSX_PATTERN.test(content)) {
      throw new Error(
        [
          "Sentinelle S10.1.11-NUQS-ADAPTER-001 — balise <NuqsAdapter> manquante.",
          "",
          "`src/app/layout.tsx` doit wrapper children avec <NuqsAdapter> :",
          "  <NuqsAdapter>",
          "    {children}",
          "    <Toaster ... />",
          "  </NuqsAdapter>",
          "",
          "Cf. bug runtime S10.1.11 — l'import seul ne suffit pas, il faut",
          "que le composant soit effectivement mount dans l'arbre.",
        ].join("\n"),
      );
    }
  });

  it("les regex de détection matchent le pattern canonique (sanity)", () => {
    // Import groupé
    expect(
      NUQS_ADAPTER_IMPORT_PATTERN.test('import { NuqsAdapter } from "nuqs/adapters/next/app";'),
    ).toBe(true);
    // Import multi-membres
    expect(
      NUQS_ADAPTER_IMPORT_PATTERN.test(
        'import { foo, NuqsAdapter, bar } from "nuqs/adapters/next/app";',
      ),
    ).toBe(true);
    // Single quotes
    expect(
      NUQS_ADAPTER_IMPORT_PATTERN.test("import { NuqsAdapter } from 'nuqs/adapters/next/app';"),
    ).toBe(true);
    // Faux-positifs à éviter
    expect(NUQS_ADAPTER_IMPORT_PATTERN.test('import { NuqsAdapter } from "nuqs"')).toBe(false);
    expect(NUQS_ADAPTER_IMPORT_PATTERN.test('import { useQueryState } from "nuqs"')).toBe(false);
    expect(
      NUQS_ADAPTER_IMPORT_PATTERN.test('import { NuqsAdapter } from "nuqs/adapters/next/pages"'),
    ).toBe(false);

    // JSX
    expect(NUQS_ADAPTER_JSX_PATTERN.test("<NuqsAdapter>")).toBe(true);
    expect(NUQS_ADAPTER_JSX_PATTERN.test("<NuqsAdapter someprop={x}>")).toBe(true);
    expect(NUQS_ADAPTER_JSX_PATTERN.test("<NuqsAdapter />")).toBe(true);
    expect(NUQS_ADAPTER_JSX_PATTERN.test("<NuqsAdapterMock>")).toBe(false);
  });
});
