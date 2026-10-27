/**
 * Page server `/admin/contacts` (S10.1.5 Phase 5).
 *
 * - L'auth Clerk + RBAC commercial+ est déjà faite par
 *   `src/app/admin/layout.tsx` (server) — pas de re-check ici.
 * - SSR via `getCachedSmsCampaigns` (PR2c tour 1 — source unique de
 *   cache 5 min, miroir `/admin/conversations`, `/api/admin/campaigns`
 *   et `load-conversation-detail.ts`). Pas de refetch HubSpot si une
 *   autre route a déjà tapé la liste dans la fenêtre TTL.
 * - Si `getCachedSmsCampaigns` throw (HubSpot 5xx, token expiré),
 *   l'erreur remonte à la Next.js error boundary (`error.tsx` du
 *   layout admin, à créer séparément si besoin — MVP accepte l'erreur
 *   standard Next.js). Le cache invalide alors son TTL (cf.
 *   `campaigns-cache.ts:52-55`), le prochain hit retentera.
 *
 * 🚨 Wrapper layout cohérent : `<main id="admin-main">` est posé par le
 * layout, on ne le re-pose pas ici. Le `<h1>` vit DANS
 * `<ContactsPageClient>` (cohérence sémantique : 1 seul h1 par page).
 */
import { getCachedSmsCampaigns } from "@/lib/campaigns/campaigns-cache";

import { ContactsPageClient } from "./contacts-page-client";

export default async function ContactsPage() {
  const campaigns = await getCachedSmsCampaigns();
  return <ContactsPageClient initialCampaigns={campaigns} />;
}
