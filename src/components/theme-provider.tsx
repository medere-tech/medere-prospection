"use client";

/**
 * Provider next-themes — wrapper minimal pour le dark mode shadcn.
 *
 * Convention shadcn : `attribute="class"` ajoute `class="dark"` sur
 * `<html>` (le sélecteur `.dark` est défini dans `globals.css`).
 * `disableTransitionOnChange` évite le flash de transition au toggle.
 */
import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

export function ThemeProvider({ children, ...props }: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      // F-11 fix : clé localStorage namespacée — évite collision si Médéré
      // ajoute un jour une autre app sur le même domaine/sous-domaine.
      storageKey="medere-theme"
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
