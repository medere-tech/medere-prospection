/**
 * Singleton du client Inngest (`inngest@^4.4.0`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pattern identique S7a (`claude/client.ts`) et S6 (`firestore/admin.ts`) :
 * instanciation paresseuse au premier appel, mémoïsation module-level,
 * back-door tests via `__setInngestClientForTests`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Lecture des credentials
 *
 * Le SDK Inngest lit `INNGEST_EVENT_KEY` (pour `.send()`) et
 * `INNGEST_SIGNING_KEY` (pour valider les requêtes entrantes sur l'endpoint
 * `/api/inngest`) AUTOMATIQUEMENT depuis `process.env` si on ne les passe
 * pas explicitement au constructeur.
 *
 * On NE LES PASSE PAS explicitement ici (cohérent avec la philosophie
 * « validation paresseuse par service » S2) :
 *
 *   - En prod Vercel : les deux vars sont set → le SDK les utilise.
 *   - En dev local : si absentes, le SDK warn et tout appel `.send()`
 *     throw avec un message explicite ; on ne bloque PAS le boot.
 *   - En test vitest : la back-door `__setInngestClientForTests` injecte
 *     un fake sans toucher à process.env.
 *
 * La validation Zod stricte (`getInngestEnv()` S2) reste disponible pour
 * un futur health-check / CI gate (`validateAllEnvNow`), mais n'est PAS
 * appelée au boot du client — cohérence avec le reste du codebase.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * `id` du client = identifiant de l'app Inngest
 *
 * `medere-prospection` est ce qui apparaîtra dans le dashboard Inngest
 * cloud. Il doit rester STABLE pour la durée de vie du projet — changer
 * cet ID après déploiement crée une nouvelle app Inngest et casse les
 * historiques d'exécution.
 */
import { Inngest } from "inngest";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ID stable de l'app Inngest côté cloud. NE PAS modifier après le premier
 * déploiement — création d'une nouvelle app + perte d'historique.
 */
const INNGEST_APP_ID = "medere-prospection";

// ─────────────────────────────────────────────────────────────────────────────
// Singleton + back-door tests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Type structurel minimal du client utilisé par le wrapper. Permet aux
 * tests d'injecter un fake `{ send: vi.fn(), createFunction: vi.fn() }`
 * sans recréer une instance `Inngest` complète.
 *
 * En production on retourne le singleton `Inngest` natif (compatible avec
 * `serve()` de `inngest/next` qui type-check sur la classe complète).
 */
export type InngestClient = Inngest;

let cachedClient: InngestClient | null = null;

function buildClient(): InngestClient {
  return new Inngest({ id: INNGEST_APP_ID });
}

/**
 * Retourne le client Inngest singleton. Premier appel instancie via
 * `new Inngest({ id })` ; les suivants retournent l'instance mémoïsée.
 *
 * Le SDK lit `INNGEST_EVENT_KEY` et `INNGEST_SIGNING_KEY` depuis
 * `process.env` à chaque appel `.send()` / requête entrante — leur
 * absence en dev local ne bloque PAS la construction du client.
 */
export function getInngestClient(): InngestClient {
  if (cachedClient === null) {
    cachedClient = buildClient();
  }
  return cachedClient;
}

/**
 * Test-only : injecte un client fake. À utiliser dans `beforeEach()`
 * pour les tests qui veulent contrôler `.send()` / `.createFunction()`.
 * Passer `null` pour forcer la prochaine résolution via `buildClient()`.
 *
 * Garde runtime : refuse en dehors de `NODE_ENV === "test"` pour éviter
 * un usage applicatif accidentel (qui ferait silencieusement no-op les
 * envois d'event en prod).
 */
export function __setInngestClientForTests(client: InngestClient | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setInngestClientForTests called outside of tests");
  }
  cachedClient = client;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exposé pour tests sentinelles
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export const __INNGEST_APP_ID_FOR_TESTS = INNGEST_APP_ID;
