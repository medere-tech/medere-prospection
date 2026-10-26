"use client";

/**
 * Bandeau "N nouvelles conversations" — PR2b-2 P3.
 *
 * - Rendu uniquement si `visible === true`.
 * - `delta > 0` → "{delta} nouvelle(s) conversation(s)".
 * - Sinon → "La liste a été mise à jour".
 * - `aria-live="polite"` : le lecteur d'écran annonce sans voler le focus.
 * - Bouton "Afficher" déclenche `onShow()` (parent : reset cursor, refetch,
 *   acknowledge watch, mask banner).
 *
 * Jamais de reorganisation automatique de la liste sous le curseur : le
 * banner est additif, l'utilisateur décide.
 */
import { Button } from "@/components/ui/button";

export interface RefreshBannerProps {
  readonly visible: boolean;
  readonly delta: number | null;
  readonly onShow: () => void;
}

export function RefreshBanner({ visible, delta, onShow }: RefreshBannerProps) {
  if (!visible) return null;
  const message =
    typeof delta === "number" && delta > 0
      ? `${delta} nouvelle${delta > 1 ? "s" : ""} conversation${delta > 1 ? "s" : ""}`
      : "La liste a été mise à jour";
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`${message}. Cliquez sur Afficher pour mettre à jour la liste.`}
      className="flex items-center justify-between gap-3 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm"
    >
      <span className="font-medium text-foreground">{message}</span>
      <Button
        type="button"
        size="sm"
        onClick={onShow}
        aria-label="Afficher les nouvelles conversations"
      >
        Afficher
      </Button>
    </div>
  );
}
