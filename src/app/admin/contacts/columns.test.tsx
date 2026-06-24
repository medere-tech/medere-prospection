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

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { Contact, ContactStatus } from "@/types/contact";

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

function buildContact(overrides: Partial<Contact> = {}): Contact {
  const now = Timestamp.now();
  return {
    hubspotId: "hs_test_1",
    firstName: "Jean",
    lastName: "Dupont",
    civilite: "Dr",
    speciality: "Chirurgien-dentiste",
    city: "Paris",
    postalCode: "75001",
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
// maskPhoneForUI (helper pur)
// ─────────────────────────────────────────────────────────────────────────────

describe("maskPhoneForUI", () => {
  it("masque un E.164 mobile français", () => {
    expect(maskPhoneForUI("+33612345678")).toBe("+336 •• ••• •78");
  });

  it("masque un E.164 fixe (+33 1)", () => {
    expect(maskPhoneForUI("+33145678901")).toBe("+331 •• ••• •01");
  });

  it("retourne placeholder pour string < 5 chars", () => {
    expect(maskPhoneForUI("")).toBe("••••");
    expect(maskPhoneForUI("+33")).toBe("••••");
    expect(maskPhoneForUI("1234")).toBe("••••");
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
  it("rend le numéro masqué par défaut + bouton 'Afficher'", () => {
    render(<PhoneCell e164="+33612345678" />);
    expect(screen.getByText("+336 •• ••• •78")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Afficher le numéro complet" })).toBeInTheDocument();
  });

  it("clic sur 'Afficher' → révèle le numéro complet + bouton devient 'Masquer'", async () => {
    render(<PhoneCell e164="+33612345678" />);
    const toggleBtn = screen.getByRole("button", { name: "Afficher le numéro complet" });
    await userEvent.click(toggleBtn);

    expect(screen.getByText("+33612345678")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Masquer le numéro" })).toBeInTheDocument();
    expect(screen.queryByText("+336 •• ••• •78")).not.toBeInTheDocument();
  });

  it("aria-label change selon l'état (révélé / masqué)", async () => {
    render(<PhoneCell e164="+33612345678" />);
    // Masqué initialement
    expect(screen.getByLabelText("Numéro masqué")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Afficher/i }));
    expect(screen.getByLabelText("Numéro complet : +33612345678")).toBeInTheDocument();
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
