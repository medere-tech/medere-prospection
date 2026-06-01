/**
 * Setup file pour le project Vitest "firestore-rules" (S6.7).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Responsabilités :
 *
 *   1. Forcer `FIRESTORE_EMULATOR_HOST` + `GCLOUD_PROJECT` + `NODE_ENV=test`
 *      AVANT que `@firebase/rules-unit-testing` ne s'auto-configure. Le SDK
 *      client Firebase utilise ces vars pour pointer vers l'emulator.
 *
 *   2. Probe TCP de l'emulator au `beforeAll` du run. Si l'emulator n'est
 *      pas joignable → throw avec un message d'instruction explicite.
 *      PAS de démarrage automatique : c'est le job de `firebase emulators:exec`
 *      (script `npm run test:firestore-rules`).
 *
 *   3. PAS de `afterEach` global de clear ici — chaque test rules gère
 *      via `testEnv.clearFirestore()` (scoped au projectId
 *      `medere-rules-test`). Pattern propre du SDK
 *      `@firebase/rules-unit-testing`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi un `PROJECT_ID` distinct (`medere-rules-test` vs `medere-test`) :
 *
 *   - Le MÊME emulator (port 8085) sert les 2 suites de tests.
 *   - Firestore emulator namespace les écritures par `projectId` — les
 *     données rules-test ne polluent JAMAIS les données des tests S6.1-S6.6.
 *   - Permet de lancer les 2 suites en séquence sans clear inter-runs.
 *
 * Stratégie "emulator déjà up" : la probe TCP renvoie `true` que l'emulator
 * ait été lancé par `firebase emulators:exec` OU par un terminal séparé
 * (`npm run emulator:firestore`). On ne distingue pas — on consomme le
 * premier qui répond.
 */
import { Socket } from "node:net";

import { beforeAll } from "vitest";

const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8085";
const PROJECT_ID = process.env.GCLOUD_PROJECT ?? "medere-rules-test";

/**
 * Pingue l'emulator en ouvrant une connexion TCP brute. Identique au
 * helper de `tests/firestore/setup.ts` — pattern aligné, duplication
 * tolérée (~20 lignes) pour ne pas créer un module partagé `tests/_shared/`
 * pour si peu.
 */
function probeEmulator(host: string, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const [hostname, portStr] = host.split(":");
    const port = Number(portStr);
    /* v8 ignore start — défense en profondeur : host malformé n'est jamais
       atteint en pratique. */
    if (!hostname || !Number.isFinite(port)) {
      resolve(false);
      return;
    }
    /* v8 ignore stop */
    const sock = new Socket();
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.once("timeout", () => done(false));
    sock.connect(port, hostname);
  });
}

beforeAll(async () => {
  const env = process.env as Record<string, string | undefined>;
  env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;
  env.GCLOUD_PROJECT = PROJECT_ID;
  env.NODE_ENV = "test";

  const up = await probeEmulator(EMULATOR_HOST);
  if (!up) {
    throw new Error(
      [
        ``,
        `[firestore-rules-setup] Emulator Firestore non joignable sur ${EMULATOR_HOST}.`,
        ``,
        `→ Solution 1 (recommandée, tout-en-un) :`,
        `    npm run test:firestore-rules`,
        `  Cette commande démarre l'emulator, exécute les tests rules, l'arrête.`,
        ``,
        `→ Solution 2 (dev interactif, emulator persistant entre runs) :`,
        `  Terminal A :  npm run emulator:firestore`,
        `  Terminal B :  npx vitest --config vitest.config.firestore-rules.ts`,
        ``,
        `Si le démarrage de l'emulator échoue lui-même : voir README §8`,
        `(port 8085, Java 17, FIREBASE_CACHE_DIR pour les home accentués).`,
        ``,
      ].join("\n"),
    );
  }
});
