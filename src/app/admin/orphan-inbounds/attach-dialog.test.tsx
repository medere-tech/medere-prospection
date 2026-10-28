// @vitest-environment jsdom

/**
 * Tests `<AttachDialog />` (PR2c tour 2b bloc B).
 *
 * Couverture essentielle (user-visible) :
 *   - Question opt-out SANS valeur par défaut (bouton Continuer disabled
 *     tant que l'admin n'a pas répondu Oui ou Non).
 *   - STOP détecté → Oui imposé, radios absents, texte d'explication
 *     visible.
 *   - Bouton « Rattacher définitivement » désactivé si body vide.
 *   - Aucun identifiant visible (docId, Clerk userId, slackUserId).
 *
 * Mutations manuelles vérifiées par ces tests :
 *   - M1 : si on pré-cochait l'opt-out à `true` par défaut, le test
 *          « bouton Continuer désactivé par défaut » tomberait.
 *   - M2 : si on retirait la détection STOP, le test « STOP détecté
 *          impose Oui » tomberait.
 */
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AttachDialog } from "./attach-dialog";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

// Pas d'appel réseau — on surveille via vi.spyOn fetch global.
function mockFetch(
  overrides?: Partial<{
    conversationItem: Partial<{
      conversationId: string;
      contactDisplayName: string | null;
      contactSpecialty: string | null;
      contactCity: string | null;
      assignedTo: string | null;
      assignedToName: string | null;
    }>;
  }>,
) {
  const defaultItem = {
    conversationId: "c1_hubspot-list-9999",
    contactDisplayName: "Dr Dupont",
    contactSpecialty: "Dentiste",
    contactCity: "Paris",
    assignedTo: null,
    assignedToName: null,
  };
  const item = { ...defaultItem, ...(overrides?.conversationItem ?? {}) };
  const impl = vi.fn(async (url: string) => {
    if (url.includes("/api/admin/conversations")) {
      return {
        ok: true,
        json: async () => ({ items: [item] }),
      } as unknown as Response;
    }
    throw new Error("Unexpected fetch: " + url);
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

async function openAndPickConversation() {
  const user = userEvent.setup();
  const input = await screen.findByLabelText(/Recherche par nom/);
  await user.type(input, "Dup");
  const option = await screen.findByRole("option", { name: /Dr Dupont/ });
  await user.click(option);
}

describe("<AttachDialog />", () => {
  it("étape 2 : la question opt-out est SANS valeur par défaut (bouton Continuer désactivé)", async () => {
    mockFetch();
    render(
      wrap(
        <AttachDialog
          open={true}
          onOpenChange={vi.fn()}
          orphanDocId="oih_abc"
          orphanBody="Je ne suis plus intéressé par vos services"
        />,
      ),
    );

    await openAndPickConversation();
    // Les deux radios « Oui » et « Non » sont visibles, aucun pré-coché.
    const yes = await screen.findByLabelText(/Oui, ne plus solliciter/);
    const no = await screen.findByLabelText(/Non, le médecin reste joignable/);
    expect((yes as HTMLInputElement).checked).toBe(false);
    expect((no as HTMLInputElement).checked).toBe(false);
    const continueBtn = screen.getByRole("button", { name: /Continuer/ });
    expect(continueBtn).toBeDisabled();
  });

  it("étape 2 : STOP détecté → Oui imposé, pas de radios, explication affichée", async () => {
    mockFetch();
    render(
      wrap(
        <AttachDialog open={true} onOpenChange={vi.fn()} orphanDocId="oih_abc" orphanBody="STOP" />,
      ),
    );
    await openAndPickConversation();
    // L'alerte explicative est visible.
    const notice = await screen.findByText(/La réponse « Oui » est imposée/);
    expect(notice).toBeInTheDocument();
    // Les radios ne sont pas rendues.
    expect(screen.queryByLabelText(/Oui, ne plus solliciter/)).toBeNull();
    expect(screen.queryByLabelText(/Non, le médecin reste joignable/)).toBeNull();
    // Le bouton Continuer est actif (puisque la réponse est pré-déterminée).
    const continueBtn = screen.getByRole("button", { name: /Continuer/ });
    expect(continueBtn).not.toBeDisabled();
  });

  it("étape 3 : body vide → bouton « Rattacher définitivement » désactivé", async () => {
    mockFetch();
    render(
      wrap(<AttachDialog open={true} onOpenChange={vi.fn()} orphanDocId="oih_abc" orphanBody="" />),
    );
    await openAndPickConversation();
    // body vide → aucun opt-out détecté → on doit répondre Non pour aller en confirmation.
    const no = await screen.findByLabelText(/Non, le médecin reste joignable/);
    await userEvent.click(no);
    await userEvent.click(screen.getByRole("button", { name: /Continuer/ }));
    const confirmBtn = await screen.findByRole("button", {
      name: /Rattacher définitivement/,
    });
    expect(confirmBtn).toBeDisabled();
    expect(
      screen.getByText(/Aucun texte lisible\. Le rattachement n'est pas possible/),
    ).toBeInTheDocument();
  });

  it("aucun identifiant brut (docId, conversationId, userId) ne doit atteindre le DOM visible", async () => {
    mockFetch();
    render(
      wrap(
        <AttachDialog
          open={true}
          onOpenChange={vi.fn()}
          orphanDocId="oih_SECRET_LEAK_1234"
          orphanBody="Merci pour votre message"
        />,
      ),
    );
    await openAndPickConversation();
    await waitFor(() => {
      expect(document.body.textContent ?? "").not.toContain("oih_SECRET_LEAK_1234");
      // conversationId technique « c1_hubspot-list-9999 » doit être masqué
      // sous un libellé humain partout dans le DOM visible.
      expect(document.body.textContent ?? "").not.toContain("c1_hubspot-list-9999");
    });
  });

  it("étape 3 : confirmation nomme le titulaire par son nom quand la conv en a un", async () => {
    mockFetch({
      conversationItem: { assignedTo: "U05UVHGBURX", assignedToName: "Vanessa Rabba" },
    });
    render(
      wrap(
        <AttachDialog
          open={true}
          onOpenChange={vi.fn()}
          orphanDocId="oih_abc"
          orphanBody="Merci"
        />,
      ),
    );
    await openAndPickConversation();
    const no = await screen.findByLabelText(/Non, le médecin reste joignable/);
    await userEvent.click(no);
    await userEvent.click(screen.getByRole("button", { name: /Continuer/ }));
    await screen.findByRole("button", { name: /Rattacher définitivement/ });
    expect(document.body.textContent ?? "").toContain("Vanessa Rabba");
    // Pas de leak du slackUserId.
    expect(document.body.textContent ?? "").not.toContain("U05UVHGBURX");
  });

  it("étape 3 : confirmation annonce « le canal des SMS orphelins » quand pas de titulaire", async () => {
    mockFetch({
      conversationItem: { assignedTo: null, assignedToName: null },
    });
    render(
      wrap(
        <AttachDialog
          open={true}
          onOpenChange={vi.fn()}
          orphanDocId="oih_abc"
          orphanBody="Merci"
        />,
      ),
    );
    await openAndPickConversation();
    const no = await screen.findByLabelText(/Non, le médecin reste joignable/);
    await userEvent.click(no);
    await userEvent.click(screen.getByRole("button", { name: /Continuer/ }));
    await screen.findByRole("button", { name: /Rattacher définitivement/ });
    expect(document.body.textContent ?? "").toContain("le canal des SMS orphelins");
  });
});
