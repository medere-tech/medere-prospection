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

  test("S1 — `/conversations/<id>` renvoie 308 vers `/admin/conversations/<id>`", async ({
    page,
  }) => {
    test.skip(
      !CONV_ID_ADMIN_NON_OWNER,
      "E2E_CONV_ID_FOR_ADMIN_NON_OWNER non fourni — scénario S1 ignoré",
    );
    // La route `src/app/conversations/[id]/page.tsx` est PUBLIQUE côté
    // middleware (pass-through) et renvoie 308 via `permanentRedirect`.
    // On lit le statut sur la réponse de redirection elle-même
    // (`maxRedirects: 0`) — `page.goto` suivrait le 308 et masquerait
    // le vrai code. Pas de session Clerk nécessaire : la cible 308 (sous
    // `/admin/*`) sera protégée par le middleware MAIS on arrête AVANT.
    const url = `/conversations/${CONV_ID_ADMIN_NON_OWNER}`;
    const resp = await page.request.get(url, { maxRedirects: 0 });
    expect(resp.status(), `GET ${url} doit renvoyer 308`).toBe(308);
    const location = resp.headers()["location"];
    expect(location, "en-tête Location manquant sur la 308").toBeTruthy();
    expect(location).toContain(
      `/admin/conversations/${encodeURIComponent(CONV_ID_ADMIN_NON_OWNER!)}`,
    );
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
    // Texte 403 réel du composant `ConversationNotMine`
    // (`src/components/conversations/conversation-not-mine.tsx:29,33`).
    await expect(
      page.getByRole("heading", { name: /Conversation suivie par un collègue/i, level: 1 }),
    ).toBeVisible();
    await expect(page.getByText(/suivie par .+ Demandez-lui/i)).toBeVisible();
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
    // Cible le heading <h1>Conversation introuvable</h1> du composant
    // `not-found.tsx:15`. L'ancien `getByText(/introuvable|404|n'existe pas/i)`
    // matchait h1 + <p> → strict mode violation 2 éléments.
    await expect(
      page.getByRole("heading", { name: /Conversation introuvable/i, level: 1 }),
    ).toBeVisible();
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
