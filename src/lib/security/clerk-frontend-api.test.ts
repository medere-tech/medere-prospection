import { describe, expect, it } from "vitest";

import { ClerkFrontendApiError, clerkFrontendApiFromPublishableKey } from "./clerk-frontend-api";

/**
 * Clés utilisées dans ces tests :
 *   - pk_live_Y2xlcmsucHJvc3BlY3Rpb24ubWVkZXJlLmZyJA
 *       = base64("clerk.prospection.medere.fr$") → instance prod
 *   - pk_test_bmV3LWxhbXByZXktMTcuY2xlcmsuYWNjb3VudHMuZGV2JA
 *       = base64("new-lamprey-17.clerk.accounts.dev$") → instance dev
 *
 * Elles figurent dans la consigne de la PR et sont les valeurs réelles
 * posées dans l'env Vercel (prod) et dans `.env.local` (dev). Pas de
 * secret : une publishable key est publique par conception.
 */
const PROD_KEY = "pk_live_Y2xlcmsucHJvc3BlY3Rpb24ubWVkZXJlLmZyJA";
const DEV_KEY = "pk_test_bmV3LWxhbXByZXktMTcuY2xlcmsuYWNjb3VudHMuZGV2JA";

describe("clerkFrontendApiFromPublishableKey", () => {
  it("clé prod → FQDN prod exact (pas de joker)", () => {
    expect(clerkFrontendApiFromPublishableKey(PROD_KEY)).toBe("clerk.prospection.medere.fr");
  });

  it("clé dev → FQDN dev exact (pas de joker)", () => {
    expect(clerkFrontendApiFromPublishableKey(DEV_KEY)).toBe("new-lamprey-17.clerk.accounts.dev");
  });

  it("clé undefined → throw ClerkFrontendApiError", () => {
    expect(() => clerkFrontendApiFromPublishableKey(undefined)).toThrow(ClerkFrontendApiError);
  });

  it("clé vide → throw ClerkFrontendApiError", () => {
    expect(() => clerkFrontendApiFromPublishableKey("")).toThrow(ClerkFrontendApiError);
  });

  it("clé sans préfixe pk_(test|live)_ → throw", () => {
    expect(() => clerkFrontendApiFromPublishableKey("not-a-clerk-key")).toThrow(
      ClerkFrontendApiError,
    );
  });

  it("clé avec base64 malformé → throw", () => {
    expect(() => clerkFrontendApiFromPublishableKey("pk_live_@@@")).toThrow(ClerkFrontendApiError);
  });

  it("clé qui décode en hostname avec joker → refusée côté app (second filet)", () => {
    // base64("*.evil.com$") — @clerk/shared/parsePublishableKey ne filtre pas
    // les jokers côté host décodé (sondé 2026-11-10). Notre fonction DOIT
    // refuser, sinon la CSP du projet autoriserait `https://*.evil.com`.
    const wildcardKey = "pk_live_" + Buffer.from("*.evil.com$").toString("base64");
    expect(() => clerkFrontendApiFromPublishableKey(wildcardKey)).toThrow(/strict DNS hostname/);
  });

  it("clé qui décode en label unique sans point → throw (via parsePublishableKey)", () => {
    const singleLabelKey = "pk_live_" + Buffer.from("localhost$").toString("base64");
    expect(() => clerkFrontendApiFromPublishableKey(singleLabelKey)).toThrow(ClerkFrontendApiError);
  });

  it("ne fait JAMAIS de fallback silencieux (preuve : jamais de retour sur erreur)", () => {
    // Ceinture + bretelles : on verrouille le fait qu'aucune branche ne
    // retourne un host de secours sur erreur. Toute erreur est propagée.
    const cases: Array<string | undefined> = [undefined, "", "pk_bogus_xxx", "pk_live_@@@"];
    for (const k of cases) {
      expect(() => clerkFrontendApiFromPublishableKey(k)).toThrow();
    }
  });
});
