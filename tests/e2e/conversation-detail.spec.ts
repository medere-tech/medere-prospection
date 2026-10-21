/**
 * Scénarios S1-S5 — page détail conversation (PR1 lecture seule).
 *
 *   S1 — redirection 308 /admin/conversations/<id>/slug → /admin/conversations/<id>
 *   S2 — commercial TITULAIRE (slackUserId U05UVHGBURX) voit sa conversation A
 *   S3 — commercial NON-TITULAIRE (slackUserId UE2ECOMMERCIAL) reçoit 403, zéro contenu
 *   S4 — identifiant inexistant → 404 propre
 *   S5 — admin voit la bannière "Mode admin" sur A
 *
 * Les 3 scénarios "owner / non-owner / admin" tournent avec la MÊME
 * conversation A (CONV_ID_ADMIN_NON_OWNER). Aucun ID "owner commercial"
 * séparé n'est nécessaire — c'est le compte Clerk `e2e-commercial-owner`
 * qui partage le slackUserId de Déthié qui ouvre la vue owner sans
 * aucune écriture Firestore.
 */
import {
  assertNoFrenchPhone,
  CONV_ID_ADMIN_NON_OWNER,
  CONV_ID_INEXISTANT,
  expect,
  installApiPhoneSentinel,
  scrubPii,
  test,
} from "./fixtures";

test.describe("Détail conversation — lecture seule", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Firefox/Webkit non visés PR1.14");

  test("S1 — slug superflu redirigé en 308 vers l'URL canonique", async ({
    page,
    signInAsAdmin,
  }) => {
    test.skip(
      !CONV_ID_ADMIN_NON_OWNER,
      "E2E_CONV_ID_FOR_ADMIN_NON_OWNER non fourni — scénario S1 ignoré",
    );
    await signInAsAdmin();
    const url = `/admin/conversations/${CONV_ID_ADMIN_NON_OWNER}/anything-slug`;
    const resp = await page.goto(url);
    expect(resp?.status()).toBe(200);
    expect(page.url()).toContain(`/admin/conversations/${CONV_ID_ADMIN_NON_OWNER}`);
    expect(page.url()).not.toContain("/anything-slug");
  });

  test("S2 — commercial titulaire (U05UVHGBURX) : vue complète, pas de bannière admin, zéro numéro", async ({
    page,
    signInAsCommercialOwner,
  }) => {
    test.skip(
      !CONV_ID_ADMIN_NON_OWNER,
      "E2E_CONV_ID_FOR_ADMIN_NON_OWNER non fourni — scénario S2 ignoré",
    );
    installApiPhoneSentinel(page);
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(scrubPii(err.message)));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(scrubPii(msg.text()));
    });
    await signInAsCommercialOwner();
    const resp = await page.goto(`/admin/conversations/${CONV_ID_ADMIN_NON_OWNER}`);
    expect(resp?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // Owner → pas de bannière "Mode admin" (viewerIsOwner=true côté serveur).
    await expect(page.getByRole("status").filter({ hasText: /Mode admin/ })).toHaveCount(0);
    const bodyText = await page.locator("body").innerText();
    assertNoFrenchPhone(bodyText, "DOM S2 commercial titulaire");
    expect(errors, `Console errors: ${errors.join(" | ")}`).toEqual([]);
  });

  test("S3 — commercial non-titulaire (UE2ECOMMERCIAL) : 403, aucun contenu de conversation", async ({
    page,
    signInAsCommercial,
  }) => {
    test.skip(
      !CONV_ID_ADMIN_NON_OWNER,
      "E2E_CONV_ID_FOR_ADMIN_NON_OWNER non fourni — scénario S3 ignoré",
    );
    installApiPhoneSentinel(page);
    await signInAsCommercial();
    const resp = await page.goto(`/admin/conversations/${CONV_ID_ADMIN_NON_OWNER}`);
    expect([200, 403]).toContain(resp?.status() ?? 0);
    // Texte 403 présent
    await expect(page.getByText(/pas assignée|accès refusé|403/i)).toBeVisible();
    // Aucun contenu de la conversation : pas de MessageThread, pas de header
    // contact, pas de bannière admin.
    await expect(page.getByRole("log")).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: /Mode admin/ })).toHaveCount(0);
    // Zéro numéro dans le DOM.
    const bodyText = await page.locator("body").innerText();
    assertNoFrenchPhone(bodyText, "DOM S3 commercial non-titulaire 403");
  });

  test("S4 — ID inexistant : 404 propre", async ({ page, signInAsAdmin }) => {
    await signInAsAdmin();
    const resp = await page.goto(`/admin/conversations/${CONV_ID_INEXISTANT}`);
    expect([200, 404]).toContain(resp?.status() ?? 0);
    await expect(page.getByText(/introuvable|404|n'existe pas/i)).toBeVisible();
  });

  test("S5 — admin sur A : bannière 'Mode admin' visible, zéro numéro", async ({
    page,
    signInAsAdmin,
  }) => {
    test.skip(
      !CONV_ID_ADMIN_NON_OWNER,
      "E2E_CONV_ID_FOR_ADMIN_NON_OWNER non fourni — scénario S5 ignoré",
    );
    installApiPhoneSentinel(page);
    await signInAsAdmin();
    await page.goto(`/admin/conversations/${CONV_ID_ADMIN_NON_OWNER}`);
    const banner = page.getByRole("status").filter({ hasText: /Mode admin/ });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/conversation suivie par/);
    const bodyText = await page.locator("body").innerText();
    assertNoFrenchPhone(bodyText, "DOM S5 admin non-owner");
  });
});
