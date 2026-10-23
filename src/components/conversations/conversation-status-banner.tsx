/**
 * Bandeau de statut de la conversation (VUE-CONVERSATION PR1).
 *
 * Variants par statut :
 *   - `opted_out`  → destructive — « Contact désabonné : aucune sollicitation
 *                     SMS sans nouveau consentement explicite. »
 *   - `blocked`    → destructive — « Contact bloqué : ne pas recontacter
 *                     par SMS. »
 *   - `closed`    → neutre      — « Conversation clôturée. »
 *   - `handed_off`→ info        — « Repris par <Prénom> le <date>. Léa
 *                     reste muette. »
 *   - autres statuts (`active`, `awaiting_reply`, `in_dialogue`, `qualified`)
 *                 → PAS DE BANDEAU (null).
 *
 * Priorité : si plusieurs variants pouvaient s'appliquer (ex: handed_off
 * + opted_out), on affiche TOUJOURS `opted_out` d'abord — la restriction
 * la plus forte prime.
 *
 * Accessibilité : `role="status"` + `aria-live="polite"` pour que les
 * lecteurs d'écran annoncent le bandeau en entrant sur la page.
 */
import { AlertTriangle, CheckCircle2, ShieldAlert, UserCheck } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatDateParis } from "@/lib/utils/format-paris";

import type { ConversationDisplayStatus, HandoffDisplayProps } from "./types";

interface Props {
  status: ConversationDisplayStatus;
  handoff: HandoffDisplayProps | null;
  /**
   * `true` si le contact a `consent.optedOut`. Force la bannière opt_out
   * MÊME si la conversation a un autre statut (ex: `handed_off` + opt-out
   * reçu après ⇒ bannière opt-out prime).
   */
  contactOptedOut: boolean;
}

export function ConversationStatusBanner({ status, handoff, contactOptedOut }: Props) {
  // Priorité : opt-out contact > blocked > closed > handed_off > rien.
  const showOptedOut = contactOptedOut || status === "opted_out";

  if (showOptedOut) {
    return (
      <Banner
        role="alert"
        variant="destructive"
        icon={<ShieldAlert className="h-4 w-4" aria-hidden="true" />}
      >
        Contact désabonné : aucune sollicitation SMS sans nouveau consentement explicite.
      </Banner>
    );
  }

  if (status === "blocked") {
    return (
      <Banner
        role="alert"
        variant="destructive"
        icon={<AlertTriangle className="h-4 w-4" aria-hidden="true" />}
      >
        Contact bloqué : ne pas recontacter par SMS.
      </Banner>
    );
  }

  if (status === "closed") {
    return (
      <Banner
        role="status"
        variant="muted"
        icon={<CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
      >
        Conversation clôturée.
      </Banner>
    );
  }

  if (status === "handed_off") {
    const name = handoff?.assignedToName ?? "un commercial";
    const dateLabel = handoff?.assignedAtIso ? ` le ${formatDateParis(handoff.assignedAtIso)}` : "";
    return (
      <Banner
        role="status"
        variant="info"
        icon={<UserCheck className="h-4 w-4" aria-hidden="true" />}
      >
        {`Repris par ${name}${dateLabel}. Léa reste muette.`}
      </Banner>
    );
  }

  return null;
}

/**
 * Bannière interne. Styles alignés sur la palette shadcn (sombre).
 * `role` paramétrable pour choisir entre `role="alert"` (opt-out/blocked)
 * et `role="status"` (closed/handed_off) selon la gravité.
 */
function Banner({
  children,
  role,
  variant,
  icon,
}: {
  children: React.ReactNode;
  role: "alert" | "status";
  variant: "destructive" | "muted" | "info";
  icon: React.ReactNode;
}) {
  return (
    <div
      role={role}
      aria-live={role === "alert" ? "assertive" : "polite"}
      className={cn(
        "flex items-start gap-3 rounded-md border px-4 py-3 text-sm",
        variant === "destructive" &&
          "border-destructive/40 bg-destructive/10 text-destructive-foreground",
        variant === "muted" && "border-border bg-card text-muted-foreground",
        variant === "info" && "border-primary/30 bg-primary/5 text-foreground",
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <p className="leading-relaxed">{children}</p>
    </div>
  );
}
