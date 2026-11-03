/**
 * Sentinelle anti-régression PR2c tour 1 — un seul cache HubSpot campagnes.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rationale
 *
 * `getCachedSmsCampaigns` (`campaigns-cache.ts:43`) est l'UNIQUE point
 * d'entrée production vers `listSmsLists("SMS")`. PR2c tour 1 a fusionné
 * les appels directs qui existaient dans :
 *   - `src/app/admin/contacts/page.tsx`
 *   - `src/app/admin/conversations/page.tsx`
 *   - `src/app/api/admin/campaigns/route.ts`
 *
 * Un deuxième cache (ou un nouvel appel direct `listSmsLists(...)` dans
 * `src/`) ferait repartir le fetch HubSpot à chaque requête sur le
 * callsite non-caché, et casserait la cohérence des libellés campagne
 * entre dashboard et détail. Cette sentinelle échoue dès qu'une telle
 * réapparition est détectée.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Contournements fermés (tour 1 bis)
 *
 *   PR2c tour 1 avait une regex `/\blistSmsLists\(/` qui matchait les
 *   call sites directs mais LAISSAIT PASSER :
 *     - `import { listSmsLists as fetchLists }` + `fetchLists(...)`
 *     - `const fn = listSmsLists; fn(...)` (indirection via variable)
 *     - `import * as listsModule from "..."; listsModule.listSmsLists(...)`
 *
 *   Finding security-reviewer PR2c tour 1 : "regex contournable par alias
 *   d'import". Fermeture tour 1 bis : on AJOUTE une inspection AST des
 *   imports via TypeScript compiler API — tout import `value` du symbole
 *   `listSmsLists` depuis `@/lib/hubspot/lists` (ou chemin relatif
 *   équivalent) hors des fichiers autorisés échoue la sentinelle.
 *
 *   Les imports `type` sont tolérés (compile-time only, aucun risque
 *   runtime de contournement du cache).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Périmètre scanné
 *
 *   - `src/**` TS/TSX, hors `.test.ts(x)` / `.spec.ts(x)` / `__mocks__`.
 *   - On ne scanne PAS `scripts/*.mjs` (CLI one-shot : pas de boucle de
 *     requêtes, aucun bénéfice au cache).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Exemptions
 *
 *   - `src/lib/hubspot/lists.ts` — définition même de `listSmsLists`.
 *   - `src/lib/campaigns/campaigns-cache.ts` — unique appelant autorisé
 *     en runtime application (contient le TTL 5 min).
 *
 * Toute autre apparition fait échouer ce test.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const SRC_DIR = join(REPO_ROOT, "src");

const EXCLUDE_DIR_NAMES = new Set(["__fixtures__", "__mocks__", "node_modules"]);
const EXCLUDE_SUFFIXES = [
  ".test.ts",
  ".test.tsx",
  ".spec.ts",
  ".spec.tsx",
  ".test-helpers.ts",
  ".sentinel.test.ts",
] as const;

/**
 * Fichiers autorisés à référencer `listSmsLists`. Chemins relatifs au
 * repo root, séparateur `/`.
 */
const ALLOWED_FILES: ReadonlySet<string> = new Set<string>([
  "src/lib/hubspot/lists.ts",
  "src/lib/campaigns/campaigns-cache.ts",
]);

/**
 * Noms de module reconnus comme pointant vers `src/lib/hubspot/lists.ts`.
 * Couvre l'alias TS (`@/lib/hubspot/lists`) et les paths relatifs
 * équivalents. On garde la liste exhaustive plutôt qu'une resolve full :
 * le projet n'utilise que ces 2 formes.
 */
function moduleSpecifierTargetsHubspotLists(moduleSpec: string): boolean {
  const normalized = moduleSpec.replace(/\\/g, "/");
  if (normalized === "@/lib/hubspot/lists") return true;
  // Paths relatifs : …/hubspot/lists sans trailing slash. On tolère un
  // chemin qui ne passe pas forcément par `/lib/` (si le module est
  // déplacé plus tard — la sentinelle doit tenir).
  if (/(?:^|\/)hubspot\/lists$/.test(normalized)) return true;
  return false;
}

/**
 * Pattern call-site défensif. Garde-fou pour les variantes exotiques
 * (require(), import dynamique, re-export) non couvertes par l'AST.
 * Ne retire PAS l'inspection d'import ci-dessus — c'est un filet
 * supplémentaire, pas un substitut.
 */
