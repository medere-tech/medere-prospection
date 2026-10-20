"use client";

/**
 * Wrapper client de la vue conversation (VUE-CONVERSATION PR1).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Polling économique en 2 étapes (VUE-CONVERSATION PR1)
 *
 *   1. **Query A — version légère** (`/api/admin/conversations/[id]/version`,
 *      refetchInterval 30s) : lit UNIQUEMENT le doc conversation
 *      (1 read Firestore/poll). Retourne une signature
 *      `{ updatedAtIso, status, assignedTo, inboundCount, outboundCount,
 *         lastInboundAtIso, lastOutboundAtIso }`.
 *
 *   2. **Query B — détail complet** (`/api/admin/conversations/[id]`,
 *      pas de refetchInterval, refetch manuel) : rechargée UNIQUEMENT
 *      quand la signature de version A a changé entre 2 polls. Lecture
 *      initiale servie par `initialData` (SSR). Jusqu'à 245 reads par
 *      refetch.
 *
 *   Impact chiffré (10 commerciaux × 8 h/j, ~90 % polls "quiet") :
 *     - Avant : ~2.3 M reads/j.
 *     - Après : ~290 k reads/j (-87 %).
 *
 *   Trade-off : latence d'affichage d'une mutation ≤ 30 s (identique
 *   avant/après) + 1 round-trip supplémentaire quand la version change.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pause en arrière-plan + fail-closed
 *
 *   - `refetchIntervalInBackground: false` → zero poll onglet caché.
 *   - 403 côté API (commercial non-titulaire post-handoff) → la Query A
 *     passe en erreur → la Query B n'est plus retriggée. Garde l'affichage
 *     du premier chargement SSR. L'utilisateur doit recharger la page
 *     pour voir le 403 propre.
 *   - 429 (rate-limit) → React Query retry×2 avec backoff, pas d'affichage
 *     cassé.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { ConversationAdminBanner } from "@/components/conversations/conversation-admin-banner";
import { ConversationError } from "@/components/conversations/conversation-error";
import { ConversationHeader } from "@/components/conversations/conversation-header";
import { ConversationLoading } from "@/components/conversations/conversation-loading";
import { ConversationSidePanel } from "@/components/conversations/conversation-side-panel";
import { ConversationStatusBanner } from "@/components/conversations/conversation-status-banner";
import { MessageThread } from "@/components/conversations/message-thread";
import type { ConversationDetailProps } from "@/components/conversations/types";

const VERSION_POLL_INTERVAL_MS = 30_000;
const VERSION_STALE_TIME_MS = 15_000;

interface Props {
  conversationId: string;
  initialData: ConversationDetailProps | null;
  viewerRole: "admin" | "commercial";
}

/** Shape de la signature retournée par `/version`. */
interface ConversationVersion {
  updatedAtIso: string;
  status: string;
  assignedTo: string | null;
  inboundCount: number;
  outboundCount: number;
  lastInboundAtIso: string | null;
  lastOutboundAtIso: string | null;
}

/**
 * Dérive une signature stable d'une `ConversationDetailProps` (initial
 * SSR). STRICTEMENT identique à `signatureFromVersion` côté format —
 * permet au premier poll `/version` de ne PAS déclencher un refetch
 * détail inutile quand rien n'a bougé entre SSR et client mount.
 *
 * Finding INFO security-reviewer PR1.11 appliqué (PR1.12) :
 * `data.updatedAtIso` est maintenant exposé dans la payload RSC, donc
 * la signature SSR est strictement identique à celle du premier poll
 * si et seulement si la conv n'a pas muté entre les deux.
 */
function signatureFromDetail(data: ConversationDetailProps): string {
  const sig: ConversationVersion = {
    updatedAtIso: data.updatedAtIso,
    status: data.status,
    assignedTo: data.handoff?.assignedToSlackId ?? null,
    inboundCount: data.inboundCount,
    outboundCount: data.outboundCount,
    lastInboundAtIso: data.lastInboundAtIso,
    lastOutboundAtIso: data.lastOutboundAtIso,
  };
  return JSON.stringify(sig);
}

