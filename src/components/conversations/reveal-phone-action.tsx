"use client";

/**
 * `RevealPhoneAction` — composant client unique pour révéler un numéro
 * de contact, audité à chaque action (VUE-CONVERSATION PR3 tour 2b).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Un seul composant, deux consommateurs
 *
 *   - En-tête de la vue conversation (`ConversationHeader`) : consomme
 *     `POST /api/admin/conversations/[id]/reveal-phone` (admin OU
 *     commercial titulaire, règle d'accès serveur `revealContactPhone`).
 *   - Colonne « Téléphone » de `/admin/contacts` (`PhoneCell`) : consomme
 *     `POST /api/admin/contacts/[id]/reveal-phone` (admin seul).
 *
 *   Le parent passe l'`endpoint` complet ; le composant ne connaît ni la
 *   conversation ni le contact — juste l'URL et les 4 derniers chiffres
 *   pour le rendu masqué initial.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Invariants anti-PII (brief Déthié)
 *
 *   - Aucun appel réseau avant un clic délibéré (zero-trust shoulder-surf).
 *   - Le numéro vit UNIQUEMENT dans le `useState` local. Jamais dans le
 *     cache React Query (on utilise `useMutation` + state), jamais dans
 *     l'URL, jamais dans `localStorage`. Il disparaît quand on quitte la
 *     page (unmount React).
 *   - Chaque action (afficher / copier / appeler) déclenche son propre
 *     POST (son propre audit `contact_phone_accessed` côté serveur, avec
 *     la méthode correspondante). Si l'audit échoue :
 *       • `navigator.clipboard.writeText` n'est PAS appelé ;
 *       • `window.location.href` n'est PAS modifié.
 *     C'est garanti par la séquence `await fetch → await writeText` dans
 *     la mutation — si fetch rejette, writeText n'est jamais atteint.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rafraîchissement du journal
 *
 *   Le POST reveal-phone ne mute pas `conversation.updatedAt` côté
 *   Firestore (c'est un simple write dans `audit_log`), donc le poll
 *   `/version` ne détecte pas de changement. On expose un callback
 *   `onAudited` que le parent appelle sur chaque succès pour invalider la
 *   query détail → le journal se remet à jour sans reload.
 */
import { useMutation } from "@tanstack/react-query";
import { Copy, Loader2, Phone, PhoneCall } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";

type Method = "display" | "copy" | "call";

interface RevealPhoneResult {
  e164: string;
  display: string;
  optedOut: boolean;
}

export interface RevealPhoneActionProps {
  /**
   * URL absolue du POST `/reveal-phone`. Le composant NE recompose PAS
   * l'URL — c'est au parent de la construire avec le bon id (conv ou
   * contact) pour aller avec la bonne route RBAC.
   */
  endpoint: string;
  /**
   * 4 derniers chiffres du numéro pour l'affichage masqué initial.
   * `null` = le contact n'a pas de `phone.e164` (fail-closed PR3 tour 2b
   * bis quinquies). Le composant rend alors « Numéro indisponible » sans
   * bouton — pas d'appel réseau tentable, pas de 500 côté serveur.
   */
  phoneLast4: string | null;
  /**
   * Appelé après un POST réussi (quel que soit la méthode). Le parent
   * peut s'en servir pour invalider une query (journal) ou pour
   * incrémenter un compteur UI. Pas appelé sur erreur.
   */
  onAudited?: () => void;
  /** Taille shadcn/ui du bouton. Défaut `"default"` pour l'en-tête. */
  size?: "default" | "sm";
}

