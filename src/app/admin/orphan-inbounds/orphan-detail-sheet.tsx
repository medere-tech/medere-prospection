"use client";

/**
 * Tiroir de détail d'un SMS orphelin (PR2c tour 2b bloc B).
 *
 *   - S'ouvre via l'état URL `?id=<docId>` (lien Slack du canal orphelins).
 *   - Charge `/api/admin/orphan-inbounds/<id>` (hook `useOrphanDetail`).
 *   - Historique : lecture directe des champs du doc (`attachment`,
 *     `dismissal`) sans query audits séparée — tout ce dont la vue a
 *     besoin est déjà sur le doc après `attach` ou `dismiss`.
 *   - Actions : rattacher / classer (pending), remettre à traiter
 *     (dismissed), aucune (attached — doc figé).
 */
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { formatDateTimeParis } from "@/lib/utils/format-paris";

import { AttachDialog } from "./attach-dialog";
import { DismissDialog } from "./dismiss-dialog";
import {
  ORPHAN_DISMISS_LABELS,
  ORPHAN_PHONE_MATCH_EXPLANATIONS,
  ORPHAN_PHONE_MATCH_LABELS,
  ORPHAN_REASON_EXPLANATIONS,
  ORPHAN_REASON_LABELS,
  ORPHAN_STATE_LABELS,
  ORPHAN_UNKNOWN_ADMIN_LABEL,
  UNKNOWN_SENDER_LABEL,
} from "./orphan-labels";
import {
  OrphanDetailNotFoundError,
  TOAST_MESSAGES,
  useOrphanDetail,
  useReopenOrphan,
} from "./use-orphans";

export interface OrphanDetailSheetProps {
  readonly docId: string | null;
  readonly onClose: () => void;
}

