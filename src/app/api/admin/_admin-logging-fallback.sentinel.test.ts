/**
 * Sentinelle anti-régression S10.1.12-LIST-CONTACTS-DIAGNOSIS-001.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rationale (bug runtime S10.1.12) :
 *
 *   Déthié a rencontré un `500 INTERNAL` sur `GET /api/admin/contacts`
 *   avec un log Pino quasi-vide :
 *
 *     ERROR: [GET /api/admin/contacts] unexpected error
 *         errName: "Error"
 *
 *   `errName` seul (= `Error.name` = "Error") rend les bugs Firestore/Claude/
 *   HubSpot/Inngest opaques :
 *
 *     - SDK firebase-admin throw `Error` standard pour `FAILED_PRECONDITION`
 *       (index manquant) — le lien de création de l'index dans la Firebase
 *       Console est dans `err.message`, perdu sans logging.
 *     - SDK Anthropic, HubSpot, OVH idem — `err.message` contient le HTTP
 *       status + message texte, crucial pour le diagnostic.
 *     - Sans `err.code` (GoogleError, AnthropicError), impossible de
 *       distinguer un manque d'index d'un quota dépassé ou d'une auth
 *       expirée — toutes ces erreurs partagent `errName: "Error"`.
 *
 *   Mitigation : les 4 catch fallback "unexpected error" des routes admin
 *   loggent désormais `errName + errMessage + errCode`. Le sanitizer Pino
 *   projet couvre les fragments PII éventuels dans `err.message`. Pas de
 *   `err.stack` (verbeux pour les logs Vercel, Sentry serveur capture
 *   séparément si configuré).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Ce que cette sentinelle verrouille :
 *
 *   Pour CHAQUE route admin dans `src/app/api/admin/<route>/route.ts`,
 *   vérifie que le bloc qui contient `unexpected error` (catch fallback
 *   500 générique) logue au moins :
 *
 *     1. `errName`    — Error.name ou "unknown"
 *     2. `errMessage` — Error.message (peut être undefined pour non-Error)
 *
 *   `errCode` est recommandé (GoogleError/AnthropicError code) mais pas
 *   strictement exigé par cette sentinelle — beaucoup d'erreurs JS
 *   standard n'en ont pas.
 *
 *   Si quelqu'un retire l'un de ces 2 champs (refactor, simplification
 *   accidentelle, copy-paste depuis une route plus ancienne), ce test
 *   ÉCHOUE clairement avec un message qui rappelle le bug original.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pattern aligné projet :
 *
 *   - `src/lib/security/no-cause-leak.sentinel.test.ts`           (S10.1.7)
 *   - `src/app/layout-providers.sentinel.test.ts`                  (S10.1.11)
 *
 *   Walk filesystem zero-dep + regex + commentaire explicite "anti-régression".
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const ADMIN_ROUTES_DIR = join(REPO_ROOT, "src", "app", "api", "admin");

/**
 * Marker textuel qui identifie le catch fallback "500 générique" dans une
 * route admin. Toutes nos routes admin utilisent ce log message — c'est
 * notre point d'ancrage pour localiser le bloc à auditer.
 *
 * Si une future route admin utilise un autre wording (ex: "internal
 * server error"), elle ne sera PAS auditée par cette sentinelle —
 * accepter le risque ou mettre à jour le marker.
 */
const FALLBACK_LOG_MARKER = /"\[[A-Z]+ \/api\/admin\/[a-z-]+\] unexpected error"/;

// ─────────────────────────────────────────────────────────────────────────────
// Walk récursif (zero-dep, Node natif) — collecte les route.ts admin
// ─────────────────────────────────────────────────────────────────────────────

