// @vitest-environment jsdom

/**
 * Tests `<PreviewDialog />` (S10.1.6 — refonte UX premium).
 *
 * Couvre (préserve la couverture comportementale S10.1.5) :
 *   - contact null → modal fermée, pas de fetch
 *   - contact set → fetch preview au mount + affiche header riche +
 *     smsBody/reasoning + pills compliance (Annonce IA / STOP)
 *   - preview success (preSendCheckPassed=true) → badge OK + send activable
 *   - preview success (preSendCheckPassed=false) → badge KO + code/rule +
 *     reasoning AUTO-EXPAND + send disabled
 *   - preview error → message d'erreur + bouton "Réessayer"
 *   - bouton Réessayer → re-fetch (retryNonce bump)
 *   - abort race : change rapidement de contact → seul le dernier fetch
 *     est honoré
 *   - confirm INLINE flow : clic "Envoyer le SMS" → footer transitionne
 *     en "Annuler" / "Confirmer l'envoi définitif" (preview reste visible)
 *   - aria-live="polite" présent sur le conteneur d'état
 *
 * Tests E2E Playwright (S10.2+) couvriront :
 *   - reasoning collapsible toggle clavier
 *   - sending/sent transitions visuelles
 *   - send success → toast + onSendSuccess + onClose après 1200ms
 *   - reduced-motion (CSS `prefers-reduced-motion`)
 */
import "@testing-library/jest-dom/vitest";

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import type { Contact } from "@/types/contact";

import { PreviewDialog } from "./preview-dialog";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const PREVIEW_OK = {
  smsBody: "Bonjour Dr Dupont, Léa de Médéré. STOP pour ne plus recevoir.",
  reasoning: "Court, vouvoiement, IA mentionnée.",
  charCount: 60,
  preSendCheckPassed: true,
};

