/**
 * Scénario S10 PR1.14.2 — page de refus propre `src/app/forbidden.tsx`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Compte utilisé : `e2e-no-role+clerk_test@...`
 *
 *   publicMetadata = { testAccount: true } — pas de role, pas de slackUserId.
 *   → `requireRole("commercial")` du layout `/admin` throw `ForbiddenError`
 *     → le layout catch et appelle `forbidden()` depuis `next/navigation`
 *     → Next.js remonte au segment parent et rend `src/app/forbidden.tsx`
 *       (pas `src/app/admin/forbidden.tsx` qui est au même niveau que le
 *       layout qui a thrown — cf. convention Next 16).
 *     → Statut HTTP 403.
 *
 * Contrat vérifié :
 *   - Statut HTTP 403 (vrai code — pas 200 avec composant 403, pas 500 brut)
 *   - Texte EXACT : "Votre rôle n'est pas encore configuré. Contactez l'administrateur."
 *   - Bouton "Se déconnecter" visible (SignOutButton Clerk)
 *   - Aucun bouton "Réessayer" (contrat Déthié)
 *   - Aucun contenu de conversation dans le DOM (pas de MessageThread,
 *     pas de header contact)
 *   - Aucun appel réseau vers `/api/admin/conversations/*` (le layout
 *     throw AVANT que la page conversation ne monte)
 *
 * Prérequis : `scripts/setup-e2e-clerk-users.mjs --apply` doit avoir
 * provisionné `e2e-no-role`. Sans ce compte, S10 est skippé avec un
 * message explicite.
 */
import { assertNoFrenchPhone, CONV_ID_ADMIN_NON_OWNER, expect, test } from "./fixtures";

const ADMIN_API_CALLS_RE = /\/api\/admin\/(conversations|contacts|campaigns)/;

test.describe("S10 — page de refus propre pour user sans role", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Firefox/Webkit non visés PR1.14");

  test("S10a — e2e-no-role sur /admin/contacts : 403, texte exact, Se déconnecter, zéro Réessayer, zéro appel API admin", async ({
    page,
    signInAsNoRole,
  }) => {
    const adminApiCalls: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (ADMIN_API_CALLS_RE.test(url)) adminApiCalls.push(url);
    });

    await signInAsNoRole();
    const resp = await page.goto("/admin/contacts");
    expect(resp?.status(), "GET /admin/contacts doit renvoyer 403").toBe(403);

    // Texte EXACT (match sous-chaîne pour tolérer les apostrophes typographiques).
    await expect(page.getByRole("heading", { name: "Accès refusé", level: 1 })).toBeVisible();
    await expect(
      page.getByText("Votre rôle n'est pas encore configuré. Contactez l'administrateur."),
    ).toBeVisible();

    // Bouton déconnexion
    await expect(page.getByRole("button", { name: "Se déconnecter" })).toBeVisible();

    // AUCUN « Réessayer »
    await expect(page.getByRole("button", { name: /Réessayer/i })).toHaveCount(0);

    // Aucun contenu admin : pas de MessageThread, pas de table contacts.
    await expect(page.getByRole("log")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Contacts", level: 1 })).toHaveCount(0);

    // Aucun appel réseau vers l'API admin : le layout throw AVANT que
    // les data-fetching enfants ne montent.
    expect(
      adminApiCalls,
      `Appels /api/admin/* interdits sur la page forbidden : ${adminApiCalls.join(" | ")}`,
    ).toEqual([]);
  });

  test("S10b — e2e-no-role sur /admin/conversations/A : 403 + zéro contenu conversation + zéro numéro FR", async ({
    page,
    signInAsNoRole,
  }) => {
    test.skip(
      !CONV_ID_ADMIN_NON_OWNER,
      "E2E_CONV_ID_FOR_ADMIN_NON_OWNER non fourni — scénario S10b ignoré",
    );

    const adminApiCalls: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (ADMIN_API_CALLS_RE.test(url)) adminApiCalls.push(url);
    });

    await signInAsNoRole();
    const resp = await page.goto(`/admin/conversations/${CONV_ID_ADMIN_NON_OWNER}`);
    expect(resp?.status()).toBe(403);

    await expect(page.getByRole("heading", { name: "Accès refusé", level: 1 })).toBeVisible();
    await expect(
      page.getByText("Votre rôle n'est pas encore configuré. Contactez l'administrateur."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Se déconnecter" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Réessayer/i })).toHaveCount(0);

    // Aucun contenu de conversation DOM : pas de MessageThread (role=log),
    // pas de bannière admin, pas de titre conversation.
    await expect(page.getByRole("log")).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: /Mode admin/ })).toHaveCount(0);

    // Aucun appel API admin
    expect(adminApiCalls).toEqual([]);

    // Zéro numéro FR dans le DOM (sentinelle PII globale)
    const bodyText = await page.locator("body").innerText();
    assertNoFrenchPhone(bodyText, "DOM S10b forbidden page");
  });
});
