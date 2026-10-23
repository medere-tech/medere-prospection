/**
 * Page de refus propre (`forbidden.tsx`) pour le segment `/admin/*`
 * (PR1.14.2 — fix FAIT 1 point 2).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi un fichier dédié
 *
 *   Un throw `ForbiddenError` depuis `requireRole` (role absent du JWT,
 *   role invalide, ou compte test en prod) atterrissait sur `error.tsx`
 *   avec un message générique « Impossible d'afficher cette page » +
 *   bouton « Réessayer ». Inadapté : le refus de rôle n'est PAS une
 *   erreur transitoire — réessayer ne changera rien.
 *
 *   Avec Next.js 15.1+/16, `forbidden()` depuis `next/navigation` déclenche
 *   le rendu de ce composant AVEC un vrai statut HTTP 403. `error.tsx`
 *   reste pour les vraies erreurs inattendues (I/O Firestore, bug server).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Déclencheur unique : `src/app/admin/layout.tsx` catch `ForbiddenError`
 * depuis `requireRole` et appelle `forbidden()`.
 *
 * Bouton déconnexion (pas « Réessayer ») : si le user ne peut pas
 * accéder à l'admin, la seule action utile est de se déconnecter pour
 * utiliser un autre compte (ou prévenir l'administrateur).
 *
 * Texte exact (contrat Déthié) :
 *   « Votre rôle n'est pas encore configuré. Contactez l'administrateur. »
 */
import { SignOutButton } from "@clerk/nextjs";
import { ShieldOff } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function AdminForbidden() {
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
