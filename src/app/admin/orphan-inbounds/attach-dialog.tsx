"use client";

/**
 * Dialog « Rattacher à une conversation » (PR2c tour 2b bloc B).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Flux en 3 étapes
 *
 *   1. **Choix conversation** : recherche par nom via l'API DÉJÀ EXISTANTE
 *      `/api/admin/conversations?q=<name>&limit=10` (admin voit tout).
 *      Pas de nouvelle recherche serveur — réutilise la même source que
 *      `/admin/conversations` (page liste). Min 2 chars, debounce 300 ms.
 *
 *   2. **Question opt-out OBLIGATOIRE** : « Ce SMS demande-t-il l'arrêt
 *      des sollicitations ? » Oui / Non, SANS valeur par défaut.
 *      ⚠ Si `isOptOut(orphan.body)` (détecteur partagé serveur) renvoie
 *      `true`, la réponse est imposée à « Oui » avec une explication
 *      visible. Le serveur applique l'opt-out de toute façon — un
 *      client ne peut JAMAIS annuler un STOP détecté (invariant L.34-5
 *      CPCE enforced dans `attachOrphanToConversation`).
 *
 *   3. **Écran de confirmation** : phrase explicite nommant la destination
 *      de la notification (titulaire vs canal orphelins), rappel « Action
 *      définitive. » et « Léa ne répondra pas. ». Le bouton « Rattacher
 *      définitivement » est désactivé tant que le body de l'orphan est
 *      vide (cas `parse_failed` sans payload — refusé côté serveur de
 *      toute façon, défense en profondeur UI).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Toasts FR et erreur serveur
 *
 *   `toast.success` sur réussite, `toast.error` sur erreur en reprenant
 *   le `clientMessage` quand il est fourni par `AppError.toClientBody`.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { isOptOut } from "@/lib/compliance/opt-out";
import { describeAttachNotifyTargetForUi } from "@/lib/slack/orphan-notify-target";

import { UNKNOWN_SENDER_LABEL } from "./orphan-labels";
import { TOAST_MESSAGES, useAttachOrphan } from "./use-orphans";

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_MIN_CHARS = 2;

/** Shape minimale lue de `/api/admin/conversations?q=` — on ne consomme
 * que les champs nécessaires pour l'affichage. */
interface ConversationSearchHit {
  readonly conversationId: string;
  readonly contactDisplayName: string | null;
  readonly contactSpecialty: string | null;
  readonly contactCity: string | null;
  /** Slack userId du titulaire — passé à `describeAttachNotifyTargetForUi`. */
  readonly assignedTo: string | null;
  /** Nom pro du titulaire pré-résolu côté serveur (`null` si pas de titulaire). */
  readonly assignedToName: string | null;
}

interface ConversationSearchResponse {
  readonly items: readonly ConversationSearchHit[];
}