const PREVIEW_BLOCKED = {
  smsBody: "Bonjour Dr Dupont, Léa de Médéré. STOP pour ne plus recevoir.",
  reasoning: "Court, vouvoiement, IA mentionnée.",
  charCount: 60,
  preSendCheckPassed: false,
  preSendCheckCode: "bloctel_not_checked",
  preSendCheckRule: "bloctel",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function buildContact(overrides: Partial<Contact> = {}): Contact {
  const now = Timestamp.now();
  return {
    hubspotId: "hs_abc",
    firstName: "Jean",
    lastName: "Dupont",
    civilite: "Dr",
    speciality: "Chirurgien-dentiste",
    city: "Paris",
    postalCode: "75001",
    email: "jean.dupont@cabinet-test.fr",
    phone: {
      e164: "+33612345678",
      raw: "06 12 34 56 78",
      type: "mobile",
      valid: true,
      lookupAt: now,
    },
    segment: "b2c_mobile_perso",
    bloctelChecked: true,
    bloctelOptOut: false,
    consent: {
      legitimateInterest: "Prospection B2B intérêt légitime documenté",
      optedOut: false,
    },
    enrichment: { source: "hubspot", enrichedAt: now },
    status: "ready",
    campaignId: "hubspot-list-200",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("PreviewDialog (S10.1.6 — UX premium)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("contact null → modal fermée, fetch JAMAIS appelé", () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    render(<PreviewDialog contact={null} onClose={vi.fn()} />);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("contact set → fetch /api/admin/preview-first-sms au mount avec hubspotId", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse(PREVIEW_OK));
    render(<PreviewDialog contact={buildContact()} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/preview-first-sms",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ contactId: "hs_abc" }),
        }),
      );
    });
  });

  it("header riche : nom + spécialité + ville + téléphone masqué", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse(PREVIEW_OK));
    render(<PreviewDialog contact={buildContact()} onClose={vi.fn()} />);

    expect(screen.getByText("Dr Jean Dupont")).toBeInTheDocument();
    expect(screen.getByText("Chirurgien-dentiste")).toBeInTheDocument();
    expect(screen.getByText(/Paris · 75001/)).toBeInTheDocument();
    // Téléphone masqué visuellement (cohérent avec PhoneCell de la table)
    expect(screen.getByText("+336 •• ••• •78")).toBeInTheDocument();
  });

  it("preview success preSendCheckPassed=true → smsBody + char count + pills + badge OK", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse(PREVIEW_OK));
    render(<PreviewDialog contact={buildContact()} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/Bonjour Dr Dupont/)).toBeInTheDocument();
    });
    // Char count avec couleur (≤160 → vert)
    expect(screen.getByLabelText(/60 caractères, 1 segment SMS/)).toBeInTheDocument();
    // Pills compliance — l'annonce "Léa" et le token "STOP" sont détectés
    expect(screen.getByText("Annonce IA détectée")).toBeInTheDocument();
    expect(screen.getByText("Token STOP présent")).toBeInTheDocument();
    // Badge compliance OK
    expect(screen.getByText("Compliance OK")).toBeInTheDocument();
  });

  it("preview success preSendCheckPassed=false → badge KO + code/rule + reasoning AUTO-EXPAND + send disabled", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse(PREVIEW_BLOCKED));
    render(<PreviewDialog contact={buildContact()} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Compliance bloquée")).toBeInTheDocument();
    });
    expect(screen.getByText("bloctel_not_checked")).toBeInTheDocument();
    expect(screen.getByText("bloctel")).toBeInTheDocument();
    // Reasoning AUTO-EXPAND quand pre-send-check KO (l'admin doit voir le motif)
    expect(screen.getByText(PREVIEW_BLOCKED.reasoning)).toBeInTheDocument();
    // Bouton Envoyer disabled
    const sendBtn = screen.getByRole("button", { name: /Envoyer le SMS/i });
    expect(sendBtn).toBeDisabled();
  });

  it("reasoning COLLAPSED par défaut quand pre-send-check OK", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse(PREVIEW_OK));
    render(<PreviewDialog contact={buildContact()} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Compliance OK")).toBeInTheDocument();
    });
    // Toggle button visible avec aria-expanded=false
    const toggle = screen.getByRole("button", { name: /Raisonnement Claude/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // Reasoning content non visible (collapsed)
    expect(screen.queryByText(PREVIEW_OK.reasoning)).not.toBeInTheDocument();
  });

  it("toggle reasoning : clic → aria-expanded=true + contenu visible", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse(PREVIEW_OK));
    render(<PreviewDialog contact={buildContact()} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Compliance OK")).toBeInTheDocument();
    });
    const toggle = screen.getByRole("button", { name: /Raisonnement Claude/i });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(PREVIEW_OK.reasoning)).toBeInTheDocument();
  });

  it("preview error 404 → message d'erreur lisible + bouton Réessayer", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ error: { code: "NOT_FOUND", message: "Contact introuvable." } }, 404),
    );
    render(<PreviewDialog contact={buildContact()} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/Impossible de générer la preview \(404\)/)).toBeInTheDocument();
    });
    expect(screen.getByText("Contact introuvable.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Réessayer/i })).toBeInTheDocument();
  });

  it("clic Réessayer → re-fetch (deuxième appel API)", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse({ error: { code: "INTERNAL", message: "Boom" } }, 500))
      .mockResolvedValueOnce(jsonResponse(PREVIEW_OK));

    render(<PreviewDialog contact={buildContact()} onClose={vi.fn()} />);

    const retryBtn = await screen.findByRole("button", { name: /Réessayer/i });
    await userEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.getByText("Compliance OK")).toBeInTheDocument();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("preview error réseau (fetch throw) → message générique sans leak technique", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    render(<PreviewDialog contact={buildContact()} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Erreur réseau. Réessayez.")).toBeInTheDocument();
    });
    // Le message technique ne doit JAMAIS être affiché à l'admin
    expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
  });

  it("abort race : changement rapide de contact → seul le dernier fetch peuple l'UI", async () => {
    let resolveFirst: ((value: Response) => void) | undefined;
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce(jsonResponse({ ...PREVIEW_OK, reasoning: "Second fetch wins." }));

    const { rerender } = render(
      <PreviewDialog contact={buildContact({ hubspotId: "hs_first" })} onClose={vi.fn()} />,
    );

    // Rerender avec un autre hubspotId → key change → remount + abort 1er fetch
    rerender(
      <PreviewDialog contact={buildContact({ hubspotId: "hs_second" })} onClose={vi.fn()} />,
    );

    // Résout le 1er fetch APRÈS le rerender — il doit être ignoré (signal aborted)
    resolveFirst?.(jsonResponse({ ...PREVIEW_OK, reasoning: "First fetch (should be ignored)." }));

    // Le reasoning est collapsed par défaut quand pre-send-check OK ;
    // on toggle pour le voir et confirmer que c'est le 2e fetch qui a gagné.
    const toggle = await screen.findByRole("button", { name: /Raisonnement Claude/i });
    await userEvent.click(toggle);
    await waitFor(() => {
      expect(screen.getByText("Second fetch wins.")).toBeInTheDocument();
    });
    expect(screen.queryByText("First fetch (should be ignored).")).not.toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("confirm INLINE : clic 'Envoyer le SMS' → footer transitionne en 'Annuler' + 'Confirmer définitif'", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse(PREVIEW_OK));
    render(<PreviewDialog contact={buildContact()} onClose={vi.fn()} />);

    const sendBtn = await screen.findByRole("button", { name: /Envoyer le SMS/i });
    await waitFor(() => expect(sendBtn).not.toBeDisabled());

    await userEvent.click(sendBtn);

    // Footer transitionné : 2 nouveaux boutons
    expect(screen.getByRole("button", { name: /Annuler/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Confirmer l'envoi définitif/i }),
    ).toBeInTheDocument();
    // Preview reste visible (anti-anxiété)
    expect(screen.getByText("Compliance OK")).toBeInTheDocument();
  });

  it("confirm INLINE : 'Annuler' → revient au footer idle", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse(PREVIEW_OK));
    render(<PreviewDialog contact={buildContact()} onClose={vi.fn()} />);

    const sendBtn = await screen.findByRole("button", { name: /Envoyer le SMS/i });
    await waitFor(() => expect(sendBtn).not.toBeDisabled());
    await userEvent.click(sendBtn);

    const cancelBtn = screen.getByRole("button", { name: /Annuler/i });
    await userEvent.click(cancelBtn);

    // Footer idle de nouveau
    expect(screen.getByRole("button", { name: /Envoyer le SMS/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Fermer$/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Confirmer l'envoi définitif/i }),
    ).not.toBeInTheDocument();
  });

  it("aria-live='polite' sur le conteneur d'état (annonce loading/success/error aux AT)", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse(PREVIEW_OK));
    render(<PreviewDialog contact={buildContact()} onClose={vi.fn()} />);

    const liveRegion = document.querySelector("[aria-live='polite']");
    expect(liveRegion).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Compliance OK")).toBeInTheDocument();
    });
  });
});
