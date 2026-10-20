/**
 * Bannière info pour l'admin qui ouvre une conversation NON assignée à
 * lui (VUE-CONVERSATION PR1). Permet à l'admin de voir tout tout en
 * sachant qui est le titulaire.
 */
import { Info } from "lucide-react";

interface Props {
  /** Nom du titulaire résolu depuis Airtable. Fallback si non résolvable. */
  assignedToName: string | null;
}

export function ConversationAdminBanner({ assignedToName }: Props) {
  const label = assignedToName ?? "un autre commercial";
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-3 rounded-md border border-primary/30 bg-primary/5 px-4 py-3 text-sm"
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <p className="leading-relaxed">
        Mode admin : conversation suivie par {label}. Vous voyez tout pour la supervision.
      </p>
    </div>
  );
}
