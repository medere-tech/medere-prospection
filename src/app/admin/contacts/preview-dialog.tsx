"use client";

/**
 * Modal preview + send pour le 1er SMS d'un contact (S10.1.6 — UX premium).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Flow utilisateur (S10.1.6) :
 *
 *   1. Parent ouvre le dialog en setant `contact` (Contact non-null).
 *      Le `key={contact.hubspotId}` côté wrapper remount complètement
 *      l'arbre interne à chaque change → reset propre du state.
 *   2. Header riche : civilité + nom + spécialité + ville + téléphone
 *      masqué (anti-shoulder-surfing, identique à la cellule table).
 *   3. useEffect : fetch POST /api/admin/preview-first-sms.
 *      - Loading → skeleton matchant le layout final.
 *      - Error   → message + bouton "Réessayer" (re-trigger fetch).
 *      - Success → SMS body (mono) avec highlight inline "STOP" + annonce
 *                  IA + pills compliance "Annonce IA détectée" / "STOP
 *                  présent". Char count coloré (≤160 vert, ≤320 ambre,
 *                  >320 orange) + nombre de segments SMS.
 *   4. Compliance badge :
 *      - OK   → Badge default vert "Compliance OK".
 *      - KO   → Card destructive avec code + rule en `<code>`.
 *   5. Confirm INLINE (pas d'AlertDialog imbriqué) : clic "Envoyer le
 *      SMS" → footer transitionne en 2 boutons "Annuler" / "Confirmer
 *      définitivement". La preview reste visible (anti-anxiété).
 *   6. Sending → overlay loader centré "Envoi via OVHcloud…".
 *      Sent → checkmark + message rassurant + auto-close après 1200ms.
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
 *   - Toasts sonner ne loggent PAS de PII (smsCharCount, code, status —
 *     pas le body, pas le phone). Le téléphone du header est MASQUÉ via
 *     `maskPhoneForUI` (le toggle œil n'est pas réintroduit ici par
 *     design : la modal est un contexte d'envoi, pas de vérification).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Animations : `motion-safe:` strict sur toutes les transitions →
 * respect WCAG 2.3.3 "Animation from Interactions" + `prefers-reduced-motion`.
 */
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  MapPin,
  Phone,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

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
import { cn } from "@/lib/utils";
import type { Contact } from "@/types/contact";

import { maskPhoneForUI } from "./columns";

// ─────────────────────────────────────────────────────────────────────────────
// Types alignés sur les routes API S10.1.4.b/c
// ─────────────────────────────────────────────────────────────────────────────

interface PreviewResponse {
  smsBody: string;
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
  | { kind: "loading" }
  | { kind: "success"; data: PreviewResponse }
  | { kind: "error"; message: string; status: number };

/**
 * Send state machine (S10.1.6) :
 *   idle       → footer normal (Fermer + Envoyer le SMS)
 *   confirming → footer transitionné (Annuler + Confirmer définitivement)
 *   sending    → overlay loader centré, footer désactivé
 *   sent       → overlay checkmark, auto-close 1200ms
 */
type SendState =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "sending" }
  | { kind: "sent"; charCount: number };

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
      // L'abort vient d'un remount/unmount — pas un vrai état UI. On
      // renvoie "loading" pour que le prochain useEffect prenne le relais
      // (jamais set côté UI grâce au `if (!aborted)` du caller).
      return { kind: "loading" };
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
// Sub-component : ContactHeader (A1)
// ─────────────────────────────────────────────────────────────────────────────

