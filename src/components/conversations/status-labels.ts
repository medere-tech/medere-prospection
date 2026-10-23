/**
 * Libellés et variants des statuts conversation — SOURCE UNIQUE partagée
 * entre `/admin/conversations` (table + cartes mobile, PR2b-1) et
 * `/admin/conversations/[id]` (bandeau statut PR1 via
 * `conversation-status-banner.tsx`).
 *
 * Les libellés courts (`StatusBadgeLabels`) servent dans les cellules de
 * table ; les phrases longues restent dans `conversation-status-banner.tsx`
 * (contexte : bandeau tête de page avec consigne compliance explicite).
 */
import type { ConversationStatus } from "@/types/conversation";

/** Libellé court FR du statut — affiché dans un `<Badge>` compact. */
export const CONVERSATION_STATUS_SHORT_LABELS: Record<ConversationStatus, string> = {
  active: "Active",
  awaiting_reply: "En attente",
  in_dialogue: "En dialogue",
  qualified: "Qualifiée",
  handed_off: "Reprise",
  closed: "Clôturée",
  opted_out: "Désabonnée",
  blocked: "Bloquée",
};

/**
 * Variante `Badge` par statut (couleur) :
 *   - `destructive` : états bloquants (`opted_out`, `blocked`).
 *   - `outline`     : état terminal neutre (`closed`).
 *   - `secondary`   : états actifs sous-contrôle Léa (dialogue, qualification…).
 *   - `default`     : état de bascule nécessitant une action (`handed_off`).
 */
export const CONVERSATION_STATUS_BADGE_VARIANT: Record<
  ConversationStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  active: "secondary",
  awaiting_reply: "secondary",
  in_dialogue: "secondary",
  qualified: "secondary",
  handed_off: "default",
  closed: "outline",
  opted_out: "destructive",
  blocked: "destructive",
};
