// @vitest-environment node

/**
 * Tests unitaires de la règle d'exemption du sentinel réseau (PR3 tour 2b).
 *
 * `isPhoneSentinelExempt(method, url)` est une fonction pure extraite de
 * `installApiPhoneSentinel` pour être verrouillée :
 *
 *   - POST .../reveal-phone (conv ou contact) → exempté (contrat produit).
 *   - GET  .../reveal-phone → NON exempté (si un jour l'endpoint devient
 *     GET par erreur, le scan le fouette toujours).
 *   - POST /api/admin/contacts (liste, sans reveal-phone) → NON exempté.
 *   - GET  /api/admin/conversations/[id]/version → NON exempté.
 *   - URL hors scope `/api/admin/(conv|contacts)/` → le sentinel ne
 *     s'applique pas (laisse passer, mais pour une autre raison).
 */
import { describe, expect, it } from "vitest";

import { isPhoneSentinelExempt } from "./e2e/fixtures";

describe("isPhoneSentinelExempt — règle d'exemption du sentinel PR3 tour 2b", () => {
  it("POST /api/admin/conversations/[id]/reveal-phone → EXEMPTÉ (contrat produit)", () => {
    expect(
      isPhoneSentinelExempt(
        "POST",
        "https://x.vercel.app/api/admin/conversations/abc/reveal-phone",
      ),
    ).toBe(true);
  });

  it("POST /api/admin/contacts/[id]/reveal-phone → EXEMPTÉ (contrat produit)", () => {
    expect(
      isPhoneSentinelExempt("POST", "https://x.vercel.app/api/admin/contacts/hs_42/reveal-phone"),
    ).toBe(true);
  });

  it("POST .../reveal-phone?foo=bar → EXEMPTÉ (query string tolérée)", () => {
    expect(
      isPhoneSentinelExempt(
        "POST",
        "https://x.vercel.app/api/admin/contacts/hs_42/reveal-phone?dry=1",
      ),
    ).toBe(true);
  });

  it("GET /api/admin/conversations/[id]/reveal-phone → NON exempté (seul POST a le contrat)", () => {
    expect(
      isPhoneSentinelExempt("GET", "https://x.vercel.app/api/admin/conversations/abc/reveal-phone"),
    ).toBe(false);
  });

  it("POST /api/admin/contacts (liste) → NON exempté", () => {
    expect(isPhoneSentinelExempt("POST", "https://x.vercel.app/api/admin/contacts")).toBe(false);
  });

  it("GET /api/admin/conversations/[id] (détail) → NON exempté", () => {
    expect(isPhoneSentinelExempt("GET", "https://x.vercel.app/api/admin/conversations/abc")).toBe(
      false,
    );
  });

  it("GET /api/admin/conversations/[id]/version → NON exempté (poll)", () => {
    expect(
      isPhoneSentinelExempt("GET", "https://x.vercel.app/api/admin/conversations/abc/version"),
    ).toBe(false);
  });

  it("GET /api/admin/contacts?cursor=xyz → NON exempté (liste paginée)", () => {
    expect(isPhoneSentinelExempt("GET", "https://x.vercel.app/api/admin/contacts?cursor=xyz")).toBe(
      false,
    );
  });

  it("POST /api/admin/preview-first-sms → hors scope sentinel (laissé passer avant application)", () => {
    // Note : le sentinel ne scanne que `/api/admin/(conversations|contacts)/`.
    // Un `preview-first-sms` passe son chemin par `return true` (hors scope),
    // ce n'est PAS une exemption au sens contrat reveal-phone mais un
    // désintérêt du listener. C'est OK produit : la sanitize serveur
    // garantit déjà qu'il ne fuite rien.
    expect(isPhoneSentinelExempt("POST", "https://x.vercel.app/api/admin/preview-first-sms")).toBe(
      true,
    );
  });

  it("POST /api/webhooks/ovh-sms → hors scope sentinel", () => {
    expect(isPhoneSentinelExempt("POST", "https://x.vercel.app/api/webhooks/ovh-sms")).toBe(true);
  });

  it("mutation testing — si la règle devenait `always exempt`, ce test tombe", () => {
    // Ce test consomme la règle réelle : si quelqu'un remplace la fonction
    // par `return true;`, les assertions `NON exempté` ci-dessus tombent
    // immédiatement — 4 tests rouges qui pointent la faille.
    expect(
      isPhoneSentinelExempt("GET", "https://x.vercel.app/api/admin/conversations/abc/version"),
    ).toBe(false);
  });
});
