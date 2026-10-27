// @vitest-environment node

/**
 * Sentinelle PR2c tour 1 bis — l'e2e Playwright utilise le module unique
 * `collectVisibleText` (pas une duplication inline).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rationale
 *
 * Avant PR2c, `tests/e2e/fixtures.ts::innerTextWithoutMessageThread`
 * dupliquait la logique DOM walk de `tests/_helpers/visible-text.ts`.
 * Toute évolution devait être répliquée des DEUX côtés, et une
 * divergence silencieuse aurait fait passer les 7 tests jsdom tandis
 * que l'e2e tombait sur un faux positif en production.
 *
 * PR2c fait passer la source du module unique à `page.evaluate` via
 * `collectVisibleText.toString()`. Cette sentinelle verrouille cette
 * discipline :
 *
 *   1. L'import `collectVisibleText` est présent.
 *   2. La source stringifiée est bien passée à `page.evaluate`.
 *   3. Aucun walk DOM inline ne subsiste dans la fonction e2e.
 *   4. Le module reste auto-suffisant.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rigidification tour 1 bis
 *
 *   Tour 1 extrayait le corps de la fonction e2e via `content.slice(start,
 *   start + 3000)` — fragile si la fonction grossit au-delà de 3000 chars.
 *   Finding security-reviewer MOYEN : "borne start + 3000 chars fragile
 *   si innerTextWithoutMessageThread grossit".
 *
 *   Fermeture : on utilise désormais le TypeScript compiler API pour
 *   isoler EXACTEMENT le corps de `innerTextWithoutMessageThread`,
 *   quelle que soit sa taille. Le test de sanity ci-dessous valide
 *   l'extraction sur une fonction fabriquée > 60 lignes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..");
const FIXTURES_PATH = join(REPO_ROOT, "tests", "e2e", "fixtures.ts");
const MODULE_PATH = join(REPO_ROOT, "tests", "_helpers", "visible-text.ts");

/**
 * Extrait le corps d'une fonction exportée (`export async function` ou
 * `export function`) par son nom, via TS AST. Retourne le TEXTE du bloc
 * `{ ... }` (accolades incluses) tel qu'il apparaît dans la source,
 * ou `null` si la fonction n'existe pas ou n'a pas de corps.
 *
 * @internal — exposé pour les tests de sanity.
 */
