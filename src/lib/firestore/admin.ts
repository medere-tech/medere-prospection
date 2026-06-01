/**
 * Singleton firebase-admin pour le projet Médéré.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Deux modes de fonctionnement détectés au runtime :
 *
 *   1. **Emulator** : si `FIRESTORE_EMULATOR_HOST` est défini (dev/CI/tests),
 *      le SDK admin se connecte automatiquement à l'emulator local. Aucune
 *      credential réelle requise — on passe juste un `projectId` factice
 *      (`medere-test` par défaut). Garde-fou : si la variable est définie
 *      mais que `NODE_ENV === "production"`, on REFUSE de démarrer. C'est
 *      une protection contre une mauvaise configuration prod qui partirait
 *      sur un emulator local.
 *
 *   2. **Production** : credentials Firebase Admin via `getFirebaseEnv()`
 *      (validation paresseuse S2). Le getter parse `process.env` au PREMIER
 *      appel, memoize, et throw `ConfigError` (message sanitisé, pas de
 *      fuite de valeur) si les vars manquent.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Singleton — protection multi-couches contre la double-init :
 *
 *   - **Niveau module** : `cachedApp` et `cachedDb` mémoïsent l'instance
 *     entre appels (même process, même module).
 *
 *   - **Niveau firebase-admin** : on nomme explicitement l'app
 *     (`APP_NAME`) et on consulte `getApps()` avant `initializeApp()`.
 *     Couvre le cas HMR Next.js où le module peut être ré-évalué : si
 *     une app du même nom existe déjà, on la réutilise au lieu de
 *     planter avec "The default Firebase app already exists".
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi pas `getFirestore()` direct sans wrapper ?
 *
 *   - Centralise la décision emulator/prod en un point unique → un seul
 *     test à écrire pour la branche prod, pas N tests redondants.
 *   - Le wrapper laisse de la place en S6.2+ pour des décorateurs cross-
 *     cutting (retry, telemetry, scrubber PII en écriture) sans toucher
 *     aux 8 modules consommateurs.
 */
import { type App, cert, getApps, initializeApp } from "firebase-admin/app";
import { type Firestore, getFirestore } from "firebase-admin/firestore";

import { getFirebaseEnv } from "@/lib/security/env";

// Nom explicite pour éviter le conflit avec la "default" app que d'autres
// packages (Firebase auth client, Functions emulator) initialisent parfois.
const APP_NAME = "medere-default";

let cachedApp: App | null = null;
let cachedDb: Firestore | null = null;

/**
 * `true` si on cible l'emulator Firestore. On considère que la simple
 * présence de `FIRESTORE_EMULATOR_HOST` (non vide) suffit — c'est le
 * mécanisme natif du SDK firebase-admin pour basculer en mode emulator.
 */
function isEmulatorMode(): boolean {
  const v = process.env.FIRESTORE_EMULATOR_HOST;
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Construit (ou récupère) l'instance App. Trois branches :
 *
 *   1. App nommée déjà initialisée → `getApp(APP_NAME)` (cas HMR).
 *   2. Mode emulator → `initializeApp` avec projectId factice.
 *   3. Mode prod → `initializeApp` avec credentials cert() depuis env.
 *
 * Branche 3 peut throw `ConfigError` si les vars Firebase manquent
 * (propagation depuis `getFirebaseEnv()`).
 */
function buildApp(): App {
  const existing = getApps().find((a) => a.name === APP_NAME);
  if (existing) {
    return existing;
  }

  if (isEmulatorMode()) {
    // Garde-fou : un emulator activé en prod = config cassée.
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "FIRESTORE_EMULATOR_HOST défini en NODE_ENV=production — " +
          "config refusée pour éviter un démarrage prod qui parlerait à un emulator local.",
      );
    }
    return initializeApp(
      {
        projectId: process.env.GCLOUD_PROJECT ?? "medere-test",
      },
      APP_NAME,
    );
  }

  const env = getFirebaseEnv();
  return initializeApp(
    {
      credential: cert({
        projectId: env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        privateKey: env.FIREBASE_PRIVATE_KEY,
      }),
    },
    APP_NAME,
  );
}

/**
 * Renvoie l'app firebase-admin (singleton). Throw `ConfigError` si on
 * est en mode prod et que les vars Firebase manquent.
 */
export function getAdminApp(): App {
  if (cachedApp === null) {
    cachedApp = buildApp();
  }
  return cachedApp;
}

/**
 * Renvoie l'instance Firestore (singleton). Premier appel dérive de
 * `getAdminApp()` — donc même contrat d'erreur en mode prod.
 */
export function getAdminDb(): Firestore {
  if (cachedDb === null) {
    cachedDb = getFirestore(getAdminApp());
  }
  return cachedDb;
}

/**
 * Vide les singletons module-level. À utiliser UNIQUEMENT dans les tests
 * (idem pattern S2 `__resetEnvCacheForTests`). Garde runtime : refuse de
 * tourner si `NODE_ENV !== "test"`, sinon un code applicatif qui appellerait
 * cette fonction par erreur viderait l'app en pleine prod.
 *
 * Note : ne libère PAS l'app côté firebase-admin (pas de `deleteApp()`).
 * `getApps()` continuera de la lister. Le prochain `getAdminApp()` la
 * récupérera via la branche `existing` au lieu de la réinitialiser —
 * comportement voulu, pas un bug.
 */
export function __resetFirestoreAdminForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__resetFirestoreAdminForTests called outside of tests");
  }
  cachedApp = null;
  cachedDb = null;
}

/**
 * Helper pour les tests qui ont besoin de récupérer l'app par nom
 * (vérifier qu'elle est bien créée, l'inspecter, etc.) sans repasser
 * par le singleton. Pas exposé en runtime applicatif.
 *
 * @internal
 */
export function __getAppByName(name: string = APP_NAME): App | undefined {
  return getApps().find((a) => a.name === name);
}

export { APP_NAME as __APP_NAME_FOR_TESTS };
