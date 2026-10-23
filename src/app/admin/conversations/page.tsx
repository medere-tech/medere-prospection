/**
 * Page server `/admin/conversations` (PR2b-1).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Auth
 *
 *   L'auth Clerk + RBAC (role minimum = commercial) + le fail-closed
 *   `commercial sans slackUserId → 403` sont faits par :
 *     - `src/app/admin/layout.tsx:30-39` → `forbidden()` renvoie
 *       `src/app/admin/forbidden.tsx` + statut HTTP 403 natif Next.
 *     - `src/app/api/admin/conversations*` (PR2a) : re-vérifié à chaque
 *       appel API côté serveur (jamais côté UI).
 *   La page elle-même ne re-check PAS — mais récupère le rôle via
 *   `requireRole("commercial")` pour le passer en prop (les onglets
 *   diffèrent par rôle, source unique `conversation-list-tabs.ts`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Preload serveur (zéro appel HubSpot/Airtable par ligne)
 *
 *   - `campaigns` : `listSmsLists("SMS")` — identique à /admin/contacts.
 *     Cache HubSpot géré par le wrapper. Passé en prop → map locale
 *     côté client `campaignId → campaignName`.
 *   - `commerciaux` : `listCommerciauxForFilter()` — Airtable cache 5 min.
 *     Alimente le dropdown « Commercial » (admin uniquement). Pour un
 *     commercial loggé, non envoyé (il n'y a pas de dropdown à alimenter).
 */
import { listCommerciauxForFilter } from "@/lib/airtable/commerciaux";
import { requireRole } from "@/lib/auth/require-role";
import { listSmsLists } from "@/lib/hubspot/lists";

import { ConversationsPageClient } from "./conversations-page-client";

export default async function ConversationsPage() {
  const { role, slackUserId } = await requireRole("commercial");

  // Deux fetchs SSR en parallèle. Si l'un throw :
  //   - HubSpot down → Next.js error boundary (page error.tsx)
  //   - Airtable down → fallback liste vide côté admin, UI dégradée mais
  //     la liste de conversations reste accessible (le filtre commercial
  //     montrera un dropdown vide avec un placeholder "Indisponible").
  const [campaigns, commerciauxOrError] = await Promise.all([
    listSmsLists("SMS"),
    role === "admin" ? listCommerciauxForFilter().catch(() => null) : Promise.resolve(null),
  ]);

  // Projection minimale pour le client — on ne sérialise QUE ce qui est
  // utile au dropdown. `active` est délibérément inclus pour que l'UI
  // puisse signaler visuellement un commercial inactif ("(inactif)").
  const commerciauxForClient =
    commerciauxOrError === null
      ? null
      : commerciauxOrError.map((c) => ({
          slackUserId: c.slackUserId,
          name: c.name,
          active: c.active,
        }));

  return (
    <ConversationsPageClient
      role={role}
      viewerSlackUserId={slackUserId ?? null}
      initialCampaigns={campaigns}
      initialCommerciaux={commerciauxForClient}
    />
  );
}
