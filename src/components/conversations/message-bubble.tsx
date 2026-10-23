/**
 * Bulle de message dans le fil de la vue conversation
 * (VUE-CONVERSATION PR1).
 *
 * 3 variantes visuelles distinctes :
 *   - **Léa** (`direction=outbound` + `generatedBy=ai`) : fond `muted`,
 *     alignée à droite, initiale « L ».
 *   - **PS** (`direction=inbound`) : fond `card`, alignée à gauche,
 *     initiale lettre du contact — mais on ne connaît pas le nom ici
 *     côté composant, on affiche une initiale générique « • » pour éviter
 *     une PII.
 *   - **Commercial** (`direction=outbound` + `generatedBy=human`) : fond
 *     primary foncé, alignée à droite, nom résolu depuis Airtable
 *     (`commercialName`) ou libellé générique « Commercial ».
 *
 * Statut sous la bulle outbound (envoyé HH:mm / délivré / échec / « Non
 * envoyé » grisé pour `abandoned`). Les docs `duplicate` sont filtrés
 * côté `listMessagesInConversation` + à nouveau côté sanitize — ils ne
 * doivent jamais atteindre ce composant.
 */
import { cn } from "@/lib/utils";
import { formatHourParis } from "@/lib/utils/format-paris";

import type { MessageProps } from "./types";

interface Props {
  message: MessageProps;
}

/** Convertit un statut outbound en libellé FR court. */
function outboundStatusLabel(status: MessageProps["status"], message: MessageProps): string {
  switch (status) {
    case "draft":
      return "Brouillon";
    case "queued":
      return "En file d'attente";
    case "sending":
      return "Envoi en cours";
    case "sent":
      return `Envoyé ${formatHourParis(message.sentAtIso ?? message.createdAtIso)}`;
    case "delivered":
      return `Délivré ${formatHourParis(message.deliveredAtIso ?? message.sentAtIso ?? message.createdAtIso)}`;
    case "failed":
      return "Échec d'envoi";
    case "abandoned":
      return "Non envoyé";
    default:
      return "";
  }
}

export function MessageBubble({ message }: Props) {
  const { direction, generatedBy, status } = message;

  // Détermination de la variante visuelle.
  const isLea = direction === "outbound" && generatedBy === "ai";
  const isCommercial = direction === "outbound" && generatedBy === "human";
  const isInbound = direction === "inbound";

  // Classe de l'avatar + initiale.
  const avatarInitial = isLea ? "L" : isCommercial ? "C" : "•";
  const avatarLabel = isLea
    ? "Léa (IA)"
    : isCommercial
      ? (message.commercialName ?? "Commercial")
      : "Contact";

  // Alignement : outbound (Léa + commercial) à droite, inbound (PS) à gauche.
  const alignRight = !isInbound;

  // Grisé si abandoned (jamais envoyé). Reste visible mais atténué.
  const abandoned = status === "abandoned";

  // Composition de l'aria-label pour lecteur d'écran.
  const timeLabel = formatHourParis(
    message.direction === "inbound"
      ? (message.receivedAtIso ?? message.createdAtIso)
      : (message.sentAtIso ?? message.createdAtIso),
  );
  const srAuthor = isLea
    ? "Léa"
    : isCommercial
      ? (message.commercialName ?? "Commercial")
      : "Contact";
  const srDirectionVerb = isInbound ? "reçu à" : "envoyé à";
  const ariaLabel = `${srAuthor}, ${srDirectionVerb} ${timeLabel} : ${message.body}`;

  return (
    <article
      aria-label={ariaLabel}
      className={cn("flex w-full items-end gap-2", alignRight ? "flex-row-reverse" : "flex-row")}
    >
      {/* Avatar */}
      <div
        aria-hidden="true"
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium uppercase",
          isLea && "border-primary/30 bg-primary/10 text-primary",
          isCommercial && "border-emerald-400/30 bg-emerald-500/10 text-emerald-400",
          isInbound && "border-border bg-card text-muted-foreground",
        )}
        title={avatarLabel}
      >
        {avatarInitial}
      </div>

      {/* Bulle */}
      <div
        className={cn("flex max-w-[75%] flex-col gap-1", alignRight ? "items-end" : "items-start")}
      >
        {/* Nom du commercial au-dessus de la bulle commercial */}
        {isCommercial && message.commercialName ? (
          <span className="px-1 text-xs font-medium text-emerald-400">
            {message.commercialName}
          </span>
        ) : null}

        <div
          className={cn(
            "whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-sm leading-relaxed",
            isLea && "border-primary/20 bg-primary/5 text-foreground",
            isCommercial && "border-emerald-400/30 bg-emerald-500/10 text-foreground",
            isInbound && "border-border bg-card text-foreground",
            abandoned && "border-dashed opacity-60",
          )}
        >
          {message.body}
        </div>

        {/* Statut sous bulle outbound (jamais sous inbound) */}
        {!isInbound ? (
          <span
            className={cn(
              "px-1 text-[11px] text-muted-foreground",
              status === "failed" && "text-destructive",
              status === "abandoned" && "italic",
            )}
          >
            {outboundStatusLabel(status, message)}
          </span>
        ) : (
          <span className="px-1 text-[11px] text-muted-foreground">Reçu {timeLabel}</span>
        )}
      </div>
    </article>
  );
}
