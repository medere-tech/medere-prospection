/**
 * En-tête contact de la vue conversation (VUE-CONVERSATION PR1 → PR3).
 *
 * Affiche : civilité + prénom + nom + spécialité + ville. Zéro PII
 * numéro ni email (strippés par `sanitize.ts`).
 *
 * PR3 tour 2b — le bouton « Afficher le numéro » est branché sur
 * `POST /api/admin/conversations/[id]/reveal-phone` via
 * `RevealPhoneAction`. Chaque action (afficher/copier/appeler) déclenche
 * un write `contact_phone_accessed` audité AVANT de rendre le numéro ;
 * audit en échec = clipboard et tel: intacts (cf. JSDoc du composant).
 */
import { MapPin, Stethoscope } from "lucide-react";

import { RevealPhoneAction } from "./reveal-phone-action";
import type { ContactHeaderProps, ConversationDisplayIntent } from "./types";

interface Props {
  contact: ContactHeaderProps;
  intent: ConversationDisplayIntent;
  /**
   * docId Firestore composite `${contactId}_${campaignId}` — passé à
   * `RevealPhoneAction` pour construire l'endpoint audité. Requis en PR3.
   * `phoneLast4` est lu depuis `contact.phoneLast4` (source unique).
   */
  conversationId: string;
  /** Callback appelé après chaque POST reveal-phone réussi — invalide le journal. */
  onAudited?: () => void;
}

const INTENT_LABELS: Record<ConversationDisplayIntent, string> = {
  INTERESSE: "Intéressé",
  OBJECTION: "Objection",
  NEUTRE: "Neutre",
  STOP: "STOP",
  unknown: "Non classifié",
};

const INTENT_CLASSES: Record<ConversationDisplayIntent, string> = {
  INTERESSE: "border-emerald-400/40 bg-emerald-500/10 text-emerald-400",
  OBJECTION: "border-amber-400/40 bg-amber-500/10 text-amber-400",
  NEUTRE: "border-border bg-card text-muted-foreground",
  STOP: "border-destructive/40 bg-destructive/10 text-destructive-foreground",
  unknown: "border-dashed border-border bg-card text-muted-foreground",
};

export function ConversationHeader({ contact, intent, conversationId, onAudited }: Props) {
  const fullName = buildFullName(contact);
  return (
    <header className="flex flex-col gap-3 border-b pb-4 md:flex-row md:items-start md:justify-between">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold leading-tight">{fullName ?? "Contact sans nom"}</h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          {contact.speciality ? (
            <span className="inline-flex items-center gap-1">
              <Stethoscope className="h-3.5 w-3.5" aria-hidden="true" />
              {contact.speciality}
            </span>
          ) : null}
          {contact.city ? (
            <span className="inline-flex items-center gap-1">
              <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
              {contact.city}
            </span>
          ) : null}
          <span
            className={`inline-flex items-center rounded border px-2 py-0.5 text-xs ${INTENT_CLASSES[intent]}`}
            aria-label={`Intention : ${INTENT_LABELS[intent]}`}
          >
            {INTENT_LABELS[intent]}
          </span>
        </div>
      </div>

      <RevealPhoneAction
        endpoint={`/api/admin/conversations/${encodeURIComponent(conversationId)}/reveal-phone`}
        phoneLast4={contact.phoneLast4}
        onAudited={onAudited}
      />
    </header>
  );
}

/** Construit le nom complet avec civilité, en évitant les espaces fantômes. */
function buildFullName(contact: ContactHeaderProps): string | null {
  const parts: string[] = [];
  if (contact.civilite) parts.push(contact.civilite);
  if (contact.firstName) parts.push(contact.firstName);
  if (contact.lastName) parts.push(contact.lastName);
  if (parts.length === 0) return null;
  return parts.join(" ");
}
