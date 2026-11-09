"use client";

/**
 * `HandoffContactedUndoButton` — bouton « Annuler le contact » du
 * panneau latéral (PR4 B1).
 *
 * Distinct de `HandoffContactedAction` (bouton d'en-tête + toast) :
 * celui-ci est un contrôle persistant du panneau, visible seulement
 * quand `canUndoContact` est vrai (droit calculé serveur).
 *
 * Même mapping d'erreurs (403/404/409/429 → `clientMessage` serveur,
 * autre → « Une erreur est survenue. Réessayez. »), même anti-double-clic.
 */
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";

const GENERIC_ERROR = "Une erreur est survenue. Réessayez.";

export interface HandoffContactedUndoButtonProps {
  conversationId: string;
  onAudited: () => void;
}

interface ServerError {
  error?: { message?: string };
}

async function parseServerMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ServerError;
    const msg = body?.error?.message;
    if (typeof msg === "string" && msg.length > 0) return msg;
  } catch {
    // body non JSON — on tombe sur le générique.
  }
  return GENERIC_ERROR;
}

export function HandoffContactedUndoButton(props: HandoffContactedUndoButtonProps) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const endpoint = `/api/admin/conversations/${encodeURIComponent(props.conversationId)}/handoff-contacted`;

  const mutation = useMutation<void, Error, void>({
    mutationFn: async () => {
      const res = await fetch(endpoint, {
        method: "DELETE",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) {
        if ([403, 404, 409, 429].includes(res.status)) {
          throw new Error(await parseServerMessage(res));
        }
        throw new Error(GENERIC_ERROR);
      }
    },
    retry: false,
    onError: (err) => setErrorMessage(err.message),
  });

  const handleClick = async () => {
    setErrorMessage(null);
    try {
      await mutation.mutateAsync();
      props.onAudited();
    } catch {
      // onError a posé l'erreur.
    }
  };

  const busy = mutation.isPending;

  return (
    <div className="flex flex-col gap-1" data-testid="handoff-contacted-undo">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleClick}
        disabled={busy}
        aria-label="Annuler le contact"
      >
        {busy ? "Annulation…" : "Annuler le contact"}
      </Button>
      {errorMessage !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
