/**
 * En-tête contact de la vue conversation (VUE-CONVERSATION PR1).
 *
 * Affiche : civilité + prénom + nom + spécialité + ville. Zéro PII
 * numéro ni email (strippés par `sanitize.ts`).
 *
 * Le bouton « Afficher le numéro » devient fonctionnel en PR3 (endpoint
 * audité `contact_phone_accessed`). D'ici là il est grisé avec badge
 * « Bientôt », aligné sur le pattern des items sidebar non fonctionnels
 * (décision produit PR1.14 : cibles visibles, jamais masquées).
 */
import { MapPin, Phone, Stethoscope } from "lucide-react";

import { Badge } from "@/components/ui/badge";

import type { ContactHeaderProps, ConversationDisplayIntent } from "./types";

interface Props {
  contact: ContactHeaderProps;
  intent: ConversationDisplayIntent;
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

export function ConversationHeader({ contact, intent }: Props) {
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

      {/* "Afficher le numéro" — grisé jusqu'à PR3 (endpoint audité). */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled
          aria-label="Afficher le numéro, disponible prochainement"
          title="Disponible prochainement"
          className="inline-flex cursor-not-allowed items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground opacity-60"
        >
          <Phone className="h-4 w-4" aria-hidden="true" />
          Afficher le numéro
          <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
            Bientôt
          </Badge>
        </button>
      </div>
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
