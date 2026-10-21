/**
 * Playwright global setup — initialise `@clerk/testing` une fois par run.
 * Lit `CLERK_SECRET_KEY` et `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` depuis
 * `.env.local` (loader dotenv).
 */
import { clerkSetup } from "@clerk/testing/playwright";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: ".env.local" });

export default async function globalSetup() {
  // H1 security-reviewer PR1.14 — miroir du refus `sk_live_` du script
  // setup : si on tombe en prod par accident (CLERK_SECRET_KEY=sk_live_...),
  // on ne LANCE PAS le harnais, même en lecture seule. Les scénarios
  // signInAs* passent du coup par le mode test Clerk → c'est l'instance
  // Clerk de test qui doit héberger les users e2e, pas la prod.
  const secret = process.env.CLERK_SECRET_KEY ?? "";
  if (secret.startsWith("sk_live_") && process.env.ALLOW_E2E_ON_LIVE_CLERK !== "1") {
    throw new Error(
      "Refus : Playwright configuré avec un CLERK_SECRET_KEY=sk_live_... — " +
        "les scénarios e2e ne doivent pas se connecter à Clerk prod. " +
        "Positionner ALLOW_E2E_ON_LIVE_CLERK=1 pour forcer (sous supervision).",
    );
  }
  await clerkSetup();
}
