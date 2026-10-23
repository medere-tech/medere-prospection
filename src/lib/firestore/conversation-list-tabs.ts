/**
 * Mapping onglet → statuts conversation partagé (PR2a).
 *
 * SOURCE UNIQUE utilisée par :
 *   - `src/app/api/admin/conversations/route.ts` (liste)
 *   - `src/app/api/admin/conversations/counts/route.ts`
 *   - `src/app/api/admin/conversations/version/route.ts`
 *   - `src/lib/firestore/conversation-list-query-forms.ts` (vérification d'index)
 *
 * Toute modification du mapping doit être reflétée sur ces 4 sites via ce
 * module unique — pas de duplication.
 */
import type { ConversationStatus } from "@/types/conversation";

export const TAB_TO_STATUSES: Record<"a_traiter" | "en_cours" | "cloturees", ConversationStatus[]> =
  {
    a_traiter: ["handed_off"],
    en_cours: ["active", "awaiting_reply", "in_dialogue", "qualified"],
    cloturees: ["closed", "opted_out", "blocked"],
  };

export const ADMIN_TABS = ["toutes", "a_traiter", "en_cours", "cloturees"] as const;
export const COMMERCIAL_TABS = ["toutes", "a_traiter", "cloturees"] as const;

export const ALLOWED_TABS_BY_ROLE: Record<"admin" | "commercial", ReadonlyArray<string>> = {
  admin: ADMIN_TABS as unknown as string[],
  commercial: COMMERCIAL_TABS as unknown as string[],
};

export type ListTab = (typeof ADMIN_TABS)[number];

/** Retourne les statuts d'un onglet, ou `undefined` pour `toutes`. */
export function statusesForTab(tab: string): ConversationStatus[] | undefined {
  if (tab === "toutes") return undefined;
  if (tab === "a_traiter" || tab === "en_cours" || tab === "cloturees") {
    return TAB_TO_STATUSES[tab];
  }
  return undefined;
}
