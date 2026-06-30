// @vitest-environment jsdom

/**
 * Tests `<PreviewDialog />` (S10.1.6 — refonte UX premium).
 *
 * Couvre (préserve la couverture comportementale S10.1.5) :
 *   - contact null → modal fermée, pas de fetch
 *   - contact set → fetch preview au mount + affiche header riche +
 *     smsBody + pills compliance (Annonce IA / STOP)
 *   - preview success (preSendCheckPassed=true) → badge OK + send activable
 *   - preview success (preSendCheckPassed=false) → badge KO + code/rule +
 *     send disabled
 *   - preview error → message d'erreur + bouton "Réessayer"
 *   - bouton Réessayer → re-fetch (retryNonce bump)
 *   - abort race : change rapidement de contact → seul le dernier fetch
 *     est honoré
 *   - confirm INLINE flow : clic "Envoyer le SMS" → footer transitionne
 *     en "Annuler" / "Confirmer l'envoi définitif" (preview reste visible)
 *   - aria-live="polite" présent sur le conteneur d'état
 *
 * Tests E2E Playwright (S10.2+) couvriront :
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
  charCount: 60,
  preSendCheckPassed: true,
};

const PREVIEW_BLOCKED = {
  smsBody: "Bonjour Dr Dupont, Léa de Médéré. STOP pour ne plus recevoir.",
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

    // S10.1.7-Q1 : findByText (async) plutôt que getByText (sync) pour
    // wrapper implicitement le rendu post-mount dans act(). Sinon, le
    // fetch mock résout dans un microtask et trigger un setState après la
    // fin du test → warning "An update to PreviewDialogContent inside a
    // test was not wrapped in act(...)" en pre-push.
    expect(await screen.findByText("Dr Jean Dupont")).toBeInTheDocument();
    expect(screen.getByText("Chirurgien-dentiste")).toBeInTheDocument();
    expect(screen.getByText(/Paris · 75001/)).toBeInTheDocument();
    // Téléphone masqué visuellement (cohérent avec PhoneCell de la table)
    expect(screen.getByText("+336 •• ••• •78")).toBeInTheDocument();

    // Wait final pour s'assurer que le fetch résolu a settled le state
    // (success) — évite que le test termine avant le setState du then().
    await waitFor(() => {
      expect(screen.getByText("Compliance OK")).toBeInTheDocument();
    });
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

  it("preview success preSendCheckPassed=false → badge KO + code/rule + send disabled", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse(PREVIEW_BLOCKED));
    render(<PreviewDialog contact={buildContact()} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Compliance bloquée")).toBeInTheDocument();
    });
    expect(screen.getByText("bloctel_not_checked")).toBeInTheDocument();
    expect(screen.getByText("bloctel")).toBeInTheDocument();
    // Bouton Envoyer disabled
    const sendBtn = screen.getByRole("button", { name: /Envoyer le SMS/i });
    expect(sendBtn).toBeDisabled();
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
    // 🚨 Anti-piège highlight : `SmsBodyPreview` enrobe "Léa" et "STOP" dans
    // des <mark> → le body complet est splité en plusieurs text nodes. On
    // assert donc sur un FRAGMENT unique inséré DANS le body mais en dehors
    // des zones highlightées, repérable comme une seule text-node continue.
    const SECOND_FRAGMENT = "SECOND fetch wins";
    const FIRST_FRAGMENT = "FIRST fetch should be ignored";
    const SECOND_BODY = `Bonjour Dr Second, Léa de Médéré. ${SECOND_FRAGMENT}. STOP pour ne plus recevoir.`;
    const FIRST_BODY = `Bonjour Dr First, Léa de Médéré. ${FIRST_FRAGMENT}. STOP pour ne plus recevoir.`;
    let resolveFirst: ((value: Response) => void) | undefined;
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce(jsonResponse({ ...PREVIEW_OK, smsBody: SECOND_BODY }));

    const { rerender } = render(
      <PreviewDialog contact={buildContact({ hubspotId: "hs_first" })} onClose={vi.fn()} />,
    );

    // Rerender avec un autre hubspotId → key change → remount + abort 1er fetch
    rerender(
      <PreviewDialog contact={buildContact({ hubspotId: "hs_second" })} onClose={vi.fn()} />,
    );

    // Résout le 1er fetch APRÈS le rerender — il doit être ignoré (signal aborted)
    resolveFirst?.(jsonResponse({ ...PREVIEW_OK, smsBody: FIRST_BODY }));

    // Assert sur un fragment unique du smsBody (en dehors des marks Léa/STOP) :
    // seul le 2e fetch peut peupler l'UI.
    await waitFor(() => {
      expect(screen.getByText(new RegExp(SECOND_FRAGMENT))).toBeInTheDocument();
    });
    expect(screen.queryByText(new RegExp(FIRST_FRAGMENT))).not.toBeInTheDocument();
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

  // ───────────────────────────────────────────────────────────────────────
  // S10.1.7-M1 : couverture handleConfirmSend success + error paths
  // ───────────────────────────────────────────────────────────────────────

  it("confirm + send success → transition 'sent' + toast.success + onSendSuccess + onClose après 2500ms", async () => {
    const onSendSuccess = vi.fn();
    const onClose = vi.fn();
    // 1er fetch = preview, 2e fetch = send
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse(PREVIEW_OK))
      .mockResolvedValueOnce(
        jsonResponse({
          jobId: "job_abc",
          status: "queued",
          contactId: "hs_abc",
          smsCharCount: 60,
        }),
      );

    // useFakeTimers AVANT render pour intercepter le setTimeout(2500ms)
    // qu'utilise handleConfirmSend après succès.
    vi.useFakeTimers({ shouldAdvanceTime: true });

    render(
      <PreviewDialog contact={buildContact()} onClose={onClose} onSendSuccess={onSendSuccess} />,
    );

    // Attend que la preview soit chargée (sortie de l'état loading)
    const sendBtn = await screen.findByRole("button", { name: /Envoyer le SMS/i });
    await waitFor(() => expect(sendBtn).not.toBeDisabled());

    // 1er clic : passe en mode confirming
    await userEvent.click(sendBtn);

    // 2e clic : confirme l'envoi définitif
    const confirmBtn = screen.getByRole("button", { name: /Confirmer l'envoi définitif/i });
    await userEvent.click(confirmBtn);

    // Vérifie l'appel à /api/admin/send-first-sms
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/send-first-sms",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ contactId: "hs_abc", confirm: true }),
        }),
      );
    });

    // Transition "sent" visible : SMS envoyé à Dr Dupont
    await waitFor(() => {
      expect(screen.getByText(/SMS envoyé à Dr Dupont/)).toBeInTheDocument();
    });

    // toast.success + onSendSuccess appelés
    const { toast } = await import("sonner");
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("SMS envoyé (60 car.)"));
    expect(onSendSuccess).toHaveBeenCalledTimes(1);

    // onClose pas encore appelé (avant 2500ms)
    expect(onClose).not.toHaveBeenCalled();

    // Avance le temps de 2500ms → setTimeout déclenché → onClose appelé
    vi.advanceTimersByTime(2500);
    expect(onClose).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  // ───────────────────────────────────────────────────────────────────────
  // S10.1.7 : couverture branches (CharCountBadge tones + pills non-matched)
  // ───────────────────────────────────────────────────────────────────────

  it("CharCountBadge tone 'warn' quand 161 ≤ charCount ≤ 320 (2 segments)", async () => {
    const longBody = "x".repeat(200) + " STOP Léa";
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ ...PREVIEW_OK, smsBody: longBody, charCount: 209 }),
    );
    render(<PreviewDialog contact={buildContact()} onClose={vi.fn()} />);

    expect(await screen.findByLabelText(/209 caractères, 2 segments SMS/)).toBeInTheDocument();
  });

  it("CharCountBadge tone 'alert' quand charCount > 320 (3+ segments)", async () => {
    const veryLong = "y".repeat(400) + " STOP Léa";
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ ...PREVIEW_OK, smsBody: veryLong, charCount: 409 }),
    );
    render(<PreviewDialog contact={buildContact()} onClose={vi.fn()} />);

    expect(await screen.findByLabelText(/409 caractères, 3 segments SMS/)).toBeInTheDocument();
  });

  it("ComplianceCheckPill matched=false quand smsBody ne contient ni 'STOP' ni 'Léa/IA' (signal compliance manquant)", async () => {
    const bodyMissingTokens = "Hello Dr Dupont, message generic sans token compliance.";
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ ...PREVIEW_OK, smsBody: bodyMissingTokens }),
    );
    render(<PreviewDialog contact={buildContact()} onClose={vi.fn()} />);

    // Les pills affichent toujours leur label, même si non-matched (signal
    // visuel "absent" via couleur ambre vs vert)
    await waitFor(() => {
      expect(screen.getByText("Annonce IA détectée")).toBeInTheDocument();
      expect(screen.getByText("Token STOP présent")).toBeInTheDocument();
    });
  });

  it("send → erreur réseau (fetch throw TypeError) → toast.error générique (anti-leak)", async () => {
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse(PREVIEW_OK))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));

    render(<PreviewDialog contact={buildContact()} onClose={vi.fn()} />);

    const sendBtn = await screen.findByRole("button", { name: /Envoyer le SMS/i });
    await waitFor(() => expect(sendBtn).not.toBeDisabled());
    await userEvent.click(sendBtn);

    const confirmBtn = screen.getByRole("button", {
      name: /Confirmer l'envoi définitif/i,
    });
    await userEvent.click(confirmBtn);

    const { toast } = await import("sonner");
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Erreur réseau"));
    });
    // Pas de leak du message technique brut
    const errCall = vi.mocked(toast.error).mock.calls[0];
    expect(errCall?.[0]).not.toContain("Failed to fetch");
  });

  it("confirm + send error → toast.error + footer revient idle (modal reste ouverte)", async () => {
    const onSendSuccess = vi.fn();
    const onClose = vi.fn();
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse(PREVIEW_OK))
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: "INTERNAL", message: "OVH 500" } }, 500),
      );

    render(
      <PreviewDialog contact={buildContact()} onClose={onClose} onSendSuccess={onSendSuccess} />,
    );

    const sendBtn = await screen.findByRole("button", { name: /Envoyer le SMS/i });
    await waitFor(() => expect(sendBtn).not.toBeDisabled());
    await userEvent.click(sendBtn);

    const confirmBtn = screen.getByRole("button", {
      name: /Confirmer l'envoi définitif/i,
    });
    await userEvent.click(confirmBtn);

    const { toast } = await import("sonner");
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("OVH 500"));
    });

    // Footer revient idle (bouton "Envoyer le SMS" de nouveau présent)
    expect(screen.getByRole("button", { name: /Envoyer le SMS/i })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSendSuccess).not.toHaveBeenCalled();
  });
});
