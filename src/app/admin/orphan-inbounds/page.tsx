/**
 * Page server `/admin/orphan-inbounds` (PR2c tour 2b bloc B).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Accès réservé aux admins
 *
 *   `requireRoleOrForbidden("admin")` : un commercial reçoit `forbidden()`
 *   et voit `src/app/admin/forbidden.tsx` avec un vrai 403 HTTP (mème
 *   pattern que `/admin/conversations/page.tsx`). Le layout `/admin/*`
 *   est protégé en amont par `requireRoleOrForbidden("commercial")` →
 *   on ne couvre ici que le palier supérieur « admin only ».
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rendu client en SSR
 *
 *   L'orchestrateur est 100 % client (nuqs + TanStack Query). Le server
 *   component se contente de forcer `dynamic` (lecture authent + query
 *   params `?id=`) et de prouver le RBAC avant d'instancier le client.
 */
import { requireRoleOrForbidden } from "@/lib/auth/require-role";

import { OrphanInboundsPageClient } from "./orphan-inbounds-page-client";

export const dynamic = "force-dynamic";

export default async function OrphanInboundsPage() {
  await requireRoleOrForbidden("admin");
  return <OrphanInboundsPageClient />;
}
