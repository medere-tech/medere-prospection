/**
 * Scénarios C1-C8 — bouton « J'ai contacté le médecin » (PR4 B1/B2).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Cible unique : la conversation de test PR4
 *
 *   `CONV_ID_PR4 = 427963864300_hubspot-list-999999` — seedée par
 *   `scripts/seed-e2e-pr4-conv.mjs` (`src/lib/firestore/seed-reset-e2e-pr4-core.ts`),
 *   status `handed_off`, `assignedTo = U05UVHGBURX` — même slackUserId que
 *   le fixture `e2e-commercial-owner`. La conv A (`hubspot-list-6081`,
 *   opted_out) n'est JAMAIS touchée par ce spec.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * État de départ (avant chaque test)
 *
 *   Avant le `test.beforeEach` on se signe en e2e-admin, on tape
 *   `DELETE /api/admin/conversations/<id>/handoff-contacted` depuis la
 *   session admin (tolère le 409 si aucune marque à annuler), puis on
 *   re-signe en tant qu'acteur du test (si différent). Ça garantit que
 *   la conv PR4 est TOUJOURS non contactée au début d'un test.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Preuves par réponses API
 *
 *   `waitForResponse` pour POST /handoff-contacted, GET /conversations/<id>
 *   (refetch détail), GET /conversations?tab=... (filtre list). Jamais
 *   d'attente sur une position ou un nom qui peut diverger.
 */
import {
  assertNoFrenchPhone,
  assertNoTechnicalId,
  expect,
  installApiPhoneSentinel,
  test,
} from "./fixtures";

/**
 * docId Firestore de la conversation test PR4. Hardcodé fail-closed
 * (même pattern que `CONV_ID_O7` dans orphan-inbounds.spec.ts). La
 * source unique est `src/lib/conversations/e2e-conversation-ids.ts`,
 * mais on duplique ici pour ne PAS importer de code serveur dans la
 * suite e2e (cette importation tirerait server-only et casserait le
 * harnais).
 */
const CONV_ID_PR4 = "427963864300_hubspot-list-999999";

/**
 * Endpoint commun POST/DELETE. Construit à partir du docId.
 */
const HANDOFF_CONTACTED_URL = `/api/admin/conversations/${CONV_ID_PR4}/handoff-contacted`;

