"use client";

/**
 * Sélecteur de thème — Light / Dark / System.
 *
 * shadcn dropdown-menu + lucide icons. SSR-safe : `useSyncExternalStore`
 * distingue server/client snapshots SANS effect (pattern React 19), ce
 * qui évite le hydration mismatch sans déclencher la règle
 * `react-hooks/set-state-in-effect`.
 *
 *   - serverSnapshot → false → on rend `<Monitor />` (icône neutre)
 *   - clientSnapshot → true  → on rend l'icône qui matche `theme`
 *
 * Pas de subscribe car la valeur ne change jamais après le mount initial.
 */
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const NOOP_SUBSCRIBE = () => () => {};
const CLIENT_SNAPSHOT = () => true;
const SERVER_SNAPSHOT = () => false;

function useIsClient(): boolean {
  return useSyncExternalStore(NOOP_SUBSCRIBE, CLIENT_SNAPSHOT, SERVER_SNAPSHOT);
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const isClient = useIsClient();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon" aria-label="Changer de thème">
            {!isClient ? (
              <Monitor className="size-4" aria-hidden />
            ) : theme === "dark" ? (
              <Moon className="size-4" aria-hidden />
            ) : theme === "light" ? (
              <Sun className="size-4" aria-hidden />
            ) : (
              <Monitor className="size-4" aria-hidden />
            )}
            {/* F-07 fix : pas de <span sr-only> en plus de aria-label (sinon
                NVDA/VoiceOver annoncent "Changer de thème Changer de thème"). */}
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme("light")}>
          <Sun className="size-4" aria-hidden />
          Clair
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("dark")}>
          <Moon className="size-4" aria-hidden />
          Sombre
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("system")}>
          <Monitor className="size-4" aria-hidden />
          Système
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
