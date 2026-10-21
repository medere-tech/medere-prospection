/**
 * Sidebar desktop fixe — visible ≥ md, masquée < md.
 * En < md, c'est le `<AdminHeader />` qui rend un drawer sheet équivalent.
 *
 * Server Component (pas de state local) — délègue l'active state au
 * `<AdminNavItems />` qui est client (usePathname) et le user menu au
 * `<UserMenuClient />`.
 */
import Link from "next/link";

import { AdminNavItems } from "@/components/layout/admin-nav-items";
import { UserMenuClient } from "@/components/layout/user-menu-client";
import type { Role } from "@/lib/auth/require-role";

export function AdminSidebar({
  role,
  firstName,
  lastName,
}: {
  role: Role;
  firstName?: string;
  lastName?: string;
}) {
  return (
    <aside
      aria-label="Barre latérale admin"
      // PR1.14 : sidebar sticky plein viewport + flex column.
      //   - `sticky top-0 h-dvh` : la barre colle en haut et occupe la
      //     hauteur dynamique du viewport (iOS Safari compris, barre d'URL
      //     dynamique). Garantit que profil/déconnexion restent visibles.
      //   - La zone nav est `flex-1 min-h-0 overflow-y-auto` → scroll
      //     interne si beaucoup d'items, sans jamais pousser le pied hors
      //     viewport (sans `min-h-0`, flex-1 déborde le parent).
      //   - Le pied est `shrink-0` → jamais compressé.
      className="sticky top-0 hidden h-dvh w-60 shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex md:flex-col"
    >
      <div className="flex h-14 shrink-0 items-center border-b border-sidebar-border px-4">
        <Link
          href="/admin/contacts"
          className="flex items-center gap-2 font-heading text-base font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        >
          <span aria-hidden className="inline-block size-2 rounded-full bg-primary" />
          Médéré
        </Link>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <AdminNavItems role={role} />
      </div>

      <div className="shrink-0 border-t border-sidebar-border p-3">
        <UserMenuClient role={role} firstName={firstName} lastName={lastName} />
      </div>
    </aside>
  );
}
