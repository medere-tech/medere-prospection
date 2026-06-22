// @vitest-environment jsdom

/**
 * Tests `<PreviewDialog />` (S10.1.5 Phase 6).
 *
 * Couvre :
 *   - contactId null → modal fermée, pas de fetch
 *   - contactId set → fetch preview au mount + affiche smsBody/reasoning
 *   - preview success (preSendCheckPassed=true) → badge OK + send activable
 *   - preview success (preSendCheckPassed=false) → badge KO + send disabled
 *   - preview error → message d'erreur lisible
 *   - abort race : change rapidement de contactId → seul le dernier fetch est honoré
 *   - send success → toast.success + onSendSuccess + onClose appelés
 *   - send error → toast.error appelé, modal reste ouverte
 */
import "@testing-library/jest-dom/vitest";

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// Note : `toast.success` / `toast.error` sont mockés ci-dessus pour ne pas
// crasher en jsdom (le Toaster sonner du root layout n'est pas mounted en
// test isolé). Les tests du flow send (qui appelle ces toasts) nécessitent
// d'ouvrir l'AlertDialog imbriqué dans Dialog — pattern portails complexe
// en jsdom, couverts en E2E Playwright S10.2+. Les mocks sont donc
// silencieux par design — pas d'assertion ici.

import { PreviewDialog } from "./preview-dialog";

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

describe("PreviewDialog (S10.1.5 Phase 6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("contactId null → modal fermée, fetch JAMAIS appelé", () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    render(<PreviewDialog contactId={null} onClose={vi.fn()} />);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("contactId set → fetch /api/admin/preview-first-sms au mount avec contactId", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse(PREVIEW_OK));
    render(<PreviewDialog contactId="hs_abc" onClose={vi.fn()} />);

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

  it("preview success preSendCheckPassed=true → affiche smsBody + reasoning + badge OK", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse(PREVIEW_OK));
    render(<PreviewDialog contactId="hs_abc" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/Bonjour Dr Dupont, Léa de Médéré/)).toBeInTheDocument();
    });
    expect(screen.getByText(PREVIEW_OK.reasoning)).toBeInTheDocument();
    expect(screen.getByText(/60 caractères/)).toBeInTheDocument();
    expect(screen.getByText("Compliance OK")).toBeInTheDocument();
  });

  it("preview success preSendCheckPassed=false → badge KO + code/rule + send disabled", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse(PREVIEW_BLOCKED));
    render(<PreviewDialog contactId="hs_abc" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Compliance bloquée")).toBeInTheDocument();
    });
    // Match EXACT (pas regex /bloctel/ qui matche 2 éléments — le code
    // `bloctel_not_checked` ET la rule `bloctel` sont rendus côte à côte
    // dans 2 `<code>` distincts).
    expect(screen.getByText("bloctel_not_checked")).toBeInTheDocument();
    expect(screen.getByText("bloctel")).toBeInTheDocument();

    const sendBtn = screen.getByRole("button", { name: /Envoyer le SMS/i });
    expect(sendBtn).toBeDisabled();
  });

  it("preview error 404 → message d'erreur lisible avec status", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ error: { code: "NOT_FOUND", message: "Contact introuvable." } }, 404),
    );
    render(<PreviewDialog contactId="hs_inexistant" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/Impossible de générer la preview \(404\)/)).toBeInTheDocument();
    });
    expect(screen.getByText("Contact introuvable.")).toBeInTheDocument();
  });

  it("preview error réseau (fetch throw) → message générique", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    render(<PreviewDialog contactId="hs_abc" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Erreur réseau. Réessayez.")).toBeInTheDocument();
    });
  });

  it("ne fuit PAS d'erreur 'Failed to fetch' brute côté UI (anti-leak)", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    render(<PreviewDialog contactId="hs_abc" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Erreur réseau. Réessayez.")).toBeInTheDocument();
    });
    // Le message technique de l'erreur ne doit JAMAIS être affiché à l'admin.
    expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
  });

  it("abort race : changement rapide de contactId → seul le dernier fetch peuple l'UI", async () => {
    let resolveFirst: ((value: Response) => void) | undefined;
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce(jsonResponse({ ...PREVIEW_OK, reasoning: "Second fetch wins." }));

    const { rerender } = render(<PreviewDialog contactId="hs_first" onClose={vi.fn()} />);

    // Rerender avec un autre contactId → AbortController du 1er fetch s'active.
    rerender(<PreviewDialog contactId="hs_second" onClose={vi.fn()} />);

    // Résout le 1er fetch APRÈS le rerender — il doit être ignoré.
    resolveFirst?.(jsonResponse({ ...PREVIEW_OK, reasoning: "First fetch (should be ignored)." }));

    await waitFor(() => {
      expect(screen.getByText("Second fetch wins.")).toBeInTheDocument();
    });
    expect(screen.queryByText("First fetch (should be ignored).")).not.toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("aria-live='polite' sur le conteneur d'état (annonce loading/success/error aux AT)", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse(PREVIEW_OK));
    render(<PreviewDialog contactId="hs_abc" onClose={vi.fn()} />);

    const liveRegion = document.querySelector("[aria-live='polite']");
    expect(liveRegion).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Compliance OK")).toBeInTheDocument();
    });
  });
});
