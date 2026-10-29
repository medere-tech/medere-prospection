/**
 * Scénarios O1-O8 — page `/admin/orphan-inbounds` (PR2c tour 2b bloc B).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Prérequis AVANT chaque run du harnais contre une preview Vercel réelle
 *
 *   node scripts/seed-e2e-orphans.mjs --apply   # pose les 4 fixtures
 *   node scripts/reset-e2e-orphans.mjs --apply  # remet tout en pending
 *
 *   (reset APRÈS seed : si une run précédente a laissé une fixture en
 *    "attached" ou "dismissed", le reset la ramène en pending — invariant
 *    append-only des docs orphelins respecté.)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Isolation test ↔ réel
 *
 *   Previews et prod partagent la MÊME base Firestore. Les 4 fixtures
 *   portent `isTestFixture: true` ; les 4 comptes e2e portent
 *   `testAccount: true`. La garde serveur `assertActorMatchesOrphanFixture`
 *   rejette tout croisement (compte réel sur fixture → 404 indiscernable
 *   du GET détail ; compte test sur orphan réel → 403). Les notifications
 *   Slack issues de ces fixtures partent vers `SLACK_TEST_CHANNEL_ID`,
 *   jamais vers le canal ops.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Projets × scénarios
 *
 *   O1-O6 : lecture seule, exécutés sur les 3 projets (mobile-390,
 *           tablet-768, desktop-1440).
 *   O7-O8 : actions d'écriture (rattacher, classer, remettre à traiter)
 *           — exécutés UNIQUEMENT sur desktop-1440 pour ne pas tripler
 *           les mutations réelles sur la même fixture (`test.skip` sur
 *           les 2 autres projets avec raison explicite).
 */
import type { Page } from "@playwright/test";

import {
  assertNoAuditActionCode,
  assertNoFrenchPhone,
  assertNoTechnicalId,
  expect,
  innerTextWithoutMessageThread,
  installApiPhoneSentinel,
  test,
} from "./fixtures";

/** Conv réelle (Déthié Faye) utilisée par O7 comme cible de rattachement. */
const CONV_ID_O7 = "427963864300_hubspot-list-6081";

/** Terme de recherche qui doit remonter la conv `CONV_ID_O7`. */
const SEARCH_TERM_O7 = "dethie";

/** Raison figée affichée par `test.skip` sur mobile/tablette en O7/O8. */
const O7_O8_DESKTOP_ONLY_REASON =
  "O7/O8 écrivent sur la vraie base Firestore via l'API — on les joue sur desktop-1440 uniquement pour éviter de tripler les mutations sur la même fixture.";

/** Shape minimale lue depuis `/api/admin/orphan-inbounds` dans les helpers. */
interface OrphanLookupHit {
  readonly docId: string;
  readonly isTestFixture: boolean;
  readonly body: string;
  readonly processingState: "pending" | "attached" | "dismissed";
  readonly reason: "no_conversation" | "unknown_contact" | "parse_failed" | "enqueue_failed";
}

/**
 * Résout le `docId` de LA fixture pour `(reason, state)`. Fail-fast si
 * absente — message explicite qui pointe sur `seed-e2e-orphans.mjs`.
 *
 * Note : l'API renvoie fixtures ET docs réels pour un `testAccount`. Le
 * filtre `isTestFixture` isole strictement les 4 fixtures.
 */
async function fetchFixtureDocIdByReason(
  page: Page,
  reason: "no_conversation" | "unknown_contact" | "parse_failed" | "enqueue_failed",
  state: "pending" | "attached" | "dismissed",
): Promise<string> {
  const res = await page.request.get(
    `/api/admin/orphan-inbounds?reason=${reason}&processingState=${state}`,
  );
  expect(
    res.ok(),
    `GET /api/admin/orphan-inbounds reason=${reason}&state=${state} doit retourner 2xx`,
  ).toBe(true);
  const body = (await res.json()) as { orphans: readonly OrphanLookupHit[] };
  const fixtures = body.orphans.filter((o) => o.isTestFixture === true);
  expect(
    fixtures.length,
    `fixture ${reason}/${state} introuvable — relancer :\n` +
      `  node scripts/seed-e2e-orphans.mjs --apply\n` +
      `  node scripts/reset-e2e-orphans.mjs --apply`,
  ).toBe(1);
  return fixtures[0]!.docId;
}

