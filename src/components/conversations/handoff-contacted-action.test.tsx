// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

/**
 * Tests unitaires jsdom — `HandoffContactedAction` (PR4 B1 — review commit c1c40f4).
 *
 * Invariants :
 *   - bouton absent si `canMarkContacted` false ;
 *   - double clic → un seul POST ;
 *   - sur succès : `toast.success` appelé avec le message, l'action
 *     « Annuler » et `duration: 10_000` ;
 *   - BUG FIX : le toast « Annuler » reste disponible même quand le
 *     parent flip `canMarkContacted` à false au refetch (simulé). Le
 *     toast est émis par le système global sonner, pas par un rendu
 *     conditionnel du composant lui-même.
 *   - action « Annuler » invoque un DELETE puis `onAudited()` ;
 *   - 409 serveur → `toast.error(clientMessage)` ;
 *   - aucun identifiant technique (userId / conversationId) visible
 *     dans le DOM.
 */
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { toast } from "sonner";
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
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("HandoffContactedAction", () => {
  it("rend NULL si canMarkContacted=false (bouton absent)", () => {
    const { container } = renderWithQuery(
      <HandoffContactedAction
        conversationId={CONV_ID}
        canMarkContacted={false}
        onAudited={vi.fn()}
      />,
    );
    expect(container.querySelector("[data-testid=handoff-contacted-action]")).toBeNull();
    expect(screen.queryByRole("button", { name: /J'ai contacté/i })).toBeNull();
  });

  it("double clic → un seul POST (anti-double-clic via disabled pendant la mutation)", async () => {
    const user = userEvent.setup();
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
    await user.click(button);
    await user.click(button);
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

  it("succès POST → toast.success(message, { action: 'Annuler', duration: 10000 })", async () => {
    const user = userEvent.setup();
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
        onAudited={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /J'ai contacté/i }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    const call = vi.mocked(toast.success).mock.calls[0]!;
    expect(call[0]).toBe("Médecin marqué comme contacté.");
    const opts = call[1] as { action?: { label: string }; duration?: number } | undefined;
    expect(opts?.action?.label).toBe("Annuler");
    expect(opts?.duration).toBe(10_000);
  });

  it("🔒 BUG FIX — le toast reste visible quand le parent flip canMarkContacted à false au refetch", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ contactedAtIso: "2026-11-09T10:00:00.000Z" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    // Parent qui simule le vrai cycle : au onAudited() il rechange
    // canMarkContacted à false (comme loadConversationDetail renvoie
    // après POST). Le composant action va donc se démonter — le toast,
    // émis par le système sonner global, doit survivre.
    function Harness() {
      const [canMark, setCanMark] = useState(true);
      return (
        <HandoffContactedAction
          conversationId={CONV_ID}
          canMarkContacted={canMark}
          onAudited={() => setCanMark(false)}
        />
      );
    }

    const { container } = renderWithQuery(<Harness />);
    await user.click(screen.getByRole("button", { name: /J'ai contacté/i }));

    // Après un flush : bouton démonté (canMarkContacted=false).
    await waitFor(() =>
      expect(container.querySelector("[data-testid=handoff-contacted-action]")).toBeNull(),
    );

    // MAIS : `toast.success` a bien été appelé AVANT le démontage —
    // l'action Annuler est portée par sonner, pas par ce composant,
    // donc elle reste cliquable après démontage.
    expect(toast.success).toHaveBeenCalledTimes(1);
    const call = vi.mocked(toast.success).mock.calls[0]!;
    const opts = call[1] as unknown as { action?: { label: string; onClick: () => void } };
    expect(opts.action?.label).toBe("Annuler");
    expect(typeof opts.action?.onClick).toBe("function");

    // Et l'action Annuler, invoquée APRÈS démontage, déclenche le DELETE
    // + ne plante pas (ne s'appuie plus sur un state démonté).
    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    opts.action!.onClick();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(fetchSpy.mock.calls[1]![1]?.method).toBe("DELETE");
  });

  it("action « Annuler » du toast → DELETE + onAudited()", async () => {
    const user = userEvent.setup();
    const onAudited = vi.fn();
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ contactedAtIso: "2026-11-09T10:00:00.000Z" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    renderWithQuery(
      <HandoffContactedAction
        conversationId={CONV_ID}
        canMarkContacted={true}
        onAudited={onAudited}
      />,
    );
    await user.click(screen.getByRole("button", { name: /J'ai contacté/i }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));

    const call = vi.mocked(toast.success).mock.calls[0]!;
    const opts = call[1] as unknown as { action: { onClick: () => void } };
    opts.action.onClick();

    await waitFor(() => expect(onAudited).toHaveBeenCalledTimes(2));
    expect(fetchSpy.mock.calls[1]![1]?.method).toBe("DELETE");
  });

  it("409 serveur → toast.error(clientMessage FR)", async () => {
    const user = userEvent.setup();
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
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Cette conversation est déjà marquée comme contactée.",
      ),
    );
  });

  it("zéro identifiant technique (conversationId) visible dans le DOM", async () => {
    const user = userEvent.setup();
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
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));

    const txt = container.textContent ?? "";
    expect(txt).not.toContain(CONV_ID);
    expect(txt).not.toMatch(/user_[A-Za-z0-9]{10,}/);
    expect(txt).not.toMatch(/\bU0[A-Z0-9]{8,}\b/);
  });
});
