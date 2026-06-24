/**
 * Layout admin protégé — sidebar + header + main content.
 *
 *   - `requireRole("commercial")` : autorise commercial ET admin (hiérarchie).
 *     Throw `UnauthorizedError` ou `ForbiddenError` si non — captés par
 *     Next.js + Clerk middleware en amont (redirect `/sign-in`).
 *
 *   - Layout responsive flex : sidebar fixe ≥ md, drawer sheet < md
 *     (Vanessa sur tablette portrait, Zacharie sur desktop).
 *
 *   - Le `<AdminSidebar />` est server component qui contient un
 *     `<UserMenuClient />` extraite en client. Le `<AdminHeader />` aussi.
 */
import { AdminHeader } from "@/components/layout/admin-header";
import { AdminSidebar } from "@/components/layout/admin-sidebar";
import { CommandPalette } from "@/components/layout/command-palette";
import { requireRole } from "@/lib/auth/require-role";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { role, firstName, lastName } = await requireRole("commercial");

  return (
    <div className="flex min-h-screen w-full bg-background">
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