export function OrphanDetailSheet({ docId, onClose }: OrphanDetailSheetProps) {
  const query = useOrphanDetail(docId);
  const orphan = query.data?.orphan;

  const [attachOpen, setAttachOpen] = useState(false);
  const [dismissOpen, setDismissOpen] = useState(false);

  const reopen = useReopenOrphan({
    onSuccess: () => toast.success(TOAST_MESSAGES.reopenSuccess),
    onError: (err) => toast.error(err.message || TOAST_MESSAGES.reopenError),
  });

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) onClose();
  }

  const senderName = orphan?.contact?.displayName ?? UNKNOWN_SENDER_LABEL;
  const senderSub = orphan
    ? [orphan.contact?.speciality, orphan.contact?.city]
        .filter((x): x is string => typeof x === "string" && x.length > 0)
        .join(" · ")
    : "";

  return (
    <>
      <Sheet open={docId !== null} onOpenChange={handleOpenChange}>
        <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-md">
          <SheetHeader className="border-b">
            <SheetTitle>Détail du SMS orphelin</SheetTitle>
            <SheetDescription>
              Décidez de rattacher ce SMS à une conversation, de le classer sans suite, ou de le
              remettre à traiter.
            </SheetDescription>
          </SheetHeader>

          <div className="flex flex-col gap-4 p-4 text-sm">
            {query.isLoading && (
              <p className="text-muted-foreground" aria-live="polite">
                Chargement…
              </p>
            )}
            {query.isError && query.error instanceof OrphanDetailNotFoundError && (
              <div
                role="status"
                aria-live="polite"
                className="flex flex-col items-start gap-3 rounded-md border border-dashed p-4"
              >
                <p className="text-sm text-muted-foreground">
                  Ce SMS orphelin est introuvable. Le lien est peut-être ancien.
                </p>
                <Button variant="outline" size="sm" onClick={onClose}>
                  Fermer
                </Button>
              </div>
            )}
            {query.isError && !(query.error instanceof OrphanDetailNotFoundError) && (
              <p role="alert" className="text-destructive">
                Impossible de charger ce SMS orphelin. Fermez le tiroir puis réessayez.
              </p>
            )}
            {orphan && (
              <>
                <section aria-label="Statut">
                  <Badge
                    variant={
                      orphan.processingState === "pending"
                        ? "default"
                        : orphan.processingState === "attached"
                          ? "secondary"
                          : "outline"
                    }
                  >
                    {ORPHAN_STATE_LABELS[orphan.processingState]}
                  </Badge>
                </section>

                <section aria-label="Motif" className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">Motif</span>
                  <span className="font-medium">{ORPHAN_REASON_LABELS[orphan.reason]}</span>
                  <p className="text-xs text-muted-foreground">
                    {ORPHAN_REASON_EXPLANATIONS[orphan.reason]}
                  </p>
                </section>

                <section aria-label="Médecin" className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">Médecin</span>
                  <span className="font-medium">{senderName}</span>
                  {senderSub && <span className="text-xs text-muted-foreground">{senderSub}</span>}
                  {orphan.contact?.optedOut && (
                    <Badge variant="destructive" className="w-fit">
                      Désabonné
                    </Badge>
                  )}
                </section>

                <section aria-label="Texte du SMS" className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">Texte complet</span>
                  <div className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3">
                    {orphan.body.trim().length > 0 ? (
                      orphan.body
                    ) : (
                      <span className="italic text-muted-foreground">Aucun texte lisible.</span>
                    )}
                  </div>
                </section>

                <section aria-label="Réception" className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">Reçu le</span>
                  <span className="tabular-nums">
                    {formatDateTimeParis(new Date(orphan.receivedAtIso))}
                  </span>
                </section>

                {orphan.attachment && (
                  <section
                    aria-label="Historique du rattachement"
                    className="flex flex-col gap-1 rounded-md border bg-muted/20 p-3"
                  >
                    <span className="text-xs font-medium text-muted-foreground">Rattachement</span>
                    <p>
                      Rattaché à la{" "}
                      <Link
                        href={`/admin/conversations/${encodeURIComponent(
                          orphan.attachment.conversationId,
                        )}`}
                        className="font-medium underline underline-offset-2"
                      >
                        conversation du médecin
                      </Link>{" "}
                      par{" "}
                      <strong>
                        {orphan.attachment.attachedByName ?? ORPHAN_UNKNOWN_ADMIN_LABEL}
                      </strong>{" "}
                      le{" "}
                      <span className="tabular-nums">
                        {formatDateTimeParis(new Date(orphan.attachment.attachedAtIso))}
                      </span>
                      .
                    </p>
                    <div className="flex flex-col gap-0.5">
                      <Badge variant="outline" className="w-fit">
                        {ORPHAN_PHONE_MATCH_LABELS[orphan.attachment.phoneMatch]}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {ORPHAN_PHONE_MATCH_EXPLANATIONS[orphan.attachment.phoneMatch]}
                      </span>
                    </div>
                  </section>
                )}

                {orphan.dismissal && (
                  <section
                    aria-label="Historique du classement"
                    className="flex flex-col gap-1 rounded-md border bg-muted/20 p-3"
                  >
                    <span className="text-xs font-medium text-muted-foreground">Classement</span>
                    <p>
                      Classé sans suite par{" "}
                      <strong>
                        {orphan.dismissal.dismissedByName ?? ORPHAN_UNKNOWN_ADMIN_LABEL}
                      </strong>{" "}
                      le{" "}
                      <span className="tabular-nums">
                        {formatDateTimeParis(new Date(orphan.dismissal.dismissedAtIso))}
                      </span>
                      . Motif : <strong>{ORPHAN_DISMISS_LABELS[orphan.dismissal.reason]}</strong>.
                    </p>
                    {orphan.processingState === "pending" && (
                      <p className="text-xs text-muted-foreground">
                        Ce SMS a ensuite été remis à traiter.
                      </p>
                    )}
                  </section>
                )}
              </>
            )}
          </div>

          {orphan && orphan.processingState === "pending" && (
            <SheetFooter className="border-t">
              <Button variant="outline" onClick={() => setDismissOpen(true)}>
                Classer sans suite
              </Button>
              <Button onClick={() => setAttachOpen(true)}>Rattacher…</Button>
            </SheetFooter>
          )}
          {orphan && orphan.processingState === "dismissed" && (
            <SheetFooter className="border-t">
              <Button
                variant="outline"
                onClick={() => reopen.mutate({ orphanDocId: orphan.docId })}
                disabled={reopen.isPending}
              >
                {reopen.isPending ? "Remise en cours…" : "Remettre à traiter"}
              </Button>
            </SheetFooter>
          )}
        </SheetContent>
      </Sheet>

      {orphan && (
        <>
          <AttachDialog
            open={attachOpen}
            onOpenChange={setAttachOpen}
            orphanDocId={orphan.docId}
            orphanBody={orphan.body}
          />
          <DismissDialog
            open={dismissOpen}
            onOpenChange={setDismissOpen}
            orphanDocId={orphan.docId}
          />
        </>
      )}
    </>
  );
}
