import "./globals.css";

import { frFR } from "@clerk/localizations";
import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { NuqsAdapter } from "nuqs/adapters/next/app";

import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Médéré — Admin",
  description: "Console interne de prospection IA Médéré.",
  // Outil interne — pas d'indexation moteur.
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider localization={frFR}>
      <html
        lang="fr"
        className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
        suppressHydrationWarning
      >
        <body className="min-h-full flex flex-col bg-background text-foreground">
          <ThemeProvider>
            <TooltipProvider>
              {/*
                S10.1.11-NUQS-ADAPTER-001 : NuqsAdapter REQUIS pour tout
                composant client qui utilise `useQueryState` / `useQueryStates`
                (actuellement : src/app/admin/contacts/contacts-page-client.tsx).
                Sans cet adapter, nuqs throw au runtime :
                  "[nuqs] nuqs requires an adapter to work with your framework"
                Toutes les tests UI mockent nuqs → ne couvrent pas l'absence
                d'adapter. Garde-fou : sentinelle filesystem
                src/app/layout-providers.sentinel.test.ts.
              */}
              <NuqsAdapter>
                {children}
                <Toaster richColors closeButton />
              </NuqsAdapter>
            </TooltipProvider>
          </ThemeProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
