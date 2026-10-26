/**
 * Panneau latéral de la vue conversation (VUE-CONVERSATION PR1).
 *
 * Trois sections :
 *   1. **Métadonnées** : campaignId, compteurs inbound/outbound, créée le,
 *      dernier échange.
 *   2. **Hand-off** : titulaire (nom résolu + Slack ID), dates
 *      `assignedAt` / `acceptedAt` / `contactedAt` (PR4).
 *   3. **Journal** : audits conversation + contact fusionnés, les 5
 *      derniers, triés `timestamp desc`.
 *
 * Zéro PII (numéros/emails strippés par `sanitize.ts`).
 */
import { Clock, FileText, Hash, Inbox, Mail, UserCheck } from "lucide-react";

import { campaignDisplayLabel } from "@/lib/campaigns/campaign-id";
import { formatDateTimeParis } from "@/lib/utils/format-paris";

import type { ConversationDetailProps, JournalEntryProps } from "./types";

interface Props {
  data: ConversationDetailProps;
}

export function ConversationSidePanel({ data }: Props) {
  return (
    <aside
      aria-label="Détails de la conversation"
      className="flex flex-col gap-5 rounded-lg border bg-card p-4"
    >
      {/* Section 1 — Métadonnées */}
      <section aria-labelledby="section-meta" className="flex flex-col gap-3">
        <h2
          id="section-meta"
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Détails
        </h2>
        <dl className="grid grid-cols-1 gap-y-2 text-sm">
          <MetaRow
            icon={<Hash className="h-3.5 w-3.5" />}
            label="Campagne"
            // PR2b-2 round 3 — JAMAIS `data.campaignId` brut (`hubspot-list-6081`
            // était affiché avant). On privilégie la copie dénormalisée
            // `campaignName`. Si absente, `campaignDisplayLabel` tombe sur
            // "Campagne inconnue" (map vide côté détail, pas de refetch
            // HubSpot pour éviter un round-trip SSR).
            value={campaignDisplayLabel(data.campaignId, data.campaignName, new Map())}
          />
          <MetaRow
            icon={<Clock className="h-3.5 w-3.5" />}
            label="Créée le"
            value={formatDateTimeParis(data.createdAtIso)}
          />
          <MetaRow
            icon={<Inbox className="h-3.5 w-3.5" />}
            label="Dernier message reçu"
            value={data.lastInboundAtIso ? formatDateTimeParis(data.lastInboundAtIso) : "—"}
          />
          <MetaRow
            icon={<Mail className="h-3.5 w-3.5" />}
            label="Dernier message envoyé"
            value={data.lastOutboundAtIso ? formatDateTimeParis(data.lastOutboundAtIso) : "—"}
          />
          <MetaRow
            icon={<Inbox className="h-3.5 w-3.5" />}
            label="Messages reçus"
            value={String(data.inboundCount)}
          />
          <MetaRow
            icon={<Mail className="h-3.5 w-3.5" />}
            label="Messages envoyés"
            value={String(data.outboundCount)}
          />
        </dl>
      </section>

      {/* Section 2 — Hand-off */}
      {data.handoff ? (
        <section aria-labelledby="section-handoff" className="flex flex-col gap-3 border-t pt-4">
          <h2
            id="section-handoff"
            className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Hand-off
          </h2>
          <dl className="grid grid-cols-1 gap-y-2 text-sm">
            <MetaRow
              icon={<UserCheck className="h-3.5 w-3.5" />}
              label="Titulaire"
              value={data.handoff.assignedToName ?? "Un autre commercial"}
            />
            {data.handoff.assignedAtIso ? (
              <MetaRow
                icon={<Clock className="h-3.5 w-3.5" />}
                label="Repris le"
                value={formatDateTimeParis(data.handoff.assignedAtIso)}
              />
            ) : null}
            {data.handoff.contactedAtIso ? (
              <MetaRow
                icon={<Clock className="h-3.5 w-3.5" />}
                label="Contacté le"
                value={formatDateTimeParis(data.handoff.contactedAtIso)}
              />
            ) : null}
            {data.handoff.acceptedAtIso ? (
              <MetaRow
                icon={<Clock className="h-3.5 w-3.5" />}
                label="Accepté le"
                value={formatDateTimeParis(data.handoff.acceptedAtIso)}
              />
            ) : null}
          </dl>
        </section>
      ) : null}

      {/* Section 3 — Journal */}
      <section aria-labelledby="section-journal" className="flex flex-col gap-3 border-t pt-4">
        <h2
          id="section-journal"
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Journal
        </h2>
        {data.journal.length === 0 ? (
          <p className="text-xs text-muted-foreground">Aucune entrée récente dans le journal.</p>
        ) : (
          <ol className="flex flex-col gap-2 text-xs">
            {data.journal.map((entry) => (
              <JournalRow key={entry.docId} entry={entry} />
            ))}
          </ol>
        )}
      </section>

      {/* Section 4 — Résumé hand-off (optionnel) */}
      {data.summary ? (
        <section aria-labelledby="section-summary" className="flex flex-col gap-2 border-t pt-4">
          <h2
            id="section-summary"
            className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Synthèse hand-off
          </h2>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {data.summary}
          </p>
        </section>
      ) : null}
    </aside>
  );
}

function MetaRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-x-2">
      <dt className="inline-flex items-center gap-1 text-muted-foreground" aria-hidden="true">
        {icon}
      </dt>
      <dd className="flex flex-col">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-sm text-foreground">{value}</span>
      </dd>
    </div>
  );
}

function JournalRow({ entry }: { entry: JournalEntryProps }) {
  return (
    <li className="flex items-start gap-2">
      <FileText className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="flex flex-col">
        <span className="text-foreground">{entry.label}</span>
        <span className="text-muted-foreground">{entry.timestampLabel}</span>
      </div>
    </li>
  );
}
