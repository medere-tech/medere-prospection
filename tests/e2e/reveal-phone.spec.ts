/**
 * Scénarios R1-R6 — révélation auditée du numéro (VUE-CONVERSATION PR3 tour 2b).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Cible : conversation `427963864300_hubspot-list-6081` (contact
 * Déthié Faye, désabonné). L'ID est en dur comme pour les specs orphan —
 * c'est une donnée réelle de la preview, pas une fixture.
 *
 * Projets × scénarios
 *
 *   R1-R6 sont lancés sur les 3 projets viewport (mobile-390 /
 *   tablet-768 / desktop-1440) — chaque action admin produit un audit
 *   réel en base, mais `actorTestAccount: true` est posé en payload (cf.
 *   `revealContactPhone`) et ces entrées sont filtrées du journal pour
 *   les comptes réels par `sanitizeAuditEntriesForJournal` (PR3 tour 2b).
 *   Elles restent visibles pour les comptes e2e (testAccount) — c'est
 *   leur canal de debug.
 *
 * Invariants vérifiés
 *
 *   - R1 commercial titulaire : masqué avant clic (sentinelles DOM +
 *     réseau), numéro FR + warning opt-out après clic, copie →
 *     presse-papiers, appel → `tel:+33…`, journal mis à jour avec les 3
 *     libellés spécialisés (`Numéro affiché / copié`, `Appel lancé`).
 *   - R2 admin : affichage fonctionne idem.
 *   - R3 commercial non-titulaire : POST direct 403, aucun numéro dans
 *     la réponse (défense RBAC serveur).
 *   - R4 compte sans rôle : page refusée, pas d'accès.
 *   - R5 admin /admin/contacts : la liste ne contient aucun numéro, le
 *     reveal unitaire fonctionne sur une ligne.
 *   - R6 commercial sur route contacts : POST direct 403.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Régression des sentinelles « zéro numéro » existantes
 *
 *   Les specs suivantes continuent de vérifier qu'AUCUN numéro n'apparaît
 *   dans leur scope (via `assertNoFrenchPhone` sur le DOM et
 *   `installApiPhoneSentinel` sur les réponses API) :
 *
 *     - `conversation-detail.spec.ts` S2, S3, S5 : vue conversation
 *       ouverte SANS clic reveal → la payload RSC + `/version` + `/detail`
 *       ne contiennent jamais d'E.164 (strippés par `sanitize.ts`).
 *     - `conversations-list.spec.ts`, `orphan-inbounds.spec.ts`,
 *       `polling.spec.ts`, `layout.spec.ts`, `forbidden.spec.ts` : aucune
 *       de ces routes ne fait transiter d'E.164 côté client.
 *
 *   L'exemption du sentinel est STRICTEMENT limitée aux réponses de
 *   `POST .../reveal-phone` (cf. `fixtures.ts::installApiPhoneSentinel`) —
 *   toute autre route qui fuite un numéro casse immédiatement l'une de
 *   ces specs.
 */
import { assertNoFrenchPhone, expect, installApiPhoneSentinel, test } from "./fixtures";

const CONV_ID = "427963864300_hubspot-list-6081";
const CONTACT_ID = "427963864300";
const CONV_URL = `/admin/conversations/${CONV_ID}`;

/** Regex minimal reconnaissant un numéro FR formaté « 0X XX XX XX XX ». */
const FR_DISPLAY = /\b0[1-9](?:\s\d{2}){4}\b/;

