"use client";

/**
 * `HandoffContactedAction` — bouton « J'ai contacté le médecin » (PR4 B1).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Contrat
 *
 *   - Rendu UNIQUEMENT si `canMarkContacted` (droit calculé côté serveur
 *     par `loadConversationDetail`, source unique `canMarkHandoffContacted`).
 *   - Désactivé pendant l'appel (anti-double-clic) : la mutation est
 *     bloquée tant que `mutation.isPending`.
 *   - Sur POST 200 : appelle `onAudited()` pour que le parent refetch
 *     le détail, puis déclenche un `toast.success` sonner avec action
 *     « Annuler » et `duration: 10_000`. Le toast est émis par le
 *     système global (`<Toaster />` layout) — INDÉPENDANT du montage
 *     de ce composant. `canMarkContacted` passera à `false` au refetch
 *     et ce composant se démonte, mais le toast reste visible.
 *   - Un clic « Annuler » du toast déclenche un DELETE puis `onAudited()`.
 *   - Erreurs : `clientMessage` serveur pour 403/404/409/429, message
 *     générique sinon → `toast.error`.
 *   - Zéro emoji, zéro symbole décoratif, zéro raccourci clavier.
 *   - Zéro `aria-label` sur le bouton : le texte visible est le nom
 *     accessible (évite de figer un nom qui diverge du label pendant
 *     « Marquage en cours… »).
 */
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

const UNDO_TOAST_MS = 10_000;
const GENERIC_ERROR = "Une erreur est survenue. Réessayez.";

export interface HandoffContactedActionProps {
  conversationId: string;
  canMarkContacted: boolean;
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
    // body non JSON — fallback générique.
  }
  return GENERIC_ERROR;
}

async function mapError(res: Response): Promise<string> {
  if ([403, 404, 409, 429].includes(res.status)) return parseServerMessage(res);
  return GENERIC_ERROR;
}

export function HandoffContactedAction(props: HandoffContactedActionProps) {
  const endpoint = `/api/admin/conversations/${encodeURIComponent(props.conversationId)}/handoff-contacted`;

  const markMutation = useMutation<MarkResponse, Error, void>({
    mutationFn: async () => {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(await mapError(res));
      return (await res.json()) as MarkResponse;
    },
    retry: false,
    onError: (err) => toast.error(err.message),
  });

  const handleUndo = async () => {
    try {
      const res = await fetch(endpoint, {
        method: "DELETE",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(await mapError(res));
      props.onAudited();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : GENERIC_ERROR);
    }
  };

  const handleClick = async () => {
    try {
      await markMutation.mutateAsync();
      props.onAudited();
      // Le toast est émis par le Toaster global — INDÉPENDANT de ce
      // composant. `canMarkContacted` peut passer à `false` au refetch
      // et nous démonter, le toast reste visible pendant `UNDO_TOAST_MS`.
      toast.success("Médecin marqué comme contacté.", {
        action: {
          label: "Annuler",
          onClick: () => {
            void handleUndo();
          },
        },
        duration: UNDO_TOAST_MS,
      });
    } catch {
      // onError (mark) a déjà posé le toast d'erreur.
    }
  };

  if (!props.canMarkContacted) {
    return null;
  }

  const busy = markMutation.isPending;

  return (
    <div className="flex flex-col gap-1" data-testid="handoff-contacted-action">
      <Button type="button" variant="default" onClick={handleClick} disabled={busy}>
        {busy ? "Marquage en cours…" : "J'ai contacté le médecin"}
      </Button>
    </div>
  );
}
