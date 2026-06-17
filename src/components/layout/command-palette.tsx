"use client";

/**
 * Command palette — Cmd+K / Ctrl+K global.
 *
 * Items stub MVP S10.1.1 (extensibles dans les sprints suivants) :
 *   - Contacts (navigation)
 *   - Toggle theme
 *   - Sign out
 *
 * Écoute deux triggers :
 *   1. Hotkey Cmd+K (Mac) ou Ctrl+K (Win/Linux)
 *   2. Custom event `medere:open-command-palette` dispatché par le bouton
 *      "Rechercher…" du header
 *
 * Le SignOutButton de Clerk est ici aussi (cohérence avec le menu user).
 */
import { useClerk } from "@clerk/nextjs";
import { LogOut, Monitor, Moon, Sun, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useState } from "react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { setTheme } = useTheme();
  const { signOut } = useClerk();

  // Hotkey Cmd+K / Ctrl+K + custom event d'ouverture manuel.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    function onOpenEvent() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("medere:open-command-palette", onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("medere:open-command-palette", onOpenEvent);
    };
  }, []);

  const run = useCallback((action: () => void) => {
    setOpen(false);
    // Petit délai pour laisser le dialog se fermer avant de naviguer/changer
    // de thème (sinon flicker visible).
    setTimeout(action, 0);
  }, []);

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Palette de commandes"
      description="Cherchez une action ou une page à ouvrir."
    >
      <CommandInput placeholder="Rechercher une commande…" />
      <CommandList>
        <CommandEmpty>Aucun résultat.</CommandEmpty>

        <CommandGroup heading="Navigation">
          <CommandItem onSelect={() => run(() => router.push("/admin/contacts"))}>
            <Users aria-hidden />
            Contacts
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Apparence">
          <CommandItem onSelect={() => run(() => setTheme("light"))}>
            <Sun aria-hidden />
            Thème clair
          </CommandItem>
          <CommandItem onSelect={() => run(() => setTheme("dark"))}>
            <Moon aria-hidden />
            Thème sombre
          </CommandItem>
          <CommandItem onSelect={() => run(() => setTheme("system"))}>
            <Monitor aria-hidden />
            Thème système
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Compte">
          {/* F-06 fix : cmdk déclenche `onSelect` (Enter/clic), pas
              `onClick` du wrapper. On appelle `useClerk().signOut()`
              directement avec un `redirectUrl` vers /sign-in pour cohérence
              UX. */}
          <CommandItem onSelect={() => run(() => signOut({ redirectUrl: "/sign-in" }))}>
            <LogOut aria-hidden />
            Se déconnecter
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
