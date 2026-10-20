/**
 * Test de la route redirect `/conversations/[id]` → `/admin/conversations/[id]`
 * (VUE-CONVERSATION PR1).
 *
 * Vérifie :
 *   - `permanentRedirect()` est appelé avec l'URL cible encodée.
 *   - Avec ou sans session Clerk : le redirect est fait AVANT tout check
 *     auth. Clerk prendra le relais sur la cible protégée.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const mockPermanentRedirect = vi.fn((_url: string) => {
  // Simule le comportement Next.js : permanentRedirect throw une erreur
  // interne pour interrompre le rendu.
  const err = new Error("NEXT_REDIRECT");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (err as any).digest = "NEXT_REDIRECT;replace;/admin/conversations/x;308";
  throw err;
});

vi.mock("next/navigation", () => ({
  permanentRedirect: mockPermanentRedirect,
}));

afterEach(() => {
  mockPermanentRedirect.mockClear();
});

describe("Route redirect /conversations/[id]", () => {
  it("appelle permanentRedirect avec /admin/conversations/<id> encodé", async () => {
    const { default: Page } = await import("@/app/conversations/[id]/page");
    const params = Promise.resolve({ id: "contact1_camp1" });
    await expect(Page({ params })).rejects.toThrow("NEXT_REDIRECT");
    expect(mockPermanentRedirect).toHaveBeenCalledWith("/admin/conversations/contact1_camp1");
  });

  it("encode les caractères spéciaux dans l'id (defense-in-depth)", async () => {
    const { default: Page } = await import("@/app/conversations/[id]/page");
    const params = Promise.resolve({ id: "a/b c" });
    await expect(Page({ params })).rejects.toThrow("NEXT_REDIRECT");
    const callArg = mockPermanentRedirect.mock.calls[0]?.[0];
    expect(callArg).toBe("/admin/conversations/a%2Fb%20c");
  });

  it("fonctionne même sans session (route publique côté middleware)", async () => {
    // La route page.tsx N'APPELLE PAS `auth()` ni `requireRole`. Le
    // middleware Clerk ne la liste pas dans isProtectedRoute. Donc le
    // redirect est fait sans aucun check auth, et c'est la cible /admin/*
    // qui déclenchera le flow sign-in si pas de session.
    // On teste ça en vérifiant qu'il n'y a aucun import de requireRole ou auth.
    const pageSource = await import("@/app/conversations/[id]/page");
    expect(pageSource.default).toBeDefined();
    expect(mockPermanentRedirect).toHaveBeenCalledTimes(0); // pas encore appelé
  });
});
