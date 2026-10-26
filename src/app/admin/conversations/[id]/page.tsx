/**
 * Vue conversation en lecture seule — server component
 * (VUE-CONVERSATION PR1).
 *
 * - RBAC : `requireRole("commercial")` (admin couvre commercial).
 * - 403 : commercial non-titulaire → page dédiée nommant le titulaire.
 * - 404 : conversation ou contact inconnu → `notFound()`.
 * - Erreur I/O : page d'erreur générique client-side (bouton réessayer).
 *
 * 🚨 ZÉRO PII : la payload RSC n'inclut jamais `e164` / `phone` /
 * `externalReceiver` (strippés par `sanitize.ts`). Sentinelle test
 * `tests/scripts/no-phone-in-payload.test.ts`.
 */
import { notFound } from "next/navigation";

import { ConversationNotMine } from "@/components/conversations/conversation-not-mine";
import { requireRoleOrForbidden } from "@/lib/auth/require-role";
import { loadConversationDetail } from "@/lib/conversations/load-conversation-detail";

import { ConversationDetailClient } from "./conversation-detail-client";

interface Params {
  id: string;
}

export const dynamic = "force-dynamic";

export default async function ConversationDetailPage({ params }: { params: Promise<Params> }) {
  // PR1.14.2 → factorisé en `requireRoleOrForbidden` (PR2b-1 round 3).
  // Même pattern utilisé par layout + page liste.
  const { role, slackUserId } = await requireRoleOrForbidden("commercial");
  const { id } = await params;

  const result = await loadConversationDetail(id, { role, slackUserId });

  if (result.kind === "not_found") {
    notFound();
  }

  if (result.kind === "not_mine") {
    return <ConversationNotMine assignedToName={result.assignedToName} />;
  }

  if (result.kind === "error") {
    // Erreur I/O non-404 non-403 → le client wrapper gérera un refetch
    // (bouton « Réessayer »). On passe `null` data et le wrapper affiche
    // `ConversationError`.
    return <ConversationDetailClient initialData={null} conversationId={id} viewerRole={role} />;
  }

  return (
    <ConversationDetailClient initialData={result.data} conversationId={id} viewerRole={role} />
  );
}
