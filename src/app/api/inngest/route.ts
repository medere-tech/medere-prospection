/**
 * Endpoint HTTP Inngest — `POST/GET/PUT /api/inngest`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rôle
 *
 * Point d'entrée que Inngest cloud (ou le dev server local
 * `npx inngest-cli dev`) appelle pour :
 *
 *   - `PUT /api/inngest`  → synchronisation : Inngest découvre les
 *                            functions exposées (`functions: [...]`) et
 *                            leurs triggers.
 *   - `POST /api/inngest` → exécution : Inngest invoque une function
 *                            spécifique avec le payload de l'event,
 *                            l'état des steps déjà exécutés, etc.
 *   - `GET /api/inngest`  → introspection / health (UI Inngest cloud).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Sécurité — signature des requêtes
 *
 * Le SDK `serve()` vérifie AUTOMATIQUEMENT la signature HMAC des requêtes
 * Inngest cloud entrantes via `INNGEST_SIGNING_KEY` (lu de `process.env`
 * par le client). Sans cette clé, ou avec une signature invalide, la
 * requête est rejetée 401 par le SDK avant que notre handler ne soit
 * appelé.
 *
 * Conformité CLAUDE.md règle sécurité #3 (« Tous les webhooks vérifient
 * leur signature HMAC en première ligne ») : la vérification est faite par
 * `inngest/next::serve()` lui-même, donc respectée par défaut.
 *
 * En dev local (sans clé set), le SDK détecte le mode dev et skip la
 * signature — comportement attendu pour `npx inngest-cli dev`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Ajouter une fonction
 *
 * 1. Créer le fichier dans `src/lib/inngest/functions/<name>.ts`.
 * 2. L'ajouter à `src/lib/inngest/functions/index.ts` (re-export).
 * 3. L'ajouter au tableau `functions: []` ci-dessous.
 * 4. Push → Vercel deploy → Inngest cloud auto-sync (ou `PUT` manuel).
 */
import { serve } from "inngest/next";

import { getInngestClient } from "@/lib/inngest/client";
import { processReply, sendFirstSms, sendReply } from "@/lib/inngest/functions";

export const { GET, POST, PUT } = serve({
  client: getInngestClient(),
  functions: [sendFirstSms, processReply, sendReply],
});
