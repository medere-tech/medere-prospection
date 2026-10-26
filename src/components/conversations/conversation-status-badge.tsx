/**
 * Badge compact de statut — colonne « Statut » de /admin/conversations
 * (PR2b-1). Libellés et variants partagés avec le bandeau PR1 via
 * `status-labels.ts`.
 */
import { Badge } from "@/components/ui/badge";
import type { ConversationStatus } from "@/types/conversation";

import {
  CONVERSATION_STATUS_BADGE_VARIANT,
  CONVERSATION_STATUS_SHORT_LABELS,
} from "./status-labels";

export function ConversationStatusBadge({ status }: { status: ConversationStatus }) {
  return (
    <Badge
      variant={CONVERSATION_STATUS_BADGE_VARIANT[status]}
      aria-label={`Statut : ${CONVERSATION_STATUS_SHORT_LABELS[status]}`}
    >
      {CONVERSATION_STATUS_SHORT_LABELS[status]}
    </Badge>
  );
}