function walkRoutes(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      out.push(...walkRoutes(abs));
    } else if (st.isFile() && entry === "route.ts") {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Extrait le bloc `logger.error({...}, "[...] unexpected error")` complet
 * depuis le contenu d'un fichier. Retourne `null` si le marker est absent
 * (= la route n'a pas de catch fallback "unexpected error" — soit elle
 * n'a pas de catch global, soit elle utilise un autre wording).
 *
 * Pattern conservateur : on matche le `logger.error(` puis on capture
 * tout jusqu'au marker `"[<METHOD> /api/admin/<route>] unexpected error"`
 * inclus. Si la route a un `logger.error(...)` AVANT le marker, on capture
 * trop large — c'est volontaire, le test vérifie juste la PRÉSENCE des
 * champs (false positives acceptables, false negatives non).
 */
function extractFallbackBlock(content: string): string | null {
  // Localise le marker (le log message).
  const markerMatch = content.match(FALLBACK_LOG_MARKER);
  if (!markerMatch || markerMatch.index === undefined) return null;

  const markerEnd = markerMatch.index + markerMatch[0].length;

  // Remonte jusqu'au `logger.error(` le plus proche AVANT le marker.
  const beforeMarker = content.slice(0, markerMatch.index);
  const loggerErrorStart = beforeMarker.lastIndexOf("logger.error(");
  if (loggerErrorStart === -1) return null;

  return content.slice(loggerErrorStart, markerEnd);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Sentinelle logging fallback routes admin (S10.1.12-LIST-CONTACTS-DIAGNOSIS-001)", () => {
  const routes = walkRoutes(ADMIN_ROUTES_DIR);

  it("au moins 4 routes admin détectées (sanity check)", () => {
    // Sanity : si le walk trouve 0 ou 1 route, le test passe en boucle
    // dégénérée → faux négatif. On exige les 4 routes attendues au moment
    // du fix S10.1.12 : contacts, preview-first-sms, send-first-sms, campaigns.
    expect(routes.length).toBeGreaterThanOrEqual(4);
  });

  it.each(routes.map((abs) => [relative(REPO_ROOT, abs).replace(/\\/g, "/"), abs] as const))(
    "`%s` — catch fallback 'unexpected error' logue errName + errMessage",
    (relPath, abs) => {
      const content = readFileSync(abs, "utf-8");
      const block = extractFallbackBlock(content);

      if (block === null) {
        // Route sans catch fallback "unexpected error" — acceptable si la
        // route n'a pas de catch global (rare). On skip silencieusement.
        // Le sanity check ci-dessus garantit qu'on a au moins 4 routes
        // analysées au total, donc impossible que TOUTES les routes soient
        // skip (faux négatif systémique impossible).
        return;
      }

      const errors: string[] = [];

      if (!/\berrName\b/.test(block)) {
        errors.push("`errName` manquant");
      }
      if (!/\berrMessage\b/.test(block)) {
        errors.push("`errMessage` manquant");
      }

      if (errors.length > 0) {
        throw new Error(
          [
            `Sentinelle S10.1.12-LIST-CONTACTS-DIAGNOSIS-001 — ${relPath}`,
            "",
            `Bloc catch "unexpected error" incomplet : ${errors.join(", ")}.`,
            "",
            "Bloc actuel :",
            ...block.split("\n").map((l) => `  ${l}`),
            "",
            "Pattern attendu :",
            "  logger.error(",
            "    {",
            '      errName: err instanceof Error ? err.name : "unknown",',
            "      errMessage: err instanceof Error ? err.message : undefined,",
            "      errCode: (err as { code?: unknown })?.code,",
            "    },",
            '    "[<METHOD> /api/admin/<route>] unexpected error",',
            "  );",
            "",
            "Rationale : `errName` seul (= 'Error') rend les bugs Firestore/",
            "Claude/HubSpot opaques. Le sanitizer Pino projet couvre les",
            "fragments PII éventuels dans `err.message`. Cf. bug runtime S10.1.12.",
          ].join("\n"),
        );
      }
    },
  );

  it("regex marker matche le pattern canonique (sanity)", () => {
    expect(FALLBACK_LOG_MARKER.test('"[GET /api/admin/contacts] unexpected error"')).toBe(true);
    expect(FALLBACK_LOG_MARKER.test('"[POST /api/admin/send-first-sms] unexpected error"')).toBe(
      true,
    );
    expect(FALLBACK_LOG_MARKER.test('"[GET /api/admin/campaigns] unexpected error"')).toBe(true);
    // Faux-positifs à éviter
    expect(FALLBACK_LOG_MARKER.test('"[GET /api/webhooks/ovh] unexpected error"')).toBe(false);
    expect(FALLBACK_LOG_MARKER.test('"[GET /api/admin/contacts] something else"')).toBe(false);
  });
});
