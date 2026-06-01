/**
 * Tests admin.ts — singleton firebase-admin + branche emulator/prod.
 *
 * Tourne dans le project "firestore" → l'emulator est garanti up
 * (probé en `beforeAll` par tests/firestore/setup.ts). Chaque test
 * repart à blanc côté firebase-admin (`deleteApp` en afterEach) pour
 * que la branche `existing` du buildApp() ne pollue pas les autres.
 */
import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetEnvCacheForTests } from "@/lib/security/env";
import { ConfigError } from "@/lib/utils/errors";

import {
  __APP_NAME_FOR_TESTS,
  __getAppByName,
  __resetFirestoreAdminForTests,
  getAdminApp,
  getAdminDb,
} from "./admin";

async function fullReset() {
  // Vide le singleton local…
  __resetFirestoreAdminForTests();
  // …et détruit l'app côté firebase-admin pour que le prochain
  // buildApp() ne tombe pas sur la branche "existing".
  const existing = __getAppByName();
  if (existing) {
    await deleteApp(existing);
  }
  // Vide aussi le cache env (le test prod va re-stuber les vars Firebase).
  __resetEnvCacheForTests();
}

describe("admin.ts — singleton + branches emulator/prod", () => {
  beforeEach(async () => {
    // Défait les éventuels stubs leakés d'un test précédent AVANT le reset.
    // Sinon : si un test a stubé NODE_ENV="production" et que `unstubEnvs`
    // de Vitest ne s'est pas encore exécuté (il tourne APRÈS afterEach),
    // le helper __resetFirestoreAdminForTests qui exige NODE_ENV==="test"
    // refuse de tourner et le test crash en cascade.
    vi.unstubAllEnvs();
    await fullReset();
  });

  afterEach(async () => {
    // Même raison qu'en beforeEach : un test du describe en cours a pu
    // stubber NODE_ENV. On défait AVANT le fullReset, pas après.
    vi.unstubAllEnvs();
    await fullReset();
  });

  describe("mode emulator (FIRESTORE_EMULATOR_HOST défini)", () => {
    it("renvoie la même instance App à chaque appel (singleton module-level)", () => {
      const a = getAdminApp();
      const b = getAdminApp();
      expect(a).toBe(b);
      expect(a.name).toBe(__APP_NAME_FOR_TESTS);
    });

    it("renvoie la même instance Firestore à chaque appel", () => {
      const a = getAdminDb();
      const b = getAdminDb();
      expect(a).toBe(b);
    });

    it("ping emulator : write + read d'un document via le SDK admin", async () => {
      const db = getAdminDb();
      const ref = db.collection("_health").doc("ping-admin");
      const ts = Timestamp.now();
      await ref.set({ ts, ok: true });
      const snap = await ref.get();
      expect(snap.exists).toBe(true);
      const data = snap.data();
      expect(data?.ok).toBe(true);
      expect(data?.ts).toBeInstanceOf(Timestamp);
    });

    it("fallback projectId='medere-test' quand GCLOUD_PROJECT est unset", () => {
      // setup.ts a set GCLOUD_PROJECT="medere-test" en beforeAll. On le
      // unset pour ce test précis afin de couvrir la branche `?? "medere-test"`
      // du fallback (sinon non atteinte → seuil branches 95% non tenu).
      vi.stubEnv("GCLOUD_PROJECT", undefined);
      const app = getAdminApp();
      expect(app.options.projectId).toBe("medere-test");
    });

    it("utilise GCLOUD_PROJECT s'il est défini explicitement", () => {
      vi.stubEnv("GCLOUD_PROJECT", "custom-project-id");
      const app = getAdminApp();
      expect(app.options.projectId).toBe("custom-project-id");
    });

    it("récupère l'app existante au lieu de la ré-init (branche HMR/existing)", () => {
      // Premier appel → init via initializeApp.
      const a = getAdminApp();
      // On vide UNIQUEMENT le cache local, sans deleteApp côté firebase-admin :
      // l'app reste listée par getApps(). Le prochain buildApp() doit la
      // récupérer via la branche `existing` au lieu de planter sur
      // "app already exists".
      __resetFirestoreAdminForTests();
      const b = getAdminApp();
      expect(b).toBe(a);
    });
  });

  describe("garde-fous", () => {
    it("refuse FIRESTORE_EMULATOR_HOST défini en NODE_ENV=production", () => {
      vi.stubEnv("NODE_ENV", "production");
      expect(() => getAdminApp()).toThrow(/refusée/);
    });

    it("throw ConfigError si pas d'emulator et env Firebase manquantes", () => {
      // Mode prod-like : on coupe l'emulator et on vide les credentials
      // Firebase. getFirebaseEnv() doit échouer via parseOrThrow.
      vi.stubEnv("FIRESTORE_EMULATOR_HOST", "");
      vi.stubEnv("FIREBASE_PROJECT_ID", "");
      vi.stubEnv("FIREBASE_CLIENT_EMAIL", "");
      vi.stubEnv("FIREBASE_PRIVATE_KEY", "");
      __resetEnvCacheForTests();
      expect(() => getAdminApp()).toThrow(ConfigError);
    });

    it("__resetFirestoreAdminForTests throw si NODE_ENV !== 'test'", () => {
      vi.stubEnv("NODE_ENV", "production");
      expect(() => __resetFirestoreAdminForTests()).toThrow(/outside of tests/);
    });
  });

  describe("helpers internes", () => {
    it("__getAppByName retourne l'app courante après init", () => {
      getAdminApp();
      const app = __getAppByName();
      expect(app).toBeDefined();
      expect(app?.name).toBe(__APP_NAME_FOR_TESTS);
    });

    it("__getAppByName retourne undefined pour un nom inconnu", () => {
      getAdminApp();
      const app = __getAppByName("ce-nom-n-existe-pas");
      expect(app).toBeUndefined();
    });
  });
});
