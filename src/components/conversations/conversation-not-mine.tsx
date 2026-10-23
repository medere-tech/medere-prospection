/**
 * Page 403 — un commercial non-titulaire tente d'ouvrir une conversation
 * qui ne lui est pas assignée (VUE-CONVERSATION PR1).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Décision Déthié : nommer le titulaire pour faciliter la demande de
 * transfert. Si résolution Slack ID → nom échoue (contact Airtable
 * inactif, HS Airtable), fallback générique « un autre commercial ».
 *
 * PII minimale employé interne — nom professionnel du commercial Médéré,
 * source Airtable RH, affiché à un autre commercial Médéré authentifié
 * pour permettre la demande de transfert interne. Base légale : intérêt
 * légitime de l'employeur à faciliter la collaboration équipe (RGPD
 * Art. 6.1.f). Pas de donnée patient ni de PII externe (ni email, ni
 * téléphone, ni source CRM — Airtable RH uniquement).
 */
import { ShieldOff } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

interface Props {
  /** Nom résolu depuis Airtable Commerciaux, ou `null` si introuvable. */
  assignedToName: string | null;
}

export function ConversationNotMine({ assignedToName }: Props) {
  const label = assignedToName ?? "Un autre commercial";
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-5 py-16 text-center">
      <ShieldOff className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">Conversation suivie par un collègue</h1>
        <p className="text-sm text-muted-foreground">
          {assignedToName
            ? `Cette conversation est suivie par ${label}.`
            : "Cette conversation est suivie par un autre commercial."}{" "}
          Demandez-lui de vous la transférer si vous devez intervenir.
        </p>
      </div>
      <Link href="/admin/contacts">
        <Button variant="outline">Retour au tableau de bord</Button>
      </Link>
    </div>
  );
}
