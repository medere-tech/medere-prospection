// @vitest-environment jsdom
/**
 * Tests composants vue conversation (VUE-CONVERSATION PR1).
 *
 * Couvre :
 *   - MessageBubble : 3 variantes (Léa / PS / commercial), statut sous
 *     outbound, abandoned grisé « Non envoyé ».
 *   - MessageThread : séparateurs par jour, filtre duplicate (defense-in-depth),
 *     mutation testing.
 *   - ConversationStatusBanner : 5 variants (opt-out, blocked, closed,
 *     handed_off, pas de bandeau sur statut neutre), priorité opt-out.
 *   - ConversationNotMine : nom résolu / fallback.
 *   - ConversationHeader : civilité + nom + spé + ville, pas de téléphone.
 */
import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ConversationHeader } from "@/components/conversations/conversation-header";
import { ConversationNotMine } from "@/components/conversations/conversation-not-mine";
import { ConversationStatusBanner } from "@/components/conversations/conversation-status-banner";
import { MessageBubble } from "@/components/conversations/message-bubble";
import { MessageThread } from "@/components/conversations/message-thread";
import type { MessageProps } from "@/components/conversations/types";

afterEach(() => cleanup());

function makeMsg(partial: Partial<MessageProps>): MessageProps {
  return {
    messageId: "m1",
    direction: "outbound",
    status: "sent",
    body: "Hello",
    generatedBy: "ai",
    createdAtIso: "2026-10-19T10:00:00.000Z",
    sentAtIso: "2026-10-19T10:00:00.000Z",
    commercialName: null,
    ...partial,
  };
}

describe("MessageBubble", () => {
  it("Léa (ai outbound) : rendu + statut 'Envoyé'", () => {
    render(<MessageBubble message={makeMsg({ generatedBy: "ai" })} />);
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByText(/Envoyé/)).toBeInTheDocument();
  });

  it("Commercial (human outbound) : affiche nom résolu", () => {
    render(
      <MessageBubble
        message={makeMsg({ generatedBy: "human", commercialName: "Vanessa Rabba" })}
      />,
    );
    expect(screen.getByText("Vanessa Rabba")).toBeInTheDocument();
  });

  it("PS (inbound) : rendu avec libellé 'Reçu'", () => {
    render(
      <MessageBubble
        message={makeMsg({
          direction: "inbound",
          generatedBy: "human",
          status: "received",
          receivedAtIso: "2026-10-19T10:05:00.000Z",
        })}
      />,
    );
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByText(/Reçu/)).toBeInTheDocument();
  });

  it("abandoned : libellé 'Non envoyé' + style grisé italique", () => {
    render(<MessageBubble message={makeMsg({ status: "abandoned" })} />);
    const label = screen.getByText("Non envoyé");
    expect(label).toBeInTheDocument();
    expect(label.className).toContain("italic");
  });

  it("failed : libellé 'Échec' + style destructive", () => {
    render(<MessageBubble message={makeMsg({ status: "failed" })} />);
    expect(screen.getByText(/Échec/)).toBeInTheDocument();
  });

  it("aria-label composite pour lecteur d'écran", () => {
    render(<MessageBubble message={makeMsg({ body: "Message test" })} />);
    const article = screen.getByRole("article");
    expect(article.getAttribute("aria-label")).toContain("Message test");
    expect(article.getAttribute("aria-label")).toContain("envoyé");
  });
});

describe("MessageThread", () => {
  it("regroupe par jour Europe/Paris + rend chaque bulle", () => {
    const messages: MessageProps[] = [
      makeMsg({ messageId: "m1", body: "Jour 1 - A", createdAtIso: "2026-10-18T10:00:00.000Z" }),
      makeMsg({ messageId: "m2", body: "Jour 2 - A", createdAtIso: "2026-10-19T10:00:00.000Z" }),
    ];
    render(<MessageThread messages={messages} />);
    expect(screen.getByText("Jour 1 - A")).toBeInTheDocument();
    expect(screen.getByText("Jour 2 - A")).toBeInTheDocument();
    // Les 2 jours doivent apparaître en séparateur
    const dayHeaders = screen.getAllByText(/octobre 2026/i);
    expect(dayHeaders.length).toBeGreaterThanOrEqual(2);
  });

  it("sentinelle : un message valide (non-duplicate) est rendu", () => {
    // Les docs `duplicate` sont filtrés UPSTREAM par `sanitizeMessageForBubble`
    // (retourne `null`) + `load-conversation-detail.ts` (strip des nulls).
    // `MessageThread` reçoit UNIQUEMENT des `MessageProps` valides (pas de
    // defense-in-depth no-op embarquée côté composant, cf. finding INFO [1]
    // security-reviewer PR1 corrigé).
    //
    // Le test « duplicate → sanitizeMessageForBubble retourne null » est
    // dans `tests/conversations/no-phone-in-payload.test.ts`.
    // Le test « exclusion duplicate dans la payload complète » est dans
    // `tests/firestore/load-conversation-detail.test.ts`.
    render(<MessageThread messages={[makeMsg({ messageId: "normal", body: "Normal" })]} />);
    expect(screen.getByText("Normal")).toBeInTheDocument();
  });

  it("empty state si aucun message", () => {
    render(<MessageThread messages={[]} />);
    expect(screen.getByText(/Aucun message/i)).toBeInTheDocument();
  });

  it("role='log' + aria-live='polite' sur le container", () => {
    render(<MessageThread messages={[makeMsg({})]} />);
    const log = screen.getByRole("log");
    expect(log).toBeInTheDocument();
    expect(log.getAttribute("aria-live")).toBe("polite");
  });
});

