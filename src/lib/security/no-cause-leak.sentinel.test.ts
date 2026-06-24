/**
 * Sentinelle anti-régression S10.1.7-SECURITY-CAUSE-LEAK-001.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rationale (cf. CLAUDE.md "Pièges connus" + SECURITY-NOTES.md) :
 *
 *   Le pattern `throw new ExternalServiceError({ cause: err })` sur une
 *   erreur SDK tierce (HubSpot, Anthropic, OVH, Twilio) peut LEAK le
 *   token Bearer / X-Api-Key au moment où un caller logue l'erreur via
 *   `logger.error({ err: ext })` (Pino sérialiseur par défaut) :
 *
 *     1. Le SDK encapsule l'auth header dans `err.message` (cas HubSpot
 *        SDK confirmé S10.1.3, cas Anthropic SDK suspecté sur catch-all).
 *     2. Pino sérialise `err` via std-serializers.err → inclut `err.cause`
 *        récursivement → la chaîne `err.cause.message` apparaît dans les
 *        logs Vercel/Sentry.
 *
 *   Mitigation : NE PAS attacher `cause: err` quand `err` provient d'un
 *   SDK HTTP tiers susceptible d'embarquer un secret dans son message.
 *   Le forensic reste assuré via `context` (op, statut HTTP, fingerprint
 *   d'ID opaque) + Sentry côté serveur.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Périmètre verrouillé par cette sentinelle :
 *
 *   - src/lib/hubspot/**  → toutes les surfaces HubSpot SDK
 *   - src/lib/claude/**   → toutes les surfaces Anthropic SDK
 *   - src/lib/ovh/**      → toutes les surfaces OVH SDK
 *
 *   À AJOUTER dès leur création (S11+) : src/lib/twilio/**,
 *   src/lib/slack/** (autres SDK HTTP tiers susceptibles d'embarquer
 *   leur token dans `err.message`).
 *
 *   Si une nouvelle occurrence de `cause: err` y apparaît, ce test
 *   ÉCHOUE. Pour la lever, il faut :
 *     - soit retirer `cause: err` (préféré)
 *     - soit ajouter une exemption explicite dans `ALLOWED_OCCURRENCES`
 *       ci-dessous, avec rationale écrite (ex: AppError du projet
 *       wrappé, pas d'origine SDK tierce).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi un test et pas un ESLint rule custom ? :
 *
 *   - ESLint rule custom = bootstrap lourd (parsing AST, plugin), bruit
 *     en dev si on doit l'écrire à la main.
 *   - Test Vitest = lit le code source comme un fichier texte (fs.read),
 *     applique une regex sur les chemins concernés, échoue clairement
 *     dans la suite tests + CI. Pas de plugin à maintenir.
 *   - Le coût d'exécution est négligeable (~5 ms).
 *
 *   Le test devrait être déplacé en ESLint rule custom le jour où on
 *   en a ≥3 (rule générique "no-cause-from-third-party-sdk"). MVP : test.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = join(__dirname, "..", "..", "..");

/**
 * Dossiers racines à scanner. Lecture récursive en walk + filter sur
 * suffixes `.ts` ET exclusion des fichiers de tests/fixtures.
 */
const SCAN_DIRS = [
  join(REPO_ROOT, "src", "lib", "hubspot"),
  join(REPO_ROOT, "src", "lib", "claude"),
  join(REPO_ROOT, "src", "lib", "ovh"),
] as const;

const EXCLUDE_SUFFIXES = [".test.ts", ".test-helpers.ts"] as const;

const EXCLUDE_DIR_NAMES = new Set(["__fixtures__", "__mocks__", "node_modules"]);

/**
 * Exemptions explicites (avec rationale). Si une occurrence est listée
 * ici, le test passe pour cette ligne. Toute autre occurrence dans
 * SCAN_DIRS échouera le test.
 *
 * Format : `<relative-path>:<line>` (relative au repo root, slashes /).
 *
 * 🚨 Toute addition ici DOIT inclure dans le commentaire la raison
 * EXACTE pour laquelle l'origine n'est PAS un SDK tiers susceptible
 * d'embarquer un secret. Pas de "TODO j'ajusterai plus tard".
 */
