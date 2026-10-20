/**
 * Sanitize côté serveur : transforme les docs Firestore bruts en shapes
 * `types.ts` sans PII numéro (VUE-CONVERSATION PR1).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 INVARIANT — JAMAIS DE `e164`, `phone`, `externalReceiver` DANS LE PAYLOAD RSC
 *
 * Les fonctions ici sont utilisées par le server component de la page
 * détail conversation AVANT de passer les données au client. Elles
 * STRIPPENT activement les champs téléphone. Toute régression (ajout
 * involontaire) est détectée par la sentinelle
 * `tests/scripts/no-phone-in-payload.test.ts` qui sérialise la payload
 * complète et grep les patterns `+33\d{9}`, `0033`, FR national.
 */
import type { Timestamp } from "firebase-admin/firestore";

import { formatDateTimeParis } from "@/lib/utils/format-paris";
import type { AuditLog } from "@/types/audit-log";
import type { Contact } from "@/types/contact";
import type { Conversation } from "@/types/conversation";
import type { Message } from "@/types/message";

import type {
  ContactHeaderProps,
  ConversationDisplayIntent,
  ConversationDisplayStatus,
  HandoffDisplayProps,
  JournalEntryProps,
  MessageDisplayStatus,
  MessageProps,
} from "./types";

/** Convertit un Timestamp Firestore en ISO 8601 (ou null). */
function toIsoOrNull(ts: Timestamp | undefined | null): string | null {
  if (!ts) return null;
  try {
    return ts.toDate().toISOString();
  } catch {
    return null;
  }
}

/**
 * Sanitize un `Contact` → `ContactHeaderProps`. STRIPPE `phone.*` et
 * `email`. Garde uniquement identité + spécialité + ville + opt-out status.
 */
export function sanitizeContactForHeader(contact: Contact): ContactHeaderProps {
  const civ = typeof contact.civilite === "string" ? contact.civilite.trim() : "";
  const normalizedCiv: ContactHeaderProps["civilite"] =
    civ === "M." || civ === "Mme" || civ === "Dr" || civ === "Pr" ? civ : civ === "" ? null : "";
  return {
    contactId: contact.hubspotId,
    civilite: normalizedCiv,
    firstName: contact.firstName && contact.firstName.length > 0 ? contact.firstName : null,
    lastName: contact.lastName && contact.lastName.length > 0 ? contact.lastName : null,
    speciality: contact.speciality && contact.speciality.length > 0 ? contact.speciality : null,
    city: contact.city && contact.city.length > 0 ? contact.city : null,
    optedOut: Boolean(contact.consent?.optedOut),
  };
}

/**
 * Sanitize un `Message` (shape complète lue par `listMessagesInConversation`)
 * → `MessageProps` pour la bulle. STRIPPE `externalReceiver` (et tout
 * autre champ hors shape de sortie — approche allow-list via construction
 * d'un objet littéral).
 */
export function sanitizeMessageForBubble(
  msg: Message & { messageId: string },
  commercialName: string | null,
): MessageProps | null {
  // Defense-in-depth : les messages `duplicate` DOIVENT disparaître de
  // l'UI (filtrés en amont par `listMessagesInConversation`). Si un
  // document avec `status: "duplicate"` survit jusqu'ici (régression,
  // oubli d'un chemin de lecture), on retourne `null` → le caller
  // (`load-conversation-detail.ts`) filtre les `null` avant d'exposer
  // `messages[]` au client.
  //
  // 🔒 Pattern volontaire : la sanitize est LA source de vérité du
  // filtrage, pas la couche composant. Les tests sentinelle vérifient
  // qu'aucun body `duplicate` n'atteint le DOM rendu.
  if (msg.status === "duplicate") return null;

  const status: MessageDisplayStatus = msg.status as MessageDisplayStatus;

  const abandonReason =
    msg.abandonReason === "stale_pre_launch_test_cleanup" ? msg.abandonReason : undefined;

  return {
    messageId: msg.messageId,
    direction: msg.direction,
    status,
    body: msg.body,
    outboundKind: msg.outboundKind,
    generatedBy: msg.generatedBy,
    createdAtIso: toIsoOrNull(msg.createdAt as Timestamp | undefined) ?? "",
    sentAtIso: toIsoOrNull(msg.sentAt as Timestamp | undefined) ?? undefined,
    deliveredAtIso: toIsoOrNull(msg.deliveredAt as Timestamp | undefined) ?? undefined,
    receivedAtIso: toIsoOrNull(msg.receivedAt as Timestamp | undefined) ?? undefined,
    abandonedAtIso: toIsoOrNull(msg.abandonedAt as Timestamp | undefined) ?? undefined,
    abandonReason,
    intent: msg.intent,
    commercialName,
  };
}

/** Mapping statut conversation. Pass-through typé. */
export function sanitizeConversationStatus(conv: Conversation): ConversationDisplayStatus {
  return conv.status;
}

/** Mapping intent. Pass-through typé. */
export function sanitizeConversationIntent(conv: Conversation): ConversationDisplayIntent {
  return conv.intent;
}

