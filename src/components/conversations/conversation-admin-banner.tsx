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

/**
 * Règle de visibilité de la bannière, extraite en helper pur pour que la
 * logique soit testable sans monter tout le wrapper client
 * `ConversationDetailClient` (qui dépend de React Query, du routing,
 * etc.). La bannière doit apparaître ssi un admin consulte une conv
 * qu'il ne suit pas lui-même.
 *
 * Table de vérité :
 *   admin  + !isOwner → true   (le cas visé — superviseur sur conv d'un autre)
 *   admin  +  isOwner → false  (admin sur sa propre conv — pas de supervision)
 *   commercial + !isOwner → false  (ne devrait pas arriver, blocké en 403 — fail-safe)
 *   commercial +  isOwner → false  (cas nominal commercial sur sa conv)
 */
export function shouldShowAdminBanner(
  viewerRole: "admin" | "commercial",
  viewerIsOwner: boolean,
): boolean {
  return viewerRole === "admin" && !viewerIsOwner;
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
