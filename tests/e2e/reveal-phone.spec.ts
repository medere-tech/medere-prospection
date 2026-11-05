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
 *   tablet-768 / desktop-1440). Pour un compte `testAccount: true`
 *   (`e2e-commercial-owner`, `e2e-admin`), le journal n'est PAS filtré :
 *   on voit nos propres clics apparaître (canal de debug — PR3 tour 2b).
 *
 * Invariants vérifiés
 *
 *   - R1 commercial titulaire : masqué avant clic (sentinelles DOM +
 *     réseau), numéro FR + warning opt-out après clic, copie →
 *     presse-papiers, appel audité (preuve par la réponse réseau du POST
 *     `method: "call"` statut 200 — l'intention `tel:…` est prouvée par
 *     le test unitaire du composant, cf. ci-dessous). Journal : LA
 *     PLUS RÉCENTE entrée après chaque clic porte le libellé attendu
 *     (`E2E CommercialOwner — <libellé>`). `getByText` global est
 *     PROSCRIT — le journal est append-only donc l'historique accumule
 *     plusieurs entrées identiques au fil des runs.
 *   - R2 admin : affichage fonctionne idem.
 *   - R3 commercial non-titulaire : POST direct 403, aucun numéro dans
 *     la réponse (défense RBAC serveur).
 *   - R4 compte sans rôle : page refusée, pas d'accès.
 *   - R5 admin /admin/contacts : la réponse de `/api/admin/contacts` ne
 *     contient aucun numéro ni clef `e164`. On attend EXPLICITEMENT la
 *     réponse réseau AVANT d'asserter — le h1 "Contacts" est statique
 *     et rendu avant que le fetch ne résolve.
 *   - R6 commercial sur route contacts : POST direct 403.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Filtrage des entrées test pour les comptes réels
 *
 *   Chaque action admin produit un audit réel en base.
 *   `appendAuditLog` écrit maintenant `actorTestAccount: boolean`
 *   top-level (PR3 tour 2b bis ter), dérivé du claim Clerk
 *   `publicMetadata.testAccount`. Le journal rendu dans la vue
 *   conversation filtre `where actorTestAccount == false` quand le
 *   viewer est un vrai utilisateur (cf.
 *   `src/lib/conversations/load-conversation-detail.ts:140`), et
 *   `sanitizeAuditEntriesForJournal` conserve ce filtre en défense
 *   en profondeur côté UI (cf.
 *   `src/components/conversations/sanitize.ts:315-320`). Les entrées
 *   des comptes e2e restent donc invisibles pour un admin réel ET
 *   pleinement visibles pour un compte testAccount (canal de debug).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Régression des sentinelles « zéro numéro » existantes
 *
 *   Les specs suivantes continuent de vérifier qu'AUCUN numéro n'apparaît
 *   dans leur scope (via `assertNoFrenchPhone` sur le DOM et
 *   `installApiPhoneSentinel` sur les réponses API) :
 *
 *     - `conversation-detail.spec.ts` S2, S3, S5 : vue conversation
 *       ouverte SANS clic reveal → la payload RSC + `/version` +
 *       `/detail` ne contiennent jamais d'E.164 (strippés par
 *       `sanitize.ts`).
 *     - `conversations-list.spec.ts`, `orphan-inbounds.spec.ts`,
 *       `polling.spec.ts`, `layout.spec.ts`, `forbidden.spec.ts` :
 *       aucune de ces routes ne fait transiter d'E.164 côté client.
 *
 *   L'exemption du sentinel est STRICTEMENT limitée aux réponses de
 *   `POST .../reveal-phone` (cf.
 *   `fixtures.ts::installApiPhoneSentinel` + fonction pure
 *   `isPhoneSentinelExempt`) — toute autre route qui fuite un numéro
 *   casse immédiatement l'une de ces specs.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Preuve de l'intention `tel:…`
 *
 *   `Object.defineProperty(window, "location", ...)` lève sous Chromium
 *   `TypeError: Cannot redefine property: location`. On NE patche PAS
 *   `window.location` côté E2E. L'intention « ouvrir le téléphone » est
 *   prouvée en DEUX endroits indépendants :
 *
 *     - Côté E2E : la réponse 200 du `POST .../reveal-phone` avec le
 *       body `{"method":"call"}` prouve que l'action côté serveur a été
 *       tentée ET auditée dans le bon ordre (audit avant clipboard/tel:
 *       — cf. JSDoc du composant). Sans cette réponse, le composant ne
 *       peut pas atteindre la ligne `window.location.href = …`
 *       (`src/components/conversations/reveal-phone-action.tsx:154`).
 *     - Côté unit : `reveal-phone-action.test.tsx:246-258` vérifie que
 *       `window.location.href = tel:+33612345678` est appelé APRÈS un
 *       POST `call` réussi, avec l'href EXACT attendu
 *       (`locationAssignMock.toHaveBeenCalledWith("tel:+33612345678")`).
 *       Si on supprime cette ligne du composant, ce test tombe
 *       immédiatement.
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

    // ── Helpers ───────────────────────────────────────────────────────
    /**
     * Attend UN POST `/reveal-phone` dont le body JSON contient
     * `method: <m>`. Le prédicat ne filtre PAS sur le statut : un 403,
     * 429 ou 500 doit passer le prédicat pour que l'`expect(...)` qui
     * suit affiche le vrai statut au lieu d'un dépassement de délai.
     * À POSER AVANT le clic qui l'émet.
     */
    const waitReveal = (m: "display" | "copy" | "call") =>
      page.waitForResponse((resp) => {
        if (resp.request().method() !== "POST") return false;
        if (!/\/reveal-phone(?:$|\?|#)/.test(resp.url())) return false;
        const data = resp.request().postData();
        if (data === null) return false;
        try {
          return (JSON.parse(data) as { method?: string }).method === m;
        } catch {
          return false;
        }
      });

    /**
     * Attend UN GET `/api/admin/conversations/{id}` (le DÉTAIL, pas
     * `/version`, pas `/reveal-phone`) — c'est le refetch déclenché
     * par `onAudited` → `setRefetchKey(k=>k+1)`. Même discipline que
     * `waitReveal` : pas de filtre statut dans le prédicat, la
     * vérification `expect(...status()).toBe(200)` placée après est
     * la vraie assertion.
     *
     * Preuves fichier:ligne :
     *   - `src/app/admin/conversations/[id]/conversation-detail-client.tsx:225`
     *     → `onAudited={() => setRefetchKey((k) => k + 1)}` passé au header.
     *   - `src/app/admin/conversations/[id]/conversation-detail-client.tsx:167-183`
     *     → Query B avec `queryKey: [..., refetchKey]` et `queryFn` qui
     *     fetch `/api/admin/conversations/${conversationId}` (`line 170`).
     *   - `src/app/admin/conversations/[id]/conversation-detail-client.tsx:180`
     *     → `enabled: refetchKey > 0 || initialData === null` — au 1er
     *     bump, React Query détecte le nouveau `queryKey` et déclenche
     *     `queryFn`.
     *
     * La regex exclut `/version` (poll indépendant) et `/reveal-phone`
     * (POST déjà couvert par `waitReveal`). Match UNIQUEMENT la forme
     * `/api/admin/conversations/<id>` suivie par fin de chaîne,
     * `?query`, ou `#fragment`.
     */
    const waitDetailRefresh = () =>
      page.waitForResponse((resp) => {
        if (resp.request().method() !== "GET") return false;
        const url = resp.url();
        if (!/\/api\/admin\/conversations\/[^/]+(?:$|\?|#)/.test(url)) return false;
        // Exclure /version et /reveal-phone qui partagent le préfixe.
        if (/\/version(?:$|\?|#)/.test(url)) return false;
        if (/\/reveal-phone(?:$|\?|#)/.test(url)) return false;
        return true;
      });

    /**
     * Cible la section « Journal » (sélecteur stable via
     * `aria-labelledby="section-journal"` — cf.
     * `src/components/conversations/conversation-side-panel.tsx:119`).
     * Les entrées sont triées `timestamp desc` par `load-conversation-detail`,
     * donc `.first()` donne la plus récente.
     */
    const journalSection = page.locator('section[aria-labelledby="section-journal"]');
    const latestEntry = journalSection.locator("ol > li").first();

    // ── Clic « Afficher le numéro » ───────────────────────────────────
    // On attend DEUX réponses pour éviter un faux positif sur une entrée
    // laissée par un run précédent : le POST reveal-phone (audit) ET le
    // GET détail (refetch déclenché par `onAudited` → le journal est
    // rafraîchi). Sans ce 2e wait, `toContainText` pourrait matcher
    // l'ancien « Numéro affiché » déjà présent dans le journal
    // append-only avant d'avoir vu le nouveau.
    const afficher = page.getByRole("button", { name: /Afficher le numéro/i });
    await expect(afficher).toBeVisible();
    const displayRespPromise = waitReveal("display");
    const displayDetailPromise = waitDetailRefresh();
    await afficher.click();
    const displayResp = await displayRespPromise;
    expect(displayResp.status()).toBe(200);
    const displayDetail = await displayDetailPromise;
    expect(displayDetail.status()).toBe(200);

    // Le numéro FR apparaît (format « 0X XX XX XX XX »).
    const revealed = page.getByTestId("revealed-phone");
    await expect(revealed).toBeVisible();
    await expect(revealed).toHaveText(FR_DISPLAY);

    // Warning opt-out : le contact est désabonné sur CONV_ID.
    await expect(page.getByText(/arrêt des SMS/i)).toBeVisible();

    // Journal — l'entrée la plus récente porte le libellé exact. Sûr
    // parce que le refetch détail (waitDetailRefresh ci-dessus) a eu
    // lieu : la 1re `<li>` reflète bien le NOUVEAU audit, pas l'ancien.
    await expect(latestEntry).toContainText("E2E CommercialOwner — Numéro affiché");

    // Lire l'e164 depuis le DOM (pour construire l'E.164 attendu copié).
    const displayed = (await revealed.textContent())?.trim() ?? "";
    expect(displayed).toMatch(FR_DISPLAY);
    const digits = displayed.replace(/\s/g, "");
    const expectedE164 = `+33${digits.slice(1)}`;

    // ── « Copier » → presse-papiers reçoit l'E.164 ────────────────────
    const copyRespPromise = waitReveal("copy");
    const copyDetailPromise = waitDetailRefresh();
    await page.getByRole("button", { name: /Copier/i }).click();
    const copyResp = await copyRespPromise;
    expect(copyResp.status()).toBe(200);
    const copyDetail = await copyDetailPromise;
    expect(copyDetail.status()).toBe(200);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe(expectedE164);
    // Journal — la plus récente entrée est maintenant « Numéro copié ».
    await expect(latestEntry).toContainText("E2E CommercialOwner — Numéro copié");

    // ── « Appeler » → audit POST call 200 ─────────────────────────────
    // On NE patche PAS `window.location` (Chromium throw sur
    // `Object.defineProperty(window, "location")`). L'intention `tel:…`
    // est prouvée par le test unitaire `reveal-phone-action.test.tsx:246-258`.
    // Ici on prouve que le POST `method: "call"` a bien été émis et a
    // renvoyé 200 — précondition exclusive pour que la ligne
    // `reveal-phone-action.tsx:154` soit atteinte.
    const callRespPromise = waitReveal("call");
    const callDetailPromise = waitDetailRefresh();
    await page.getByRole("button", { name: /Appeler/i }).click();
    const callResp = await callRespPromise;
    expect(callResp.status()).toBe(200);
    const callDetail = await callDetailPromise;
    expect(callDetail.status()).toBe(200);
    // Journal — la plus récente entrée est maintenant « Appel lancé ».
    await expect(latestEntry).toContainText("E2E CommercialOwner — Appel lancé");
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

    // Le `h1 Contacts` est STATIQUE et rendu AVANT que `fetch("/api/admin/contacts?...")`
    // ne résolve (cf. `src/app/admin/contacts/contacts-page-client.tsx:75`).
    // On pose donc `waitForResponse` AVANT `page.goto` pour synchroniser
    // l'assertion sur le VRAI payload de la liste.
    const listRespPromise = page.waitForResponse(
      (resp) =>
        resp.request().method() === "GET" && /\/api\/admin\/contacts(\?|$)/.test(resp.url()),
    );
    await page.goto("/admin/contacts");
    const listResp = await listRespPromise;
    expect(listResp.status()).toBe(200);
    const body = await listResp.text();
    // Aucun numéro FR dans la liste, aucune clef `e164` — invariant PR3 tour 2a.
    expect(body).not.toMatch(/\+33\d/);
    expect(body).not.toMatch(/"e164"/);

    // Attendre que le h1 soit visible (ne modifie pas la réponse déjà capturée).
    await expect(page.getByRole("heading", { name: "Contacts", level: 1 })).toBeVisible();

    // Décision skip-vs-click prise à partir du BODY JSON déjà lu, PAS
    // via `count()` sur le DOM (count=0 serait ambigu : table vide OU
    // React pas encore rendu, et masquerait le reveal sans échec).
    //
    // Preuves fichier:ligne :
    //   - `src/app/api/admin/contacts/route.ts:174-176` → `return
    //     NextResponse.json({ contacts: sanitizedContacts, ... }, ...)` :
    //     le champ liste s'appelle `contacts`.
    //   - `src/app/api/admin/contacts/route.ts:170` → chaque item porte
    //     `phoneLast4: hasE164 ? phone.e164.slice(-4) : null` : seuls les
    //     contacts avec un phone.e164 ont un `phoneLast4` non null → sont
    //     révélables.
    const parsed = JSON.parse(body) as {
      contacts: Array<{ phoneLast4: string | null }>;
    };
    const hasRevealableContact = parsed.contacts.some((c) => c.phoneLast4 !== null);
    test.skip(
      !hasRevealableContact,
      "Aucun contact révélable (tous les phoneLast4 sont null) — R5 non applicable",
    );

    // Il existe au moins un contact révélable → le bouton « Afficher
    // le numéro » DOIT apparaître. On attend la visibilité avant de
    // cliquer (jamais de count()/skip silencieux).
    const afficherBtns = page.getByRole("button", { name: /Afficher le numéro/i });
    await expect(afficherBtns.first()).toBeVisible();
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
