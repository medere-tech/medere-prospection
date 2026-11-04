// @vitest-environment jsdom

/**
 * Tests `columns.tsx` (S10.1.7-M3 — couverture composants internes).
 *
 * Couvre :
 *   - maskPhoneForUI : tous les cas (e164 valide, court, vide)
 *   - PhoneCell : masquage par défaut + toggle reveal/hide + aria-label
 *   - ActionsCell : trigger render, label menu, items selon status,
 *     handleCopyId success/error, Tooltip B1 quand previewDisabled
 *     (aria-describedby + sr-only span présents)
 *   - STATUS_LABEL_FR : map exhaustive sur tous les status
 */
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Wrapper requis par `RevealPhoneAction` (useMutation) depuis PR3 tour 2b. */
function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { ContactListItem, ContactStatus } from "@/types/contact";

import {
  __ActionsCell_FOR_TESTS as ActionsCell,
  __maskPhoneForUI_FOR_TESTS as maskPhoneForUI,
  __PhoneCell_FOR_TESTS as PhoneCell,
  __STATUS_LABEL_FR_FOR_TESTS as STATUS_LABEL_FR,
  __statusVariant_FOR_TESTS as statusVariant,
} from "./columns";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

// PR3 — fixture `ContactListItem` : `phoneLast4` + `phoneMeta` à la place
// de `phone` complet. Le `e164` ne doit plus apparaître ici.
function buildContact(overrides: Partial<ContactListItem> = {}): ContactListItem {
  const now = Timestamp.now();
  return {
    hubspotId: "hs_test_1",
    firstName: "Jean",
    lastName: "Dupont",
    civilite: "Dr",
    speciality: "Chirurgien-dentiste",
    city: "Paris",
    postalCode: "75001",
    phoneLast4: "5678",
    phoneMeta: { type: "mobile", valid: true },
    segment: "b2b_cabinet",
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
// maskPhoneForUI (helper pur)
// ─────────────────────────────────────────────────────────────────────────────

describe("maskPhoneForUI", () => {
  // PR3 — la fonction prend désormais `phoneLast4` (plus de `e164`), le
  // numéro complet ne quitte plus la liste. Affichage : 5 paires de
  // bullets + les 2 derniers chiffres.
  it("masque depuis last4 (4 chiffres)", () => {
    expect(maskPhoneForUI("5678")).toBe("•• •• •• •• •• 78");
  });

  it("masque depuis last4=99 (edge court)", () => {
    expect(maskPhoneForUI("99")).toBe("•• •• •• •• •• 99");
  });

  it("retourne placeholder pour string < 2 chars", () => {
    expect(maskPhoneForUI("")).toBe("••••");
    expect(maskPhoneForUI("7")).toBe("••••");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STATUS_LABEL_FR (map exhaustive)
// ─────────────────────────────────────────────────────────────────────────────

describe("STATUS_LABEL_FR", () => {
  it("couvre tous les status (sentinelle anti-dérive)", () => {
    const allStatuses: ContactStatus[] = [
      "pending",
      "enriched",
      "ready",
      "in_conversation",
      "qualified",
      "opted_out",
      "archived",
    ];
    for (const s of allStatuses) {
      expect(STATUS_LABEL_FR[s]).toBeTruthy();
      expect(typeof STATUS_LABEL_FR[s]).toBe("string");
    }
  });
});

describe("statusVariant (helper sémantique Badge)", () => {
  it("ready + qualified → default (primary)", () => {
    expect(statusVariant("ready")).toBe("default");
    expect(statusVariant("qualified")).toBe("default");
  });

  it("pending + enriched → secondary", () => {
    expect(statusVariant("pending")).toBe("secondary");
    expect(statusVariant("enriched")).toBe("secondary");
  });

  it("opted_out → destructive", () => {
    expect(statusVariant("opted_out")).toBe("destructive");
  });

  it("in_conversation + archived → outline", () => {
    expect(statusVariant("in_conversation")).toBe("outline");
    expect(statusVariant("archived")).toBe("outline");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PhoneCell — toggle reveal/hide
// ─────────────────────────────────────────────────────────────────────────────

describe("PhoneCell", () => {
  // PR3 tour 2b — la cellule branche désormais `RevealPhoneAction` sur
  // `POST /api/admin/contacts/[id]/reveal-phone` (audit par clic). Le
  // numéro masqué reste visible tant que l'admin n'a pas cliqué.
  it("rend le numéro masqué depuis last4 + bouton 'Afficher le numéro' ACTIF (plus de grisé)", () => {
    renderWithQuery(<PhoneCell contactId="hs_abc" phoneLast4="5678" />);
    expect(screen.getByText("•• •• •• •• •• 78")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /Afficher le numéro/i });
    expect(btn).toBeEnabled();
    // Sentinelle anti-régression : plus de badge « Bientôt » ni d'aria-label
    // « disponible prochainement ».
    expect(screen.queryByText("Bientôt")).toBeNull();
    expect(btn.getAttribute("aria-label") ?? "").not.toMatch(/disponible prochainement/i);
  });

  it("aria-label du span: 'Numéro masqué' (aucun numéro complet accessible)", () => {
    renderWithQuery(<PhoneCell contactId="hs_abc" phoneLast4="5678" />);
    expect(screen.getByLabelText("Numéro masqué")).toBeInTheDocument();
  });

  it("sentinelle — aucun chiffre autre que le last4 n'est présent dans le DOM, aucun fetch avant clic", () => {
    const fetchSpy = vi.fn();
    Object.defineProperty(globalThis, "fetch", {
      value: fetchSpy,
      configurable: true,
      writable: true,
    });
    renderWithQuery(<PhoneCell contactId="hs_abc" phoneLast4="5678" />);
    const body = document.body.textContent ?? "";
    expect(body).not.toMatch(/\+33/);
    expect(body).not.toMatch(/\d{6,}/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ActionsCell — menu Preview / Copier ID + Tooltip B1
// ─────────────────────────────────────────────────────────────────────────────

/** Helper : wrap dans un TooltipProvider (hoisté en prod côté contacts-page-client). */
function renderActionsCell(props: Parameters<typeof ActionsCell>[0]) {
  return render(
    <TooltipProvider delay={0}>
      <ActionsCell {...props} />
    </TooltipProvider>,
  );
}

describe("ActionsCell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("trigger button avec aria-label accessible", () => {
    renderActionsCell({ contact: buildContact({ status: "ready" }) });
    expect(screen.getByRole("button", { name: "Actions sur le contact" })).toBeInTheDocument();
  });

  it("status='ready' → ouverture menu → DropdownMenuItem Preview ACTIF (pas de aria-describedby)", async () => {
    const onPreview = vi.fn();
    const contact = buildContact({ status: "ready" });
    renderActionsCell({ contact, onPreview });

    await userEvent.click(screen.getByRole("button", { name: "Actions sur le contact" }));

    const previewItem = await screen.findByRole("menuitem", {
      name: /Prévisualiser le 1er SMS/i,
    });
    expect(previewItem).not.toHaveAttribute("aria-disabled", "true");
    expect(previewItem).not.toHaveAttribute("aria-describedby");

    await userEvent.click(previewItem);
    expect(onPreview).toHaveBeenCalledWith(contact);
  });

  it("status='in_conversation' → menu → DropdownMenuItem Preview DISABLED + aria-describedby + sr-only span présent", async () => {
    const onPreview = vi.fn();
    const contact = buildContact({ status: "in_conversation" });
    renderActionsCell({ contact, onPreview });

    await userEvent.click(screen.getByRole("button", { name: "Actions sur le contact" }));

    const previewItem = await screen.findByRole("menuitem", {
      name: /Prévisualiser le 1er SMS/i,
    });
    expect(previewItem).toHaveAttribute("aria-disabled", "true");
    // aria-describedby pointe vers le sr-only span avec l'explication
    const describedById = previewItem.getAttribute("aria-describedby");
    expect(describedById).toBeTruthy();
    const helpSpan = document.getElementById(describedById!);
    expect(helpSpan).toBeInTheDocument();
    expect(helpSpan?.textContent).toMatch(/Importé.*Enrichi.*Prêt/);
    // onPreview ne doit PAS être appelé sur clic d'un item disabled
    expect(onPreview).not.toHaveBeenCalled();
  });

  it("status='opted_out' → preview disabled (Bloctel STOP, jamais de preview)", async () => {
    renderActionsCell({ contact: buildContact({ status: "opted_out" }) });
    await userEvent.click(screen.getByRole("button", { name: "Actions sur le contact" }));
    const previewItem = await screen.findByRole("menuitem", {
      name: /Prévisualiser le 1er SMS/i,
    });
    expect(previewItem).toHaveAttribute("aria-disabled", "true");
  });

  it("clic 'Copier l'ID HubSpot' success → toast.success", async () => {
    // jsdom n'a pas navigator.clipboard par défaut — on stub
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      configurable: true,
    });

    const contact = buildContact({ hubspotId: "hs_abc123" });
    renderActionsCell({ contact });

    await userEvent.click(screen.getByRole("button", { name: "Actions sur le contact" }));
    const copyItem = await screen.findByRole("menuitem", {
      name: /Copier l'ID HubSpot/i,
    });
    await userEvent.click(copyItem);

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith("hs_abc123");
    });
    expect(toast.success).toHaveBeenCalledWith("ID copié dans le presse-papier");
  });

  it("clic 'Copier l'ID HubSpot' error (clipboard reject) → toast.error", async () => {
    const writeTextMock = vi.fn().mockRejectedValue(new Error("Permission denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      configurable: true,
    });

    renderActionsCell({ contact: buildContact() });

    await userEvent.click(screen.getByRole("button", { name: "Actions sur le contact" }));
    const copyItem = await screen.findByRole("menuitem", {
      name: /Copier l'ID HubSpot/i,
    });
    await userEvent.click(copyItem);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Impossible de copier l'ID");
    });
  });
});
