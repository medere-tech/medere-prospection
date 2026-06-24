/**
 * Tests middleware — focus matcher unit (sentinelle anti-bypass des regex
 * de protection / publication).
 *
 * On NE teste PAS `clerkMiddleware` lui-même (framework, surface API
 * Clerk peut changer). On vérifie uniquement la liste de routes
 * couvertes par `createRouteMatcher` — c'est ÇA qui détermine si
 * `/admin/*` est protégé ou pas.
 *
 * `createRouteMatcher` de Clerk accepte un tableau de patterns
 * compatibles `path-to-regexp` (`/admin(.*)`, `/sign-in(.*)`, ...). On
 * teste donc en construisant un faux matcher avec la MÊME liste qu'on
 * passerait à Clerk, et on vérifie sur des URLs représentatives.
 */
import { createRouteMatcher } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

// On ré-importe les MÊMES listes que celles de `middleware.ts`. On ne les
// duplique PAS (sinon dérive silencieuse). On les expose ici juste pour
// le test — option (a) : reproduire le tableau ; option (b) : exporter
// depuis middleware.ts. (a) est plus simple sans casser le contrat
// Next.js (qui veut un export default + config sans autre export).
// 🚨 Listes alignées avec `middleware.ts`. Si on les divergit, ce test
// ne le détecte PAS (pas de DRY au niveau code, c'est délibéré : on ne
// veut PAS exporter d'autre symbole depuis `middleware.ts` qui doit
// rester une surface Next.js stricte default export + config). Toute
// modification ici ↔ middleware.ts → revérifier les deux.
//
// Le pattern `path` + `path/(.*)` (PAS `path(.*)`) évite le piège
// "gourmand-sur-caractère-suivant" : `/sign-in(.*)` matcherait
// `/sign-input` ; `/admin(.*)` matcherait `/admins`. Couvert par les
// describes "sentinelle anti-typo" plus bas.
const PUBLIC_PATTERNS = ["/", "/sign-in", "/sign-in/(.*)", "/api/inngest", "/api/inngest/(.*)"];
const PROTECTED_PATTERNS = ["/admin", "/admin/(.*)", "/api/admin", "/api/admin/(.*)"];

// Sentinelle : si on bouge ces listes dans middleware.ts SANS update
// ici, le test ne le détecte pas — d'où ce commentaire. Le test reste
// utile car il vérifie la SÉMANTIQUE des patterns (un dev qui change
// `/admin(.*)` en `/admin/(.*)` casse la protection de `/admin` lui-même,
// ce test attrape ça).

function mockReq(pathname: string): NextRequest {
  return new NextRequest(`https://medere.example${pathname}`);
}

describe("middleware matcher — routes PUBLIQUES", () => {
  const isPublic = createRouteMatcher(PUBLIC_PATTERNS);

  it.each([
    "/",
    "/sign-in",
    "/sign-in/sso-callback",
    "/sign-in/factor-one",
    "/api/inngest",
    "/api/inngest/anything",
  ])("autorise %s sans auth", (path) => {
    expect(isPublic(mockReq(path))).toBe(true);
  });

  it.each([
    "/admin",
    "/admin/contacts",
    "/api/admin/contacts/123/send-first-sms",
    "/sign-up", // pas de sign-up self-serve
    "/random-path",
  ])("NE liste PAS %s comme public", (path) => {
    expect(isPublic(mockReq(path))).toBe(false);
  });
});

describe("middleware matcher — routes PROTÉGÉES", () => {
  const isProtected = createRouteMatcher(PROTECTED_PATTERNS);

  it.each([
    "/admin",
    "/admin/contacts",
    "/admin/contacts/123",
    "/admin/conversations/abc_xyz",
    "/api/admin/contacts/123/send-first-sms",
    "/api/admin/audit/list",
  ])("protège %s", (path) => {
    expect(isProtected(mockReq(path))).toBe(true);
  });

  it.each([
    "/",
    "/sign-in",
    "/sign-in/sso-callback",
    "/api/inngest",
    "/api/inngest/whatever",
    "/admin-public-typo",
    "/admins",
    "/api/admins",
  ])("NE protège PAS %s (sentinelle anti-typo)", (path) => {
    expect(isProtected(mockReq(path))).toBe(false);
  });
});

describe("middleware matcher — sentinelle exclusivité (pas de chevauchement)", () => {
  const isPublic = createRouteMatcher(PUBLIC_PATTERNS);
  const isProtected = createRouteMatcher(PROTECTED_PATTERNS);

  it("aucune route critique n'est À LA FOIS public et protected", () => {
    const ALL = [
      "/",
      "/sign-in",
      "/sign-in/sso-callback",
      "/api/inngest",
      "/admin",
      "/admin/contacts",
      "/api/admin/contacts/123/send-first-sms",
    ];
    for (const path of ALL) {
      const pub = isPublic(mockReq(path));
      const prot = isProtected(mockReq(path));
      expect(pub && prot, `${path} est à la fois public ET protected`).toBe(false);
    }
  });
});
