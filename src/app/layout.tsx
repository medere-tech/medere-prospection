import "./globals.css";

import { frFR } from "@clerk/localizations";
import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { NuqsAdapter } from "nuqs/adapters/next/app";

import { QueryProvider } from "@/components/providers/query-provider";
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

                VUE-CONVERSATION PR1.13 : QueryProvider REQUIS pour tout
                composant client qui utilise `useQuery` / `useMutation` /
                `useQueryClient` de @tanstack/react-query (actuellement :
                src/app/admin/conversations/[id]/conversation-detail-client.tsx).
                Sans ce provider, react-query throw au runtime :
                  "No QueryClient set, use QueryClientProvider to set one"
                → /admin/conversations/[id] cassée (bug prod
                dpl_5wTNCuBzQdjPM9t3Cg2oQqZeBZLs). Même sentinelle filesystem.
              */}
              <NuqsAdapter>
                <QueryProvider>
                  {children}
                  <Toaster richColors closeButton />
                </QueryProvider>
              </NuqsAdapter>
            </TooltipProvider>
          </ThemeProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
