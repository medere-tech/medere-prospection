"use client";

/**
 * Modal preview + send pour le 1er SMS d'un contact (S10.1.5 Phase 4).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Flow utilisateur :
 *
 *   1. Parent ouvre le dialog en setant `contactId` (string non-null).
 *   2. useEffect : fetch POST /api/admin/preview-first-sms → affiche
 *      smsBody (monospace), reasoning, charCount, badge preSendCheck.
 *   3. Si preSendCheck OK : bouton "Envoyer" actif. Sinon : disabled +
 *      message d'avertissement clair (badge KO + code/rule).
 *   4. Clic "Envoyer" : AlertDialog confirm ("Cette action enverra
 *      réellement un SMS via OVH..."). Si confirm :
 *      POST /api/admin/send-first-sms { contactId, confirm: true }.
 *      Toast sonner success/error + ferme la modal au succès.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Sécurité / Compliance :
 *
 *   - Le `smsBody` retourné par l'API est le RÉEL body qui sera envoyé
 *     (single source of truth `generateFirstSms`, sentinelle S10.1.4.c
 *     "preview = send"). Aucune divergence possible.
 *   - `preSendCheckPassed` reflète le pre-check S5 complet (9 règles).
 *     Le bouton "Envoyer" est désactivé si KO — défense en profondeur
 *     UI (le handler Inngest re-check de toute façon).
 *   - Toasts sonner ne loggent PAS de PII (juste smsCharCount, code,
 *     status — pas le body, pas le phone).
 */
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

// ─────────────────────────────────────────────────────────────────────────────
// Types alignés sur les routes API S10.1.4.b/c
// ─────────────────────────────────────────────────────────────────────────────

interface PreviewResponse {
  smsBody: string;
  reasoning: string;
  charCount: number;
  preSendCheckPassed: boolean;
  preSendCheckCode?: string;
  preSendCheckRule?: string;
}

interface SendResponse {
  jobId: string;
  status: "queued";
  contactId: string;
  smsCharCount: number;
}

interface ApiError {
  error: { code: string; message: string };
}

type PreviewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; data: PreviewResponse }
  | { kind: "error"; message: string; status: number };

// ─────────────────────────────────────────────────────────────────────────────
// Helpers fetch (manuel — pas de TanStack Query, cf. décision B1)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchPreview(contactId: string, signal: AbortSignal): Promise<PreviewState> {
  try {
    const res = await fetch("/api/admin/preview-first-sms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contactId }),
      signal,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as ApiError | null;
      const message = body?.error?.message ?? `Erreur ${res.status}`;
      return { kind: "error", message, status: res.status };
    }
    const data = (await res.json()) as PreviewResponse;
    return { kind: "success", data };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { kind: "idle" };
    }
    return { kind: "error", message: "Erreur réseau. Réessayez.", status: 0 };
  }
}