test.describe("PR4 B2 — Bouton « J'ai contacté le médecin »", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Firefox/Webkit non visés PR4 B2");

  /**
   * Remet la conv PR4 à l'état « non contactée » (fail-tolérant). Signé
   * e2e-admin → 200 si un marquage existait, 409 si aucun. Tout autre
   * status est un vrai échec.
   */
  async function resetMarkingAsAdmin(
    page: import("@playwright/test").Page,
    signInAsAdmin: () => Promise<void>,
  ): Promise<void> {
    await signInAsAdmin();
    const res = await page.request.delete(HANDOFF_CONTACTED_URL);
    expect(
      [200, 409],
      `reset handoff-contacted doit rendre 200 ou 409, pas ${res.status()}`,
    ).toContain(res.status());
    // On déconnecte pour ne pas polluer la session de l'acteur du test.
    await page.context().clearCookies();
  }

  test.beforeEach(async ({ page, signInAsAdmin }) => {
    installApiPhoneSentinel(page);
    await resetMarkingAsAdmin(page, signInAsAdmin);
  });

  // ────────────────────────────────────────────────────────────────────
  // C1 — titulaire : marquage + toast persistant + journal + panneau
  // ────────────────────────────────────────────────────────────────────
  test("C1 titulaire — clic marque, le toast « Annuler » reste visible APRÈS rechargement, le panneau et le journal affichent le nom", async ({
    page,
    signInAsCommercialOwner,
  }) => {
    test.setTimeout(60_000);
    await signInAsCommercialOwner();

    // Vérifie l'état de départ : la conv PR4 est dans l'onglet
    // « À traiter » du titulaire. On cible par HREF (jamais par position).
    await page.goto("/admin/conversations?tab=a_traiter");
    await expect(
      page.locator(`a[href$="/admin/conversations/${CONV_ID_PR4}"]`).first(),
    ).toBeVisible();

    // Navigation vers le détail PR4.
    await page.goto(`/admin/conversations/${CONV_ID_PR4}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    const markButton = page.getByRole("button", { name: "J'ai contacté le médecin" });
    await expect(markButton).toBeVisible();

    // Les 2 waitForResponse DOIVENT être posés AVANT le clic (sinon
    // race). On capture le POST 200 puis le GET détail 200 qui suit
    // via `setRefetchKey → refetch React Query`.
    const [postResp, detailResp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes(HANDOFF_CONTACTED_URL) && r.request().method() === "POST",
      ),
      page.waitForResponse(
        (r) =>
          new RegExp(`/api/admin/conversations/${CONV_ID_PR4}(\\?|$)`).test(r.url()) &&
          r.request().method() === "GET",
      ),
      markButton.click(),
    ]);
    expect(postResp.status()).toBe(200);
    expect(detailResp.status()).toBe(200);

    // Preuve directe du BUG FIX (toast via sonner global) : le bouton
    // de marquage DISPARAÎT (canMarkContacted passé à false au refetch),
    // mais le toast « Médecin marqué comme contacté. » + son action
    // « Annuler » restent visibles.
    await expect(markButton).toBeHidden();
    const toast = page.getByText("Médecin marqué comme contacté.");
    await expect(toast).toBeVisible();
    await expect(page.getByRole("button", { name: "Annuler" })).toBeVisible();

    // Le panneau affiche « par E2E CommercialOwner » (nom résolu via
    // `resolveAdminNamesBatch`). On scope sur le panneau pour éviter de
    // matcher du bruit ailleurs dans la page.
    const panel = page.getByRole("complementary", { name: /Détails de la conversation/i });
    await expect(panel.getByText(/par E2E CommercialOwner/)).toBeVisible();

    // Première entrée du journal : « E2E CommercialOwner — Médecin contacté ».
    // Le journal vit dans la section `aria-labelledby="section-journal"`.
    const journalItems = panel.locator('section[aria-labelledby="section-journal"] ol > li');
    await expect(journalItems.first()).toContainText("E2E CommercialOwner — Médecin contacté");

    // Zéro identifiant technique côté DOM (sentinelle B1 point 6 #7).
    const body = await page.locator("body").innerText();
    assertNoTechnicalId(body, "C1 détail PR4 après marquage");
    assertNoFrenchPhone(body, "C1 détail PR4 — zéro numéro");
  });

  // ────────────────────────────────────────────────────────────────────
  // C2 — clic « Annuler » du toast dans les 10 s → DELETE 200 + journal
  // ────────────────────────────────────────────────────────────────────
  test("C2 titulaire — clic « Annuler » du toast → DELETE 200, bouton revient, journal « Contact annulé »", async ({
    page,
    signInAsCommercialOwner,
  }) => {
    test.setTimeout(60_000);
    await signInAsCommercialOwner();
    await page.goto(`/admin/conversations/${CONV_ID_PR4}`);

    const markButton = page.getByRole("button", { name: "J'ai contacté le médecin" });
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes(HANDOFF_CONTACTED_URL) && r.request().method() === "POST",
      ),
      markButton.click(),
    ]);
    const undoAction = page.getByRole("button", { name: "Annuler" });
    await expect(undoAction).toBeVisible();

    // waitForResponse DELETE + GET détail posés AVANT le clic.
    const [delResp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes(HANDOFF_CONTACTED_URL) && r.request().method() === "DELETE",
      ),
      page.waitForResponse(
        (r) =>
          new RegExp(`/api/admin/conversations/${CONV_ID_PR4}(\\?|$)`).test(r.url()) &&
          r.request().method() === "GET",
      ),
      undoAction.click(),
    ]);
    expect(delResp.status()).toBe(200);

    // Le bouton de marquage revient (canMarkContacted repasse à true).
    await expect(markButton).toBeVisible();

    const panel = page.getByRole("complementary", { name: /Détails de la conversation/i });
    const journalItems = panel.locator('section[aria-labelledby="section-journal"] ol > li');
    await expect(journalItems.first()).toContainText("Contact annulé");
  });

  // ────────────────────────────────────────────────────────────────────
  // C3 — après disparition du toast, « Annuler le contact » du panneau
  // ────────────────────────────────────────────────────────────────────
  test("C3 titulaire — après disparition du toast (10s), le panneau « Annuler le contact » → DELETE 200", async ({
    page,
    signInAsCommercialOwner,
  }) => {
    test.setTimeout(60_000);
    await signInAsCommercialOwner();
    await page.goto(`/admin/conversations/${CONV_ID_PR4}`);

    const markButton = page.getByRole("button", { name: "J'ai contacté le médecin" });
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes(HANDOFF_CONTACTED_URL) && r.request().method() === "POST",
      ),
      markButton.click(),
    ]);

    const toast = page.getByText("Médecin marqué comme contacté.");
    await expect(toast).toBeVisible();
    // Durée toast = 10 s (duration: 10_000 dans handoff-contacted-action.tsx).
    // On attend qu'il disparaisse avant d'essayer le bouton du panneau.
    await expect(toast).toBeHidden({ timeout: 15_000 });

    // Bouton panneau « Annuler le contact ».
    const panel = page.getByRole("complementary", { name: /Détails de la conversation/i });
    const panelUndo = panel.getByRole("button", { name: "Annuler le contact" });
    await expect(panelUndo).toBeVisible();

    const [delResp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes(HANDOFF_CONTACTED_URL) && r.request().method() === "DELETE",
      ),
      panelUndo.click(),
    ]);
    expect(delResp.status()).toBe(200);
  });

  // ────────────────────────────────────────────────────────────────────
  // C4 — admin annule un marquage posé par le titulaire
  // ────────────────────────────────────────────────────────────────────
  test("C4 admin annule un marquage posé par le titulaire", async ({
    page,
    signInAsCommercialOwner,
    signInAsAdmin,
  }) => {
    test.setTimeout(60_000);
    // Phase 1 : titulaire marque.
    await signInAsCommercialOwner();
    const markResp = await page.request.post(HANDOFF_CONTACTED_URL);
    expect(markResp.status()).toBe(200);
    await page.context().clearCookies();

    // Phase 2 : admin annule depuis l'UI.
    await signInAsAdmin();
    await page.goto(`/admin/conversations/${CONV_ID_PR4}`);
    const panel = page.getByRole("complementary", { name: /Détails de la conversation/i });
    const panelUndo = panel.getByRole("button", { name: "Annuler le contact" });
    await expect(panelUndo).toBeVisible();
    const [delResp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes(HANDOFF_CONTACTED_URL) && r.request().method() === "DELETE",
      ),
      panelUndo.click(),
    ]);
    expect(delResp.status()).toBe(200);
  });

  // ────────────────────────────────────────────────────────────────────
  // C5 — commercial non titulaire : POST direct → 403, sans numéro
  // ────────────────────────────────────────────────────────────────────
  test("C5 non-titulaire — POST direct → 403, zéro numéro dans la réponse", async ({
    page,
    signInAsCommercial,
  }) => {
    await signInAsCommercial();
    const res = await page.request.post(HANDOFF_CONTACTED_URL);
    expect(res.status()).toBe(403);
    const body = await res.text();
    assertNoFrenchPhone(body, "C5 réponse 403 handoff-contacted");
  });

  // ────────────────────────────────────────────────────────────────────
  // C6 — e2e-no-role : POST direct → 401 ou 403
  // ────────────────────────────────────────────────────────────────────
  test("C6 no-role — POST direct → 401 ou 403", async ({ page, signInAsNoRole }) => {
    await signInAsNoRole();
    const res = await page.request.post(HANDOFF_CONTACTED_URL);
    expect([401, 403]).toContain(res.status());
  });

  // ────────────────────────────────────────────────────────────────────
  // C7 — e2e-admin : POST sur un ID inexistant hors whitelist → 403
  //      (pas 404) parce que l'admin e2e porte `testAccount: true` et
  //      seule la whitelist `TEST_ACCOUNT_WHITELIST_CONV_IDS` passe.
  // ────────────────────────────────────────────────────────────────────
  test("C7 admin e2e — POST sur id hors whitelist → 403 (pas 404)", async ({
    page,
    signInAsAdmin,
  }) => {
    await signInAsAdmin();
    const hostileId = "999999999_hubspot-list-42";
    const res = await page.request.post(`/api/admin/conversations/${hostileId}/handoff-contacted`);
    expect(res.status()).toBe(403);
  });

  // ────────────────────────────────────────────────────────────────────
  // C8 — après marquage : /list tab=contactees contient PR4, tab=a_traiter non
  //      Preuve via waitForResponse posé AVANT le goto, jamais via position.
  //      Nom des champs prouvé par le code serveur :
  //        - `items[].conversationId`
  //          (`src/app/api/admin/conversations/route.ts:201`)
  // ────────────────────────────────────────────────────────────────────
  test("C8 admin — après marquage, « Contactées » contient PR4 et « À traiter » ne la contient plus", async ({
    page,
    signInAsAdmin,
  }) => {
    await signInAsAdmin();
    const markResp = await page.request.post(HANDOFF_CONTACTED_URL);
    expect(markResp.status()).toBe(200);

    // Liste `tab=contactees` : la conv PR4 doit apparaître dans items[].
    const [contacteesResp] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/admin/conversations?") &&
          r.url().includes("tab=contactees") &&
          r.request().method() === "GET",
      ),
      page.goto("/admin/conversations?tab=contactees"),
    ]);
    const contactees = (await contacteesResp.json()) as {
      items: Array<{ conversationId: string }>;
    };
    expect(contactees.items.map((i) => i.conversationId)).toContain(CONV_ID_PR4);

    // Liste `tab=a_traiter` : la conv PR4 ne doit PAS apparaître.
    const [aTraiterResp] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/admin/conversations?") &&
          r.url().includes("tab=a_traiter") &&
          r.request().method() === "GET",
      ),
      page.goto("/admin/conversations?tab=a_traiter"),
    ]);
    const aTraiter = (await aTraiterResp.json()) as {
      items: Array<{ conversationId: string }>;
    };
    expect(aTraiter.items.map((i) => i.conversationId)).not.toContain(CONV_ID_PR4);
  });

  // ────────────────────────────────────────────────────────────────────
  // Fin de spec — la conv PR4 revient à l'état non contacté. Posé en
  // `test.afterAll` pour TOUS les projets (même après les tests qui
  // n'écrivent pas, par défense en profondeur).
  // ────────────────────────────────────────────────────────────────────
  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // On ne peut pas appeler signInAsAdmin ici (hors scope fixture) —
    // on utilise directement l'API avec la session créée via
    // `storageState`. Si le harnais ne persiste pas la session admin,
    // la DELETE anonyme renvoie 401 : on tolère ce cas (reset déjà
    // effectué entre tests par `beforeEach`).
    const res = await page.request.delete(HANDOFF_CONTACTED_URL).catch(() => null);
    if (res) {
      expect([200, 401, 403, 409]).toContain(res.status());
    }
    await ctx.close();
  });
});
