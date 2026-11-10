// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

/**
 * Tests unitaires jsdom — `HandoffContactedUndoButton` (PR4 B1).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HandoffContactedUndoButton } from "./handoff-contacted-undo-button";

const CONV_ID = "427963864300_hubspot-list-999999";

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("HandoffContactedUndoButton", () => {
  it("affiche le bouton « Annuler le contact »", () => {
    renderWithQuery(<HandoffContactedUndoButton conversationId={CONV_ID} onAudited={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Annuler le contact/i })).toBeInTheDocument();
  });

  it("clic → DELETE + onAudited()", async () => {
    const user = userEvent.setup();
    const onAudited = vi.fn();
    const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    renderWithQuery(<HandoffContactedUndoButton conversationId={CONV_ID} onAudited={onAudited} />);
    await user.click(screen.getByRole("button", { name: /Annuler le contact/i }));
    await waitFor(() => expect(onAudited).toHaveBeenCalledTimes(1));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![1]?.method).toBe("DELETE");
  });

  it("409 → affiche le clientMessage FR", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "CONFLICT", message: "Aucun contact à annuler." },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    renderWithQuery(<HandoffContactedUndoButton conversationId={CONV_ID} onAudited={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /Annuler le contact/i }));
    expect(await screen.findByText("Aucun contact à annuler.")).toBeInTheDocument();
  });

  it("zéro identifiant technique (conversationId) visible dans le DOM", () => {
    const { container } = renderWithQuery(
      <HandoffContactedUndoButton conversationId={CONV_ID} onAudited={vi.fn()} />,
    );
    expect(container.textContent ?? "").not.toContain(CONV_ID);
  });
});
