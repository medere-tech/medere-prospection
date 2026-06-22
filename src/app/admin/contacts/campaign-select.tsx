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

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { HubspotListInfo } from "@/lib/hubspot/lists";

export interface CampaignSelectProps {
  campaigns: readonly HubspotListInfo[];
  /** Optionnel : appelé après changement (utile pour reset le cursor). */
  onChange?: (campaignId: string | null) => void;
}

function toCampaignId(listId: string): string {
  return `hubspot-list-${listId}`;
}

function fromCampaignId(campaignId: string | null): string | null {
  if (!campaignId) return null;
  const m = campaignId.match(/^hubspot-list-(\d+)$/);
  return m ? (m[1] ?? null) : null;
}

export function CampaignSelect({ campaigns, onChange }: CampaignSelectProps) {
  const [campaignId, setCampaignId] = useQueryState("campaignId");
  const selectedListId = fromCampaignId(campaignId);

  // Signature Base UI `onValueChange?: (value: string | null, eventDetails) => void`
  // — `null` arrive sur déselection (Escape, outsidePress, focus loss).
  // "__all__" est la sentinelle UI pour "pas de filtre" (URL state omis).
  const handleChange = (value: string | null) => {
    if (value === null || value === "__all__" || value === "") {
      void setCampaignId(null);
      onChange?.(null);
      return;
    }
    const next = toCampaignId(value);
    void setCampaignId(next);
    onChange?.(next);
  };

  return (
    <div className="flex min-w-[220px] flex-col gap-1.5">
      <label htmlFor="campaign-select" className="text-xs font-medium text-muted-foreground">
        Campagne HubSpot
      </label>
      <Select value={selectedListId ?? "__all__"} onValueChange={handleChange}>
        <SelectTrigger id="campaign-select" aria-label="Sélectionner une campagne">
          <SelectValue placeholder="Toutes les campagnes" />
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
    </div>
  );
}

// Exposés pour tests
export const __toCampaignId_FOR_TESTS = toCampaignId;
export const __fromCampaignId_FOR_TESTS = fromCampaignId;