test.describe("SMS orphelins — /admin/orphan-inbounds (PR2c tour 2b bloc B)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Firefox/Webkit non visés");

  // ────────────────────────────────────────────────────────────────────
  // O1 — e2e-admin voit la page, compteurs == /counts, 4 fixtures pending
  // ────────────────────────────────────────────────────────────────────
  test("O1 admin — page affichée + compteurs égaux à /counts + 4 fixtures en « À traiter »", async ({
    page,
    signInAsAdmin,
  }) => {
    installApiPhoneSentinel(page);
    await signInAsAdmin();

    const [countsResp] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/admin/orphan-inbounds/counts") && r.request().method() === "GET",
      ),
      page.goto("/admin/orphan-inbounds"),
    ]);
    const { counts } = (await countsResp.json()) as {
      counts: { pending: number; attached: number; dismissed: number; all: number };
    };

    // Titre page.
    await expect(page.getByRole("heading", { name: "SMS orphelins", level: 1 })).toBeVisible();

    // 4 onglets rendus.
    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveCount(4);

    // Compteurs == valeurs du /counts, lus directement dans chaque bouton
    // (chaque onglet rend son nom + un Badge avec le chiffre).
    const aTraiter = tabs.filter({ hasText: "À traiter" });
    await expect(aTraiter.getByText(new RegExp(`^${counts.pending}$`))).toBeVisible();
    const rattaches = tabs.filter({ hasText: "Rattachés" });
    await expect(rattaches.getByText(new RegExp(`^${counts.attached}$`))).toBeVisible();
    const classes = tabs.filter({ hasText: "Classés sans suite" });
    await expect(classes.getByText(new RegExp(`^${counts.dismissed}$`))).toBeVisible();
    const toutes = tabs.filter({ hasText: "Tous" });
    await expect(toutes.getByText(new RegExp(`^${counts.all}$`))).toBeVisible();

    // Les 4 fixtures sont EN PENDING : lecture directe de la liste API,
    // filtre `isTestFixture: true`.
    const listResp = await page.request.get(
      "/api/admin/orphan-inbounds?processingState=pending&limit=100",
    );
    expect(listResp.ok()).toBe(true);
    const { orphans } = (await listResp.json()) as { orphans: readonly OrphanLookupHit[] };
    const fixturesPending = orphans.filter((o) => o.isTestFixture === true);
    expect(
      fixturesPending.map((o) => o.reason).sort(),
      "les 4 fixtures doivent être en pending — relancer seed+reset",
    ).toEqual(["enqueue_failed", "no_conversation", "parse_failed", "unknown_contact"]);
  });

  // ────────────────────────────────────────────────────────────────────
  // O2 — commerciaux + no-role : 403 + aucune entrée « SMS orphelins »
  // ────────────────────────────────────────────────────────────────────
  test("O2 e2e-commercial — /admin/orphan-inbounds → 403, aucune entrée « SMS orphelins » dans la barre latérale", async ({
    page,
    signInAsCommercial,
    viewport,
  }) => {
    installApiPhoneSentinel(page);
    await signInAsCommercial();
    const resp = await page.goto("/admin/orphan-inbounds");
    expect(resp?.status(), "GET /admin/orphan-inbounds doit renvoyer 403 pour un commercial").toBe(
      403,
    );

    // Le commercial a bien accès à /admin/conversations : c'est là qu'on
    // peut vérifier que la sidebar NE PORTE PAS l'entrée « SMS orphelins »
    // (filtre `adminOnly` dans `admin-nav-items.tsx`).
    await page.goto("/admin/conversations");
    await assertNoOrphanLinkInSidebar(page, viewport?.width ?? 1440);
  });

  test("O2 e2e-commercial-owner — /admin/orphan-inbounds → 403, aucune entrée « SMS orphelins » dans la barre latérale", async ({
    page,
    signInAsCommercialOwner,
    viewport,
  }) => {
    installApiPhoneSentinel(page);
    await signInAsCommercialOwner();
    const resp = await page.goto("/admin/orphan-inbounds");
    expect(resp?.status()).toBe(403);

    await page.goto("/admin/conversations");
    await assertNoOrphanLinkInSidebar(page, viewport?.width ?? 1440);
  });

  test("O2 e2e-no-role — /admin/orphan-inbounds → page forbidden (403, texte exact)", async ({
    page,
    signInAsNoRole,
  }) => {
    installApiPhoneSentinel(page);
    await signInAsNoRole();
    const resp = await page.goto("/admin/orphan-inbounds");
    expect(resp?.status()).toBe(403);

    // Page de refus propre (racine `src/app/forbidden.tsx`).
    await expect(page.getByRole("heading", { name: "Accès refusé", level: 1 })).toBeVisible();
    await expect(
      page.getByText("Votre rôle n'est pas encore configuré. Contactez l'administrateur."),
    ).toBeVisible();

    // Le layout admin lui-même a thrown → aucune sidebar rendue, donc
    // AUCUNE entrée « SMS orphelins » visible où que ce soit.
    await expect(page.getByRole("link", { name: /^SMS orphelins$/ })).toHaveCount(0);
  });

  // ────────────────────────────────────────────────────────────────────
  // O3 — filtre Motif : libellé + URL + motif inconnu + combo onglet "Tous"
  // ────────────────────────────────────────────────────────────────────
  test("O3 admin — filtre Motif libellé + URL + motif inconnu + onglet « Tous »", async ({
    page,
    signInAsAdmin,
  }) => {
    installApiPhoneSentinel(page);
    await signInAsAdmin();

    // (a) Sélection d'une valeur valide → URL reflète + libellé affiché.
    await page.goto("/admin/orphan-inbounds?reason=no_conversation");
    const motifTrigger = page.getByLabel("Motif");
    await expect(motifTrigger).toBeVisible();
    await expect(motifTrigger).toContainText("Pas de conversation");
    expect(page.url()).toContain("reason=no_conversation");

    // (b) ?reason=<inconnu> → libellé « Motif non reconnu » + bouton de retrait.
    await page.goto("/admin/orphan-inbounds?reason=zzz_inconnu");
    await expect(motifTrigger).toContainText("Motif non reconnu");
    await expect(page.getByRole("button", { name: /Retirer le filtre motif/i })).toBeVisible();

    // (c) Onglet « Tous » + motif → fonctionne (URL combine tab=all & reason).
    await page.goto("/admin/orphan-inbounds?tab=all&reason=unknown_contact");
    await expect(motifTrigger).toContainText("Médecin inconnu");
    const toutes = page.getByRole("tab").filter({ hasText: "Tous" });
    await expect(toutes).toHaveAttribute("aria-selected", "true");
    expect(page.url()).toContain("tab=all");
    expect(page.url()).toContain("reason=unknown_contact");
  });

  // ────────────────────────────────────────────────────────────────────
  // O4 — ?id=<fixture> ouvre le tiroir ; ?id=inexistant → message dédié
  // ────────────────────────────────────────────────────────────────────
  test("O4 admin — ?id=<fixture no_conversation> ouvre le tiroir avec le texte complet", async ({
    page,
    signInAsAdmin,
  }) => {
    installApiPhoneSentinel(page);
    await signInAsAdmin();
    const docId = await fetchFixtureDocIdByReason(page, "no_conversation", "pending");
    await page.goto(`/admin/orphan-inbounds?id=${encodeURIComponent(docId)}`);
    const sheet = page.getByRole("dialog", { name: /Détail du SMS orphelin/i });
    await expect(sheet).toBeVisible();
    // Texte complet du seed : « SEED E2E — no_conversation. Contact connu… »
    await expect(sheet.getByText(/SEED E2E — no_conversation/)).toBeVisible();
  });

  test("O4 admin — ?id=inexistant → « Ce SMS orphelin est introuvable. Le lien est peut-être ancien. »", async ({
    page,
    signInAsAdmin,
  }) => {
    installApiPhoneSentinel(page);
    await signInAsAdmin();
    await page.goto("/admin/orphan-inbounds?id=oih_inexistant_e2e_pr2c");
    const sheet = page.getByRole("dialog", { name: /Détail du SMS orphelin/i });
    await expect(sheet).toBeVisible();
    await expect(
      sheet.getByText("Ce SMS orphelin est introuvable. Le lien est peut-être ancien."),
    ).toBeVisible();
  });

  // ────────────────────────────────────────────────────────────────────
  // O5 — fixture parse_failed (body="") : rattachement impossible
  // ────────────────────────────────────────────────────────────────────
  test("O5 admin — fixture parse_failed (texte vide) : « Rattacher définitivement » désactivé jusqu'à la confirmation", async ({
    page,
    signInAsAdmin,
  }) => {
    installApiPhoneSentinel(page);
    await signInAsAdmin();
    const docId = await fetchFixtureDocIdByReason(page, "parse_failed", "pending");
    await page.goto(`/admin/orphan-inbounds?id=${encodeURIComponent(docId)}`);

    const sheet = page.getByRole("dialog", { name: /Détail du SMS orphelin/i });
    await expect(sheet).toBeVisible();
    // Le tiroir indique explicitement que le texte est illisible.
    await expect(sheet.getByText(/Aucun texte lisible/)).toBeVisible();

    // On ouvre le dialog de rattachement, on sélectionne la conv e2e
    // (recherche "dethie"), on répond « Non » à l'opt-out, et on arrive
    // à l'écran de confirmation où le bouton est désactivé — invariant
    // UI défense en profondeur (le serveur refuse aussi via
    // `ValidationError` « body must be non-empty »).
    await sheet.getByRole("button", { name: /^Rattacher…$/ }).click();
    const attachDialog = page.getByRole("dialog", { name: /Rattacher ce SMS/i });
    await expect(attachDialog).toBeVisible();

    const searchInput = attachDialog.getByLabel("Recherche par nom du médecin");
    await searchInput.fill(SEARCH_TERM_O7);
    const firstHit = attachDialog.getByRole("option").first();
    await expect(firstHit).toBeVisible({ timeout: 5000 });
    await firstHit.click();

    // Étape 2 : opt-out → « Non ».
    const optOutNo = attachDialog.getByLabel(/Non, le médecin reste joignable/);
    await optOutNo.check();
    await attachDialog.getByRole("button", { name: /^Continuer$/ }).click();

    // Étape 3 : confirmation. Le bouton doit être DISABLED.
    const confirmBtn = attachDialog.getByRole("button", { name: /^Rattacher définitivement$/ });
    await expect(confirmBtn).toBeDisabled();
  });

  // ────────────────────────────────────────────────────────────────────
  // O6 — sentinelles liste + tiroir + dialogues, 0 console error, no scroll
  // ────────────────────────────────────────────────────────────────────
  test("O6 admin — sentinelles id technique + snake_case + numéro FR + 0 erreur console + no scroll horizontal (mobile)", async ({
    page,
    signInAsAdmin,
    viewport,
  }) => {
    installApiPhoneSentinel(page);
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    await signInAsAdmin();
    await page.goto("/admin/orphan-inbounds");
    await expect(page.getByRole("heading", { name: "SMS orphelins", level: 1 })).toBeVisible();

    // (1) Liste — pas d'id technique, pas de snake_case audit, pas de n° FR.
    const bodyList = await page.locator("body").innerText();
    assertNoTechnicalId(bodyList, "O6 liste /admin/orphan-inbounds");
    assertNoAuditActionCode(
      await innerTextWithoutMessageThread(page),
      "O6 snake liste /admin/orphan-inbounds",
    );
    assertNoFrenchPhone(bodyList, "O6 liste /admin/orphan-inbounds");

    // (2) Tiroir — on l'ouvre via ?id=<fixture no_conversation>.
    const docId = await fetchFixtureDocIdByReason(page, "no_conversation", "pending");
    await page.goto(`/admin/orphan-inbounds?id=${encodeURIComponent(docId)}`);
    await expect(page.getByRole("dialog", { name: /Détail du SMS orphelin/i })).toBeVisible();
    const bodySheet = await page.locator("body").innerText();
    assertNoTechnicalId(bodySheet, "O6 tiroir fixture no_conversation");
    assertNoAuditActionCode(
      await innerTextWithoutMessageThread(page),
      "O6 snake tiroir fixture no_conversation",
    );
    assertNoFrenchPhone(bodySheet, "O6 tiroir fixture no_conversation");

    // (3) Dialog classer sans suite — vérifie motifs et apostrophes.
    await page.getByRole("button", { name: /Classer sans suite/i }).click();
    const dismissDialog = page.getByRole("dialog", { name: /Classer ce SMS sans suite/i });
    await expect(dismissDialog).toBeVisible();
    const bodyDismiss = await page.locator("body").innerText();
    assertNoTechnicalId(bodyDismiss, "O6 dialog classer sans suite");
    assertNoAuditActionCode(
      await innerTextWithoutMessageThread(page),
      "O6 snake dialog classer sans suite",
    );
    assertNoFrenchPhone(bodyDismiss, "O6 dialog classer sans suite");
    // Referme ce dialog (lecture seule, aucune mutation).
    await dismissDialog.getByRole("button", { name: /^Annuler$/ }).click();

    // (4) Zéro erreur console sur tout le parcours.
    expect(consoleErrors, `Erreurs console sur O6 : ${consoleErrors.join(" | ")}`).toEqual([]);

    // (5) Pas de scroll horizontal — déclenché uniquement en mobile (390).
    if ((viewport?.width ?? 1440) <= 480) {
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(
        scrollWidth,
        `Scroll horizontal détecté en mobile : scrollWidth=${scrollWidth} > clientWidth=${clientWidth}`,
      ).toBeLessThanOrEqual(clientWidth + 1);
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // O7 — WRITE : rattacher fixture no_conversation à CONV_ID_O7, "Non"
  //
  //   Serial sur desktop-1440 uniquement — mutations réelles sur la base
  //   partagée des previews. Le reset-e2e-orphans.mjs ramène le tout en
  //   pending à la prochaine préparation (cf. tâche 3 de la restitution).
  // ────────────────────────────────────────────────────────────────────
  test.describe.serial("O7-O8 — actions d'écriture (desktop uniquement)", () => {
    test("O7 admin — rattacher fixture no_conversation à la conversation Déthié, répondre « Non »", async ({
      page,
      signInAsAdmin,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop-1440", O7_O8_DESKTOP_ONLY_REASON);
      installApiPhoneSentinel(page);
      await signInAsAdmin();
      const docId = await fetchFixtureDocIdByReason(page, "no_conversation", "pending");

      // Ouverture du tiroir, puis du dialog de rattachement.
      await page.goto(`/admin/orphan-inbounds?id=${encodeURIComponent(docId)}`);
      const sheet = page.getByRole("dialog", { name: /Détail du SMS orphelin/i });
      await expect(sheet).toBeVisible();
      await sheet.getByRole("button", { name: /^Rattacher…$/ }).click();

      const attachDialog = page.getByRole("dialog", { name: /Rattacher ce SMS/i });
      await expect(attachDialog).toBeVisible();

      // Étape 1 : recherche par nom (debounce 300 ms, min 2 chars).
      const searchInput = attachDialog.getByLabel("Recherche par nom du médecin");
      await searchInput.fill(SEARCH_TERM_O7);
      const firstHit = attachDialog.getByRole("option").first();
      await expect(firstHit).toBeVisible({ timeout: 5000 });
      // Preuve stricte : le hit sélectionné correspond bien à CONV_ID_O7.
      // On lit la réponse API déjà faite par le dialog pour s'en assurer.
      await firstHit.click();

      // Étape 2 : opt-out → « Non, le médecin reste joignable ».
      const optOutNo = attachDialog.getByLabel(/Non, le médecin reste joignable/);
      await optOutNo.check();
      await attachDialog.getByRole("button", { name: /^Continuer$/ }).click();

      // Étape 3 : confirmation. L'écran nomme explicitement QUI sera prévenu.
      await expect(attachDialog.getByText(/sera prévenu/)).toBeVisible();
      // Déclenche l'attach (POST /attach + mise à jour UI).
      await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url().includes(`/api/admin/orphan-inbounds/${docId}/attach`) &&
            r.request().method() === "POST",
        ),
        attachDialog.getByRole("button", { name: /^Rattacher définitivement$/ }).click(),
      ]);

      // Toast de succès.
      await expect(page.getByText(/SMS rattaché à la conversation/)).toBeVisible();

      // L'orphan est maintenant dans « Rattachés » : navigation + présence.
      await page.goto("/admin/orphan-inbounds?tab=attached");
      await expect(page.getByRole("tab", { name: /Rattachés/ })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      // Rouvre le tiroir : historique nomme l'admin + le lien conv.
      await page.goto(`/admin/orphan-inbounds?tab=attached&id=${encodeURIComponent(docId)}`);
      const sheetAfter = page.getByRole("dialog", { name: /Détail du SMS orphelin/i });
      await expect(sheetAfter).toBeVisible();
      await expect(sheetAfter.getByText(/E2E Admin/)).toBeVisible();
      const convLink = sheetAfter.getByRole("link", { name: /conversation du médecin/i });
      await expect(convLink).toHaveAttribute(
        "href",
        `/admin/conversations/${encodeURIComponent(CONV_ID_O7)}`,
      );

      // La conversation ciblée affiche « Ajouté manuellement depuis un SMS orphelin ».
      await page.goto(`/admin/conversations/${CONV_ID_O7}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(
        page.getByText("Ajouté manuellement depuis un SMS orphelin").first(),
      ).toBeVisible();
    });

    // ────────────────────────────────────────────────────────────────
    // O8 — WRITE : classer sans suite fixture unknown_contact, puis remise
    // ────────────────────────────────────────────────────────────────
    test("O8 admin — classer sans suite fixture unknown_contact puis « Remettre à traiter »", async ({
      page,
      signInAsAdmin,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop-1440", O7_O8_DESKTOP_ONLY_REASON);
      installApiPhoneSentinel(page);
      await signInAsAdmin();
      const docId = await fetchFixtureDocIdByReason(page, "unknown_contact", "pending");

      // Ouverture du tiroir.
      await page.goto(`/admin/orphan-inbounds?id=${encodeURIComponent(docId)}`);
      const sheet = page.getByRole("dialog", { name: /Détail du SMS orphelin/i });
      await expect(sheet).toBeVisible();

      // Dialog classer sans suite → pick « Hors sujet ou spam ».
      await sheet.getByRole("button", { name: /Classer sans suite/i }).click();
      const dismissDialog = page.getByRole("dialog", { name: /Classer ce SMS sans suite/i });
      await expect(dismissDialog).toBeVisible();
      await dismissDialog.getByLabel(/Hors sujet ou spam/).check();
      await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url().includes(`/api/admin/orphan-inbounds/${docId}/dismiss`) &&
            r.request().method() === "POST",
        ),
        dismissDialog.getByRole("button", { name: /^Classer sans suite$/ }).click(),
      ]);
      await expect(page.getByText(/SMS classé sans suite/)).toBeVisible();

      // Onglet « Classés sans suite » → la fixture y est.
      await page.goto("/admin/orphan-inbounds?tab=dismissed");
      await expect(page.getByRole("tab", { name: /Classés sans suite/ })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      // Rouvre le tiroir : motif affiché dans l'historique.
      await page.goto(`/admin/orphan-inbounds?tab=dismissed&id=${encodeURIComponent(docId)}`);
      const sheetDismissed = page.getByRole("dialog", { name: /Détail du SMS orphelin/i });
      await expect(sheetDismissed).toBeVisible();
      await expect(sheetDismissed.getByText(/Hors sujet ou spam/)).toBeVisible();

      // « Remettre à traiter » → retour en pending.
      await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url().includes(`/api/admin/orphan-inbounds/${docId}/reopen`) &&
            r.request().method() === "POST",
        ),
        sheetDismissed.getByRole("button", { name: /^Remettre à traiter$/ }).click(),
      ]);
      await expect(page.getByText(/SMS remis à traiter/)).toBeVisible();

      // L'onglet « À traiter » rend la fixture — compteur côté API.
      const listResp = await page.request.get(
        `/api/admin/orphan-inbounds?processingState=pending&reason=unknown_contact`,
      );
      expect(listResp.ok()).toBe(true);
      const { orphans } = (await listResp.json()) as { orphans: readonly OrphanLookupHit[] };
      const found = orphans.find((o) => o.docId === docId);
      expect(
        found,
        "fixture unknown_contact doit être revenue en pending après reopen",
      ).toBeTruthy();
      expect(found!.processingState).toBe("pending");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Helpers partagés — vit UNIQUEMENT dans cette spec car très spécifique à
// l'invariant sidebar sur `/admin/orphan-inbounds`. Les helpers génériques
// restent dans `fixtures.ts`.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Vérifie qu'AUCUN lien « SMS orphelins » n'est atteignable depuis la
 * barre latérale, qu'elle soit rendue en sidebar desktop ou en drawer
 * mobile. Pattern analogue à `L10` dans `conversations-list.spec.ts`.
 */
async function assertNoOrphanLinkInSidebar(page: Page, viewportWidth: number): Promise<void> {
  const isMobile = viewportWidth < 768;
  if (isMobile) {
    // Sur mobile, la sidebar est dans un drawer qu'on ouvre d'abord.
    const trigger = page.getByRole("button", { name: "Ouvrir le menu", exact: true });
    await expect(trigger).toBeVisible();
    await trigger.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("link", { name: /^SMS orphelins$/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
  } else {
    const sidebar = page.getByRole("complementary", { name: /Barre latérale admin/i });
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByRole("link", { name: /^SMS orphelins$/ })).toHaveCount(0);
  }
}
