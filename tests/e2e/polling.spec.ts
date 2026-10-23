/**
 * Scénario S6 — polling économique PR1 avec mesure horodatée.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Baseline attendue sur 95 s (page A ouverte, zéro interaction) :
 *
 *   t=0s   : poll /version initial (refetchOnMount true dans QueryProvider)
 *   t=30s  : poll /version
 *   t=60s  : poll /version
 *   t=90s  : poll /version
 *                                 → 3 à 4 polls /version, zéro /detail
 *
 *   Plafond : 4 polls /version. Au-delà, c'est une régression (par ex.
 *   `refetchOnWindowFocus: true` qui aurait repopé, ou un double-mount
 *   React Strict).
 *
 *   `/detail` ne doit JAMAIS être appelé pendant la mesure (initialData
 *   SSR + `enabled: refetchKey > 0 || initialData === null`).
 *
 * Pause onglet caché : `refetchIntervalInBackground: false` doit arrêter
 * le polling pendant 40 s cachés.
 *
 * Discipline : zéro écriture, zéro interaction, zéro capture de PII dans
 * les traces (video/trace off par défaut cf. playwright.config.ts).
 */
import { CONV_ID_ADMIN_NON_OWNER, expect, installApiPhoneSentinel, test } from "./fixtures";

interface RequestRow {
  readonly ts: string;
  readonly url: string;
  readonly kind: "version" | "detail";
}

const VERSION_RE = /\/api\/admin\/conversations\/[^/]+\/version/;
const DETAIL_RE = /\/api\/admin\/conversations\/[^/]+(?:$|\?)/;

test.describe("Polling économique — mesure horodatée", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Firefox/Webkit non visés PR1.14");

  test("S6 — 95s page ouverte : ≤4 polls /version, 0 /detail, pause onglet caché", async ({
    page,
    signInAsAdmin,
  }) => {
    test.skip(
      !CONV_ID_ADMIN_NON_OWNER,
      "E2E_CONV_ID_FOR_ADMIN_NON_OWNER non fourni — scénario S6 ignoré",
    );
    // 95s de mesure + 40s pause onglet caché + ~20s pour sign-in Clerk,
    // navigation et assertions. Le défaut Playwright (30s) ne couvre que
    // le sign-in.
    test.setTimeout(95_000 + 40_000 + 20_000);
    installApiPhoneSentinel(page);

    const rows: RequestRow[] = [];
    const t0 = Date.now();
    page.on("request", (req) => {
      const url = req.url();
      if (VERSION_RE.test(url)) {
        rows.push({
          ts: `+${Math.floor((Date.now() - t0) / 100) / 10}s`,
          url: url.replace(/^https?:\/\/[^/]+/, ""),
          kind: "version",
        });
      } else if (
        DETAIL_RE.test(url) &&
        !/\/version$/.test(url) &&
        req.method() === "GET" &&
        /^GET$/i.test(req.method())
      ) {
        rows.push({
          ts: `+${Math.floor((Date.now() - t0) / 100) / 10}s`,
          url: url.replace(/^https?:\/\/[^/]+/, ""),
          kind: "detail",
        });
      }
    });

    await signInAsAdmin();
    await page.goto(`/admin/conversations/${CONV_ID_ADMIN_NON_OWNER}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // Fenêtre de mesure : 95s page ouverte, zéro interaction.
    await page.waitForTimeout(95_000);
    const measureRows = [...rows];

    // Pause onglet caché 40s.
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const countBeforeHidden = rows.length;
    await page.waitForTimeout(40_000);
    const countAfterHidden = rows.length;

    const versionCalls = measureRows.filter((r) => r.kind === "version");
    const detailCalls = measureRows.filter((r) => r.kind === "detail");

    // Log horodaté lisible dans la sortie de test (le reporter affiche).
    console.log(
      `S6 timeline (95s) :\n` +
        measureRows.map((r) => `  ${r.ts.padStart(6)} ${r.kind.padEnd(7)} ${r.url}`).join("\n"),
    );

    // Assertion 1 — plafond /version
    expect(
      versionCalls.length,
      `Attendu ≤4 polls /version sur 95s, reçu ${versionCalls.length}. ` +
        `Régression probable : refetchOnWindowFocus, double-mount Strict, ou refetchOnMount agressif.`,
    ).toBeLessThanOrEqual(4);

    // Assertion 2 — plancher /version (au moins 2 polls — initial + 1 à 30s)
    expect(
      versionCalls.length,
      `Attendu ≥2 polls /version sur 95s, reçu ${versionCalls.length}. ` + `Polling cassé.`,
    ).toBeGreaterThanOrEqual(2);

    // Assertion 3 — zéro /detail
    expect(
      detailCalls.length,
      `Attendu 0 GET /detail (initialData SSR + refetchKey=0), reçu ${detailCalls.length}.`,
    ).toBe(0);

    // Assertion 4 — pause onglet caché
    expect(
      countAfterHidden,
      `Attendu : aucun poll pendant les 40s caché. Delta : ${
        countAfterHidden - countBeforeHidden
      }.`,
    ).toBe(countBeforeHidden);
  });
});
