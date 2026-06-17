"use client";

/**
 * Menu utilisateur Clerk — avatar + nom + rôle + sign out.
 *
 * Deux variantes :
 *   - default (compact=false) : carte verticale dans la sidebar/drawer
 *     (nom + email + bouton sign out visibles).
 *   - compact (compact=true)  : trigger avatar seul dans le header,
 *     dropdown au clic.
 */
import { SignOutButton } from "@clerk/nextjs";
import { LogOut } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Role } from "@/lib/auth/require-role";

function initials(firstName?: string, lastName?: string): string {
  const f = firstName?.trim()?.[0]?.toUpperCase() ?? "";
  const l = lastName?.trim()?.[0]?.toUpperCase() ?? "";
  return `${f}${l}` || "?";
}

function fullName(firstName?: string, lastName?: string): string {
  const f = firstName?.trim() ?? "";
  const l = lastName?.trim() ?? "";
  return [f, l].filter(Boolean).join(" ") || "Utilisateur";
}

function roleLabel(role: Role): string {
  return role === "admin" ? "Admin" : "Commercial";
}

export function UserMenuClient({
  role,
  firstName,
  lastName,
  compact = false,
}: {
  role: Role;
  firstName?: string;
  lastName?: string;
  compact?: boolean;
}) {
  const name = fullName(firstName, lastName);
  const inits = initials(firstName, lastName);

  if (compact) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full"
              aria-label={`Menu utilisateur — ${name}`}
            >
              <Avatar>
                <AvatarFallback>{inits}</AvatarFallback>
              </Avatar>
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">{name}</span>
              <Badge variant="outline" className="w-fit text-[10px] uppercase tracking-wide">
                {roleLabel(role)}
              </Badge>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <SignOutButton>
            <DropdownMenuItem className="cursor-pointer">
              <LogOut className="size-4" aria-hidden />
              Se déconnecter
            </DropdownMenuItem>
          </SignOutButton>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  // Variante carte (sidebar/drawer)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Avatar>
          <AvatarFallback>{inits}</AvatarFallback>
        </Avatar>
        <div className="flex flex-1 flex-col min-w-0">
          <span className="truncate text-sm font-medium text-sidebar-foreground">{name}</span>
          <Badge variant="outline" className="w-fit text-[10px] uppercase tracking-wide">
            {roleLabel(role)}
          </Badge>
        </div>
      </div>
      <SignOutButton>
        <Button variant="outline" size="sm" className="w-full gap-2">
          <LogOut className="size-4" aria-hidden />
          Se déconnecter
        </Button>
      </SignOutButton>
    </div>
  );
}
