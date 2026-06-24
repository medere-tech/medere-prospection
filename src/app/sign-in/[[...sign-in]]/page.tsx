/**
 * Catch-all sign-in Clerk.
 *
 * - Pas de sign-up self-serve : les comptes sont créés manuellement par
 *   Déthié côté Clerk dashboard. Si un user tape `/sign-up`, Clerk
 *   redirige vers cette page (paramétré côté dashboard).
 *
 * - Locale FR héritée de `<ClerkProvider localization={frFR}>` dans le
 *   root layout.
 *
 * - `<SignIn />` est un composant Clerk client — la page Next.js
 *   reste server component (Clerk gère son boundary client en interne).
 */
import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
      <SignIn
        appearance={{
          elements: {
            // Cohérence visuelle avec shadcn — radius + fond.
            card: "shadow-lg",
            rootBox: "w-full max-w-md",
          },
        }}
      />
    </main>
  );
}
