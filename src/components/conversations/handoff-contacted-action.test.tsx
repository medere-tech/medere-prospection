// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

/**
 * Tests unitaires jsdom — `HandoffContactedAction` (PR4 B1).
 *
 * Invariants :
 *   - bouton absent si `canMarkContacted` false ;
 *   - double clic → un seul POST ;
 *   - toast « Annuler » propose un DELETE ;
 *   - 409 serveur → clientMessage affiché ;
 *   - zéro identifiant technique (userId / conversationId) visible dans le DOM.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HandoffContactedAction } from "./handoff-contacted-action";

const CONV_ID = "427963864300_hubspot-list-999999";

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

describe("HandoffContactedAction", () => {
  it("rend NULL si canMarkContacted=false (bouton absent)", () => {
    const onAudited = vi.fn();
    const { container } = renderWithQuery(
      <HandoffContactedAction
        conversationId={CONV_ID}
        canMarkContacted={false}
        onAudited={onAudited}
      />,
    );
    expect(container.querySelector("[data-testid=handoff-contacted-action]")).toBeNull();
    expect(screen.queryByRole("button", { name: /J'ai contacté/i })).toBeNull();
  });

  it("double clic → un seul POST (anti-double-clic via disabled pendant la mutation)", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    const onAudited = vi.fn();
    let resolvePost: (v: Response) => void = () => {};
    const postPromise = new Promise<Response>((r) => {
      resolvePost = r;
    });
    const fetchSpy = vi.fn().mockImplementation(() => postPromise);
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    renderWithQuery(
      <HandoffContactedAction
        conversationId={CONV_ID}
        canMarkContacted={true}
        onAudited={onAudited}
      />,
    );
    const button = screen.getByRole("button", { name: /J'ai contacté/i });
    await user.click(button);
    await user.click(button); // 2e clic pendant la mutation en cours
    await user.click(button); // 3e clic
    // La mutation n'a pas encore résolu — un seul fetch.
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    resolvePost(
      new Response(JSON.stringify({ contactedAtIso: "2026-11-09T10:00:00.000Z" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await waitFor(() => expect(onAudited).toHaveBeenCalledTimes(1));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("succès POST → toast « Médecin marqué comme contacté. » + action « Annuler »", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    const onAudited = vi.fn();
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ contactedAtIso: "2026-11-09T10:00:00.000Z" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    renderWithQuery(
      <HandoffContactedAction
        conversationId={CONV_ID}
        canMarkContacted={true}
        onAudited={onAudited}
      />,
    );
    await user.click(screen.getByRole("button", { name: /J'ai contacté/i }));
    await waitFor(() => expect(onAudited).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Médecin marqué comme contacté.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Annuler le marquage/i })).toBeInTheDocument();
  });

  it("le toast « Annuler » déclenche un DELETE", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    const onAudited = vi.fn();
    const fetchSpy = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(JSON.stringify({ contactedAtIso: "2026-11-09T10:00:00.000Z" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
        ),
      );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    renderWithQuery(
      <HandoffContactedAction
        conversationId={CONV_ID}
        canMarkContacted={true}
        onAudited={onAudited}
      />,
    );
    await user.click(screen.getByRole("button", { name: /J'ai contacté/i }));
    const undo = await screen.findByRole("button", { name: /Annuler le marquage/i });
    await user.click(undo);
    await waitFor(() => expect(onAudited).toHaveBeenCalledTimes(2));

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const lastCall = fetchSpy.mock.calls[1]!;
    expect(lastCall[1]?.method).toBe("DELETE");
  });

  it("409 serveur → affiche le clientMessage FR", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "CONFLICT",
            message: "Cette conversation est déjà marquée comme contactée.",
          },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    renderWithQuery(
      <HandoffContactedAction
        conversationId={CONV_ID}
        canMarkContacted={true}
        onAudited={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /J'ai contacté/i }));
    expect(
      await screen.findByText("Cette conversation est déjà marquée comme contactée."),
    ).toBeInTheDocument();
  });

  it("zéro identifiant technique (conversationId) visible dans le DOM", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ contactedAtIso: "2026-11-09T10:00:00.000Z" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { container } = renderWithQuery(
      <HandoffContactedAction
        conversationId={CONV_ID}
        canMarkContacted={true}
        onAudited={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /J'ai contacté/i }));
    await screen.findByText("Médecin marqué comme contacté.");

    // Le DOM ne doit contenir NI le conversationId (427963864300_hubspot-list-999999)
    // NI un Clerk userId (user_...) NI un Slack U-prefix.
    const txt = container.textContent ?? "";
    expect(txt).not.toContain(CONV_ID);
    expect(txt).not.toMatch(/user_[A-Za-z0-9]{10,}/);
    expect(txt).not.toMatch(/\bU0[A-Z0-9]{8,}\b/);
  });
});
