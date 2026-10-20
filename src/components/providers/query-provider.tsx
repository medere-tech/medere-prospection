"use client";

/**
 * Provider React Query pour l'ensemble de l'application (fix bug prod
 * dpl_5wTNCuBzQdjPM9t3Cg2oQqZeBZLs).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi ce fichier existe
 *
 *   Avant VUE-CONVERSATION PR1.13, l'app n'avait AUCUN `QueryClientProvider`.
 *   La page `/admin/conversations/[id]` utilisait `useQuery` dans
 *   `conversation-detail-client.tsx` → plantait côté serveur dès le
 *   premier GET avec "No QueryClient set, use QueryClientProvider to set
 *   one". `/admin/contacts` fonctionnait quand même car il n'utilise
 *   PAS react-query (uniquement nuqs/useQueryState pour l'URL state).
 *
 *   Les tests Vitest ne détectaient pas l'absence du provider car ils
 *   mockent `useQuery` individuellement OU wrappent eux-mêmes dans un
 *   `QueryClientProvider` local — jamais le root layout réel.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Discipline : un QueryClient par session navigateur, JAMAIS partagé
 * entre requêtes serveur
 *
 *   - `useState(() => new QueryClient(...))` instancie le client UNE
 *     fois par mount client (hydration côté browser), jamais au niveau
 *     module. En SSR Next.js, chaque requête serveur produit son propre
 *     render → aucun client partagé entre utilisateurs.
 *
 *   - Si on faisait `const queryClient = new QueryClient()` au top-level
 *     du module, le module serait caché Node.js par VM → tous les SSR
 *     Vercel partageraient le même QueryClient → cache utilisateur A
 *     servi à utilisateur B. Pattern anti-sécurité. Fail-closed par
 *     construction : useState initializer est appelé par instance React.
 *
 *   - `staleTime` défaut à 0 : chaque query est "stale" immédiatement.
 *     Les composants qui veulent du cache long doivent spécifier leur
 *     `staleTime` explicitement (comme fait
 *     `conversation-detail-client.tsx` avec `VERSION_STALE_TIME_MS`).
 *
 *   - Pas de persistance localStorage/sessionStorage (pas de dep
 *     `@tanstack/query-sync-storage-persister`). Simplicité MVP.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Garantie sentinelle
 *
 *   `src/app/layout-providers.sentinel.test.ts` verrouille la présence
 *   de `<QueryProvider>` dans root layout — toute suppression accidentelle
 *   casse le build. Pattern miroir de la sentinelle NuqsAdapter
 *   (S10.1.11-NUQS-ADAPTER-001).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

interface Props {
  children: React.ReactNode;
}

export function QueryProvider({ children }: Props) {
  // ⚠️ `useState` initializer — un client PAR mount, PAS un client
  // module-level qui serait partagé entre requêtes serveur (fuite
  // utilisateur A → utilisateur B).
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Chaque query est stale par défaut. Les callers qui veulent
            // du cache long passent leur propre `staleTime` (pattern
            // conversation-detail-client.tsx).
            staleTime: 0,
            // Pas de refetch auto sur mount — React Query refetch quand
            // la query est stale ET montée. Avec staleTime=0, c'est
            // équivalent à "refetch immédiat au mount".
            refetchOnMount: true,
            // Pas de retry infini — 2 est raisonnable pour les I/O
            // réseau transients (429, 500 ponctuel). Les callers peuvent
            // override.
            retry: 2,
          },
        },
      }),
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
