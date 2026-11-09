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
import { clerk } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";

import {
  assertNoFrenchPhone,
  assertNoTechnicalId,
  expect,
  installApiPhoneSentinel,
  test,
} from "./fixtures";

/**
 * Déconnecte la session Clerk COURANTE puis purge les cookies.
 *
 * `clerk.signOut` vit dans `node_modules/@clerk/testing/dist/types/playwright/helpers.d.ts:81`
 * (signature : `(opts: PlaywrightClerkSignOutParams) => Promise<void>`
 * avec `PlaywrightClerkSignOutParams = { page: Page; signOutOptions?: SignOutOptions }`,
 * mêmes fichier/lignes :95-98). Son impl attend que `window.Clerk` soit
 * chargé sur la page (JSDoc l.62 : « It is required to call `page.goto`
 * before calling this helper, and navigate to a page that loads Clerk »).
 *
 * Donc :
 *   1. si la page est encore sur `about:blank` (aucun `goto` effectué)
 *      OU sur une route qui n'inclut pas Clerk, on navigue vers
 *      `/sign-in` pour charger `window.Clerk` ;
 *   2. on appelle `clerk.signOut({ page })` ;
 *   3. en défense en profondeur, on purge les cookies (une session
 *      abandonnée peut laisser un `__session` traîner si signOut échoue
 *      partiellement sur le réseau).
 *
 * Fail-tolérant : si `window.Clerk` ne se charge jamais (ex. route sans
 * `<ClerkProvider>`), `clerk.signOut` throw → on catch et on reclearCookies.
 */
async function ensureSignedOut(page: Page): Promise<void> {
  try {
    const hasClerk = await page
      .evaluate(() => typeof (window as unknown as { Clerk?: unknown }).Clerk !== "undefined")
      .catch(() => false);
    if (!hasClerk) {
      await page.goto("/sign-in");
    }
    await clerk.signOut({ page });
  } catch {
    // Clerk indisponible ou session déjà vide → on retombe sur
    // `clearCookies` seul, qui invalide la session côté serveur même
    // si l'état côté JS n'a pas pu être purgé proprement.
  }
  await page.context().clearCookies();
}

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
   *
   * IMPORTANT : `ensureSignedOut` AVANT `signInAsAdmin`. Appelé depuis
   * `afterEach`, l'acteur du test (owner, non-titulaire, no-role) est
   * encore connecté côté Clerk (son état vit dans `localStorage` +
   * `window.Clerk.session`, pas seulement dans les cookies). Un simple
   * `clearCookies` ne déconnecte PAS toujours la session JS → `clerk.signIn`
   * throw « You're already signed in. » (prouvé par le run réel 23/24).
   *
   * `ensureSignedOut` appelle `clerk.signOut({ page })` qui purge l'état
   * JS, PUIS `clearCookies` en défense en profondeur. À la fin, on
   * `ensureSignedOut` à nouveau pour laisser la page en état propre.
   */
  async function resetMarkingAsAdmin(
    page: Page,
    signInAsAdmin: () => Promise<void>,
  ): Promise<void> {
    await ensureSignedOut(page);
    await signInAsAdmin();
    const res = await page.request.delete(HANDOFF_CONTACTED_URL);
    expect(
      [200, 409],
      `reset handoff-contacted doit rendre 200 ou 409, pas ${res.status()}`,
    ).toContain(res.status());
    // Libère la session admin pour que le `beforeEach` suivant puisse
    // appeler `clerk.signIn` sans « already signed in ».
    await ensureSignedOut(page);
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
    // PR4 B2 — tour correctif : en mobile 390, le tableau desktop est
    // rendu mais caché (`md:hidden`/`hidden md:table`), les cartes
    // mobiles portent AUSSI un lien href. `.first()` cru résout le
    // nœud du tableau desktop → `hidden` → `toBeVisible` throw. On
    // garde seulement les nœuds effectivement visibles via
    // `.filter({ visible: true })` (Playwright 1.60+).
    await expect(
      page
        .locator(`a[href$="/admin/conversations/${CONV_ID_PR4}"]`)
        .filter({ visible: true })
        .first(),
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
    //
    // Le bouton « Annuler » doit être cherché STRICTEMENT dans le
    // conteneur du toast sonner, sinon il entrerait en collision avec
    // « Annuler le contact » du panneau latéral (visible après
    // marquage pour l'auteur, canUndoContact=true côté serveur).
    // Chaque toast sonner porte l'attribut `data-sonner-toast`
    // (`node_modules/sonner/dist/index.mjs:648`) — source unique DOM.
    await expect(markButton).toBeHidden();
    const toast = page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Médecin marqué comme contacté." });
    await expect(toast).toBeVisible();
    await expect(toast.getByRole("button", { name: "Annuler", exact: true })).toBeVisible();

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
    // Même règle qu'en C1 : scope dans le toast sonner
    // (`[data-sonner-toast]`), nom exact « Annuler » — évite la
    // collision stricte avec « Annuler le contact » du panneau.
    const toast = page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Médecin marqué comme contacté." });
    const undoAction = toast.getByRole("button", { name: "Annuler", exact: true });
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
    // Changement de compte : `clearCookies` seul ne purge PAS l'état
    // JS Clerk → prochain `signIn` throw. On passe par
    // `ensureSignedOut` (c.f. `clerk.signOut` dans
    // `node_modules/@clerk/testing/dist/types/playwright/helpers.d.ts:81`).
    await ensureSignedOut(page);

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
  // Fin de CHAQUE test — reset authentifié via la fixture
  // `signInAsAdmin`. Remplace l'ancien `test.afterAll` qui créait un
  // contexte vierge sans session ni baseURL → DELETE relatif masqué
  // par un catch, laissant la conv PR4 marquée après C8.
  // Même tolérance 200/409 que `resetMarkingAsAdmin`.
  // ────────────────────────────────────────────────────────────────────
  test.afterEach(async ({ page, signInAsAdmin }) => {
    await resetMarkingAsAdmin(page, signInAsAdmin);
  });
});