export function extractExportedFunctionBody(
  source: string,
  name: string,
  virtualPath = "virtual.ts",
): string | null {
  const sf = ts.createSourceFile(
    virtualPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    virtualPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  let found: string | null = null;
  const visit = (node: ts.Node): void => {
    if (found !== null) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      const hasExport =
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      if (hasExport && node.body !== undefined) {
        found = node.body.getText(sf);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("Sentinelle PR2c tour 1 bis — fixtures e2e utilise le module unique", () => {
  it("fixtures.ts importe `collectVisibleText` depuis _helpers/visible-text", () => {
    const content = readFileSync(FIXTURES_PATH, "utf-8");

    // Import tolérant à l'ordre des symboles, strict sur le chemin.
    expect(content).toMatch(
      /import\s*\{\s*collectVisibleText\s*\}\s*from\s*["']\.\.\/_helpers\/visible-text["']/,
    );
  });

  it("fixtures.ts passe la source du module à page.evaluate (pattern .toString() dans la fonction)", () => {
    const content = readFileSync(FIXTURES_PATH, "utf-8");

    // On exige le pattern DANS le corps de la fonction e2e, pas en
    // commentaire. Sinon un JSDoc orphelin ferait passer le test après
    // mutation du corps.
    const body = extractExportedFunctionBody(
      content,
      "innerTextWithoutMessageThread",
      "fixtures.ts",
    );
    expect(body, "innerTextWithoutMessageThread doit exister et avoir un corps").not.toBeNull();
    expect(body).toMatch(/collectVisibleText\.toString\(\)/);
  });

  it("innerTextWithoutMessageThread n'embarque PLUS de walker DOM inline", () => {
    const content = readFileSync(FIXTURES_PATH, "utf-8");

    // Extraction EXACTE du corps via TS AST — robuste quelle que soit la
    // taille de la fonction (remplace la borne start+3000 du tour 1).
    const body = extractExportedFunctionBody(
      content,
      "innerTextWithoutMessageThread",
      "fixtures.ts",
    );
    expect(body, "innerTextWithoutMessageThread doit exister et avoir un corps").not.toBeNull();

    // ❌ Signatures de l'ancienne implémentation inline qui ne doivent
    //    PLUS apparaître DANS la fonction e2e.
    const antiPatterns: Array<{ re: RegExp; label: string }> = [
      {
        re: /new\s+Set\(\s*\[\s*["']SCRIPT["']/,
        label: "déclaration inline `new Set(['SCRIPT', ...])` (doit vivre dans le module)",
      },
      {
        re: /\bHIDDEN_TAGS\b/,
        label: "référence au symbole `HIDDEN_TAGS` (propre au module, pas à l'e2e)",
      },
      {
        re: /walk\s*\(\s*document\.body\s*\)/,
        label: "appel direct `walk(document.body)` (ancien walker inline)",
      },
      {
        re: /parts\.push\(/,
        label: "manipulation inline du tableau `parts.push(...)` (walker inline)",
      },
    ];

    const found = antiPatterns.filter((p) => p.re.test(body!));
    if (found.length > 0) {
      throw new Error(
        [
          "Sentinelle PR2c tour 1 bis — `innerTextWithoutMessageThread` embarque de nouveau",
          "une duplication inline du walker DOM. Pattern(s) détecté(s) :",
          "",
          ...found.map((p) => `  • ${p.label}`),
          "",
          "Action : router l'implémentation via `collectVisibleText.toString()` injecté",
          "dans `page.evaluate` (c.f. `tests/_helpers/visible-text.ts`).",
        ].join("\n"),
      );
    }
  });

  it("le module `collectVisibleText` est AUTO-SUFFISANT (HIDDEN_TAGS dans le corps)", () => {
    // Pré-requis pour que `.toString()` passé à `new Function(...)` dans
    // la page ait toutes ses dépendances. Si HIDDEN_TAGS remonte au
    // niveau module, la stringification perd sa closure et le walker
    // reçoit un `HIDDEN_TAGS is not defined` dans la page.
    const content = readFileSync(MODULE_PATH, "utf-8");

    // Extraction EXACTE du corps de `collectVisibleText` via AST.
    const body = extractExportedFunctionBody(content, "collectVisibleText", "visible-text.ts");
    expect(body, "collectVisibleText doit exister").not.toBeNull();

    expect(
      body,
      "HIDDEN_TAGS doit être déclaré À L'INTÉRIEUR de collectVisibleText (closure-safe pour .toString()).",
    ).toMatch(/const\s+HIDDEN_TAGS\s*=\s*new\s+Set/);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Sanity de l'extracteur AST — fonction de >60 lignes
  // ───────────────────────────────────────────────────────────────────────

  it("extractExportedFunctionBody isole correctement une fonction longue (>60 lignes)", () => {
    // Fonction fabriquée volontairement longue (>60 lignes) pour prouver
    // que l'extraction par AST n'est pas tronquée par une borne arbitraire.
    const longLines = Array.from({ length: 70 }, (_, i) => `  const var${i} = ${i};`);
    const synthetic = [
      `// Préambule bruyant pour pousser la fonction loin dans le fichier`,
      ...Array.from({ length: 20 }, (_, i) => `const noise${i} = "pad ${i}";`),
      ``,
      `export async function longFn(input: number): Promise<number> {`,
      `  // Marqueur de début identifiable`,
      `  const BEGIN_MARKER = "BEGIN_LONG_FN";`,
      ...longLines,
      `  const END_MARKER = "END_LONG_FN";`,
      `  return input + ${longLines.length};`,
      `}`,
      ``,
      `export function trailing(): void {`,
      `  // Doit être ignorée (nom différent)`,
      `  return;`,
      `}`,
    ].join("\n");

    // Confirme le total de lignes du corps : 70 lignes var + 2 markers +
    // 1 return + 2 commentaires + accolades = largement > 60 lignes.
    const body = extractExportedFunctionBody(synthetic, "longFn", "synthetic.ts");
    expect(body).not.toBeNull();
    expect(body).toContain("BEGIN_LONG_FN");
    expect(body).toContain("END_LONG_FN");
    expect(body).toContain(`const var0 = 0;`);
    expect(body).toContain(`const var69 = 69;`);

    // Compte au moins 70 lignes DANS le corps extrait (preuve que rien
    // n'a été tronqué à 3000 chars ou autre borne arbitraire).
    const lineCount = body!.split(/\r?\n/).length;
    expect(lineCount).toBeGreaterThan(60);

    // Ne récupère PAS le corps de `trailing` (ancre nom).
    expect(body).not.toContain('"BEGIN_TRAILING"');
    expect(body).not.toContain("Doit être ignorée");
  });

  it("extractExportedFunctionBody retourne null pour une fonction non exportée ou absente", () => {
    const src = [
      `async function privateFn(): Promise<void> { /* non exporté */ }`,
      `export async function other(): Promise<void> { return; }`,
    ].join("\n");

    expect(extractExportedFunctionBody(src, "privateFn")).toBeNull();
    expect(extractExportedFunctionBody(src, "absent")).toBeNull();
    expect(extractExportedFunctionBody(src, "other")).not.toBeNull();
  });
});