describe("ConversationStatusBanner", () => {
  it("opted_out : destructive avec texte exact", () => {
    render(<ConversationStatusBanner status="opted_out" handoff={null} contactOptedOut={true} />);
    expect(
      screen.getByText(
        /Contact désabonné : aucune sollicitation SMS sans nouveau consentement explicite\./,
      ),
    ).toBeInTheDocument();
  });

  it("contactOptedOut prime sur handed_off (restriction la plus forte)", () => {
    render(
      <ConversationStatusBanner
        status="handed_off"
        handoff={{
          assignedToName: "Vanessa",
          assignedToSlackId: "UVAN1234",
          assignedAtIso: "2026-10-19T09:00:00.000Z",
          contactedAtIso: null,
          acceptedAtIso: null,
        }}
        contactOptedOut={true}
      />,
    );
    expect(screen.getByText(/Contact désabonné/)).toBeInTheDocument();
    expect(screen.queryByText(/Repris par/)).not.toBeInTheDocument();
  });

  it("blocked : texte exact 'Contact bloqué'", () => {
    render(<ConversationStatusBanner status="blocked" handoff={null} contactOptedOut={false} />);
    expect(screen.getByText("Contact bloqué : ne pas recontacter par SMS.")).toBeInTheDocument();
  });

  it("closed : texte 'Conversation clôturée.'", () => {
    render(<ConversationStatusBanner status="closed" handoff={null} contactOptedOut={false} />);
    expect(screen.getByText("Conversation clôturée.")).toBeInTheDocument();
  });

  it("handed_off avec titulaire : texte 'Repris par <nom> le <date>. Léa reste muette.'", () => {
    render(
      <ConversationStatusBanner
        status="handed_off"
        handoff={{
          assignedToName: "Vanessa",
          assignedToSlackId: "UVAN1234",
          assignedAtIso: "2026-10-19T09:00:00.000Z",
          contactedAtIso: null,
          acceptedAtIso: null,
        }}
        contactOptedOut={false}
      />,
    );
    expect(
      screen.getByText(/Repris par Vanessa.*19\/10\/2026.*Léa reste muette/),
    ).toBeInTheDocument();
  });

  it("handed_off sans nom résolu : fallback 'un commercial'", () => {
    render(
      <ConversationStatusBanner
        status="handed_off"
        handoff={{
          assignedToName: null,
          assignedToSlackId: "UXYZ123",
          assignedAtIso: null,
          contactedAtIso: null,
          acceptedAtIso: null,
        }}
        contactOptedOut={false}
      />,
    );
    expect(screen.getByText(/Repris par un commercial/)).toBeInTheDocument();
  });

  it("statut neutre (in_dialogue) : aucun bandeau", () => {
    const { container } = render(
      <ConversationStatusBanner status="in_dialogue" handoff={null} contactOptedOut={false} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("ConversationNotMine", () => {
  it("affiche le nom du titulaire quand résolu", () => {
    render(<ConversationNotMine assignedToName="Vanessa Rabba" />);
    expect(screen.getByText(/suivie par Vanessa Rabba/)).toBeInTheDocument();
  });

  it("fallback 'un autre commercial' quand nom non résolvable", () => {
    render(<ConversationNotMine assignedToName={null} />);
    expect(screen.getByText(/suivie par un autre commercial/)).toBeInTheDocument();
  });
});

describe("ConversationHeader", () => {
  it("affiche civilité + nom + spé + ville, pas de téléphone", () => {
    render(
      <ConversationHeader
        contact={{
          contactId: "x",
          civilite: "Dr",
          firstName: "Jean",
          lastName: "Dupont",
          speciality: "Dentiste",
          city: "Paris",
          optedOut: false,
        }}
        intent="INTERESSE"
      />,
    );
    expect(screen.getByRole("heading")).toHaveTextContent("Dr Jean Dupont");
    expect(screen.getByText("Dentiste")).toBeInTheDocument();
    expect(screen.getByText("Paris")).toBeInTheDocument();
    expect(screen.getByText("Intéressé")).toBeInTheDocument();
    // Pas de téléphone affiché (bouton désactivé)
    const phoneButton = screen.getByRole("button", { name: /Afficher le numéro/ });
    expect(phoneButton).toBeDisabled();
  });

  it("contact sans nom : fallback 'Contact sans nom'", () => {
    render(
      <ConversationHeader
        contact={{
          contactId: "x",
          civilite: null,
          firstName: null,
          lastName: null,
          speciality: null,
          city: null,
          optedOut: false,
        }}
        intent="unknown"
      />,
    );
    expect(screen.getByRole("heading")).toHaveTextContent("Contact sans nom");
  });
});