function ContactHeader({ contact }: { contact: Contact }) {
  const civilite = contact.civilite ? `${contact.civilite} ` : "";
  const fullName = `${civilite}${contact.firstName} ${contact.lastName}`;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-semibold tracking-tight">{fullName}</span>
        <Badge variant="outline" className="text-[10px]">
          {contact.speciality}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <MapPin className="size-3" aria-hidden />
          <span className="tabular-nums">
            {contact.city} · {contact.postalCode}
          </span>
        </span>
        <span className="inline-flex items-center gap-1">
          <Phone className="size-3" aria-hidden />
          <span className="font-mono tabular-nums" aria-label="Numéro masqué">
            {maskPhoneForUI(contact.phone.e164)}
          </span>
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component : CharCountBadge (A2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Couleur sémantique :
 *   ≤ 160 → vert (1 SMS standard GSM-7)
 *   161-320 → ambre (2 SMS concatenés)
 *   > 320 → orange (3+ SMS — coût × N, à éviter pour 1er contact)
 *
 * On ne va PAS jusqu'au rouge — c'est un avertissement budget/coût, pas
 * une erreur compliance. Le pre-send-check S5 a sa propre règle longueur
 * si applicable (règle 7).
 */
function CharCountBadge({ count }: { count: number }) {
  const segments = Math.ceil(count / 160);
  const tone = count <= 160 ? "ok" : count <= 320 ? "warn" : "alert";
  const cls =
    tone === "ok"
      ? "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300"
      : tone === "warn"
        ? "bg-amber-500/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300"
        : "bg-orange-500/10 text-orange-700 dark:bg-orange-400/10 dark:text-orange-300";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums",
        cls,
      )}
      aria-label={`${count} caractères, ${segments} segment${segments > 1 ? "s" : ""} SMS`}
    >
      {count} car.
      {segments > 1 && <span className="opacity-70">· {segments} segments</span>}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component : SmsBodyPreview (A3 — highlight compliance inline + pills)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Patterns reconnus pour highlight inline :
 *   - STOP : token compliance opt-out obligatoire (Bloctel / L.34-5 CPCE).
 *     Match insensitive sur le mot entier, encadrement word-boundary.
 *   - Annonce IA Médéré : "Léa" (prénom IA convention projet), ou tournures
 *     "assistante IA", "assistant IA", "intelligence artificielle". Cf.
 *     skill `medere-claude-prompts` — l'annonce IA doit être présente dans
 *     le 1er SMS (AI Act art. 50 + RGPD transparency).
 */
/**
 * Sources brutes des regex compliance. On les stocke en string pour pouvoir
 * instancier des RegExp locales à chaque appel sans risquer la mutation
 * `lastIndex` (interdite par `react-hooks/immutability` sur valeurs hors
 * composant). `String.raw` évite l'escape doublé des back-references.
 */
const STOP_PATTERN_SOURCE = String.raw`\bSTOP\b`;
const AI_DISCLOSURE_PATTERN_SOURCE = String.raw`\b(Léa|assistante?\s+(?:IA|virtuelle)|intelligence\s+artificielle)\b`;

function highlightSmsBody(body: string): React.ReactNode[] {
  // RegExp locales `/g/i` — `matchAll()` exige `/g` et clone la regex en
  // interne (ne mute pas son `lastIndex`, cf. spec ECMA String.prototype.matchAll).
  const stopRegex = new RegExp(STOP_PATTERN_SOURCE, "gi");
  const aiRegex = new RegExp(AI_DISCLOSURE_PATTERN_SOURCE, "gi");

  // Tokenize en passes successives : on collecte les matches des 2 regex,
  // on trie par position, on émet les segments [texte non-match]
  // entrecoupés de <mark>. Pas de double-match (les 2 regex sont
  // mutuellement exclusives sur leurs targets).
  type Match = { start: number; end: number; kind: "stop" | "ai" };
  const matches: Match[] = [];
  for (const m of body.matchAll(stopRegex)) {
    if (m.index !== undefined)
      matches.push({ start: m.index, end: m.index + m[0].length, kind: "stop" });
  }
  for (const m of body.matchAll(aiRegex)) {
    if (m.index !== undefined)
      matches.push({ start: m.index, end: m.index + m[0].length, kind: "ai" });
  }
  if (matches.length === 0) return [body];

  matches.sort((a, b) => a.start - b.start);

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    if (m.start < cursor) continue; // chevauchement, on saute
    if (m.start > cursor) nodes.push(body.slice(cursor, m.start));
    const cls =
      m.kind === "stop"
        ? "rounded bg-emerald-500/15 px-0.5 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-200"
        : "rounded bg-primary/10 px-0.5 text-foreground";
    nodes.push(
      <mark
        key={`mark-${i}-${m.start}`}
        className={cn("font-medium not-italic", cls)}
        aria-label={m.kind === "stop" ? "Token opt-out STOP" : "Annonce IA"}
      >
        {body.slice(m.start, m.end)}
      </mark>,
    );
    cursor = m.end;
  }
  if (cursor < body.length) nodes.push(body.slice(cursor));
  return nodes;
}

