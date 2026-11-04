// @vitest-environment jsdom

/**
 * Tests unitaires `RevealPhoneAction` (VUE-CONVERSATION PR3 tour 2b).
 *
 * Invariants vérifiés (brief Déthié) :
 *   - Aucun appel réseau tant que l'admin n'a pas cliqué.
 *   - Clic « Afficher » → POST display → numéro FR affiché + boutons
 *     « Copier » et « Appeler ».
 *   - Si l'audit échoue : clipboard JAMAIS écrit, lien tel: JAMAIS ouvert.
 *   - `optedOut: true` → avertissement visible ; `false` → absent.
 *   - Erreurs en français : 403 « Vous n'avez pas accès à ce numéro. »,
 *     429 « Trop de demandes, réessayez dans N secondes. » (N depuis
 *     `Retry-After`), sinon message générique.
 *   - Région `aria-live="polite"` autour du numéro affiché.
 */
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RevealPhoneAction } from "./reveal-phone-action";

// ─────────────────────────────────────────────────────────────────────────────
// Harness React Query + fetch stub + clipboard stub + navigation stub.
// ─────────────────────────────────────────────────────────────────────────────

function wrapQuery(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

interface FetchMock extends ReturnType<typeof vi.fn> {
  calls(): Array<[RequestInfo | URL, RequestInit | undefined]>;
}

function installFetchStub(): FetchMock {
  const fn = vi.fn() as FetchMock;
  fn.calls = () => fn.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit | undefined]>;
  Object.defineProperty(globalThis, "fetch", {
    value: fn,
    configurable: true,
    writable: true,
  });
  return fn;
}

/** Réponse JSON minimale (ok, headers vides). */
function ok(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function err(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

let clipboardWriteMock: ReturnType<typeof vi.fn>;

function installClipboardStub() {
  clipboardWriteMock = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboardWriteMock },
    configurable: true,
  });
}

let locationAssignMock: ReturnType<typeof vi.fn>;

function installLocationStub() {
  locationAssignMock = vi.fn();
  // Remplace `window.location` par un objet mutable qui enregistre les
  // écritures de `href` (jsdom interdit normalement la navigation mais ne
  // nous le dit pas de façon capturable → un stub avec setter est propre).
  const realLocation = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: {
      ...realLocation,
      assign: locationAssignMock,
      set href(v: string) {
        locationAssignMock(v);
      },
      get href() {
        return realLocation.href;
      },
    },
  });
}

const ENDPOINT = "/api/admin/conversations/conv_1_hubspot-list-6081/reveal-phone";

