/**
 * Types partagés pour `/admin/conversations` (PR2b-1).
 *
 * - `ConversationListItem` : miroir strict de la payload JSON de
 *   `GET /api/admin/conversations` (ISO strings côté serveur).
 * - Les Timestamps Firestore sont déjà convertis côté serveur en ISO
 *   via `tsToIso()` dans `route.ts` → le client n'a jamais à parser
 *   `{_seconds,_nanoseconds}`.
 */
import type { ConversationStatus, Intent } from "@/types/conversation";

export interface ConversationLastMessagePreviewUI {
  direction: "inbound" | "outbound";
  authorKind: "contact" | "ai" | "human";
  text: string;
  atIso: string | null;
}

export interface ConversationListItem {
  conversationId: string;
  campaignId: string;
  status: ConversationStatus;
  intent: Intent;
  assignedTo: string | null;
  lastMessageAtIso: string | null;
  lastInboundAtIso: string | null;
  lastOutboundAtIso: string | null;
  lastHumanOutboundAtIso: string | null;
  inboundCount: number;
  outboundCount: number;
  contactDisplayName: string | null;
  contactSpecialty: string | null;
  contactCity: string | null;
  campaignName: string | null;
  lastMessagePreview: ConversationLastMessagePreviewUI | null;
  waitingForHumanReply: boolean;
}

export interface ConversationsListApiResponse {
  items: ConversationListItem[];
  nextCursor: string | null;
  hasMore: boolean;
  filterApplied: {
    role: "admin" | "commercial";
    tab: string;
    assignedTo: string | null;
    statuses: string[] | null;
    campaignId: string | null;
    q: string | null;
    searchMode: boolean;
  };
}

export interface ConversationsCountsApiResponse {
  counts: {
    a_traiter: number;
    cloturees: number;
    toutes: number;
    en_cours?: number;
  };
  filterApplied: {
    role: "admin" | "commercial";
    assignedTo: string | null;
    campaignId: string | null;
    q: string | null;
  };
}

export interface ApiErrorBody {
  error: string;
  message?: string;
}

export type ListFetchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; data: ConversationsListApiResponse }
  | { kind: "error"; message: string; status: number };

export type CountsFetchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; data: ConversationsCountsApiResponse["counts"] }
  | { kind: "error" };

export type Tab = "a_traiter" | "en_cours" | "cloturees" | "toutes";

export interface CommercialForClient {
  slackUserId: string;
  name: string;
  active: boolean;
}
