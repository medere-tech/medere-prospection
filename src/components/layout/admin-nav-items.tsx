"use client";

/**
 * Items de navigation admin — source unique partagée par la sidebar
 * desktop ET le drawer mobile (évite la dérive).
 *
 * - `enabled: false` = lien grisé "Bientôt disponible" (S10.2+).
 * - `adminOnly: true` = seuls les rôle "admin" voient l'item (filtré
 *   côté caller via la prop `role`).
 *
 * Le composant lui-même est CLIENT (`usePathname` pour l'active state).
 * Les Server Components parents lui passent `role` en prop.
 */
import { Activity, BarChart3, FileText, MessageSquare, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";

import { Badge } from "@/components/ui/badge";
import type { Role } from "@/lib/auth/require-role";
import { cn } from "@/lib/utils";

export interface AdminNavItem {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  enabled: boolean;
  adminOnly?: boolean;
  /** Indication "Bientôt" affichée comme badge. */
  comingSoon?: boolean;
}

export const ADMIN_NAV_ITEMS: readonly AdminNavItem[] = [
  { href: "/admin/contacts", label: "Contacts", icon: Users, enabled: true },
  {
    href: "/admin/conversations",
    label: "Conversations",
    icon: MessageSquare,
    enabled: false,
    comingSoon: true,
  },
  {
    href: "/admin/campaigns",
    label: "Campagnes",
    icon: BarChart3,
    enabled: false,
    comingSoon: true,
  },
  {
    href: "/admin/audits",
    label: "Audits",
    icon: FileText,
    enabled: false,
    adminOnly: true,
    comingSoon: true,
  },
  {
    href: "/admin/monitoring",
    label: "Monitoring",
    icon: Activity,
    enabled: false,
    adminOnly: true,
    comingSoon: true,
  },
] as const;

export function AdminNavItems({
  role,
  onNavigate,
}: {
  role: Role;
  /** Callback appelé au clic d'un item — utilisé par le drawer mobile pour se fermer. */
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  const items = ADMIN_NAV_ITEMS.filter((item) => !item.adminOnly || role === "admin");

  return (
    <nav aria-label="Navigation admin" className="flex flex-col gap-1 p-2">
      {items.map((item) => {
        const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
        const Icon = item.icon;
        // F-01 fix : `text-sidebar-foreground/80` (alpha 0.8) donnait ~1.3:1
        // sur fond sidebar light. `text-muted-foreground` (oklch(0.556))
        // donne ~5.9:1, WCAG AA 1.4.3 conforme.
        const baseClasses = cn(
          "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          isActive && item.enabled
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
          // F-09 fix : neutralise aussi `active:` pour les items disabled
          // (sur mobile/tablette, pas de hover mais un tap peut déclencher
          // `:active` non maîtrisé).
          !item.enabled &&
            "cursor-not-allowed opacity-60 hover:bg-transparent hover:text-muted-foreground active:bg-transparent",
        );

        if (!item.enabled) {
          // F-03 fix : `<span aria-disabled>` n'est pas annoncé par les AT.
          // On utilise `role="link"` + `aria-disabled="true"` + `tabIndex={-1}`
          // pour rester hors tab order tout en informant les AT qu'il s'agit
          // d'un lien futur désactivé.
          return (
            <span
              key={item.href}
              role="link"
              aria-disabled="true"
              tabIndex={-1}
              className={baseClasses}
              title="Bientôt disponible"
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              <span className="flex-1">{item.label}</span>
              {item.comingSoon && (
                <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                  Bientôt
                </Badge>
              )}
            </span>
          );
        }

        return (
          <Link
            key={item.href}
            href={item.href}
            className={baseClasses}
            aria-current={isActive ? "page" : undefined}
            onClick={onNavigate}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            <span className="flex-1">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