describe("<RevealPhoneAction> — invariants PR3 tour 2b", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = installFetchStub();
    installClipboardStub();
    installLocationStub();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("aucun appel réseau avant le clic (état initial = numéro masqué)", () => {
    wrapQuery(<RevealPhoneAction endpoint={ENDPOINT} phoneLast4="1234" />);
    // Le numéro masqué est visible, le bouton « Afficher le numéro » aussi.
    expect(screen.getByLabelText("Numéro masqué")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Afficher le numéro/i })).toBeInTheDocument();
    // JAMAIS de fetch tant qu'on n'a pas cliqué.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clic « Afficher » → POST display → numéro FR + boutons Copier/Appeler", async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ e164: "+33612345678", display: "06 12 34 56 78", optedOut: false }),
    );
    wrapQuery(<RevealPhoneAction endpoint={ENDPOINT} phoneLast4="5678" />);

    await userEvent.click(screen.getByRole("button", { name: /Afficher le numéro/i }));

    // La fetch a bien ciblé l'endpoint avec method: "display".
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.calls()[0]!;
    expect(fetchMock.calls()[0]?.[0]).toBe(ENDPOINT);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ method: "display" });

    // Le numéro FR formaté est visible, avec aria-live polite.
    const displayed = await screen.findByTestId("revealed-phone");
    expect(displayed).toHaveTextContent("06 12 34 56 78");
    expect(displayed).toHaveAttribute("aria-live", "polite");

    // Boutons Copier + Appeler présents.
    expect(screen.getByRole("button", { name: /Copier/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Appeler/i })).toBeInTheDocument();
  });

  it("optedOut=true → avertissement « Ce médecin a demandé l'arrêt des SMS. »", async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ e164: "+33612345678", display: "06 12 34 56 78", optedOut: true }),
    );
    wrapQuery(<RevealPhoneAction endpoint={ENDPOINT} phoneLast4="5678" />);
    await userEvent.click(screen.getByRole("button", { name: /Afficher le numéro/i }));
    expect(await screen.findByText(/Ce médecin a demandé l'arrêt des SMS\./)).toBeInTheDocument();
  });

  it("optedOut=false → aucun avertissement STOP", async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ e164: "+33612345678", display: "06 12 34 56 78", optedOut: false }),
    );
    wrapQuery(<RevealPhoneAction endpoint={ENDPOINT} phoneLast4="5678" />);
    await userEvent.click(screen.getByRole("button", { name: /Afficher le numéro/i }));
    await screen.findByTestId("revealed-phone");
    expect(screen.queryByText(/arrêt des SMS/i)).toBeNull();
  });

  it("copie avec audit en échec → navigator.clipboard JAMAIS appelé + message d'erreur", async () => {
    // 1er POST display OK → on révèle. 2ème POST copy → 500.
    fetchMock
      .mockResolvedValueOnce(
        ok({ e164: "+33612345678", display: "06 12 34 56 78", optedOut: false }),
      )
      .mockResolvedValueOnce(err(500, { error: { code: "INTERNAL", message: "boom" } }));
    wrapQuery(<RevealPhoneAction endpoint={ENDPOINT} phoneLast4="5678" />);
    await userEvent.click(screen.getByRole("button", { name: /Afficher le numéro/i }));
    await screen.findByTestId("revealed-phone");

    await userEvent.click(screen.getByRole("button", { name: /Copier/i }));

    // La fetch copy a bien tourné.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.calls()[1]?.[1]?.body))).toEqual({ method: "copy" });

    // Mais le clipboard N'A JAMAIS été écrit (ordre : audit d'abord).
    expect(clipboardWriteMock).not.toHaveBeenCalled();
    // Message d'erreur générique en français.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Impossible de récupérer le numéro/i,
    );
  });

  it("appel avec audit en échec → tel: JAMAIS ouvert", async () => {
    fetchMock
      .mockResolvedValueOnce(
        ok({ e164: "+33612345678", display: "06 12 34 56 78", optedOut: false }),
      )
      .mockResolvedValueOnce(err(500, { error: { code: "INTERNAL", message: "boom" } }));
    wrapQuery(<RevealPhoneAction endpoint={ENDPOINT} phoneLast4="5678" />);
    await userEvent.click(screen.getByRole("button", { name: /Afficher le numéro/i }));
    await screen.findByTestId("revealed-phone");

    await userEvent.click(screen.getByRole("button", { name: /Appeler/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(locationAssignMock).not.toHaveBeenCalled();
  });

  it("copie OK → navigator.clipboard.writeText(e164) appelé APRÈS l'audit", async () => {
    fetchMock
      .mockResolvedValueOnce(
        ok({ e164: "+33612345678", display: "06 12 34 56 78", optedOut: false }),
      )
      .mockResolvedValueOnce(
        ok({ e164: "+33612345678", display: "06 12 34 56 78", optedOut: false }),
      );
    wrapQuery(<RevealPhoneAction endpoint={ENDPOINT} phoneLast4="5678" />);
    await userEvent.click(screen.getByRole("button", { name: /Afficher le numéro/i }));
    await screen.findByTestId("revealed-phone");
    await userEvent.click(screen.getByRole("button", { name: /Copier/i }));
    await waitFor(() => expect(clipboardWriteMock).toHaveBeenCalledWith("+33612345678"));
  });

  it("appel OK → window.location.href = tel:+33… après l'audit", async () => {
    fetchMock
      .mockResolvedValueOnce(
        ok({ e164: "+33612345678", display: "06 12 34 56 78", optedOut: false }),
      )
      .mockResolvedValueOnce(
        ok({ e164: "+33612345678", display: "06 12 34 56 78", optedOut: false }),
      );
    wrapQuery(<RevealPhoneAction endpoint={ENDPOINT} phoneLast4="5678" />);
    await userEvent.click(screen.getByRole("button", { name: /Afficher le numéro/i }));
    await screen.findByTestId("revealed-phone");
    await userEvent.click(screen.getByRole("button", { name: /Appeler/i }));
    await waitFor(() => expect(locationAssignMock).toHaveBeenCalledWith("tel:+33612345678"));
  });

  it("403 → message « Vous n'avez pas accès à ce numéro. »", async () => {
    fetchMock.mockResolvedValueOnce(err(403, { error: { code: "FORBIDDEN", message: "x" } }));
    wrapQuery(<RevealPhoneAction endpoint={ENDPOINT} phoneLast4="5678" />);
    await userEvent.click(screen.getByRole("button", { name: /Afficher le numéro/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Vous n'avez pas accès à ce numéro.",
    );
  });

  it("429 → message « Trop de demandes, réessayez dans N secondes. » (N depuis Retry-After)", async () => {
    fetchMock.mockResolvedValueOnce(
      err(429, { error: { code: "RATE_LIMITED", message: "slow" } }, { "Retry-After": "42" }),
    );
    wrapQuery(<RevealPhoneAction endpoint={ENDPOINT} phoneLast4="5678" />);
    await userEvent.click(screen.getByRole("button", { name: /Afficher le numéro/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Trop de demandes, réessayez dans 42 secondes.",
    );
  });

  it("appelle `onAudited` après un POST réussi (hook de rafraîchissement journal)", async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ e164: "+33612345678", display: "06 12 34 56 78", optedOut: false }),
    );
    const onAudited = vi.fn();
    wrapQuery(<RevealPhoneAction endpoint={ENDPOINT} phoneLast4="5678" onAudited={onAudited} />);
    await userEvent.click(screen.getByRole("button", { name: /Afficher le numéro/i }));
    await screen.findByTestId("revealed-phone");
    expect(onAudited).toHaveBeenCalledTimes(1);
  });

  it("onAudited N'EST PAS appelé si le POST échoue", async () => {
    fetchMock.mockResolvedValueOnce(err(403, { error: { code: "FORBIDDEN", message: "x" } }));
    const onAudited = vi.fn();
    wrapQuery(<RevealPhoneAction endpoint={ENDPOINT} phoneLast4="5678" onAudited={onAudited} />);
    await userEvent.click(screen.getByRole("button", { name: /Afficher le numéro/i }));
    await screen.findByRole("alert");
    expect(onAudited).not.toHaveBeenCalled();
  });
});
