"use client";

/**
 * Dropdown campagne pour `/admin/contacts` (S10.1.5 Phase 3).
 *
 * - Source des campagnes : prop `campaigns` injectée par le parent
 *   (server component fetch initial via `listSmsLists` direct — décision
 *   S10.1.5-A1 override Phase 5).
 * - État persistant via nuqs : `?campaignId=hubspot-list-200`.
 * - Cohérent avec la regex serveur `^hubspot-list-\d+$` (S10.1.4.a) —
 *   format Médéré verrouillé.
 */
import { useQueryState } from "nuqs";

import { FilterUnknownNotice } from "@/components/filters/filter-unknown-notice";
import { resolveFilterLabel } from "@/components/filters/filter-value-label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { extractListId, toCanonicalCampaignId } from "@/lib/campaigns/campaign-id";
import type { HubspotListInfo } from "@/lib/hubspot/lists";

export interface CampaignSelectProps {
  campaigns: readonly HubspotListInfo[];
  /** Optionnel : appelé après changement (utile pour reset le cursor). */
  onChange?: (campaignId: string | null) => void;
}

// PR2b-2 round 2 — `toCampaignId` / `fromCampaignId` locaux supprimés,
// remplacés par `toCanonicalCampaignId` / `extractListId` de
// `@/lib/campaigns/campaign-id` (helper central réutilisé par
// `conversations-page-client.tsx`, `columns.tsx`, et toute future route).

/**
 * Handler pur (S10.1.7-M5 — extrait pour testabilité). Logique branche
 * la Base UI Select `onValueChange` → setCampaignId nuqs + callback parent.
 *
 * Signature Base UI : `onValueChange?: (value: string | null, eventDetails) => void`.
 * `null` arrive sur déselection (Escape, outsidePress, focus loss).
 * "__all__" est la sentinelle UI pour "pas de filtre" (URL state omis).
 */
export function handleCampaignChange(
  value: string | null,
  setCampaignId: (v: string | null) => void,
  onChange?: (campaignId: string | null) => void,
): void {
  if (value === null || value === "__all__" || value === "") {
    void setCampaignId(null);
    onChange?.(null);
    return;
  }
  const next = toCanonicalCampaignId(value);
  if (next === null) {
    // Entrée non reconnue (ni listId court, ni canonique) : on garde le
    // comportement conservateur = reset du filtre plutôt que persister
    // une valeur invalide dans l'URL.
    void setCampaignId(null);
    onChange?.(null);
    return;
  }
  void setCampaignId(next);
  onChange?.(next);
}

export function CampaignSelect({ campaigns, onChange }: CampaignSelectProps) {
  const [campaignId, setCampaignId] = useQueryState("campaignId");
  const selectedListId = extractListId(campaignId);

  const handleChange = (value: string | null) =>
    handleCampaignChange(value, setCampaignId, onChange);

  // PR2b-2 P1 — Trigger affiche toujours le nom de la campagne, jamais
  // l'identifiant brut (`hubspot-list-6081`). Cf. `commercial-select.tsx`
  // pour la cause racine Base UI.
  const label = resolveFilterLabel({
    value: selectedListId,
    items: campaigns,
    keyOf: (c) => c.listId,
    nameOf: (c) => c.name,
    allLabel: "Toutes les campagnes",
    unknownLabel: "Campagne inconnue",
  });

  return (
    <div className="flex min-w-[220px] flex-col gap-1.5">
      <label htmlFor="campaign-select" className="text-xs font-medium text-muted-foreground">
        Campagne HubSpot
      </label>
      <Select value={selectedListId ?? "__all__"} onValueChange={handleChange}>
        <SelectTrigger id="campaign-select" aria-label="Sélectionner une campagne">
          <SelectValue>{() => label.display}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">Toutes les campagnes</SelectItem>
          {campaigns.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              Aucune campagne disponible
            </div>
          ) : (
            campaigns.map((c) => (
              <SelectItem key={c.listId} value={c.listId}>
                <span className="flex items-center gap-2">
                  <span>{c.name}</span>
                  {c.size !== undefined && (
                    <span className="text-xs text-muted-foreground tabular-nums">({c.size})</span>
                  )}
                </span>
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
      {!label.known && (
        <FilterUnknownNotice
          label="Retirer le filtre campagne"
          onClear={() => handleChange(null)}
        />
      )}
    </div>
  );
}

// Exposés pour tests — forward vers le helper central (préserve la
// surface des anciens tests S10.1.5 sans dupliquer la logique).
export const __toCampaignId_FOR_TESTS = (listId: string): string =>
  toCanonicalCampaignId(listId) ?? "";
export const __fromCampaignId_FOR_TESTS = (campaignId: string | null): string | null =>
  extractListId(campaignId);
