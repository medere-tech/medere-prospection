"use client";

/**
 * Error boundary pour tout le segment `/admin/*` (PR1.14.2 — fix FAIT 1).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi
 *
 *   Un throw depuis un Server Component (`requireRole` qui throw
 *   ForbiddenError / UnauthorizedError, I/O Firestore qui timeout, …)
 *   remonte sans gestion → Next.js renvoie une page 500 brute. L'exigence
 *   Médéré (CLAUDE.md "Sécurité §5") : jamais d'erreur serveur visible
 *   côté client. On intercepte au niveau segment admin pour afficher :
 *     - un message FR court,
 *     - un bouton « Réessayer » (reset de l'erreur côté Next),
 *     - un bouton « Retour au tableau de bord ».
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi pas de détection fine (requireRole vs IO vs autre)
 *
 *   `error.tsx` reçoit l'erreur sérialisée (`message` + `digest`),
 *   PAS la classe (prototype perdu entre serveur et client Next). Un
 *   `instanceof ForbiddenError` est impossible ici. Parser `message`
 *   serait fragile et créerait un couplage avec les textes d'erreur.
 *   On affiche donc un message générique neutre + le `digest` pour que
 *   Déthié puisse corréler avec les logs Pino / Vercel.
 *
 *   NB : la vraie correction du cas FAIT 1 (admin sans slackUserId) est
 *   dans `src/lib/auth/require-role.ts` (null-safety Zod). Cet
 *   error.tsx est le filet de sécurité pour toute erreur future.
 */
import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";

interface Props {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function AdminError({ error, reset }: Props) {
  useEffect(() => {
    // On ne logge PAS le message complet côté client (il pourrait contenir
    // des traces internes). Juste le digest pour permettre à l'opérateur
    // de corréler avec les logs serveur.
    if (typeof window !== "undefined" && error.digest) {
      // console.warn est OK (pas de PII, pas de production log — c'est
      // du client-side debug pur). Pino ne tourne que côté serveur.
      console.warn(`[admin/error] digest=${error.digest}`);
    }
  }, [error]);

  return (
    <div
      role="alert"
      className="mx-auto flex max-w-md flex-col items-center gap-5 py-16 text-center"
    >
      <AlertTriangle className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">Impossible d&apos;afficher cette page</h1>
        <p className="text-sm text-muted-foreground">
          Une erreur est survenue côté serveur. Essayez de recharger ; si cela persiste, prévenez
          l&apos;administrateur.
        </p>
        {error.digest ? (
          <p className="text-xs text-muted-foreground/70 font-mono">Réf : {error.digest}</p>
        ) : null}
      </div>
      <div className="flex gap-2">
        <Button onClick={() => reset()} variant="outline">
          Réessayer
        </Button>
        <Link href="/admin/contacts">
          <Button variant="ghost">Retour au tableau de bord</Button>
        </Link>
      </div>
    </div>
  );
}