/**
 * Sanitize le hand-off d'une conversation. Si pas de hand-off, retourne null.
 * Le `commercialName` doit être résolu séparément (Airtable) par le caller
 * et injecté ici.
 */
export function sanitizeHandoffForPanel(
  conv: Conversation,
  commercialName: string | null,
): HandoffDisplayProps | null {
  const h = conv.handoff;
  if (!h) return null;
  return {
    assignedToName: commercialName,
    assignedToSlackId: h.assignedTo,
    assignedAtIso: toIsoOrNull(h.assignedAt as Timestamp | undefined),
    contactedAtIso: null, // PR4 : `handoff.contactedAt`
    acceptedAtIso: toIsoOrNull(h.acceptedAt as Timestamp | undefined),
  };
}

/**
 * Transforme une entrée `AuditLog` en libellé lisible français pour le
 * journal du panneau. Zéro PII en sortie — le `payload` audit est déjà
 * scrubber-safe par construction (`detectPiiInPayload` runtime).
 */
function labelForAction(action: string): { label: string; kind: JournalEntryProps["kind"] } {
  switch (action) {
    case "handoff":
      return { label: "Hand-off vers un commercial", kind: "handoff" };
    case "handoff_accepted":
      return { label: "Hand-off accepté", kind: "handoff" };
    case "handoff_unassigned":
      return { label: "Hand-off orphelin (sans titulaire)", kind: "handoff" };
    case "inbound_relayed_to_human":
      return { label: "SMS entrant relayé au commercial", kind: "handoff" };
    case "inbound_on_inactive_conversation":
      return { label: "SMS entrant sur conversation inactive", kind: "other" };
    case "opt_out":
      return { label: "Opt-out du contact (STOP)", kind: "opt_out" };
    case "intent_classified":
      return { label: "Intention classifiée", kind: "intent" };
    case "reply_generated":
      return { label: "Réponse IA générée", kind: "sms" };
    case "reply_processed":
      return { label: "Réponse traitée", kind: "sms" };
    case "reply_dropped":
      return { label: "SMS entrant écarté (doublon)", kind: "other" };
    case "reply_draft_dropped":
      return { label: "Brouillon de réponse écarté", kind: "sms" };
    case "sms_sent":
      return { label: "SMS envoyé", kind: "sms" };
    case "sms_failed":
      return { label: "Échec d'envoi SMS", kind: "sms" };
    case "sms_provider_dispatched":
      return { label: "SMS pris en charge par OVH", kind: "sms" };
    case "sms_received":
      return { label: "SMS reçu du contact", kind: "sms" };
    case "sms_send_initiated_by_admin":
      return { label: "SMS déclenché par un admin", kind: "sms" };
    case "send_blocked":
      return { label: "Envoi bloqué (compliance)", kind: "other" };
    case "compliance_check":
      return { label: "Contrôle compliance", kind: "other" };
    case "contact_phone_accessed":
      return { label: "Numéro consulté", kind: "override" };
    case "contact_imported_from_hubspot":
      return { label: "Contact importé depuis HubSpot", kind: "other" };
    case "contact_created":
      return { label: "Contact créé", kind: "other" };
    case "contact_import_skipped":
      return { label: "Import contact ignoré", kind: "other" };
    case "contact_deleted":
      return { label: "Contact supprimé", kind: "other" };
    case "contact_anonymized":
      return { label: "Contact anonymisé", kind: "other" };
    case "manual_override":
      return { label: "Intervention manuelle (admin)", kind: "override" };
    case "status_changed":
      return { label: "Changement de statut", kind: "other" };
    case "prompt_changed":
      return { label: "Prompt IA modifié", kind: "other" };
    case "campaign_started":
      return { label: "Campagne démarrée", kind: "other" };
    case "campaign_paused":
      return { label: "Campagne en pause", kind: "other" };
    case "campaign_completed":
      return { label: "Campagne terminée", kind: "other" };
    case "long_form_opt_out_candidate":
      return { label: "Signal d'opt-out long format", kind: "opt_out" };
    case "bloctel_imported":
      return { label: "Bloctel importé", kind: "other" };
    case "login":
      return { label: "Connexion", kind: "other" };
    case "role_changed":
      return { label: "Rôle modifié", kind: "other" };
    default:
      return { label: action, kind: "other" };
  }
}

/**
 * Sanitize une liste d'entrées `audit_log` en entrées de journal (shape
 * minimale `JournalEntryProps`). `timestampLabel` est pré-formaté en
 * Europe/Paris côté serveur pour éviter de passer les Timestamp au client.
 */
export function sanitizeAuditEntriesForJournal(
  entries: Array<AuditLog & { docId: string }>,
): JournalEntryProps[] {
  return entries.map((e) => {
    const { label, kind } = labelForAction(e.action);
    return {
      docId: e.docId,
      timestampLabel: formatDateTimeParis(e.timestamp),
      label,
      kind,
    };
  });
}
