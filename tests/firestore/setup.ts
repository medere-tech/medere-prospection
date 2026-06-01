/**
 * Setup file pour le project Vitest "firestore".
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Responsabilités :
 *
 *   1. Forcer `FIRESTORE_EMULATOR_HOST` + `GCLOUD_PROJECT` + `NODE_ENV=test`
 *      AVANT que tout module firebase-admin ne soit importé. Sinon le SDK
 *      pourrait s'auto-configurer en mode prod et essayer de joindre les
 *      vrais serveurs Google.
 *
 *   2. Probe TCP de l'emulator au `beforeAll` du run. Si l'emulator n'est
 *      pas joignable → throw avec un message qui explique exactement quoi
 *      lancer pour le démarrer. PAS de démarrage automatique : c'est le
 *      job de `firebase emulators:exec` (script `npm run test:firestore`).
 *
 *   3. Clear data entre chaque test via REST API emulator
 *      (`DELETE /emulator/v1/projects/{id}/databases/(default)/documents`).
 *      Isolation stricte — les tests ne se polluent jamais entre eux.
 *
 *   4. Reset des singletons module-level (admin.ts, env.ts cache).
 *
 * Stratégie "emulator déjà up" : la probe TCP renvoie `true` que l'emulator
 * ait été lancé par `firebase emulators:exec` OU par un terminal séparé
 * (`npm run emulator:firestore`). On ne distingue pas — on consomme le
 * premier qui répond.
 */
import { Socket } from "node:net";

import { afterEach, beforeAll } from "vitest";

const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8085";
const PROJECT_ID = process.env.GCLOUD_PROJECT ?? "medere-test";

/**
 * Pingue l'emulator en ouvrant une connexion TCP brute (pas d'HTTP) — c'est
 * le mode le plus robuste pour détecter "le port répond". On évite `fetch`
 * qui pourrait remonter d'autres erreurs (CORS, redirect, content-type) qui
 * masquent un emulator effectivement up.
 */
function probeEmulator(host: string, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const [hostname, portStr] = host.split(":");
    const port = Number(portStr);
    /* v8 ignore start — défense en profondeur : host malformé n'est jamais
       atteint en pratique (FIRESTORE_EMULATOR_HOST est validé en amont par
       firebase.json + .env.example), mais on garde le filet. */
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
  // Forcer les vars d'env AVANT tout import de firebase-admin par un test.
  // `NODE_ENV` est typé `readonly` par `@types/node` (modélisation de
  // l'invariant Node "process.env est figé après démarrage"). On le casse
  // ici de manière explicite pour le contexte test, via un cast minimal
  // sur `process.env` uniquement (pas sur la valeur).
  const env = process.env as Record<string, string | undefined>;
  env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;
  env.GCLOUD_PROJECT = PROJECT_ID;
  env.NODE_ENV = "test";

  const up = await probeEmulator(EMULATOR_HOST);
  if (!up) {
    throw new Error(
      [
        ``,
        `[firestore-setup] Emulator Firestore non joignable sur ${EMULATOR_HOST}.`,
        ``,
        `→ Solution 1 (recommandée, tout-en-un) :`,
        `    npm run test:firestore`,
        `  Cette commande démarre l'emulator, exécute les tests, l'arrête.`,
        ``,
        `→ Solution 2 (dev interactif, emulator persistant entre runs) :`,
        `  Terminal A :  npm run emulator:firestore`,
        `  Terminal B :  npx vitest --project firestore`,
        ``,
        `Si le démarrage de l'emulator échoue lui-même : voir README §8`,
        `(port 8085, Java 17, FIREBASE_CACHE_DIR pour les home accentués).`,
        ``,
      ].join("\n"),
    );
  }
});

afterEach(async () => {
  // Wipe all docs entre chaque test. On utilise l'endpoint REST natif de
  // l'emulator (pas le SDK admin) pour rester découplé du singleton testé.
  const url = `http://${EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
  const res = await fetch(url, { method: "DELETE" });
  /* v8 ignore start — l'emulator répond toujours 200 sur DELETE si up.
     Branche défensive pour faire surface immédiatement une régression
     emulator (ex: changement d'API) au lieu d'avoir des tests qui se
     polluent silencieusement. */
  if (!res.ok) {
    throw new Error(
      `[firestore-setup] Échec clear emulator (HTTP ${res.status} ${res.statusText}).`,
    );
  }
  /* v8 ignore stop */
});
