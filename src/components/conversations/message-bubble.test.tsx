// @vitest-environment jsdom

/**
 * Tests `<MessageBubble />` — indicateurs d'origine orphan
 * (PR2c tour 2b bloc B).
 *
 *   - Message rattaché depuis un orphan → mention « Ajouté manuellement
 *     depuis un SMS orphelin » visible.
 *   - phoneMatch === "mismatch" → mention supplémentaire « Envoyé depuis
 *     un autre numéro ».
 *   - Message classique (sans `attachedFromOrphan`) → aucune mention.
 */
import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageBubble } from "./message-bubble";
import type { MessageProps } from "./types";

function makeInbound(overrides: Partial<MessageProps> = {}): MessageProps {
  return {
    messageId: "m1",
    direction: "inbound",
    status: "received",
    body: "Merci pour votre message",
    generatedBy: "system",
    createdAtIso: "2026-10-27T10:00:00.000Z",
    receivedAtIso: "2026-10-27T10:00:00.000Z",
    commercialName: null,
    ...overrides,
  };
}

describe("<MessageBubble /> — indicateurs d'origine orphan", () => {
  it("sans attachedFromOrphan → aucune mention", () => {
    render(<MessageBubble message={makeInbound()} />);
    expect(screen.queryByText(/Ajouté manuellement depuis un SMS orphelin/)).toBeNull();
    expect(screen.queryByText(/Envoyé depuis un autre numéro/)).toBeNull();
  });

  it("attachedFromOrphan.phoneMatch === 'match' → mention 1 seule", () => {
    render(
      <MessageBubble message={makeInbound({ attachedFromOrphan: { phoneMatch: "match" } })} />,
    );
    expect(screen.getByText(/Ajouté manuellement depuis un SMS orphelin/)).toBeInTheDocument();
    expect(screen.queryByText(/Envoyé depuis un autre numéro/)).toBeNull();
  });

  it("attachedFromOrphan.phoneMatch === 'mismatch' → mention + sous-mention", () => {
    render(
      <MessageBubble message={makeInbound({ attachedFromOrphan: { phoneMatch: "mismatch" } })} />,
    );
    expect(screen.getByText(/Ajouté manuellement depuis un SMS orphelin/)).toBeInTheDocument();
    expect(screen.getByText(/Envoyé depuis un autre numéro/)).toBeInTheDocument();
  });

  it("attachedFromOrphan.phoneMatch === 'not_computable' → mention seule", () => {
    render(
      <MessageBubble
        message={makeInbound({ attachedFromOrphan: { phoneMatch: "not_computable" } })}
      />,
    );
    expect(screen.getByText(/Ajouté manuellement depuis un SMS orphelin/)).toBeInTheDocument();
    expect(screen.queryByText(/Envoyé depuis un autre numéro/)).toBeNull();
  });
});
