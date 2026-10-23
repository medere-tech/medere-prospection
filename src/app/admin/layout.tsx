/**
 * Layout admin protégé — sidebar + header + main content.
 *
 *   - `requireRole("commercial")` : autorise commercial ET admin (hiérarchie).
 *   - UnauthorizedError (pas de session) : capté par Clerk middleware
 *     en amont → redirect `/sign-in`.
 *   - PR1.14.2 — ForbiddenError (sessionClaims invalides, role absent,
 *     testAccount prod) : capturé ici et renvoyé en `forbidden()` →
 *     rendu de `src/app/admin/forbidden.tsx` avec vrai statut HTTP 403
 *     (plutôt qu'une page 500 brute via error.tsx générique). Les autres
 *     erreurs remontent à `error.tsx`.
 *
 *   - Layout responsive flex : sidebar fixe ≥ md, drawer sheet < md
 *     (Vanessa sur tablette portrait, Zacharie sur desktop).
 *
 *   - Le `<AdminSidebar />` est server component qui contient un
 *     `<UserMenuClient />` extraite en client. Le `<AdminHeader />` aussi.
 */
import { forbidden } from "next/navigation";

import { AdminHeader } from "@/components/layout/admin-header";
import { AdminSidebar } from "@/components/layout/admin-sidebar";
import { CommandPalette } from "@/components/layout/command-palette";
import { requireRole, type RoleContext } from "@/lib/auth/require-role";
import { ForbiddenError } from "@/lib/utils/errors";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  let ctx: RoleContext;
  try {
    ctx = await requireRole("commercial");
  } catch (err) {
    if (err instanceof ForbiddenError) {
      // Next 16 : déclenche le rendu de `src/app/admin/forbidden.tsx`
      // avec HTTP 403. L'exception `forbidden()` throw un sentinel que
      // le runtime Next.js intercepte en amont du client.
      forbidden();
    }
    throw err;
  }

  const { role, firstName, lastName } = ctx;

  return (
    <div className="flex min-h-dvh w-full bg-background">
      {/* F-04 fix : skip-to-content visible AU FOCUS clavier — permet à
          Vanessa (clavier Bluetooth iPad) et lecteurs d'écran de sauter
          la sidebar/header pour atteindre le contenu en 1 tab. */}
      <a
        href="#admin-main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:left-2 focus:top-2 focus:rounded-md focus:bg-background focus:p-3 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Aller au contenu principal
      </a>

      {/* Sidebar : fixe ≥ md, sheet < md (mobile drawer rendu dans le header) */}
      <AdminSidebar role={role} firstName={firstName} lastName={lastName} />

      {/* Colonne droite : header + main */}
      <div className="flex flex-1 flex-col min-w-0">
        <AdminHeader role={role} firstName={firstName} lastName={lastName} />
        <main className="flex-1 p-4 md:p-6 lg:p-8" id="admin-main" tabIndex={-1}>
          {children}
        </main>
      </div>

      {/* Cmd+K palette globale — listener hotkey, rendu dans le DOM mais
          invisible jusqu'à l'ouverture. */}
      <CommandPalette />
    </div>
  );
}
