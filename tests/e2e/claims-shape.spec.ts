/**
 * Preuve PR1.14.2 — le JWT template Clerk émet bien `testAccount` avec
 * le type attendu (boolean), prouvé sur un VRAI jeton signé par Clerk.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi ce spec
 *
 *   Le claim `testAccount` est le pivot de la défense en profondeur
 *   (comptes test refusés en prod). Le fail-closed strict de
 *   `require-role.ts::SessionClaimsSchema` repose sur l'hypothèse que
 *   Clerk émet un BOOLEAN natif (pas une string). Si le template Clerk
 *   oublie les parenthèses JSON (`"{{...}}"` au lieu de `{{...}}`), Zod
 *   rejette la session → 403 silencieux pour tous les comptes test.
 *   Un test unit mocké ne détecte pas ça : il faut lire le vrai JWT.
 *
 *   On ne décode pas de données sensibles côté serveur, uniquement le
 *   payload JWT (claims structurels, pas de PII). Les tokens eux-mêmes
 *   ne sont PAS loggés ni rendus — seul le TYPE et la VALEUR du claim
 *   `testAccount` + présence/absence de `slackUserId` est affiché.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Cas « vrai utilisateur sans testAccount »
 *
 *   Non testé ici — exige un 4ᵉ compte Clerk sans `publicMetadata.testAccount`.
 *   Le comportement Zod correspondant est verrouillé par les tests unit
 *   `require-role.test.ts` (claim `null` → normalisé en `false`, claim
 *   absent → normalisé en `false`).
 */
import { expect, test } from "./fixtures";

/** Décode le payload d'un JWT base64url sans vérifier la signature. */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("JWT malformé (attendu 3 segments)");
  const payload = parts[1]!;
  const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const json = Buffer.from(padded, "base64").toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

test.describe("Shape du JWT Clerk — preuve testAccount réel", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Firefox/Webkit non visés PR1.14");

  test("S11a — e2e-admin : testAccount présent, type boolean, valeur true", async ({
    page,
    signInAsAdmin,
  }) => {
    await signInAsAdmin();
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === "__session");
    expect(session, "cookie __session absent — signin Clerk cassé").toBeTruthy();
    const claims = decodeJwtPayload(session!.value);

    // Log structurel SANS fuite PII : on affiche type et valeur de
    // testAccount + slackUserId uniquement. firstName/lastName/role ne
    // sont pas affichés même en test.
    console.log(
      `S11a e2e-admin claims shape : testAccount={type:${typeof claims["testAccount"]}, value:${JSON.stringify(claims["testAccount"])}}, slackUserId={type:${typeof claims["slackUserId"]}, value:${JSON.stringify(claims["slackUserId"])}}`,
    );

    expect(typeof claims["testAccount"]).toBe("boolean");
    expect(claims["testAccount"]).toBe(true);
    // L'admin e2e n'a PAS de slackUserId → Clerk émet null (preuve FAIT 1).
    expect(claims["slackUserId"]).toBeNull();
  });

  test("S11b — e2e-commercial-owner : testAccount boolean true + slackUserId présent", async ({
    page,
    signInAsCommercialOwner,
  }) => {
    await signInAsCommercialOwner();
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === "__session");
    expect(session).toBeTruthy();
    const claims = decodeJwtPayload(session!.value);

    console.log(
      `S11b e2e-commercial-owner claims shape : testAccount={type:${typeof claims["testAccount"]}, value:${JSON.stringify(claims["testAccount"])}}, slackUserId_type=${typeof claims["slackUserId"]}, slackUserId_present=${claims["slackUserId"] !== null && claims["slackUserId"] !== undefined}`,
    );

    expect(typeof claims["testAccount"]).toBe("boolean");
    expect(claims["testAccount"]).toBe(true);
    // Owner → slackUserId présent (string, format Slack `U...`).
    expect(typeof claims["slackUserId"]).toBe("string");
    expect(claims["slackUserId"]).toMatch(/^U[A-Z0-9]+$/);
  });
});
