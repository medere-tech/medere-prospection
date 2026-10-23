/**
 * Page de refus propre racine `forbidden.tsx` (PR1.14.2 — fix S10).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi à la RACINE `src/app/` et pas dans `src/app/admin/`
 *
 *   Convention Next.js 15.1+/16 (symétrique à `not-found.tsx`) :
 *     « Next.js looks for the forbidden file in the same segment or the
 *       nearest parent segment above where forbidden() is called. »
 *
 *   `forbidden()` est appelé DEPUIS `src/app/admin/layout.tsx`. Ce layout
 *   DÉFINIT le segment `admin`. Next ne peut pas remplacer son propre
 *   rendu par un `forbidden.tsx` co-localisé — le layout l'enveloppe. Il
 *   remonte donc d'un cran et cherche `src/app/forbidden.tsx` (racine).
 *
 *   Preuve capturée (PR1.14.2, harnais e2e vs preview 098c74f, S10 ×3) :
 *   quand `forbidden.tsx` était à `src/app/admin/forbidden.tsx`, Next
 *   rendait la page 403 par défaut :
 *     <h1>403</h1>
 *     <h2>This page could not be accessed.</h2>
 *   (snapshot `test-results/forbidden-S10-…/error-context.md`).
 *
 *   Référence : https://nextjs.org/docs/app/api-reference/functions/forbidden
 *   et https://nextjs.org/docs/app/api-reference/file-conventions/forbidden
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Déclencheurs
 *
 *   - `src/app/admin/layout.tsx` catch `ForbiddenError` du `requireRole`
 *     et appelle `forbidden()`.
 *   - `src/app/admin/conversations/[id]/page.tsx` fait la même chose
 *     localement (parallel execution avec le layout : si le layout call
 *     forbidden() mais que la page throw aussi avant d'être interrompue,
 *     Next log l'erreur de la page comme une "vraie" erreur applicative).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Texte exact (contrat Déthié) :
 *   « Votre rôle n'est pas encore configuré. Contactez l'administrateur. »
 *
 * Bouton déconnexion (pas « Réessayer ») : si le user ne peut pas
 * accéder à l'admin, la seule action utile est de se déconnecter pour
 * utiliser un autre compte (ou prévenir l'administrateur).
 */
import { SignOutButton } from "@clerk/nextjs";
import { ShieldOff } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function Forbidden() {
  return (
    <div
      role="alert"
      className="mx-auto flex max-w-md flex-col items-center gap-5 py-16 text-center"
    >
      <ShieldOff className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">Accès refusé</h1>
        <p className="text-sm text-muted-foreground">
          Votre rôle n&apos;est pas encore configuré. Contactez l&apos;administrateur.
        </p>
      </div>
      <SignOutButton>
        <Button variant="outline">Se déconnecter</Button>
      </SignOutButton>
    </div>
  );
}