test.describe("Reveal phone — PR3 tour 2b (brief Déthié)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Firefox/Webkit non visés PR3");

  test.use({
    // Permissions clipboard accordées : le POST copy appellera
    // `navigator.clipboard.writeText` que l'on vérifie en lisant le
    // presse-papier (API `page.evaluate(() => navigator.clipboard.readText())`).
    permissions: ["clipboard-read", "clipboard-write"],
  });

  test("R1 — commercial titulaire : masqué avant clic, afficher/copier/appeler, journal 3 libellés", async ({
    page,
    signInAsCommercialOwner,
  }) => {
    installApiPhoneSentinel(page);
    await signInAsCommercialOwner();
    await page.goto(CONV_URL);

    // Sentinelle DOM : avant clic, zéro numéro FR dans le DOM.
    const bodyBefore = await page.locator("body").innerText();
    assertNoFrenchPhone(bodyBefore, "DOM R1 avant clic reveal");

    // Sentinelle réseau : la payload initiale `/detail` + polls `/version`
    // ne contiennent pas de numéro — `installApiPhoneSentinel` fait le
    // travail en continu sur TOUTES les réponses `/api/admin/(conv|contacts)/*`
    // sauf POST reveal-phone.

    // Clic « Afficher le numéro ».
    const afficher = page.getByRole("button", { name: /Afficher le numéro/i });
    await expect(afficher).toBeVisible();
    await afficher.click();

    // Le numéro FR apparaît (format « 0X XX XX XX XX »).
    const revealed = page.getByTestId("revealed-phone");
    await expect(revealed).toBeVisible();
    await expect(revealed).toHaveText(FR_DISPLAY);

    // Warning opt-out : le contact est désabonné sur CONV_ID.
    await expect(page.getByText(/arrêt des SMS/i)).toBeVisible();

    // Journal — l'entrée « Numéro affiché » apparaît après rafraîchissement
    // (le composant appelle `onAudited` → refetchKey bumpé côté client).
    await expect(page.getByText(/Numéro affiché/i)).toBeVisible();

    // Lire l'e164 depuis le DOM (pour construire le href tel: attendu).
    const displayed = (await revealed.textContent())?.trim() ?? "";
    expect(displayed).toMatch(FR_DISPLAY);
    const digits = displayed.replace(/\s/g, "");
    const expectedE164 = `+33${digits.slice(1)}`;

    // « Copier » → presse-papiers reçoit l'E.164.
    await page.getByRole("button", { name: /Copier/i }).click();
    await expect(page.getByText(/Numéro copié/i)).toBeVisible();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe(expectedE164);

    // « Appeler » → la navigation tel: est tentée. On capture l'intention
    // via un override de `window.location.href` injecté AVANT clic.
    await page.evaluate(() => {
      const hits: string[] = [];
      (window as unknown as { __telHits: string[] }).__telHits = hits;
      const original = window.location;
      Object.defineProperty(window, "location", {
        configurable: true,
        value: {
          ...original,
          set href(v: string) {
            hits.push(v);
          },
          get href() {
            return original.href;
          },
          assign: (v: string) => hits.push(v),
        },
      });
    });
    await page.getByRole("button", { name: /Appeler/i }).click();
    await expect(page.getByText(/Appel lancé/i)).toBeVisible();
    const telHits = await page.evaluate(
      () => (window as unknown as { __telHits: string[] }).__telHits ?? [],
    );
    expect(telHits.some((h) => h === `tel:${expectedE164}`)).toBe(true);
  });

  test("R2 — admin : « Afficher le numéro » fonctionne sur la même conversation", async ({
    page,
    signInAsAdmin,
  }) => {
    installApiPhoneSentinel(page);
    await signInAsAdmin();
    await page.goto(CONV_URL);

    const bodyBefore = await page.locator("body").innerText();
    assertNoFrenchPhone(bodyBefore, "DOM R2 admin avant clic reveal");

    await page.getByRole("button", { name: /Afficher le numéro/i }).click();
    const revealed = page.getByTestId("revealed-phone");
    await expect(revealed).toBeVisible();
    await expect(revealed).toHaveText(FR_DISPLAY);
  });

  test("R3 — commercial NON-titulaire : POST direct reveal-phone renvoie 403, aucun numéro dans la réponse", async ({
    page,
    signInAsCommercial,
  }) => {
    installApiPhoneSentinel(page);
    await signInAsCommercial();
    const resp = await page.request.post(
      `/api/admin/conversations/${encodeURIComponent(CONV_ID)}/reveal-phone`,
      {
        data: { method: "display" },
        headers: { "Content-Type": "application/json" },
        failOnStatusCode: false,
      },
    );
    // Soit 403 (not_mine), soit 403 via la couche logique revealContactPhone.
    expect(resp.status()).toBe(403);
    const body = await resp.text();
    // Aucun numéro dans la réponse d'erreur — sentinelle anti-leak.
    expect(body).not.toMatch(/\+33\d/);
    expect(body).not.toMatch(/0[1-9]\d{8}/);
  });

  test("R4 — compte sans rôle : accès refusé", async ({ page, signInAsNoRole }) => {
    await signInAsNoRole();
    const resp = await page.request.post(
      `/api/admin/conversations/${encodeURIComponent(CONV_ID)}/reveal-phone`,
      {
        data: { method: "display" },
        headers: { "Content-Type": "application/json" },
        failOnStatusCode: false,
      },
    );
    // 403 (claim role manquant → ForbiddenError côté requireRole).
    expect([403, 401]).toContain(resp.status());
  });

  test("R5 — admin sur /admin/contacts : réponse liste sans numéro + reveal fonctionnel sur une ligne", async ({
    page,
    signInAsAdmin,
  }) => {
    installApiPhoneSentinel(page);
    await signInAsAdmin();

    // Interception de la liste `/api/admin/contacts` pour vérifier qu'elle
    // ne contient jamais d'E.164 (invariant PR3 tour 2a, maintenu ici).
    const listSeen: string[] = [];
    page.on("response", async (resp) => {
      const url = resp.url();
      if (/\/api\/admin\/contacts(\?|$)/.test(url) && resp.request().method() === "GET") {
        listSeen.push(await resp.text());
      }
    });

    await page.goto("/admin/contacts");
    await expect(page.getByRole("heading", { name: "Contacts", level: 1 })).toBeVisible();

    // Au moins une réponse `/api/admin/contacts` a été interceptée, et
    // aucune ne contient de numéro complet.
    // (Note : `installApiPhoneSentinel` fait déjà le même check mais le
    // scope est un peu différent — ici on explicite la liste.)
    expect(listSeen.length).toBeGreaterThan(0);
    for (const body of listSeen) {
      expect(body).not.toMatch(/\+33\d/);
      expect(body).not.toMatch(/"e164"/);
    }

    // Clic « Afficher le numéro » sur la première ligne (si la table a
    // chargé au moins une ligne). On cible via le rôle `row` TanStack
    // Table. S'il n'y a pas de ligne, on skip proprement.
    const afficherBtns = page.getByRole("button", { name: /Afficher le numéro/i });
    const btnCount = await afficherBtns.count();
    test.skip(btnCount === 0, "Aucune ligne contact sur /admin/contacts — R5 non applicable");
    await afficherBtns.first().click();
    const revealedTestIds = page.getByTestId("revealed-phone");
    await expect(revealedTestIds.first()).toHaveText(FR_DISPLAY);
  });

  test("R6 — commercial titulaire sur route /api/admin/contacts/[id]/reveal-phone : 403", async ({
    page,
    signInAsCommercialOwner,
  }) => {
    installApiPhoneSentinel(page);
    await signInAsCommercialOwner();
    const resp = await page.request.post(
      `/api/admin/contacts/${encodeURIComponent(CONTACT_ID)}/reveal-phone`,
      {
        data: { method: "display" },
        headers: { "Content-Type": "application/json" },
        failOnStatusCode: false,
      },
    );
    // La route exige `requireRole("admin")` → un commercial reçoit 403.
    expect(resp.status()).toBe(403);
    const body = await resp.text();
    expect(body).not.toMatch(/\+33\d/);
  });
});
