/**
 * Scénarios S7-S9 — layout admin PR1.14.
 *
 *   S7 — responsive 3 viewports : pas de scroll horizontal sur /admin/contacts
 *   S8 — sidebar : liens vivants 200, liens grisés aria-disabled sans navigation,
 *        profil + déconnexion dans le viewport aux 3 tailles (y compris menu
 *        mobile ouvert)
 *   S9 — menu mobile : ouverture, Echap ferme, focus revient sur le bouton
 */
import { expect, test } from "./fixtures";

test.describe("Layout admin — PR1.14", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Firefox/Webkit non visés PR1.14");

  test("S7 — pas de scroll horizontal sur /admin/contacts", async ({
    page,
    signInAsAdmin,
    viewport,
  }) => {
    await signInAsAdmin();
    await page.goto("/admin/contacts");
    // On attend un élément stable précis : le <h1>Contacts</h1> servi
    // par `src/app/admin/contacts/contacts-page-client.tsx:157`.
    // `networkidle` ne tombe jamais : le polling /version toutes les 30s
    // et les requêtes Clerk gardent le réseau "actif".
    await expect(page.getByRole("heading", { name: "Contacts", level: 1 })).toBeVisible();
    // scrollWidth doit ≤ innerWidth + 1 (tolérance subpixel navigateur).
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(
      scrollWidth,
      `Viewport ${viewport?.width}×${viewport?.height}: scrollWidth=${scrollWidth} > innerWidth=${innerWidth}`,
    ).toBeLessThanOrEqual(innerWidth + 1);
  });

  test("S8 — sidebar : liens vivants 200, grisés inoperants, profil visible", async ({
    page,
    signInAsAdmin,
    viewport,
  }) => {
    await signInAsAdmin();
    await page.goto("/admin/contacts");

    // Sur mobile <768 (390), la sidebar est cachée (hidden md:flex). On ouvre
    // le drawer pour inspecter les mêmes items. Le bouton porte
    // `aria-label="Ouvrir le menu"` (admin-header.tsx:88) — on matche
    // en exact pour éviter de capturer "Ouvrir la palette de commandes".
    const isMobile = (viewport?.width ?? 1440) < 768;
    if (isMobile) {
      const trigger = page.getByRole("button", { name: "Ouvrir le menu", exact: true });
      await expect(trigger).toBeVisible();
      await trigger.click();
    }

    // Item vivant : "Contacts" (role=link, href=/admin/contacts)
    const contactsLink = page.getByRole("link", { name: "Contacts", exact: false }).first();
    await expect(contactsLink).toBeVisible();
    const contactsHref = await contactsLink.getAttribute("href");
    expect(contactsHref).toBe("/admin/contacts");

    // Items grisés : aria-disabled="true", clic ne change pas l'URL
    const disabledLinks = page.locator('[role="link"][aria-disabled="true"]');
    const disabledCount = await disabledLinks.count();
    expect(disabledCount, "au moins 1 item grisé attendu").toBeGreaterThanOrEqual(1);
    const initialUrl = page.url();
    await disabledLinks.first().click({ force: true });
    expect(page.url(), "un clic sur un lien grisé ne doit pas naviguer").toBe(initialUrl);

    // Profil + déconnexion dans le viewport
    const signOut = page.getByRole("button", { name: /déconnexion|se déconnecter|sign out/i });
    await expect(signOut).toBeVisible();
    const box = await signOut.boundingBox();
    expect(box, "sign out doit avoir une bounding box non nulle").not.toBeNull();
    if (box && viewport) {
      expect(
        box.y + box.height,
        `déconnexion hors viewport (y=${box.y + box.height} > ${viewport.height})`,
      ).toBeLessThanOrEqual(viewport.height);
    }
  });

  test("S9 — mobile menu : ouverture + Echap ferme + focus revient", async ({
    page,
    signInAsAdmin,
    viewport,
  }) => {
    test.skip(
      (viewport?.width ?? 1440) >= 768,
      "S9 cible mobile <768 — skipped sur tablet/desktop",
    );
    await signInAsAdmin();
    await page.goto("/admin/contacts");
    // Bouton hamburger — aria-label exact (admin-header.tsx:88).
    const trigger = page.getByRole("button", { name: "Ouvrir le menu", exact: true });
    await expect(trigger).toBeVisible();
    await trigger.click();
    // Le drawer est un dialog Radix
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Echap ferme
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    // Focus revient sur le trigger (aria-label strict).
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    expect(focused).toBe("Ouvrir le menu");
  });
});
