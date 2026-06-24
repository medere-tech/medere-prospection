/**
 * Page server `/admin/contacts` (S10.1.5 Phase 5).
 *
 * - L'auth Clerk + RBAC commercial+ est déjà faite par
 *   `src/app/admin/layout.tsx` (server) — pas de re-check ici.
 * - SSR direct via `listSmsLists` (S10.1.5-A1 override Phase 5) — plus
 *   rapide qu'un round-trip API au mount initial. Le client a aussi
 *   `/api/admin/campaigns` disponible pour refresh ultérieur (S10.2+).
 * - Si `listSmsLists` throw (HubSpot 5xx, token expiré), l'erreur remonte
 *   à la Next.js error boundary (`error.tsx` du layout admin, à créer
 *   séparément si besoin — MVP accepte l'erreur standard Next.js).
 *
 * 🚨 Wrapper layout cohérent : `<main id="admin-main">` est posé par le
 * layout, on ne le re-pose pas ici. Le `<h1>` vit DANS
 * `<ContactsPageClient>` (cohérence sémantique : 1 seul h1 par page).
 */
import { listSmsLists } from "@/lib/hubspot/lists";

import { ContactsPageClient } from "./contacts-page-client";

export default async function ContactsPage() {
  const campaigns = await listSmsLists("SMS");
  return <ContactsPageClient initialCampaigns={campaigns} />;
}
