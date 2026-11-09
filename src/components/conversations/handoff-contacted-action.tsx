"use client";

/**
 * `HandoffContactedAction` — bouton « J'ai contacté le médecin » +
 * toast « Annuler » (PR4 B1).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Contrat
 *
 *   - Rendu UNIQUEMENT si `canMarkContacted` (droit calculé côté serveur
 *     par `loadConversationDetail`, source unique `canMarkHandoffContacted`).
 *   - Désactivé pendant l'appel (anti-double-clic) : la mutation est
 *     bloquée tant que `mutation.isPending`.
 *   - Sur POST 200 : appelle `onAudited()` pour que le parent refetch
 *     le détail (même mécanisme que `RevealPhoneAction`), puis affiche
 *     un toast « Médecin marqué comme contacté. » avec action
 *     « Annuler » pendant 10 secondes.
 *   - Un clic sur « Annuler » du toast déclenche un DELETE sur le même
 *     endpoint et re-appelle `onAudited()`.
 *   - Erreurs : lit `body.error.message` serveur (clientMessage) pour
 *     403, 404, 409, 429 ; message générique « Une erreur est survenue.
 *     Réessayez. » pour tout autre code.
 *   - Zéro emoji, zéro symbole décoratif, zéro raccourci clavier.
 */
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

const UNDO_TOAST_MS = 10_000;
const GENERIC_ERROR = "Une erreur est survenue. Réessayez.";

export interface HandoffContactedActionProps {
  /** docId Firestore — passé au endpoint. */
  conversationId: string;
  /** Rendu conditionné par le serveur (jamais recalculé côté client). */
  canMarkContacted: boolean;
  /** Appelé après chaque mutation réussie — le parent refetch le détail. */
  onAudited: () => void;
}

interface MarkResponse {
  contactedAtIso: string;
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

export function HandoffContactedAction(props: HandoffContactedActionProps) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [toastVisible, setToastVisible] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearUndoTimer = () => {
    if (undoTimerRef.current !== null) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
  };

  useEffect(() => () => clearUndoTimer(), []);

  const endpoint = `/api/admin/conversations/${encodeURIComponent(props.conversationId)}/handoff-contacted`;

  const markMutation = useMutation<MarkResponse, Error, void>({
    mutationFn: async () => {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) {
        if ([403, 404, 409, 429].includes(res.status)) {
          throw new Error(await parseServerMessage(res));
        }
        throw new Error(GENERIC_ERROR);
      }
      return (await res.json()) as MarkResponse;
    },
    retry: false,
    onError: (err) => setErrorMessage(err.message),
  });

  const undoMutation = useMutation<void, Error, void>({
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
      await markMutation.mutateAsync();
      props.onAudited();
      setToastVisible(true);
      clearUndoTimer();
      undoTimerRef.current = setTimeout(() => setToastVisible(false), UNDO_TOAST_MS);
    } catch {
      // onError a posé l'erreur ; rien à révéler.
    }
  };

  const handleUndo = async () => {
    setErrorMessage(null);
    setUndoing(true);
    try {
      await undoMutation.mutateAsync();
      props.onAudited();
      setToastVisible(false);
      clearUndoTimer();
    } catch {
      // onError a posé l'erreur ; le toast reste affiché.
    } finally {
      setUndoing(false);
    }
  };

  if (!props.canMarkContacted) {
    return null;
  }

  const busy = markMutation.isPending;

  return (
    <div className="flex flex-col gap-1" data-testid="handoff-contacted-action">
      <Button
        type="button"
        variant="default"
        onClick={handleClick}
        disabled={busy}
        aria-label="J'ai contacté le médecin"
      >
        {busy ? "Marquage en cours…" : "J'ai contacté le médecin"}
      </Button>
      {errorMessage !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage}
        </p>
      ) : null}
      {toastVisible ? (
        <div
          role="status"
          aria-live="polite"
          className="mt-2 flex flex-wrap items-center gap-3 rounded border border-border bg-card p-2 text-sm"
          data-testid="handoff-contacted-toast"
        >
          <span>Médecin marqué comme contacté.</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleUndo}
            disabled={undoing}
            aria-label="Annuler le marquage"
          >
            {undoing ? "Annulation…" : "Annuler"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