const ALLOWED_OCCURRENCES: ReadonlySet<string> = new Set<string>([
  // (aucune exemption au moment du fix S10.1.7 — toutes les occurrences
  // précédemment présentes ont été retirées)
]);

/**
 * Pattern recherché. On match `cause: err` OU `cause: error` (variant de
 * nom), avec contexte permissif (espaces). On NE match PAS
 * `cause: undefined` ni `cause: someOtherSymbol` — strictement le binding
 * du paramètre `catch (err) { ... cause: err }`.
 *
 * 🔒 Pattern simple et conservateur : si un futur dev écrit
 * `cause: err as Error` ou `cause: new SomeError({ cause: err })`, le
 * pattern matche aussi — c'est OK car on veut être strict côté SDK tiers.
 */
const CAUSE_ERR_PATTERN = /\bcause:\s*(err|error)\b/;

// ─────────────────────────────────────────────────────────────────────────────
// Walk récursif (zero-dep, Node natif)
// ─────────────────────────────────────────────────────────────────────────────

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // dir absent → silencieux
  }
  for (const entry of entries) {
    if (EXCLUDE_DIR_NAMES.has(entry)) continue;
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      out.push(...walk(abs));
    } else if (st.isFile() && abs.endsWith(".ts")) {
      if (EXCLUDE_SUFFIXES.some((s) => abs.endsWith(s))) continue;
      out.push(abs);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Sentinelle anti-leak `cause: err` (S10.1.7-SECURITY-CAUSE-LEAK-001)", () => {
  it("aucune occurrence non-exemptée de `cause: err` dans hubspot/* + claude/*", () => {
    const files = SCAN_DIRS.flatMap((d) => walk(d));

    // Sanity check : on doit avoir scanné au moins quelques fichiers.
    // Si SCAN_DIRS pointe vers un endroit inexistant, on aurait 0 → faux
    // négatif dangereux (test "vert" mais ne couvre rien).
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];

    for (const abs of files) {
      const relPath = relative(REPO_ROOT, abs).replace(/\\/g, "/");
      const content = readFileSync(abs, "utf-8");
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!CAUSE_ERR_PATTERN.test(line)) continue;

        // Skip si la ligne est un commentaire (// ou * dans bloc /** */).
        // Pattern conservateur : trim() commence par `//` ou `*`.
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

        // Skip si exemption explicite
        const lineNumber = i + 1;
        const occurrenceKey = `${relPath}:${lineNumber}`;
        if (ALLOWED_OCCURRENCES.has(occurrenceKey)) continue;

        violations.push(`${occurrenceKey}  →  ${trimmed}`);
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          "Sentinelle S10.1.7-SECURITY-CAUSE-LEAK-001 — occurrence(s) non-exemptée(s) de `cause: err`",
          "détectée(s) dans src/lib/hubspot/* ou src/lib/claude/* :",
          "",
          ...violations.map((v) => `  • ${v}`),
          "",
          "Action :",
          "  1. Retirer `cause: err` (préféré — anti-leak token/secret).",
          "  2. OU ajouter une exemption ALLOWED_OCCURRENCES avec rationale écrite",
          "     dans src/lib/security/no-cause-leak.sentinel.test.ts",
          "",
          "Rationale : le SDK HubSpot/Anthropic peut embarquer le Bearer token",
          "dans `err.message`. Si un caller logue `err.cause` via Pino, ça leak.",
          "Cf. CLAUDE.md + SECURITY-NOTES.md pour le détail.",
        ].join("\n"),
      );
    }
  });

  it("la regex de détection matche bien le pattern canonique (sanity)", () => {
    expect(CAUSE_ERR_PATTERN.test("        cause: err,")).toBe(true);
    expect(CAUSE_ERR_PATTERN.test("    cause: error,")).toBe(true);
    expect(CAUSE_ERR_PATTERN.test("cause:err")).toBe(true);
    // Faux-positifs à éviter
    expect(CAUSE_ERR_PATTERN.test("const cause = err;")).toBe(false);
    expect(CAUSE_ERR_PATTERN.test("cause: undefined")).toBe(false);
    expect(CAUSE_ERR_PATTERN.test("rootCause: errMsg")).toBe(false);
  });
});
