/**
 * Sentinelle PR1.14.2 — garantit statiquement qu'aucun Client Component
 * (fichier `.tsx` démarrant par `"use client"`) n'importe `require-role`
 * ou tout module serveur-seul via chemin direct.
 *
 * Pourquoi
 *
 *   `require-role.ts` est marqué `import "server-only"`. Un import depuis
 *   un `"use client"` fait throw `next build` avec une erreur du genre :
 *     "You're importing a component that imports server-only.
 *      It only works in a Server Component but one of its parents
 *      is marked with "use client", so it's a Client Component."
 *
 *   Cette sentinelle verrouille le pattern en CI AVANT que `next build`
 *   ne tombe sur l'erreur. Plus rapide (ms vs minutes) et plus précis
 *   (dit exactement quel fichier casse).
 *
 * Démonstration de l'échec de build (preuve PR1.14.2, capturée une fois
 * par Claude le 2026-10-23 contre `npm run build` exit 1) :
 *
 *   ./src/lib/auth/require-role.ts:89:1
 *   'server-only' cannot be imported from a Client Component module
 *   > 89 | import "server-only";
 *        | ^^^^^^^^^^^^^^^^^^^^^
 *   It should only be used from a Server Component.
 *
 *   Reproduire : créer temporairement `src/app/<route>/page.tsx` avec
 *   `"use client"` + `import { requireRole } from "@/lib/auth/require-role"`
 *   et lancer `npm run build`. Supprimer le fichier après capture.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const SRC = join(REPO_ROOT, "src");

/** Récupère tous les .tsx sous `src/` (exclut `node_modules`, build, tests). */
function walkTsxFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const s = statSync(abs);
    if (s.isDirectory()) {
      if (name === "node_modules" || name === ".next" || name === "dist") continue;
      walkTsxFiles(abs, out);
    } else if (name.endsWith(".tsx")) {
      out.push(abs);
    }
  }
  return out;
}

describe("Sentinelle server-only — aucun Client Component n'importe require-role", () => {
  it("tous les fichiers .tsx `use client` sous src/ n'importent PAS require-role (direct)", () => {
    const violations: string[] = [];
    const tsxFiles = walkTsxFiles(SRC);
    for (const file of tsxFiles) {
      const content = readFileSync(file, "utf8");
      // Trim BOM + whitespace de début pour détecter "use client" en tête
      // (le pragma doit être la première instruction).
      const trimmed = content.replace(/^﻿/, "").trimStart();
      const isClient = /^["']use client["'];?/.test(trimmed);
      if (!isClient) continue;
      // Match un import DIRECT de require-role (chemin alias ou relatif).
      // On distingue les imports type-only (`import type { X } from ...`)
      // qui sont strippés à la compilation TypeScript / SWC → aucun
      // runtime load → `server-only` jamais chargé → PAS de violation.
      // Seuls les imports VALEUR cassent le build.
      const importRe = /^(.*?)from\s+["'][^"']*\/auth\/require-role["']/gm;
      const matches = content.matchAll(importRe);
      for (const m of matches) {
        const before = m[1] ?? "";
        // `import type { Role }` ou `import { type Role }` → OK.
        const isTypeOnly = /\bimport\s+type\b/.test(before) || /\{\s*type\s+/.test(before);
        if (!isTypeOnly) {
          violations.push(relative(REPO_ROOT, file).split(sep).join("/"));
          break;
        }
      }
    }
    expect(
      violations,
      `Fichiers Client Component qui importent require-role (casseraient next build) : ${violations.join(", ")}`,
    ).toEqual([]);
  });
});