async function searchConversations(
  q: string,
  signal: AbortSignal,
): Promise<readonly ConversationSearchHit[]> {
  if (q.trim().length < SEARCH_MIN_CHARS) return [];
  const params = new URLSearchParams({ q, limit: "10" });
  const res = await fetch(`/api/admin/conversations?${params.toString()}`, {
    signal,
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as ConversationSearchResponse;
  return data.items;
}

export interface AttachDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly orphanDocId: string;
  readonly orphanBody: string;
  readonly onSuccess?: () => void;
}

/**
 * Corps interne — tout l'état local est réinitialisé via la `key` que
 * `<AttachDialog>` passe sur ce composant (`${open}:${orphanDocId}`). On
 * évite ainsi tout `setState` dans un `useEffect` (lint
 * `react-hooks/set-state-in-effect`) : l'ouverture, la fermeture ou le
 * changement d'orphan remonte le composant, qui récupère les valeurs
 * initiales lazy (`useState(() => …)`) basées sur les props.
 */
function AttachDialogBody({
  onOpenChange,
  orphanDocId,
  orphanBody,
  onSuccess,
}: Omit<AttachDialogProps, "open"> & { onSuccess?: () => void }) {
  const detectorSaysOptOut = useMemo(() => isOptOut(orphanBody), [orphanBody]);
  const bodyIsEmpty = orphanBody.trim().length === 0;

  const [step, setStep] = useState<"pick-conv" | "ask-opt-out" | "confirm">("pick-conv");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ConversationSearchHit | null>(null);
  // Initialisation lazy : si le détecteur signale un STOP, on pré-coche
  // Oui ; sinon rien par défaut (invariant « pas de valeur par défaut
  // sur une question d'opt-out »).
  const [optOutAnswer, setOptOutAnswer] = useState<boolean | null>(() =>
    detectorSaysOptOut ? true : null,
  );

  // Debounce manuel — même pattern que `conversations-search-input.tsx`.
  // Seul `setDebouncedQuery` reste dans un effet ; cela ne concerne pas
  // la règle `set-state-in-effect` car l'effet ne fait que programmer un
  // timer, et il réalise la synchro externe (fenêtre → debouncé).
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [query]);

  // Fetch recherche conv via TanStack Query : plus de setState dans un
  // effet pour `results`/`searching`/`searchError`. L'état dérive
  // automatiquement de `useQuery`.
  const searchQuery = useQuery<readonly ConversationSearchHit[], Error>({
    queryKey: ["admin", "conversations", "search-for-orphan", debouncedQuery],
    queryFn: async ({ signal }) => searchConversations(debouncedQuery, signal),
    enabled: step === "pick-conv" && debouncedQuery.trim().length >= SEARCH_MIN_CHARS,
    staleTime: 15_000,
    retry: 1,
  });
  const results: readonly ConversationSearchHit[] = searchQuery.data ?? [];
  const searching = searchQuery.isFetching;
  const searchError = searchQuery.isError ? "Recherche impossible. Réessayez." : null;

  const mutation = useAttachOrphan({
    onSuccess: (result) => {
      toast.success(
        result.wasOptOut
          ? "SMS rattaché à la conversation. Désabonnement appliqué."
          : TOAST_MESSAGES.attachSuccess,
      );
      onOpenChange(false);
      onSuccess?.();
    },
    onError: (err) => {
      toast.error(err.message || TOAST_MESSAGES.attachError);
    },
  });

  function handleOpenChange(nextOpen: boolean) {
    if (mutation.isPending) return;
    onOpenChange(nextOpen);
  }

  function handlePickConversation(hit: ConversationSearchHit) {
    setSelected(hit);
    setStep("ask-opt-out");
  }

  function handleOptOutAnswer(answer: boolean) {
    if (detectorSaysOptOut) return; // Oui est imposé.
    setOptOutAnswer(answer);
  }

  function handleGoToConfirm() {
    if (optOutAnswer === null) return;
    setStep("confirm");
  }

  function handleConfirm() {
    if (bodyIsEmpty) return;
    if (selected === null) return;
    if (optOutAnswer === null && !detectorSaysOptOut) return;
    mutation.mutate({
      orphanDocId,
      conversationId: selected.conversationId,
      optOutConfirmed: detectorSaysOptOut ? true : (optOutAnswer ?? false),
    });
  }

  // PR2c tour 2b bloc B — même règle que `resolveOrphanNotifyTarget`
  // côté serveur (factorisation via `resolveTargetKind`). Si la
  // conversation a un titulaire, on le nomme ; sinon on nomme « le
  // canal des SMS orphelins ». L'actor est forcément non-testAccount
  // (un admin réel qui ouvre cette page) — pour un compte test, le
  // serveur route réellement vers le canal de test ; côté UI c'est le
  // même libellé générique « le canal de test ».
  const notificationDestinationLabel = selected
    ? describeAttachNotifyTargetForUi({
        actorTestAccount: false,
        assignedToName: selected.assignedToName,
        assignedToSlackUserId: selected.assignedTo ?? undefined,
      })
    : "";

  return (
    <DialogContent className="max-w-xl">
      {step === "pick-conv" && (
        <>
          <DialogHeader>
            <DialogTitle>Rattacher ce SMS à une conversation</DialogTitle>
            <DialogDescription>
              Recherchez la conversation du médecin par son nom. Tapez au moins 2 lettres.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Input
              aria-label="Recherche par nom du médecin"
              placeholder="Nom du médecin (ex. Dupont)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            {searchError && (
              <p role="alert" className="text-sm text-destructive">
                {searchError}
              </p>
            )}
            <ul
              role="listbox"
              aria-label="Résultats de recherche"
              className="flex max-h-72 flex-col gap-1 overflow-y-auto"
            >
              {debouncedQuery.trim().length < SEARCH_MIN_CHARS && (
                <li className="text-sm text-muted-foreground">Tapez le début du nom du médecin.</li>
              )}
              {debouncedQuery.trim().length >= SEARCH_MIN_CHARS &&
                !searching &&
                results.length === 0 &&
                !searchError && (
                  <li className="text-sm text-muted-foreground">
                    Aucun médecin ne correspond à « {debouncedQuery.trim()} ».
                  </li>
                )}
              {searching && <li className="text-sm text-muted-foreground">Recherche…</li>}
              {results.map((hit) => {
                const name = hit.contactDisplayName ?? UNKNOWN_SENDER_LABEL;
                const sub = [hit.contactSpecialty, hit.contactCity]
                  .filter((x): x is string => typeof x === "string" && x.length > 0)
                  .join(" · ");
                return (
                  <li key={hit.conversationId}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={() => handlePickConversation(hit)}
                      className="flex w-full flex-col rounded-md border border-border px-3 py-2 text-left transition-colors hover:border-primary/40"
                    >
                      <span className="text-sm font-medium">{name}</span>
                      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              Annuler
            </Button>
          </DialogFooter>
        </>
      )}

      {step === "ask-opt-out" && selected && (
        <>
          <DialogHeader>
            <DialogTitle>Désabonnement du médecin ?</DialogTitle>
            <DialogDescription>
              Ce SMS demande-t-il l&apos;arrêt des sollicitations ?
            </DialogDescription>
          </DialogHeader>
          {detectorSaysOptOut ? (
            <p
              role="status"
              aria-live="polite"
              className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
            >
              Le texte contient un mot-clé d&apos;arrêt (par exemple « STOP »). La réponse « Oui »
              est imposée : nous ne solliciterons plus ce médecin.
            </p>
          ) : (
            <div role="radiogroup" aria-label="Désabonnement" className="flex flex-col gap-2">
              <label
                htmlFor="opt-out-yes"
                className={
                  "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm " +
                  (optOutAnswer === true
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/40")
                }
              >
                <input
                  id="opt-out-yes"
                  type="radio"
                  name="opt-out-answer"
                  checked={optOutAnswer === true}
                  onChange={() => handleOptOutAnswer(true)}
                  className="size-4"
                />
                <span>Oui, ne plus solliciter ce médecin</span>
              </label>
              <label
                htmlFor="opt-out-no"
                className={
                  "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm " +
                  (optOutAnswer === false
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/40")
                }
              >
                <input
                  id="opt-out-no"
                  type="radio"
                  name="opt-out-answer"
                  checked={optOutAnswer === false}
                  onChange={() => handleOptOutAnswer(false)}
                  className="size-4"
                />
                <span>Non, le médecin reste joignable</span>
              </label>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setStep("pick-conv")}>
              Retour
            </Button>
            <Button
              onClick={handleGoToConfirm}
              disabled={optOutAnswer === null}
              aria-disabled={optOutAnswer === null}
            >
              Continuer
            </Button>
          </DialogFooter>
        </>
      )}

      {step === "confirm" && selected && (
        <>
          <DialogHeader>
            <DialogTitle>Rattacher définitivement ?</DialogTitle>
            <DialogDescription>
              Le SMS sera ajouté au fil de{" "}
              <strong>{selected.contactDisplayName ?? UNKNOWN_SENDER_LABEL}</strong>. Léa ne
              répondra pas. <strong>{notificationDestinationLabel}</strong> sera prévenu. Action
              définitive.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Texte du SMS</span>
            {bodyIsEmpty ? (
              <span className="italic text-muted-foreground">
                Aucun texte lisible. Le rattachement n&apos;est pas possible — classez ce SMS sans
                suite à la place.
              </span>
            ) : (
              <span className="whitespace-pre-wrap">{orphanBody}</span>
            )}
          </div>
          {(detectorSaysOptOut || optOutAnswer === true) && (
            <p className="text-xs text-muted-foreground">
              Le désabonnement sera appliqué dans la même opération.
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setStep("ask-opt-out")}
              disabled={mutation.isPending}
            >
              Retour
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={bodyIsEmpty || mutation.isPending}
              aria-disabled={bodyIsEmpty || mutation.isPending}
            >
              {mutation.isPending ? "Rattachement en cours…" : "Rattacher définitivement"}
            </Button>
          </DialogFooter>
        </>
      )}
    </DialogContent>
  );
}

/**
 * Wrapper du dialog. `key={open ? "open:…" : "closed"}` remonte le
 * composant interne à chaque réouverture → l'état local repart à zéro
 * sans `useEffect` de reset (lint `set-state-in-effect` respecté).
 */
export function AttachDialog({
  open,
  onOpenChange,
  orphanDocId,
  orphanBody,
  onSuccess,
}: AttachDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <AttachDialogBody
          key={`open:${orphanDocId}`}
          onOpenChange={onOpenChange}
          orphanDocId={orphanDocId}
          orphanBody={orphanBody}
          onSuccess={onSuccess}
        />
      )}
    </Dialog>
  );
}
