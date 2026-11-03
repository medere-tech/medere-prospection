"use client";

/**
 * Dialog « Classer sans suite » (PR2c tour 2b bloc B).
 *
 *   - 3 motifs figés (enum fermé) via la table FR unique
 *     `ORPHAN_DISMISS_LABELS` / `ORPHAN_DISMISS_EXPLANATIONS`.
 *   - Pas de réponse par défaut : l'admin DOIT choisir avant de pouvoir
 *     confirmer.
 *   - Toast FR via sonner (success / error).
 */
import { useState } from "react";
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

import {
  ORPHAN_DISMISS_EXPLANATIONS,
  ORPHAN_DISMISS_LABELS,
  type OrphanDismissReason,
} from "./orphan-labels";
import { TOAST_MESSAGES, useDismissOrphan } from "./use-orphans";

const DISMISS_REASONS: readonly OrphanDismissReason[] = [
  "unrelated_or_spam",
  "already_handled_elsewhere",
  "sender_not_identifiable",
] as const;

export interface DismissDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly orphanDocId: string;
  readonly onSuccess?: () => void;
}

export function DismissDialog({ open, onOpenChange, orphanDocId, onSuccess }: DismissDialogProps) {
  const [reason, setReason] = useState<OrphanDismissReason | null>(null);

  const mutation = useDismissOrphan({
    onSuccess: () => {
      toast.success(TOAST_MESSAGES.dismissSuccess);
      onOpenChange(false);
      onSuccess?.();
    },
    onError: (err) => {
      toast.error(err.message || TOAST_MESSAGES.dismissError);
    },
  });

  function handleConfirm() {
    if (reason === null) return;
    mutation.mutate({ orphanDocId, dismissReason: reason });
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) setReason(null);
    onOpenChange(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Classer ce SMS sans suite</DialogTitle>
          <DialogDescription>
            Choisissez pourquoi ce SMS n&apos;est pas rattaché à une conversation. Vous pourrez le
            remettre à traiter plus tard si besoin.
          </DialogDescription>
        </DialogHeader>

        <div role="radiogroup" aria-label="Motif de classement" className="flex flex-col gap-2">
          {DISMISS_REASONS.map((r) => {
            const checked = reason === r;
            const inputId = `dismiss-reason-${r}`;
            return (
              <label
                key={r}
                htmlFor={inputId}
                className={
                  "flex cursor-pointer flex-col rounded-md border px-3 py-2 text-sm transition-colors " +
                  (checked
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/40")
                }
              >
                <div className="flex items-center gap-2">
                  <input
                    id={inputId}
                    type="radio"
                    name="dismiss-reason"
                    value={r}
                    checked={checked}
                    onChange={() => setReason(r)}
                    className="size-4"
                  />
                  <span className="font-medium">{ORPHAN_DISMISS_LABELS[r]}</span>
                </div>
                <span className="pl-6 text-xs text-muted-foreground">
                  {ORPHAN_DISMISS_EXPLANATIONS[r]}
                </span>
              </label>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Annuler
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={reason === null || mutation.isPending}
            aria-disabled={reason === null || mutation.isPending}
          >
            {mutation.isPending ? "Classement en cours…" : "Classer sans suite"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