const CALL_SITE_PATTERN = /\blistSmsLists\(/;

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (EXCLUDE_DIR_NAMES.has(entry)) continue;
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      out.push(...walk(abs));
    } else if (st.isFile() && (abs.endsWith(".ts") || abs.endsWith(".tsx"))) {
      if (EXCLUDE_SUFFIXES.some((s) => abs.endsWith(s))) continue;
      out.push(abs);
    }
  }
  return out;
}

interface Violation {
  readonly relPath: string;
  readonly line: number;
  readonly kind: "value-import" | "call-site";
  readonly snippet: string;
}

/**
 * Inspecte les imports d'un fichier via AST. Retourne les violations
 * `value-import` (type-only imports exclus).
 */
function findValueImportsOfListSmsLists(content: string, relPath: string): Violation[] {
  const sourceFile = ts.createSourceFile(
    relPath,
    content,
    ts.ScriptTarget.Latest,
    true,
    relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const violations: Violation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const moduleSpec = node.moduleSpecifier;
      if (ts.isStringLiteral(moduleSpec) && moduleSpecifierTargetsHubspotLists(moduleSpec.text)) {
        const clause = node.importClause;
        if (clause !== undefined && clause.isTypeOnly !== true) {
          const bindings = clause.namedBindings;
          if (bindings !== undefined && ts.isNamedImports(bindings)) {
            for (const el of bindings.elements) {
              // `name` est le nom LOCAL (après alias). `propertyName` est
              // le nom D'ORIGINE si alias. On vérifie l'origine, pas
              // l'alias — c'est elle qui ancre au symbole exporté.
              if (el.isTypeOnly === true) continue;
              const origin = el.propertyName?.text ?? el.name.text;
              if (origin === "listSmsLists") {
                const { line } = sourceFile.getLineAndCharacterOfPosition(el.getStart(sourceFile));
                violations.push({
                  relPath,
                  line: line + 1,
                  kind: "value-import",
                  snippet: el.getText(sourceFile).trim(),
                });
              }
            }
          } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
            // `import * as X` — l'accès au symbole se ferait via X.listSmsLists.
            // On alerte même si c'est un namespace : tout import value du
            // module ouvre la porte à `X.listSmsLists(...)`.
            const { line } = sourceFile.getLineAndCharacterOfPosition(
              bindings.getStart(sourceFile),
            );
            violations.push({
              relPath,
              line: line + 1,
              kind: "value-import",
              snippet: `* as ${bindings.name.text}`,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

describe("Sentinelle PR2c tour 1 bis — un seul cache HubSpot campagnes", () => {
  it("aucun import value `listSmsLists` ni call-site hors module cache + définition", () => {
    const files = walk(SRC_DIR);

    // Sanity : si on scanne 0 fichier, la sentinelle serait un no-op
    // (vert mais ne couvre rien).
    expect(files.length).toBeGreaterThan(50);

    const violations: Violation[] = [];

    for (const abs of files) {
      const relPath = relative(REPO_ROOT, abs).replace(/\\/g, "/");
      if (ALLOWED_FILES.has(relPath)) continue;

      const content = readFileSync(abs, "utf-8");

      // ⚡ PR2c tour 2b bis — pré-filtre texte avant AST (perf).
      //
      // Faire tourner `ts.createSourceFile` sur CHAQUE .ts/.tsx de src/
      // prenait ~30s en CI (observé pre-push hook, timeout 15s dépassé).
      // On n'invoque donc l'AST QUE si le fichier contient au moins
      // l'une des deux chaînes repères.
      //
      // 🔒 PREUVE DE COMPLÉTUDE DU PRÉ-FILTRE :
      //   Tout import de `listSmsLists` depuis `@/lib/hubspot/lists`
      //   (ou chemin relatif équivalent) — direct, aliasé OU namespace —
      //   écrit littéralement DANS le fichier source :
      //     - import direct  : `import { listSmsLists } from "..."` → "listSmsLists" ✓
      //     - import aliasé  : `import { listSmsLists as X } from "..."` → "listSmsLists" ✓
      //     - import namespace : `import * as X from "@/lib/hubspot/lists"` → "hubspot/lists" ✓
      //   Un fichier qui ne contient NI `"listSmsLists"` NI `"hubspot/lists"`
      //   ne peut PAS avoir un import value de ce symbole. Le pré-filtre
      //   est donc une condition nécessaire sans réduire la garantie.
      if (!content.includes("listSmsLists") && !content.includes("hubspot/lists")) {
        continue;
      }

      // (1) Inspection AST des imports — strict, catch les alias.
      violations.push(...findValueImportsOfListSmsLists(content, relPath));

      // (2) Garde-fou call-site défensif — attrape les cas exotiques
      //     (dynamic import exécuté, require, etc.). Les imports normaux
      //     sont déjà couverts par (1) — si (2) matche sans (1), c'est
      //     une forme non-standard qui mérite d'alerter.
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!CALL_SITE_PATTERN.test(line)) continue;
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        violations.push({
          relPath,
          line: i + 1,
          kind: "call-site",
          snippet: trimmed,
        });
      }
    }

    if (violations.length > 0) {
      const linesOut = violations.map(
        (v) => `  • [${v.kind}] ${v.relPath}:${v.line}  →  ${v.snippet}`,
      );
      throw new Error(
        [
          "Sentinelle PR2c tour 1 bis — un chemin d'accès à `listSmsLists` a été introduit",
          "en dehors des fichiers autorisés :",
          "",
          ...linesOut,
          "",
          "Action :",
          "  1. Router l'appel via `getCachedSmsCampaigns()` du module",
          "     `@/lib/campaigns/campaigns-cache` (cache 5 min partagé).",
          "  2. OU documenter la raison et ajouter le chemin dans",
          "     ALLOWED_FILES de ce test, avec rationale écrite.",
          "",
          "Objectif : UN SEUL cache HubSpot pour tous les callsites applicatifs.",
          "Les imports `type` restent autorisés (compile-time uniquement).",
        ].join("\n"),
      );
    }
  });

  it("le détecteur d'import AST catch les alias et namespace imports (sanity)", () => {
    const samples: Array<{ src: string; expected: number; label: string }> = [
      {
        label: "import direct",
        src: `import { listSmsLists } from "@/lib/hubspot/lists";`,
        expected: 1,
      },
      {
        label: "import aliasé",
        src: `import { listSmsLists as fetchLists } from "@/lib/hubspot/lists";`,
        expected: 1,
      },
      {
        label: "import mixé avec autre symbole",
        src: `import { listSmsLists, DEFAULT_SMS_LIST_SEARCH_QUERY } from "@/lib/hubspot/lists";`,
        expected: 1,
      },
      {
        label: "import type-only (toléré)",
        src: `import type { listSmsLists } from "@/lib/hubspot/lists";`,
        expected: 0,
      },
      {
        label: "import value avec individuel type-only (toléré)",
        src: `import { type listSmsLists } from "@/lib/hubspot/lists";`,
        expected: 0,
      },
      {
        label: "import depuis path relatif équivalent",
        src: `import { listSmsLists } from "../hubspot/lists";`,
        expected: 1,
      },
      {
        label: "import namespace",
        src: `import * as listsModule from "@/lib/hubspot/lists";`,
        expected: 1,
      },
      {
        label: "import d'un autre module (ignoré)",
        src: `import { listSmsLists } from "@/lib/other";`,
        expected: 0,
      },
      {
        label: "import d'autre symbole du même module (ignoré)",
        src: `import { HUBSPOT_LISTS_PAGE_SIZE } from "@/lib/hubspot/lists";`,
        expected: 0,
      },
    ];

    for (const s of samples) {
      const v = findValueImportsOfListSmsLists(s.src, "virtual.ts");
      expect(v.length, `${s.label} — src: ${s.src}`).toBe(s.expected);
    }
  });

  it("les fichiers autorisés contiennent effectivement l'appel attendu (sanity)", () => {
    // Garde-fou : si quelqu'un vide `campaigns-cache.ts` de son appel,
    // la sentinelle doit alerter plutôt que rester silencieusement verte.
    const cacheAbs = join(REPO_ROOT, "src/lib/campaigns/campaigns-cache.ts");
    const cacheContent = readFileSync(cacheAbs, "utf-8");
    expect(cacheContent).toMatch(CALL_SITE_PATTERN);
  });
});