async function fetchSend(
  contactId: string,
): Promise<{ ok: true; data: SendResponse } | { ok: false; message: string; status: number }> {
  try {
    const res = await fetch("/api/admin/send-first-sms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contactId, confirm: true }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as ApiError | null;
      return {
        ok: false,
        message: body?.error?.message ?? `Erreur ${res.status}`,
        status: res.status,
      };
    }
    const data = (await res.json()) as SendResponse;
    return { ok: true, data };
  } catch {
    return { ok: false, message: "Erreur réseau. Réessayez.", status: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PreviewDialog
// ─────────────────────────────────────────────────────────────────────────────

export interface PreviewDialogProps {
  /** `null` = closed. Une string non-null déclenche le fetch preview. */
  contactId: string | null;
  /** Callback fermeture (parent reset son state à null). */
  onClose: () => void;
  /** Callback optionnel après send success (parent peut refresh la table). */
  onSendSuccess?: () => void;
}

/**
 * Wrapper. Le content interne reçoit `key={contactId}` → remount complet à
 * chaque change, le state initial `"loading"` est posé via `useState` lazy
 * sans setState synchrone dans `useEffect` (pattern React Compiler /
 * React 19 friendly).
 */
export function PreviewDialog({ contactId, onClose, onSendSuccess }: PreviewDialogProps) {
  return (
    <Dialog open={contactId !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        {contactId !== null ? (
          <PreviewDialogContent
            key={contactId}
            contactId={contactId}
            onClose={onClose}
            onSendSuccess={onSendSuccess}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

interface PreviewDialogContentProps {
  contactId: string;
  onClose: () => void;
  onSendSuccess?: () => void;
}

function PreviewDialogContent({ contactId, onClose, onSendSuccess }: PreviewDialogContentProps) {
  // `useState` initial `"loading"` — pas de setState synchrone nécessaire
  // dans `useEffect`. Le remount via `key={contactId}` côté parent reset
  // automatiquement à "loading" lors d'un changement de contactId.
  const [state, setState] = useState<PreviewState>({ kind: "loading" });
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    void fetchPreview(contactId, ac.signal).then((next) => {
      if (!ac.signal.aborted) setState(next);
    });
    return () => ac.abort();
  }, [contactId]);

  const handleSend = useCallback(async () => {
    if (state.kind !== "success") return;
    setSending(true);
    const result = await fetchSend(contactId);
    setSending(false);
    if (result.ok) {
      // Microcopy métier — pas de jargon technique ("Inngest job"). Le
      // jobId reste loggé côté Sentry/Pino via les routes API pour
      // forensic, jamais surfacé dans l'UI commerciale.
      toast.success(`SMS envoyé (${result.data.smsCharCount} car.). En cours de traitement.`);
      onSendSuccess?.();
      onClose();
    } else {
      toast.error(`Envoi refusé : ${result.message}`);
    }
  }, [contactId, state, onClose, onSendSuccess]);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Prévisualiser le 1er SMS</DialogTitle>
        <DialogDescription>
          Texte généré par Claude, contrôle compliance préalable avant l&apos;envoi OVH.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-4" aria-live="polite" aria-busy={state.kind === "loading"}>
        {state.kind === "loading" && (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-4 w-32" />
          </div>
        )}

        {state.kind === "error" && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden />
            <div className="flex flex-col gap-1">
              <span className="font-medium text-destructive">
                Impossible de générer la preview ({state.status})
              </span>
              <span className="text-muted-foreground">{state.message}</span>
            </div>
          </div>
        )}

        {state.kind === "success" && (
          <>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">SMS</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {state.data.charCount} caractères
                </span>
              </div>
              <div className="rounded-md border bg-muted/30 p-3 font-mono text-sm whitespace-pre-wrap">
                {state.data.smsBody}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium text-muted-foreground">Reasoning Claude</span>
              <p className="text-sm text-muted-foreground">{state.data.reasoning}</p>
            </div>

            <div className="flex items-center gap-2">
              {state.data.preSendCheckPassed ? (
                <>
                  <Badge variant="default" className="gap-1">
                    <CheckCircle2 className="size-3" aria-hidden />
                    Compliance OK
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    Pre-send-check passe — envoi autorisé.
                  </span>
                </>
              ) : (
                <>
                  <Badge variant="destructive" className="gap-1">
                    <AlertTriangle className="size-3" aria-hidden />
                    Compliance bloquée
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    Code: <code>{state.data.preSendCheckCode ?? "—"}</code> · Règle:{" "}
                    <code>{state.data.preSendCheckRule ?? "—"}</code>
                  </span>
                </>
              )}
            </div>
          </>
        )}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={sending}>
          Fermer
        </Button>

        <AlertDialog>
          <AlertDialogTrigger
            render={
              <Button
                type="button"
                disabled={state.kind !== "success" || !state.data.preSendCheckPassed || sending}
              >
                {sending ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    Envoi…
                  </>
                ) : (
                  "Envoyer le SMS"
                )}
              </Button>
            }
          />
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Confirmer l&apos;envoi du SMS ?</AlertDialogTitle>
              <AlertDialogDescription>
                Cette action enverra réellement le SMS via OVHcloud. L&apos;envoi est tracé en audit
                log. Le destinataire pourra répondre STOP pour opt-out.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={sending}>Annuler</AlertDialogCancel>
              <AlertDialogAction onClick={handleSend} disabled={sending}>
                Oui, envoyer
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogFooter>
    </>
  );
}