export function RevealPhoneAction(props: RevealPhoneActionProps): React.ReactElement {
  const [revealed, setRevealed] = React.useState<RevealPhoneResult | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const mutation = useMutation<RevealPhoneResult, RevealError, Method>({
    mutationFn: async (method: Method) => {
      const res = await fetch(props.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        cache: "no-store",
        body: JSON.stringify({ method }),
      });
      if (res.status === 403) {
        throw new RevealError("Vous n'avez pas accès à ce numéro.", 403);
      }
      if (res.status === 429) {
        const retryHeader = res.headers.get("Retry-After") ?? "60";
        const seconds = Number.parseInt(retryHeader, 10) || 60;
        throw new RevealError(`Trop de demandes, réessayez dans ${seconds} secondes.`, 429);
      }
      if (!res.ok) {
        throw new RevealError("Impossible de récupérer le numéro. Réessayez.", res.status);
      }
      return (await res.json()) as RevealPhoneResult;
    },
    onError: (err) => {
      setErrorMessage(
        err instanceof RevealError ? err.message : "Impossible de récupérer le numéro. Réessayez.",
      );
    },
    retry: false,
  });

  const handleDisplay = async () => {
    setErrorMessage(null);
    try {
      const data = await mutation.mutateAsync("display");
      setRevealed(data);
      props.onAudited?.();
    } catch {
      // onError a déjà posé le message ; on ne révèle rien.
    }
  };

  const handleCopy = async () => {
    setErrorMessage(null);
    try {
      // 1) Audit d'abord. Si fetch throw, on sort — clipboard INTACT.
      const data = await mutation.mutateAsync("copy");
      // 2) Clipboard ensuite — jamais atteint si (1) a échoué.
      await navigator.clipboard.writeText(data.e164);
      setRevealed(data);
      props.onAudited?.();
    } catch (err) {
      // Si le fetch a échoué, onError a posé le message. Si c'est le
      // clipboard qui a échoué (permission denied), on remplace par un
      // message dédié — l'audit a bien été écrit mais la copie non.
      if (!(err instanceof RevealError)) {
        setErrorMessage("Impossible de copier le numéro. Vérifiez les permissions du navigateur.");
      }
    }
  };

  const handleCall = async () => {
    setErrorMessage(null);
    try {
      // 1) Audit d'abord. Si fetch throw, on sort — tel: JAMAIS ouvert.
      const data = await mutation.mutateAsync("call");
      // 2) tel: ensuite — jamais atteint si (1) a échoué.
      setRevealed(data);
      props.onAudited?.();
      window.location.href = `tel:${data.e164}`;
    } catch {
      // onError a posé le message.
    }
  };

  const busy = mutation.isPending;
  const size = props.size ?? "default";

  // Fail-closed (PR3 tour 2b bis quinquies) : pas de numéro en base →
  // libellé explicite, pas de bouton (donc pas d'appel réseau tentable).
  if (props.phoneLast4 === null) {
    return (
      <div className="flex flex-col gap-1">
        <span
          className="text-sm text-muted-foreground"
          aria-label="Numéro indisponible pour ce contact"
          data-testid="phone-unavailable"
        >
          Numéro indisponible
        </span>
      </div>
    );
  }

  if (revealed === null) {
    const trimmedLast = props.phoneLast4.length >= 2 ? props.phoneLast4.slice(-2) : "••";
    return (
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm tabular-nums" aria-label="Numéro masqué">
            •• •• •• •• •• {trimmedLast}
          </span>
          <Button
            type="button"
            variant="outline"
            size={size}
            onClick={handleDisplay}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Phone className="size-4" aria-hidden />
            )}
            Afficher le numéro
          </Button>
        </div>
        {errorMessage !== null ? (
          <p role="alert" className="text-xs text-destructive">
            {errorMessage}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span
          data-testid="revealed-phone"
          aria-live="polite"
          className="font-mono text-sm tabular-nums"
        >
          {revealed.display}
        </span>
        <Button type="button" variant="outline" size={size} onClick={handleCopy} disabled={busy}>
          <Copy className="size-4" aria-hidden />
          Copier
        </Button>
        <Button type="button" variant="outline" size={size} onClick={handleCall} disabled={busy}>
          <PhoneCall className="size-4" aria-hidden />
          Appeler
        </Button>
      </div>
      {revealed.optedOut ? (
        <p role="note" className="text-xs text-destructive">
          Ce médecin a demandé l&apos;arrêt des SMS.
        </p>
      ) : null}
      {errorMessage !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}

class RevealError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "RevealError";
    this.status = status;
  }
}
