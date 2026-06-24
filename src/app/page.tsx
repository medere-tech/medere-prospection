/**
 * Page racine — outil interne, pas de homepage publique.
 *
 *   - utilisateur signed-in    → /admin/contacts
 *   - utilisateur non signed-in → /sign-in
 *
 * Le middleware Clerk laisse passer `/` (route publique explicite),
 * c'est ICI qu'on décide où l'envoyer. `auth()` est async (Next.js 16
 * + Clerk v7).
 */
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

export default async function HomePage() {
  const { userId } = await auth();
  if (userId) redirect("/admin/contacts");
  redirect("/sign-in");
}
