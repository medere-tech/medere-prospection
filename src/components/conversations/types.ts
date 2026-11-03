/**
 * Shapes publiques des props des composants `conversations/*`
 * (VUE-CONVERSATION PR1).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 INVARIANT ANTI-PII — CES SHAPES NE CONTIENNENT NI `e164`, NI `phone`,
 * NI `externalReceiver`, NI `phoneRaw`, NI `email`.
 *
 * Ces champs sont STRIPPÉS côté serveur (`sanitize.ts`) avant d'être
 * sérialisés en payload RSC Next.js. Le numéro ne quitte le serveur
 * QUE via l'endpoint audité `/api/admin/conversations/[id]/reveal-phone`
 * (PR3) — pas ici.
 *
 * Sentinelle : `tests/scripts/no-phone-in-payload.test.ts` sérialise tout
 * et vérifie l'absence du e164.
 */

/** Statut textuel d'un message pour l'affichage sous une bulle outbound. */
export type MessageDisplayStatus =
  | "draft"
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "failed"
  | "received"
  | "abandoned";
// Note : `duplicate` est volontairement ABSENT. Les docs `duplicate` sont
// filtrés hors UI côté `listMessagesInConversation` et ne devraient JAMAIS
// arriver jusqu'à ce composant.

/** Shape d'un message rendu dans le fil de la vue conversation. */
export interface MessageProps {
  messageId: string;
  direction: "inbound" | "outbound";
  status: MessageDisplayStatus;
  body: string;
  outboundKind?: "solicitation" | "reply";
  generatedBy: "ai" | "human" | "system";
  createdAtIso: string;
  sentAtIso?: string;
  deliveredAtIso?: string;
  receivedAtIso?: string;
  abandonedAtIso?: string;
  abandonReason?: "stale_pre_launch_test_cleanup";
  intent?: "INTERESSE" | "NEUTRE" | "OBJECTION" | "STOP" | "unknown";
  /**
   * Nom du commercial (`generatedBy === "human"`) à afficher avec la
   * bulle. Résolu côté serveur via Airtable Commerciaux. `null` si non
   * résolvable (fallback « Commercial »).
   */
  commercialName: string | null;
  /**
   * PR2c tour 2b bloc B — origine « rattachement manuel depuis un SMS
   * orphelin ». Posé par `attachOrphanToConversation` sur le doc message
   * dans la même transaction. La bulle affiche :
   *   - un bandeau « Ajouté manuellement depuis un SMS orphelin »,
   *   - un sous-indicateur « Envoyé depuis un autre numéro » quand
   *     `phoneMatch === "mismatch"`.
   *
   * `undefined` → message issu du flux normal (webhook OVH direct). Pas
   * d'affichage particulier.
   */
  attachedFromOrphan?: {
    phoneMatch: "match" | "mismatch" | "not_computable";
  };
}

/** Statut global de la conversation (bandeau en-tête). */
export type ConversationDisplayStatus =
  | "active"
  | "awaiting_reply"
  | "in_dialogue"
  | "qualified"
  | "handed_off"
  | "closed"
  | "opted_out"
  | "blocked";

/** Intent classifié par Claude. */
export type ConversationDisplayIntent = "INTERESSE" | "NEUTRE" | "OBJECTION" | "STOP" | "unknown";

/** Shape "contact" rendue en en-tête (zéro PII numéro). */
export interface ContactHeaderProps {
  contactId: string;
  civilite: "M." | "Mme" | "Dr" | "Pr" | "" | null;
  firstName: string | null;
  lastName: string | null;
  speciality: string | null;
  city: string | null;
  /** `true` si le contact a `consent.optedOut`. Affiché en pastille rouge. */
  optedOut: boolean;
}

/** Infos hand-off à afficher dans le panneau latéral. */
export interface HandoffDisplayProps {
  /** Nom du commercial titulaire résolu via Airtable. Fallback générique. */
  assignedToName: string | null;
  /** Slack userId du titulaire (identifiant workspace, pas PII personnelle). */
  assignedToSlackId: string | null;
  assignedAtIso: string | null;
  contactedAtIso: string | null;
  acceptedAtIso: string | null;
}

/** Entrée du journal fusionné (audits conversation + audits contact). */
export interface JournalEntryProps {
  docId: string;
  /** `jj/mm/aaaa à HH:mm` déjà formaté en Europe/Paris côté serveur. */
  timestampLabel: string;
  /** Libellé lisible en français de l'action (ex: « Opt-out reçu »). */
  label: string;
  /** Icône générique recommandée pour l'UI. */
  kind: "handoff" | "opt_out" | "intent" | "override" | "sms" | "other";
}

/** Shape complète passée au client wrapper. */
export interface ConversationDetailProps {
  conversationId: string;
  contactId: string;
  status: ConversationDisplayStatus;
  intent: ConversationDisplayIntent;
  /** docId Firestore `hubspot-list-${listId}`. Jamais affiché brut dans
   * l'UI — toujours passé par `campaignDisplayLabel`. */
  campaignId: string;
  /** Libellé humain pré-résolu côté serveur via la map HubSpot. `null`
   * si la campagne a disparu de HubSpot entre le seed et l'affichage —
   * l'UI tombera alors sur `CAMPAIGN_UNKNOWN_LABEL`. Jamais l'id brut. */
  campaignName: string | null;
  createdAtIso: string;
  /**
   * `conv.updatedAt` en ISO 8601. Exposé côté payload RSC pour que la
   * signature SSR calculée par `signatureFromDetail` soit STRICTEMENT
   * identique à celle du premier poll `/version` (champ `updatedAtIso`).
   * Sans ça, le premier poll déclencherait toujours un refetch détail
   * inutile (~245 reads/jour/commercial évitables).
   *
   * Zéro PII : c'est un timestamp opaque de mutation.
   */
  updatedAtIso: string;
  lastInboundAtIso: string | null;
  lastOutboundAtIso: string | null;
  inboundCount: number;
  outboundCount: number;
  summary: string | null;
  handoff: HandoffDisplayProps | null;
  contact: ContactHeaderProps;
  messages: MessageProps[];
  journal: JournalEntryProps[];
  /**
   * `true` si l'utilisateur courant est admin (voit tout + bannière info)
   * ou le commercial titulaire. `false` ne doit JAMAIS atteindre cette
   * shape — un commercial non-titulaire est bloqué AVANT par un 403 dans
   * le server component parent.
   */
  viewerIsOwner: boolean;
}
