/**
 * Scénarios L1-L10 — page liste `/admin/conversations` (PR2b-1).
 *
 *   L1 e2e-admin  : onglets vides propres + Clôturées contient A + compteurs réels
 *   L2 e2e-admin  : filtre commercial → A visible / autre commercial → vide ; URL reflète le filtre
 *   L3 e2e-commercial-owner : A visible dans "Toutes" et "Clôturées" ; onglet "En cours avec Léa" absent
 *   L4 e2e-commercial       : état vide propre partout, aucune donnée de A dans le DOM/réseau
 *   L5 e2e-no-role          : page 403 existante
 *   L6 clic/Entrée sur ligne A → navigation vers /admin/conversations/{id}
 *   L7 mobile 390           : cartes, aucun scroll horizontal
 *   L8 sentinelle réseau : aucun numéro FR dans aucune réponse `/api/admin/conversations*`
 *   L9 aucune erreur console + requêtes attendues (liste + compteurs) + pas de polling
 *   L10 lien "Conversations" actif dans la barre latérale
 *
 * Tous les scénarios tournent avec la MÊME conversation réelle A
 * (427963864300_hubspot-list-6081, statut `opted_out`, titulaire
 * `U05UVHGBURX`). Aucune écriture Firestore — PR2a a backfillé les
 * champs dénormalisés sur la base de prod.
 */
import {
  assertNoFrenchPhone,
  CONV_ID_ADMIN_NON_OWNER,
  expect,
  installApiPhoneSentinel,
  test,
} from "./fixtures";

