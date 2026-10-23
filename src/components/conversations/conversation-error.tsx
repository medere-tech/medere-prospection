/**
 * État d'erreur de la vue conversation (VUE-CONVERSATION PR1).
 *
 * Message générique côté client (pas de détail technique leaké), bouton
 * « Réessayer » qui déclenche un refetch via la prop `onRetry`.
 */
import { AlertCircle } from "lucide-react";

import { Button } from "@/components/ui/button";

interface Props {
  onRetry: () => void;
}

export function ConversationError({ onRetry }: Props) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center"
    >
      <AlertCircle className="h-8 w-8 text-destructive" aria-hidden="true" />
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">Erreur de chargement</h2>
        <p className="text-sm text-muted-foreground">
          Impossible de charger la conversation pour le moment. Réessayez dans un instant.
        </p>
      </div>
      <Button variant="outline" onClick={onRetry}>
        Réessayer
      </Button>
    </div>
  );
}
