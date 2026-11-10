import { describe, expect, it } from "vitest";

import { clerkFrontendApiFromPublishableKey } from "./clerk-frontend-api";
import { buildCspDirectives } from "./csp";

const PROD_KEY = "pk_live_Y2xlcmsucHJvc3BlY3Rpb24ubWVkZXJlLmZyJA";
const DEV_KEY = "pk_test_bmV3LWxhbXByZXktMTcuY2xlcmsuYWNjb3VudHMuZGV2JA";

/**
 * Joint les directives comme `next.config.ts` le fera pour le header.
 */
function cspFor(publishableKey: string, isDev: boolean): string {
  return buildCspDirectives({
    clerkFrontendApi: clerkFrontendApiFromPublishableKey(publishableKey),
    isDev,
  }).join("; ");
}

describe("buildCspDirectives — instance prod", () => {
  it("script-src contient l'hôte FAPI prod EXACT", () => {
    expect(cspFor(PROD_KEY, false)).toMatch(
      /script-src[^;]*https:\/\/clerk\.prospection\.medere\.fr/,
    );
  });

  it("connect-src contient FAPI https + wss + protect.clerk.com:*", () => {
    const csp = cspFor(PROD_KEY, false);
    expect(csp).toMatch(/connect-src[^;]*https:\/\/clerk\.prospection\.medere\.fr/);
    expect(csp).toMatch(/connect-src[^;]*wss:\/\/clerk\.prospection\.medere\.fr/);
    expect(csp).toMatch(/connect-src[^;]*https:\/\/\*\.protect\.clerk\.com:\*/);
  });

  it("img-src contient img.clerk.com (exigence doc Clerk)", () => {
    expect(cspFor(PROD_KEY, false)).toMatch(/img-src[^;]*https:\/\/img\.clerk\.com/);
  });

  it("frame-src contient FAPI + protect.clerk.com (doc Clerk)", () => {
    const csp = cspFor(PROD_KEY, false);
    expect(csp).toMatch(/frame-src[^;]*https:\/\/clerk\.prospection\.medere\.fr/);
    expect(csp).toMatch(/frame-src[^;]*https:\/\/\*\.protect\.clerk\.com\b/);
  });

  it("upgrade-insecure-requests présent (prod)", () => {
    expect(cspFor(PROD_KEY, false)).toContain("upgrade-insecure-requests");
  });
});

describe("buildCspDirectives — instance dev", () => {
  it("script-src contient l'hôte FAPI dev EXACT", () => {
    expect(cspFor(DEV_KEY, true)).toMatch(
      /script-src[^;]*https:\/\/new-lamprey-17\.clerk\.accounts\.dev/,
    );
  });

  it("'unsafe-eval' présent en dev uniquement", () => {
    expect(cspFor(DEV_KEY, true)).toContain("'unsafe-eval'");
    expect(cspFor(DEV_KEY, false)).not.toContain("'unsafe-eval'");
  });

  it("HMR ws://localhost ajouté en dev", () => {
    expect(cspFor(DEV_KEY, true)).toContain("ws://localhost:*");
    expect(cspFor(DEV_KEY, false)).not.toContain("ws://localhost");
  });
});

describe("buildCspDirectives — ANTI-RÉGRESSION joker clerk.accounts.dev", () => {
  it("prod : jamais de joker `*.clerk.accounts.dev` ni `*.clerk.` arbitraire", () => {
    const csp = cspFor(PROD_KEY, false);
    // Sentinelles anti-régression. Si next.config.ts ou csp.ts réintroduit le
    // joker `https://*.clerk.accounts.dev` (ou équivalent), ces assertions
    // tombent.
    expect(csp).not.toMatch(/\*\.clerk\.accounts\.dev/);
    expect(csp).not.toMatch(/wss:\/\/\*\.clerk\./);
    // Seul joker Clerk autorisé : `*.protect.clerk.com` (recommandation
    // officielle Clerk pour l'anti-abuse). Toute autre forme `https://*.clerk.…`
    // serait un bug.
    const otherClerkWildcard = csp.match(/https:\/\/\*\.clerk\.(?!accounts\.dev)[^\s;]+/g);
    expect(otherClerkWildcard).toBeNull();
  });

  it("dev : jamais de joker `*.clerk.accounts.dev` (même instance de dev → host EXACT)", () => {
    const csp = cspFor(DEV_KEY, true);
    expect(csp).not.toMatch(/\*\.clerk\.accounts\.dev/);
    expect(csp).not.toMatch(/wss:\/\/\*\.clerk\./);
  });
});