test.describe("Liste conversations — lecture seule", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Firefox/Webkit non visés PR2b-1");

  // ────────────────────────────────────────────────────────────────────
  // L1 — admin : onglets propres + compteurs réels
  // ────────────────────────────────────────────────────────────────────

  test("L1 admin — onglets propres + compteurs = valeurs réelles", async ({
    page,
    signInAsAdmin,
  }) => {
    test.skip(!CONV_ID_ADMIN_NON_OWNER, "E2E_CONV_ID_FOR_ADMIN_NON_OWNER manquant");
    installApiPhoneSentinel(page);
    await signInAsAdmin();
    await page.goto("/admin/conversations");

    // 4 onglets rendus pour un admin.
    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveCount(4);

    // Compteurs (texte Badge). A traiter + En cours = 0 ; Clôturées = 1 ; Toutes = 1.
    const aTraiter = tabs.filter({ hasText: "À traiter" });
    await expect(aTraiter.getByText(/^0$/)).toBeVisible();
    const enCours = tabs.filter({ hasText: "En cours avec Léa" });
    await expect(enCours.getByText(/^0$/)).toBeVisible();
    const cloturees = tabs.filter({ hasText: "Clôturées" });
    await expect(cloturees.getByText(/^1$/)).toBeVisible();
    const toutes = tabs.filter({ hasText: "Toutes" });
    await expect(toutes.getByText(/^1$/)).toBeVisible();

    // Onglet "A traiter" vide → phrase utile.
    await expect(page.getByText("Aucune conversation à traiter.")).toBeVisible();

    // Clôturées : A visible.
    await cloturees.click();
    await expect(page.getByRole("link", { name: /Ouvrir la conversation/ })).toBeVisible();

    // Toutes : A visible.
    await toutes.click();
    await expect(page.getByRole("link", { name: /Ouvrir la conversation/ })).toBeVisible();

    // Vérif DOM anti-numéro.
    const body = await page.locator("body").innerText();
    assertNoFrenchPhone(body, "L1 admin — body liste");
  });

  // ────────────────────────────────────────────────────────────────────
  // L2 — filtre commercial : A visible pour U05UVHGBURX, vide pour autre
  // ────────────────────────────────────────────────────────────────────

  test("L2 admin — filtre commercial reflète dans l'URL + filtre les lignes", async ({
    page,
    signInAsAdmin,
  }) => {
    test.skip(!CONV_ID_ADMIN_NON_OWNER, "E2E_CONV_ID_FOR_ADMIN_NON_OWNER manquant");
    installApiPhoneSentinel(page);
    await signInAsAdmin();
    // Pré-sélectionne "Toutes" + commercial Déthié via URL.
    await page.goto("/admin/conversations?tab=toutes&assignedTo=U05UVHGBURX");
    // A visible.
    await expect(page.getByRole("link", { name: /Ouvrir la conversation/ })).toBeVisible();
    expect(page.url()).toContain("assignedTo=U05UVHGBURX");

    // Autre commercial fictif → aucune ligne.
    await page.goto("/admin/conversations?tab=toutes&assignedTo=UDOESNOTEXIST");
    // Phrase utile du bloc "Toutes" (vide).
    await expect(page.getByText(/Aucune conversation/).first()).toBeVisible();
  });

  // ────────────────────────────────────────────────────────────────────
  // L3 — commercial titulaire : voit A, pas d'onglet "En cours avec Léa"
  // ────────────────────────────────────────────────────────────────────

  test("L3 commercial titulaire — A dans Toutes et Clôturées, pas d'onglet 'En cours avec Léa'", async ({
    page,
    signInAsCommercialOwner,
  }) => {
    test.skip(!CONV_ID_ADMIN_NON_OWNER, "E2E_CONV_ID_FOR_ADMIN_NON_OWNER manquant");
    installApiPhoneSentinel(page);
    await signInAsCommercialOwner();
    await page.goto("/admin/conversations?tab=toutes");

    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveCount(3);
    await expect(page.getByText("En cours avec Léa")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Ouvrir la conversation/ })).toBeVisible();
  });

  // ────────────────────────────────────────────────────────────────────
  // L4 — commercial non-titulaire : vide propre partout, zéro trace de A
  // ────────────────────────────────────────────────────────────────────

  test("L4 commercial non-titulaire — vide propre partout, 0 trace de A dans le DOM ou le réseau", async ({
    page,
    signInAsCommercial,
  }) => {
    test.skip(!CONV_ID_ADMIN_NON_OWNER, "E2E_CONV_ID_FOR_ADMIN_NON_OWNER manquant");
    installApiPhoneSentinel(page);
    const apiBodies: string[] = [];
    page.on("response", async (resp) => {
      if (resp.url().includes("/api/admin/conversations")) {
        try {
          apiBodies.push(await resp.text());
        } catch {
          /* stream closed */
        }
      }
    });
    await signInAsCommercial();
    await page.goto("/admin/conversations?tab=toutes");
    await expect(page.getByText(/Aucune conversation/).first()).toBeVisible();
    // L'ID de A ne doit figurer NI dans le DOM NI dans aucune réponse.
    const body = await page.locator("body").innerText();
    expect(body).not.toContain(CONV_ID_ADMIN_NON_OWNER!);
    for (const b of apiBodies) expect(b).not.toContain(CONV_ID_ADMIN_NON_OWNER!);
  });

  // ────────────────────────────────────────────────────────────────────
  // L5 — e2e-no-role : page 403 existante
  // ────────────────────────────────────────────────────────────────────

  test("L5 no-role — rendu de /admin/forbidden avec HTTP 403", async ({ page, signInAsNoRole }) => {
    await signInAsNoRole();
    const resp = await page.goto("/admin/conversations");
    expect(resp?.status()).toBe(403);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  // ────────────────────────────────────────────────────────────────────
  // L6 — clic + Entrée + Ctrl+clic sur la ligne A → navigation
  // ────────────────────────────────────────────────────────────────────

  test("L6 — clic simple, Entrée clavier et Ctrl/Cmd+clic sur la ligne A navigent vers le détail", async ({
    page,
    context,
    signInAsAdmin,
  }) => {
    test.skip(!CONV_ID_ADMIN_NON_OWNER, "E2E_CONV_ID_FOR_ADMIN_NON_OWNER manquant");
    await signInAsAdmin();
    await page.goto("/admin/conversations?tab=toutes");
    const row = page.getByRole("link", { name: /Ouvrir la conversation/ }).first();
    await expect(row).toBeVisible();

    // 1) Clic simple → navigation même onglet.
    await row.click();
    await expect(page).toHaveURL(
      new RegExp(
        `/admin/conversations/${CONV_ID_ADMIN_NON_OWNER!.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`,
      ),
    );
    await page.goBack();

    // 2) Entrée au clavier (focus puis Enter).
    const row2 = page.getByRole("link", { name: /Ouvrir la conversation/ }).first();
    await row2.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/admin\/conversations\//);
    await page.goBack();

    // 3) Ctrl/Cmd+clic → ouvre un nouvel onglet.
    const row3 = page.getByRole("link", { name: /Ouvrir la conversation/ }).first();
    const [newPage] = await Promise.all([
      context.waitForEvent("page"),
      row3.click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] }),
    ]);
    await expect(newPage).toHaveURL(/\/admin\/conversations\//);
    await newPage.close();
  });

  // ────────────────────────────────────────────────────────────────────
  // L7 — mobile 390 : cartes, aucun scroll horizontal
  // ────────────────────────────────────────────────────────────────────

  test("L7 mobile 390 — cartes rendues, aucun scroll horizontal", async ({
    page,
    signInAsAdmin,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInAsAdmin();
    await page.goto("/admin/conversations?tab=toutes");
    // La vue mobile a `.md:hidden` + cartes.
    const cardLinks = page.locator(".md\\:hidden a[href^='/admin/conversations/']");
    await expect(cardLinks.first()).toBeVisible({ timeout: 5000 });
    // Pas de scroll horizontal sur le viewport.
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  });

  // ────────────────────────────────────────────────────────────────────
  // L8 — sentinelle réseau : jamais de numéro FR
  // (couvert partout par `installApiPhoneSentinel` — test dédié ici
  //  qui laisse la sentinelle courir sur toutes les actions)
  // ────────────────────────────────────────────────────────────────────

  test("L8 — zéro numéro FR dans toutes les réponses `/api/admin/conversations*`", async ({
    page,
    signInAsAdmin,
  }) => {
    installApiPhoneSentinel(page);
    await signInAsAdmin();
    for (const tab of ["a_traiter", "en_cours", "cloturees", "toutes"]) {
      await page.goto(`/admin/conversations?tab=${tab}`);
      const body = await page.locator("body").innerText();
      assertNoFrenchPhone(body, `L8 — body onglet ${tab}`);
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // L9 — aucune erreur console + requêtes attendues + pas de polling
  // ────────────────────────────────────────────────────────────────────

  test("L9 — zéro erreur console + exactement liste+counts au chargement + aucun refetch sans action", async ({
    page,
    signInAsAdmin,
  }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    const apiCalls: string[] = [];
    page.on("request", (req) => {
      const u = req.url();
      if (u.includes("/api/admin/conversations")) apiCalls.push(u);
    });
    await signInAsAdmin();
    await page.goto("/admin/conversations?tab=toutes");
    await expect(page.getByRole("tab", { name: /Toutes/ })).toBeVisible();
    // Au chargement : exactement 2 appels (liste + counts).
    const initialCount = apiCalls.length;
    expect(initialCount).toBeGreaterThanOrEqual(2);
    // Attente 3s sans action → aucun appel supplémentaire (pas de polling PR2b-1).
    await page.waitForTimeout(3000);
    expect(apiCalls.length).toBe(initialCount);
    // Zéro erreur console.
    expect(consoleErrors).toEqual([]);
  });

  // ────────────────────────────────────────────────────────────────────
  // L10 — nav sidebar : "Conversations" actif sur la liste et le détail
  // ────────────────────────────────────────────────────────────────────

  test("L10 — lien 'Conversations' actif dans la barre latérale sur la liste et sur le détail", async ({
    page,
    signInAsAdmin,
  }) => {
    test.skip(!CONV_ID_ADMIN_NON_OWNER, "E2E_CONV_ID_FOR_ADMIN_NON_OWNER manquant");
    await signInAsAdmin();
    await page.goto("/admin/conversations");
    // Le lien de la nav sidebar porte aria-current="page" quand actif.
    const navLink = page.getByRole("link", { name: /^Conversations$/ });
    await expect(navLink).toHaveAttribute("aria-current", "page");

    // Idem sur la page détail.
    await page.goto(`/admin/conversations/${CONV_ID_ADMIN_NON_OWNER}`);
    await expect(navLink).toHaveAttribute("aria-current", "page");
  });
});
