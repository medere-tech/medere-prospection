/**
 * Mapping onglet → filtres conversation partagé (PR2a + PR4).
 *
 * SOURCE UNIQUE utilisée par :
 *   - `src/app/api/admin/conversations/route.ts` (liste)
 *   - `src/app/api/admin/conversations/counts/route.ts`
 *   - `src/app/api/admin/conversations/version/route.ts`
 *   - `src/lib/firestore/conversation-list-query-forms.ts` (vérification d'index)
 *
 * Toute modification du mapping doit être reflétée sur ces 4 sites via ce
 * module unique — pas de duplication.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * PR4 — « J'ai contacté » : décomposition `handed_off` en 2 onglets
 *
 *   - `a_traiter`  : `status==handed_off AND handoffContacted==false`
 *   - `contactees` : `status==handed_off AND handoffContacted==true`
 *
 *   Admin voit 5 onglets, commercial voit 4 (pas `en_cours`). Chaque
 *   onglet porte un filtre en 2 dimensions `{ statuses, handoffContacted }` ;
 *   `undefined` sur l'une = pas de filtre sur cet axe (ex: `cloturees` ne
 *   filtre pas sur `handoffContacted`, `toutes` ne filtre sur rien).
 */
import type { ConversationStatus } from "@/types/conversation";

export interface TabFilter {
  readonly statuses: readonly ConversationStatus[] | undefined;
  readonly handoffContacted: boolean | undefined;
}

const HANDED_OFF_STATUSES: readonly ConversationStatus[] = ["handed_off"];

export const TAB_TO_FILTER: Record<
  "a_traiter" | "contactees" | "en_cours" | "cloturees",
  TabFilter
> = {
  a_traiter: { statuses: HANDED_OFF_STATUSES, handoffContacted: false },
  contactees: { statuses: HANDED_OFF_STATUSES, handoffContacted: true },
  en_cours: {
    statuses: ["active", "awaiting_reply", "in_dialogue", "qualified"],
    handoffContacted: undefined,
  },
  cloturees: {
    statuses: ["closed", "opted_out", "blocked"],
    handoffContacted: undefined,
  },
};

export const ADMIN_TABS = ["toutes", "a_traiter", "contactees", "en_cours", "cloturees"] as const;
export const COMMERCIAL_TABS = ["toutes", "a_traiter", "contactees", "cloturees"] as const;

export const ALLOWED_TABS_BY_ROLE: Record<"admin" | "commercial", ReadonlyArray<string>> = {
  admin: ADMIN_TABS as unknown as string[],
  commercial: COMMERCIAL_TABS as unknown as string[],
};

export type ListTab = (typeof ADMIN_TABS)[number];

/**
 * Retourne le filtre d'un onglet. Pour `toutes`, retourne `{ statuses:
 * undefined, handoffContacted: undefined }` — rien n'est filtré.
 */
export function filterForTab(tab: string): TabFilter {
  if (tab === "a_traiter" || tab === "contactees" || tab === "en_cours" || tab === "cloturees") {
    return TAB_TO_FILTER[tab];
  }
  return { statuses: undefined, handoffContacted: undefined };
}

/**
 * ⚠️ DEPRECATED (compat PR2a). Garde la signature historique
 * (`statuses | undefined`) pour les callers qui ne gèrent pas encore
 * `handoffContacted`. Les nouveaux callers doivent utiliser `filterForTab`.
 */
export function statusesForTab(tab: string): ConversationStatus[] | undefined {
  const f = filterForTab(tab);
  return f.statuses ? [...f.statuses] : undefined;
}