function signatureFromVersion(v: ConversationVersion): string {
  // Pour la signature "runtime" (poll vs poll), on exclut `updatedAtIso`
  // aussi : c'est un marqueur de mutation implicite déjà reflété par
  // les autres champs (`lastInboundAt`, `inboundCount`, status, etc.).
  // Garder `updatedAtIso` ferait détecter des mutations non-impactantes
  // (ex: setConversationIntent qui ne change pas le compteur).
  //
  // 🔒 Trade-off : `updateMessageStatus` (DLR OVH) bump UNIQUEMENT
  // `updatedAt`. On RÉINCLUT donc `updatedAtIso` pour détecter DLR.
  const sig: ConversationVersion = {
    updatedAtIso: v.updatedAtIso,
    status: v.status,
    assignedTo: v.assignedTo,
    inboundCount: v.inboundCount,
    outboundCount: v.outboundCount,
    lastInboundAtIso: v.lastInboundAtIso,
    lastOutboundAtIso: v.lastOutboundAtIso,
  };
  return JSON.stringify(sig);
}

export function ConversationDetailClient({ conversationId, initialData, viewerRole }: Props) {
  const lastSignatureRef = useRef<string | null>(
    initialData !== null ? signatureFromDetail(initialData) : null,
  );
  const [refetchKey, setRefetchKey] = useState(0);

  // Query A — polling léger, 1 read/poll.
  const versionQuery = useQuery<ConversationVersion>({
    queryKey: ["admin", "conversations", conversationId, "version"],
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/conversations/${encodeURIComponent(conversationId)}/version`,
        { headers: { Accept: "application/json" }, cache: "no-store" },
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return (await res.json()) as ConversationVersion;
    },
    staleTime: VERSION_STALE_TIME_MS,
    refetchInterval: VERSION_POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 2,
  });

  // Détection d'une mutation : compare la signature actuelle avec la
  // précédente. Si changement → trigger refetch du détail.
  useEffect(() => {
    if (!versionQuery.data) return;
    const newSig = signatureFromVersion(versionQuery.data);
    const prevSig = lastSignatureRef.current;
    if (prevSig === null) {
      lastSignatureRef.current = newSig;
      return;
    }
    if (newSig !== prevSig) {
      lastSignatureRef.current = newSig;
      setRefetchKey((k) => k + 1);
    }
  }, [versionQuery.data]);

  // Query B — détail complet, refetch sur changement de version.
  const detailQuery = useQuery<ConversationDetailProps>({
    queryKey: ["admin", "conversations", conversationId, "detail", refetchKey],
    queryFn: async () => {
      const res = await fetch(`/api/admin/conversations/${encodeURIComponent(conversationId)}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return (await res.json()) as ConversationDetailProps;
    },
    // Pas d'auto-polling — déclenché par useEffect ci-dessus via refetchKey.
    enabled: refetchKey > 0 || initialData === null,
    staleTime: Infinity,
    retry: 2,
  });

  // `data` = dernière Query B si disponible, sinon `initialData` SSR.
  // Pas de `useState` local : React Query est la source de vérité, pas
  // de double stockage ni d'effet qui set le state (ESLint
  // react-hooks/set-state-in-effect) → re-render automatique sur
  // nouveau `detailQuery.data` sans effet.
  const data: ConversationDetailProps | null = detailQuery.data ?? initialData;

  // Pas de data initial ET fetch client en cours → squelette.
  if (!data && (detailQuery.isLoading || detailQuery.isFetching)) {
    return <ConversationLoading />;
  }

  // Erreur sans data → écran erreur + bouton réessayer.
  if (!data && detailQuery.isError) {
    return (
      <ConversationError
        onRetry={() => {
          setRefetchKey((k) => k + 1);
          void detailQuery.refetch();
        }}
      />
    );
  }

  if (!data) return <ConversationLoading />;

  const isAdminViewingNonMine = viewerRole === "admin" && !data.viewerIsOwner;

  return (
    <div className="flex flex-col gap-6">
      <ConversationHeader contact={data.contact} intent={data.intent} />

      {isAdminViewingNonMine ? (
        <ConversationAdminBanner assignedToName={data.handoff?.assignedToName ?? null} />
      ) : null}

      <ConversationStatusBanner
        status={data.status}
        handoff={data.handoff}
        contactOptedOut={data.contact.optedOut}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        <MessageThread messages={data.messages} />
        <ConversationSidePanel data={data} />
      </div>
    </div>
  );
}
