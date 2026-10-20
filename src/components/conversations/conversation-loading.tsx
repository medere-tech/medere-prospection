/**
 * État de chargement (squelette) de la vue conversation
 * (VUE-CONVERSATION PR1).
 *
 * Affiché pendant le fetch initial server-side ne devrait quasiment pas
 * être vu — mais aussi utilisé par le polling côté client via React Query
 * `isLoading` sur le fallback transitoire.
 */
import { Skeleton } from "@/components/ui/skeleton";

export function ConversationLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Chargement de la conversation"
      className="flex flex-col gap-6"
    >
      {/* En-tête contact */}
      <div className="flex flex-col gap-3 border-b pb-4 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-64" />
          <div className="flex gap-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-5 w-20" />
          </div>
        </div>
        <Skeleton className="h-9 w-40" />
      </div>

      {/* Grid principal : fil (2 cols) + panneau (1 col) */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        {/* Fil */}
        <div className="flex flex-col gap-4">
          <Skeleton className="h-4 w-32" />
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className={`flex ${i % 2 === 0 ? "justify-start" : "justify-end"} gap-2`}>
              {i % 2 === 0 ? <Skeleton className="h-7 w-7 rounded-full" /> : null}
              <Skeleton className="h-16 w-[60%] rounded-lg" />
              {i % 2 !== 0 ? <Skeleton className="h-7 w-7 rounded-full" /> : null}
            </div>
          ))}
        </div>

        {/* Panneau */}
        <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-5/6" />
          <Skeleton className="h-5 w-4/6" />
          <Skeleton className="my-2 h-px w-full" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-3/4" />
        </div>
      </div>
    </div>
  );
}
