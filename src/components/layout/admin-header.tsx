"use client";

/**
 * Header admin — breadcrumb + drawer mobile + Cmd+K + theme toggle + user menu.
 *
 * Client component car :
 *   - usePathname pour le breadcrumb dynamique
 *   - useState pour l'ouverture du drawer mobile
 *   - dispatch event pour ouvrir la command palette
 *
 * Drawer mobile : sheet gauche < md, déclenché par hamburger button.
 * Réutilise `<AdminNavItems />` (source unique partagée avec sidebar).
 */
import { Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { AdminNavItems } from "@/components/layout/admin-nav-items";
import { UserMenuClient } from "@/components/layout/user-menu-client";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import type { Role } from "@/lib/auth/require-role";

import { ADMIN_NAV_ITEMS } from "./admin-nav-items";

// ─────────────────────────────────────────────────────────────────────────────
// Breadcrumb dérivé du pathname (mapping flat — étendre quand on aura des
// pages détail type /admin/contacts/[id]).
// ─────────────────────────────────────────────────────────────────────────────

function deriveBreadcrumb(pathname: string): { label: string; href?: string }[] {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return [{ label: "Admin" }];

  // F-08 fix : pas de lien circulaire — si on est sur /admin/contacts
  // (la home admin MVP), le crumb "Admin" n'a PAS de href (il ne mène
  // à rien d'utile, juste à la même page).
  const isOnAdminHome = pathname === "/admin/contacts" || pathname === "/admin";
  const crumbs: { label: string; href?: string }[] = [
    isOnAdminHome ? { label: "Admin" } : { label: "Admin", href: "/admin/contacts" },
  ];

  if (segments[0] === "admin" && segments.length > 1) {
    const matchedItem = ADMIN_NAV_ITEMS.find((i) => i.href === `/admin/${segments[1]}`);
    if (matchedItem) {
      crumbs.push({ label: matchedItem.label });
    } else {
      // Fallback : capitalise le segment.
      crumbs.push({ label: segments[1]!.charAt(0).toUpperCase() + segments[1]!.slice(1) });
    }
  }

  return crumbs;
}

export function AdminHeader({
  role,
  firstName,
  lastName,
}: {
  role: Role;
  firstName?: string;
  lastName?: string;
}) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const breadcrumb = deriveBreadcrumb(pathname);

  function openCommandPalette() {
    // Dispatch event consommé par <CommandPalette /> (qui écoute Cmd+K +
    // ce custom event pour un trigger manuel).
    window.dispatchEvent(new CustomEvent("medere:open-command-palette"));
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-3 md:px-6">
      {/* Mobile drawer trigger (< md) */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetTrigger
          render={
            // Touch target 44px minimum (iOS HIG / WCAG 2.5.5) — size-11 = 44px.
            <Button
              variant="ghost"
              size="icon"
              className="size-11 md:hidden"
              aria-label="Ouvrir le menu"
            >
              <Menu className="size-5" aria-hidden />
            </Button>
          }
        />
        <SheetContent side="left" className="w-72 p-0 flex flex-col">
          <SheetTitle className="sr-only">Navigation Médéré Admin</SheetTitle>
          <div className="flex h-14 items-center border-b border-sidebar-border px-4">
            <span className="flex items-center gap-2 font-heading text-base font-semibold tracking-tight">
              <span aria-hidden className="inline-block size-2 rounded-full bg-primary" />
              Médéré
            </span>
          </div>
          <div className="flex-1 overflow-y-auto">
            <AdminNavItems role={role} onNavigate={() => setDrawerOpen(false)} />
          </div>
          <div className="border-t border-sidebar-border p-3">
            <UserMenuClient role={role} firstName={firstName} lastName={lastName} />
          </div>
        </SheetContent>
      </Sheet>

      {/* Breadcrumb */}
      <nav aria-label="Fil d'Ariane" className="flex items-center gap-2 text-sm">
        <ol className="flex items-center gap-2">
          {breadcrumb.map((crumb, i) => {
            const isLast = i === breadcrumb.length - 1;
            return (
              <li key={i} className="flex items-center gap-2">
                {i > 0 && (
                  <span aria-hidden className="text-muted-foreground/60">
                    /
                  </span>
                )}
                {crumb.href && !isLast ? (
                  <Link
                    href={crumb.href}
                    className="text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span
                    className={isLast ? "font-medium text-foreground" : "text-muted-foreground"}
                    aria-current={isLast ? "page" : undefined}
                  >
                    {crumb.label}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      {/* Spacer flex-1 */}
      <div className="flex-1" />

      {/* Right cluster : Cmd+K + theme toggle + user menu (sur desktop) */}
      <Button
        variant="outline"
        size="sm"
        onClick={openCommandPalette}
        className="hidden md:inline-flex gap-2 text-muted-foreground"
        aria-label="Ouvrir la palette de commandes"
      >
        <span className="text-xs">Rechercher…</span>
        <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
          <span className="text-xs">⌘</span>K
        </kbd>
      </Button>

      <ThemeToggle />

      {/* User menu desktop only — sur mobile il est dans le drawer */}
      <div className="hidden md:block">
        <UserMenuClient role={role} firstName={firstName} lastName={lastName} compact />
      </div>
    </header>
  );
}