function ComplianceCheckPill({ matched, label }: { matched: boolean; label: string }) {
  // Compliance pills :
  //   matched=true  → vert (token sentinelle présent dans le SMS)
  //   matched=false → ambre (signal d'absence, distinct du `text-muted-foreground`
  //                  ambient qui se confond avec le fond `bg-muted/30` du parent).
  // Cohérent avec CharCountBadge (warn ambre, alert orange).
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium",
        matched
          ? "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300"
          : "bg-amber-500/15 text-amber-800 dark:bg-amber-400/10 dark:text-amber-200",
      )}
    >
      {matched ? (
        <CheckCircle2 className="size-3" aria-hidden />
      ) : (
        <AlertTriangle className="size-3" aria-hidden />
      )}
      {label}
    </span>
  );
}

function SmsBodyPreview({ body, charCount }: { body: string; charCount: number }) {
  // RegExp locales SANS `/g` — `.test()` sur une regex non-globale ne mute
  // jamais `lastIndex` (cf. spec ECMA RegExp.prototype.test step 1.b.i).
  const stopMatched = new RegExp(STOP_PATTERN_SOURCE, "i").test(body);
  const aiMatched = new RegExp(AI_DISCLOSURE_PATTERN_SOURCE, "i").test(body);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          SMS à envoyer
        </span>
        <CharCountBadge count={charCount} />
      </div>
      <div className="rounded-lg border bg-muted/30 p-3.5 font-mono text-sm leading-relaxed whitespace-pre-wrap">
        {highlightSmsBody(body)}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <ComplianceCheckPill matched={aiMatched} label="Annonce IA détectée" />
        <ComplianceCheckPill matched={stopMatched} label="Token STOP présent" />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component : ComplianceBadge (état OK/KO)
// ─────────────────────────────────────────────────────────────────────────────

function ComplianceBadge({ data }: { data: PreviewResponse }) {
  if (data.preSendCheckPassed) {
    // Badge "Compliance OK" : variant outline + classes utilitaires emerald
    // qui suivent les CSS vars du thème via `dark:` (vs `bg-emerald-600`
    // hardcodé qui resterait vert en dark mode même si --primary passe à
    // quasi-blanc). Cohérent avec la palette des CheckPill et CharCountBadge.
    return (
      <div className="flex items-center gap-2">
        <Badge
          variant="outline"
          className="gap-1 border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/40 dark:bg-emerald-400/10 dark:text-emerald-300"
        >
          <ShieldCheck className="size-3" aria-hidden />
          Compliance OK
        </Badge>
        <span className="text-xs text-muted-foreground">
          Pre-send-check passe — envoi autorisé.
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5">
      <div className="flex items-center gap-2">
        <Badge variant="destructive" className="gap-1">
          <AlertTriangle className="size-3" aria-hidden />
          Compliance bloquée
        </Badge>
        <span className="text-xs text-muted-foreground">Envoi désactivé — voir le motif.</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          Code :{" "}
          <code className="rounded bg-background px-1 py-0.5 font-mono text-[11px]">
            {data.preSendCheckCode ?? "—"}
          </code>
        </span>
        <span>
          Règle :{" "}
          <code className="rounded bg-background px-1 py-0.5 font-mono text-[11px]">
            {data.preSendCheckRule ?? "—"}
          </code>
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component : PreviewSkeleton (A6 — matche le layout final)
// ─────────────────────────────────────────────────────────────────────────────

function PreviewSkeleton() {
  return (
    <>
      <span className="sr-only" role="status" aria-live="polite">
        Chargement de la prévisualisation du SMS en cours…
      </span>
      <div className="flex flex-col gap-4" aria-hidden>
        {/* SMS body skeleton */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-4 w-16 rounded-md" />
          </div>
          <Skeleton className="h-24 w-full rounded-lg" />
          <div className="flex gap-1.5">
            <Skeleton className="h-4 w-28 rounded-md" />
            <Skeleton className="h-4 w-24 rounded-md" />
          </div>
        </div>
        {/* Compliance badge skeleton */}
        <Skeleton className="h-5 w-40" />
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component : PreviewError (A7 — error state avec retry)
// ─────────────────────────────────────────────────────────────────────────────

function PreviewError({
  message,
  status,
  onRetry,
}: {
  message: string;
  status: number;
  onRetry: () => void;
}) {
  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3.5"
      role="alert"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="size-4 shrink-0 text-destructive mt-0.5" aria-hidden />
        <div className="flex flex-col gap-1">
          <span className="font-medium text-destructive text-sm">
            Impossible de générer la preview ({status})
          </span>
          <span className="text-sm text-muted-foreground">{message}</span>
        </div>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onRetry} className="self-start">
        <RefreshCw className="size-3.5" aria-hidden />
        Réessayer
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component : SendingTransition + SentSuccessTransition (A8)
// ─────────────────────────────────────────────────────────────────────────────

function SendingTransition({ recipientName }: { recipientName: string }) {
  // `role="status"` implique `aria-live="polite"` côté AT — pas besoin de
  // le re-déclarer (évite la double annonce avec le parent aria-live).
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 py-10 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150"
      role="status"
    >
      <Loader2
        className="size-8 animate-spin text-primary motion-reduce:animate-none"
        aria-hidden
      />
      <p className="text-sm font-medium">Envoi via OVHcloud en cours…</p>
      <p className="text-xs text-muted-foreground">
        Le SMS sera transmis à {recipientName} dans quelques secondes.
      </p>
    </div>
  );
}

function SentSuccessTransition({
  charCount,
  recipientName,
}: {
  charCount: number;
  recipientName: string;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 py-10 text-center motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-150"
      role="status"
    >
      <div className="rounded-full bg-emerald-500/10 p-3 dark:bg-emerald-400/10">
        <CheckCircle2 className="size-8 text-emerald-600 dark:text-emerald-400" aria-hidden />
      </div>
      <p className="text-base font-semibold">SMS envoyé à {recipientName}</p>
      <p className="text-xs text-muted-foreground">
        {charCount} caractères · Tracé en audit log · Opt-out STOP fonctionnel.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components : footers (idle / confirming)
// ─────────────────────────────────────────────────────────────────────────────

function IdleFooter({
  disabled,
  onClose,
  onTriggerSend,
}: {
  disabled: boolean;
  onClose: () => void;
  onTriggerSend: () => void;
}) {
  return (
    <>
      <Button type="button" variant="outline" onClick={onClose}>
        Fermer
      </Button>
      <Button type="button" disabled={disabled} onClick={onTriggerSend}>
        Envoyer le SMS
      </Button>
    </>
  );
}

function ConfirmFooter({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  // Pas de `role="alertdialog"` ici : ce n'est pas un dialog modal séparé,
  // c'est une transition d'état dans le DialogFooter du Dialog parent.
  // Un `alertdialog` impliquerait un focus trap propre + aria-modal — abus
  // sémantique qui désoriente NVDA/VoiceOver.
  //
  // `autoFocus` sur "Annuler" : choix défensif — par défaut on focus le
  // CANCEL (pas le confirm rouge) pour éviter qu'un Enter accidentel
  // déclenche un envoi irréversible (cf. WCAG 3.3.4 Error Prevention).
  // S10.1.7-L2 : `flex-wrap` sur le conteneur des boutons pour les très
  // petits écrans (< 360px) où "Confirmer l'envoi définitif" peut wrap.
  // Sur sm: et plus, comportement inchangé (row + space-between).
  return (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-150 w-full">
      <p className="text-xs text-muted-foreground">
        Envoi <span className="font-semibold text-foreground">RÉEL</span> via OVH. Tracé en audit
        log. Opt-out STOP fonctionnel.
      </p>
      <div className="flex flex-wrap gap-2 justify-end">
        <Button type="button" variant="outline" onClick={onCancel} autoFocus>
          Annuler
        </Button>
        <Button type="button" onClick={onConfirm} variant="destructive">
          Confirmer l&apos;envoi définitif
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PreviewDialog (wrapper public)
// ─────────────────────────────────────────────────────────────────────────────

export interface PreviewDialogProps {
  /**
   * `null` = closed. Un Contact non-null déclenche le fetch preview et
   * peuple le header riche (nom, spécialité, ville, téléphone masqué).
   *
   * S10.1.6 — signature étendue depuis S10.1.5 (qui ne passait que
   * `contactId: string | null`). Le parent a déjà les Contact en cache
   * via `/api/admin/contacts` → pas de fetch supplémentaire.
   */
  contact: Contact | null;
  /** Callback fermeture (parent reset son state à null). */
  onClose: () => void;
  /** Callback optionnel après send success (parent peut refresh la table). */
  onSendSuccess?: () => void;
}

export function PreviewDialog({ contact, onClose, onSendSuccess }: PreviewDialogProps) {
  /**
   * Retry nonce vit dans le WRAPPER (pas le content) car il participe à la
   * `key` du content : un bump remount complètement `PreviewDialogContent`
   * avec un `useState` initial à `"loading"` → pas de setState synchrone
   * dans `useEffect` (interdit par `react-hooks/set-state-in-effect`).
   */
  const [retryNonce, setRetryNonce] = useState(0);
  const handleRetry = useCallback(() => setRetryNonce((n) => n + 1), []);
  return (
    <Dialog open={contact !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        {contact !== null ? (
          <PreviewDialogContent
            key={`${contact.hubspotId}-${retryNonce}`}
            contact={contact}
            onClose={onClose}
            onSendSuccess={onSendSuccess}
            onRetry={handleRetry}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

interface PreviewDialogContentProps {
  contact: Contact;
  onClose: () => void;
  onSendSuccess?: () => void;
  onRetry: () => void;
}

function PreviewDialogContent({
  contact,
  onClose,
  onSendSuccess,
  onRetry,
}: PreviewDialogContentProps) {
  // `useState` initial `"loading"` — pas de setState synchrone dans
  // `useEffect`. Le remount via `key={...-${retryNonce}}` côté wrapper
  // reset automatiquement à "loading" lors d'un retry ou changement de
  // contact (pattern canonique anti-`set-state-in-effect`).
  const [state, setState] = useState<PreviewState>({ kind: "loading" });
  const [sendState, setSendState] = useState<SendState>({ kind: "idle" });
  // S10.1.8 BLQ-4 : ref pour le timer auto-close. Si l'admin ferme manuellement
  // (Escape, clic croix, backdrop) avant les 2500ms, le cleanup démontage
  // annule le timeout — évite `onClose()` fantôme + warning React setState on
  // unmounted component.
  const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    void fetchPreview(contact.hubspotId, ac.signal).then((next) => {
      if (!ac.signal.aborted) setState(next);
    });
    return () => ac.abort();
  }, [contact.hubspotId]);

  useEffect(() => {
    return () => {
      if (autoCloseTimerRef.current !== null) {
        clearTimeout(autoCloseTimerRef.current);
        autoCloseTimerRef.current = null;
      }
    };
  }, []);

  const handleConfirmSend = useCallback(async () => {
    if (state.kind !== "success") return;
    setSendState({ kind: "sending" });
    const result = await fetchSend(contact.hubspotId);
    if (result.ok) {
      setSendState({ kind: "sent", charCount: result.data.smsCharCount });
      // Microcopy métier — pas de jargon technique ("Inngest job"). Le
      // jobId reste loggé côté Sentry/Pino via les routes API pour
      // forensic, jamais surfacé dans l'UI commerciale.
      toast.success(`SMS envoyé (${result.data.smsCharCount} car.). En cours de traitement.`);
      onSendSuccess?.();
      // Auto-close après 2500ms — l'admin a le temps de lire la confirmation
      // complète ("SMS envoyé à Dr X · N car · Tracé en audit log · STOP
      // fonctionnel") avant fermeture. UX-reviewer S10.1.6 : 1200ms était
      // trop court pour assimiler le détail compliance rassurant.
      autoCloseTimerRef.current = setTimeout(() => {
        autoCloseTimerRef.current = null;
        onClose();
      }, 2500);
    } else {
      setSendState({ kind: "idle" });
      toast.error(`Envoi refusé : ${result.message}`);
    }
  }, [contact.hubspotId, state, onClose, onSendSuccess]);

  const isOverlayShown = sendState.kind === "sending" || sendState.kind === "sent";
  const sendDisabled = state.kind !== "success" || !state.data.preSendCheckPassed;
  // Nom destinataire pour les transitions Sending/Sent — civilité + nom seul
  // (pas le prénom, conformément à la conv médicale FR : "Dr Dupont" et non
  // "Jean Dupont" dans un message d'envoi).
  const recipientName = `${contact.civilite ? `${contact.civilite} ` : ""}${contact.lastName}`;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Prévisualiser le 1er SMS</DialogTitle>
        <DialogDescription>
          Texte généré par Claude, contrôle compliance préalable avant l&apos;envoi OVH.
        </DialogDescription>
      </DialogHeader>

      <ContactHeader contact={contact} />

      {/*
        Pas d'`aria-live` ici : les transitions internes (PreviewError →
        `role="alert"`, Sending/Sent → `role="status"`) gèrent leurs propres
        annonces, et le loading skeleton inclut un `sr-only` explicite. Cela
        évite la double annonce signalée par accessibility-reviewer S10.1.6.
      */}
      <div className="flex flex-col gap-4" aria-busy={state.kind === "loading" || isOverlayShown}>
        {isOverlayShown ? (
          sendState.kind === "sending" ? (
            <SendingTransition recipientName={recipientName} />
          ) : (
            <SentSuccessTransition charCount={sendState.charCount} recipientName={recipientName} />
          )
        ) : (
          <>
            {state.kind === "loading" && <PreviewSkeleton />}
            {state.kind === "error" && (
              <PreviewError message={state.message} status={state.status} onRetry={onRetry} />
            )}
            {state.kind === "success" && (
              <div className="flex flex-col gap-4 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-150">
                <SmsBodyPreview body={state.data.smsBody} charCount={state.data.charCount} />
                <ComplianceBadge data={state.data} />
              </div>
            )}
          </>
        )}
      </div>

      <DialogFooter>
        {isOverlayShown ? (
          <span className="text-xs text-muted-foreground">Veuillez patienter…</span>
        ) : sendState.kind === "confirming" ? (
          <ConfirmFooter
            onCancel={() => setSendState({ kind: "idle" })}
            onConfirm={handleConfirmSend}
          />
        ) : (
          <IdleFooter
            disabled={sendDisabled}
            onClose={onClose}
            onTriggerSend={() => setSendState({ kind: "confirming" })}
          />
        )}
      </DialogFooter>
    </>
  );
}
