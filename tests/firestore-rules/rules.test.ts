/**
 * Tests `firestore.rules` (S6.7) via `@firebase/rules-unit-testing`.
 *
 * Couvre l'option A radicale "deny all client" en MVP : chaque
 * `allow X: if false` est exercé par au moins 1 test qui `assertFails`,
 * pour les 4 actors (anonyme, signed sans role, commercial Custom Claim,
 * admin Custom Claim) × 2 ops (read + write) sur les 5 collections
 * scope-définies (contacts, conversations, conversations/.../messages,
 * audit_log) + 1 collection catchall arbitraire.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INVARIANT CRITIQUE — CLOSURE INFO-1 (S6.2 security-reviewer)
 *
 * Les 8 tests sur `audit_log/` (4 actors × 2 ops) prouvent runtime que :
 *
 *   - MÊME un client authentifié Custom Claim `role: "admin"` (configuré
 *     comme le futur dashboard S9+ via Clerk) ne peut PAS lire ni écrire
 *     dans `audit_log/`.
 *   - L'unique chemin d'accès reste l'Admin SDK serveur (bypass rules).
 *   - La promesse forensique "audit_log inaccessible client" est verrouillée
 *     par Firestore, pas juste par convention applicative.
 *
 * Si un futur dev relaxe `allow read: if isAdmin()` en S9+ (sans passer
 * par une API serveur dédiée), le test sentinel "admin Custom Claim : read
 * refusé" CASSE — alarme rouge.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * PATTERN @firebase/rules-unit-testing v4
 *
 *   - `initializeTestEnvironment` charge `firestore.rules` depuis le disque
 *     et le pousse vers l'emulator pour le `projectId` test.
 *   - `testEnv.authenticatedContext(uid, customClaims)` retourne un
 *     contexte avec token Firebase Auth synthétique (signé localement,
 *     accepté par l'emulator). Les `customClaims` sont injectés dans
 *     `request.auth.token` côté CEL.
 *   - `testEnv.unauthenticatedContext()` simule un client sans token —
 *     `request.auth == null` côté CEL.
 *   - `assertFails(promise)` : test que la promise REJECT (rule a refusé).
 *     `assertSucceeds(promise)` : test que la promise RESOLVE.
 *
 * Pour les tests de read, on n'a PAS besoin de seed préalable : Firestore
 * évalue la rule AVANT de vérifier l'existence du doc. Un `get()` sur un
 * doc inexistant retourne `permission-denied` si la rule deny, pas un
 * `null` silencieux.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertFails,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const PROJECT_ID = "medere-rules-test";
const RULES_PATH = resolve(process.cwd(), "firestore.rules");

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: "127.0.0.1",
      port: 8085,
      rules: readFileSync(RULES_PATH, "utf8"),
    },
  });
});

afterEach(async () => {
  // Chaque test repart d'une base propre. clearFirestore scope au
  // projectId du testEnv → ne touche pas aux données S6.1-S6.6
  // (projectId distinct `medere-test`).
  await testEnv.clearFirestore();
});

afterAll(async () => {
  await testEnv.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — 4 actors typés
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Renvoie les 4 contextes test pour les 4 niveaux d'auth.
 *
 *   - `anon`        : aucun token (request.auth == null)
 *   - `signed`      : token sans claim role (request.auth != null, role absent)
 *   - `commercial`  : token avec custom claim `role: "commercial"`
 *   - `admin`       : token avec custom claim `role: "admin"` (futur S9+)
 *
 * Le sentinel critique INFO-1 utilise `admin` pour prouver que MÊME ce
 * niveau d'auth ne bypass PAS les rules `allow X: if false`.
 */
function actors() {
  return {
    anon: testEnv.unauthenticatedContext(),
    signed: testEnv.authenticatedContext("user-signed"),
    commercial: testEnv.authenticatedContext("user-commercial", { role: "commercial" }),
    admin: testEnv.authenticatedContext("user-admin", { role: "admin" }),
  };
}

// Payload minimal pour les writes (le shape exact ne compte pas — la rule
// `if false` rejette avant validation des champs).
const STUB_PAYLOAD = { _stub: true };

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe("firestore.rules — MVP option A (deny all client)", () => {
  // ───────────────────────────────────────────────────────────────────────
  // Sentinel meta — testEnv initialisé
  // ───────────────────────────────────────────────────────────────────────

  describe("sentinel meta", () => {
    it("testEnv initialisé avec projectId attendu", () => {
      expect(testEnv).toBeDefined();
      expect(testEnv.projectId).toBe(PROJECT_ID);
    });

    it("rules chargées depuis firestore.rules (CEL syntaxe valide)", () => {
      // Si la syntaxe CEL était cassée, initializeTestEnvironment aurait
      // throw au beforeAll. On vérifie juste que les 4 actors construisent
      // sans crash — preuve indirecte que l'emulator a chargé les rules.
      const { anon, signed, commercial, admin } = actors();
      expect(anon).toBeDefined();
      expect(signed).toBeDefined();
      expect(commercial).toBeDefined();
      expect(admin).toBeDefined();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // contacts/{contactId} — 4 actors × 2 ops = 8 tests
  // ───────────────────────────────────────────────────────────────────────

  describe("contacts/{contactId}", () => {
    it("anonyme : read refusé", async () => {
      const db = actors().anon.firestore();
      await assertFails(db.collection("contacts").doc("c1").get());
    });

    it("anonyme : write refusé", async () => {
      const db = actors().anon.firestore();
      await assertFails(db.collection("contacts").doc("c1").set(STUB_PAYLOAD));
    });

    it("signed (no role) : read refusé", async () => {
      const db = actors().signed.firestore();
      await assertFails(db.collection("contacts").doc("c1").get());
    });

    it("signed (no role) : write refusé", async () => {
      const db = actors().signed.firestore();
      await assertFails(db.collection("contacts").doc("c1").set(STUB_PAYLOAD));
    });

    it("commercial Custom Claim : read refusé (MVP — relaxation S9+)", async () => {
      const db = actors().commercial.firestore();
      await assertFails(db.collection("contacts").doc("c1").get());
    });

    it("commercial Custom Claim : write refusé", async () => {
      const db = actors().commercial.firestore();
      await assertFails(db.collection("contacts").doc("c1").set(STUB_PAYLOAD));
    });

    it("admin Custom Claim : read refusé (MVP — relaxation S9+)", async () => {
      const db = actors().admin.firestore();
      await assertFails(db.collection("contacts").doc("c1").get());
    });

    it("admin Custom Claim : write refusé", async () => {
      const db = actors().admin.firestore();
      await assertFails(db.collection("contacts").doc("c1").set(STUB_PAYLOAD));
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // conversations/{convId} — 4 actors × 2 ops = 8 tests
  // ───────────────────────────────────────────────────────────────────────

  describe("conversations/{convId}", () => {
    it("anonyme : read refusé", async () => {
      const db = actors().anon.firestore();
      await assertFails(db.collection("conversations").doc("conv1").get());
    });

    it("anonyme : write refusé", async () => {
      const db = actors().anon.firestore();
      await assertFails(db.collection("conversations").doc("conv1").set(STUB_PAYLOAD));
    });

    it("signed (no role) : read refusé", async () => {
      const db = actors().signed.firestore();
      await assertFails(db.collection("conversations").doc("conv1").get());
    });

    it("signed (no role) : write refusé", async () => {
      const db = actors().signed.firestore();
      await assertFails(db.collection("conversations").doc("conv1").set(STUB_PAYLOAD));
    });

    it("commercial Custom Claim : read refusé (MVP)", async () => {
      const db = actors().commercial.firestore();
      await assertFails(db.collection("conversations").doc("conv1").get());
    });

    it("commercial Custom Claim : write refusé", async () => {
      const db = actors().commercial.firestore();
      await assertFails(db.collection("conversations").doc("conv1").set(STUB_PAYLOAD));
    });

    it("admin Custom Claim : read refusé (MVP)", async () => {
      const db = actors().admin.firestore();
      await assertFails(db.collection("conversations").doc("conv1").get());
    });

    it("admin Custom Claim : write refusé", async () => {
      const db = actors().admin.firestore();
      await assertFails(db.collection("conversations").doc("conv1").set(STUB_PAYLOAD));
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // conversations/{convId}/messages/{messageId} — 4 actors × 2 ops = 8 tests
  // ───────────────────────────────────────────────────────────────────────

  describe("conversations/{convId}/messages/{messageId} (sous-collection)", () => {
    function msgRef(actor: ReturnType<typeof actors>["anon"]) {
      return actor
        .firestore()
        .collection("conversations")
        .doc("conv1")
        .collection("messages")
        .doc("msg1");
    }

    it("anonyme : read refusé", async () => {
      await assertFails(msgRef(actors().anon).get());
    });

    it("anonyme : write refusé", async () => {
      await assertFails(msgRef(actors().anon).set(STUB_PAYLOAD));
    });

    it("signed (no role) : read refusé", async () => {
      await assertFails(msgRef(actors().signed).get());
    });

    it("signed (no role) : write refusé", async () => {
      await assertFails(msgRef(actors().signed).set(STUB_PAYLOAD));
    });

    it("commercial Custom Claim : read refusé (MVP)", async () => {
      await assertFails(msgRef(actors().commercial).get());
    });

    it("commercial Custom Claim : write refusé", async () => {
      await assertFails(msgRef(actors().commercial).set(STUB_PAYLOAD));
    });

    it("admin Custom Claim : read refusé (MVP)", async () => {
      await assertFails(msgRef(actors().admin).get());
    });

    it("admin Custom Claim : write refusé", async () => {
      await assertFails(msgRef(actors().admin).set(STUB_PAYLOAD));
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // audit_log/{logId} — CŒUR INVARIANT (CLOSURE INFO-1 S6.2)
  // 4 actors × 2 ops = 8 tests
  //
  // Ces tests sont les SENTINELS de la closure INFO-1. Si l'un d'eux casse
  // en S9+ (ex: dev relaxe `allow read: if isAdmin()`), c'est une alarme
  // rouge — le forensic n'est plus client-impossible.
  // ───────────────────────────────────────────────────────────────────────

  describe("audit_log/{logId} — CLOSURE INFO-1 S6.2", () => {
    it("anonyme : read refusé", async () => {
      const db = actors().anon.firestore();
      await assertFails(db.collection("audit_log").doc("log1").get());
    });

    it("anonyme : write refusé", async () => {
      const db = actors().anon.firestore();
      await assertFails(db.collection("audit_log").doc("log1").set(STUB_PAYLOAD));
    });

    it("signed (no role) : read refusé", async () => {
      const db = actors().signed.firestore();
      await assertFails(db.collection("audit_log").doc("log1").get());
    });

    it("signed (no role) : write refusé", async () => {
      const db = actors().signed.firestore();
      await assertFails(db.collection("audit_log").doc("log1").set(STUB_PAYLOAD));
    });

    it("commercial Custom Claim : read refusé", async () => {
      const db = actors().commercial.firestore();
      await assertFails(db.collection("audit_log").doc("log1").get());
    });

    it("commercial Custom Claim : write refusé", async () => {
      const db = actors().commercial.firestore();
      await assertFails(db.collection("audit_log").doc("log1").set(STUB_PAYLOAD));
    });

    /**
     * Sentinel INFO-1 S6.2 : prouve qu'un futur admin Custom Claim (quand
     * Clerk câblé en S9+) ne peut PAS bypass la garantie append-only côté
     * client. La seule voie reste l'Admin SDK serveur.
     *
     * Si ce test casse, c'est qu'une relaxation client a été introduite —
     * alarme rouge à investiguer AVANT merge.
     */
    it("admin Custom Claim : read refusé (sentinel INFO-1 : pas de bypass possible)", async () => {
      const db = actors().admin.firestore();
      await assertFails(db.collection("audit_log").doc("log1").get());
    });

    /**
     * Sentinel INFO-1 S6.2 (suite) : un futur admin Custom Claim ne peut
     * PAS écrire dans audit_log. Le seul write valide reste l'Admin SDK
     * serveur via `appendAuditLog` (S6.2) ou `appendAuditLogTx` (S6.3).
     */
    it("admin Custom Claim : write refusé (sentinel INFO-1 : append-only Admin SDK only)", async () => {
      const db = actors().admin.firestore();
      await assertFails(db.collection("audit_log").doc("log1").set(STUB_PAYLOAD));
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Catchall — collection arbitraire non listée
  // 4 actors × 1 op (write) = 4 tests
  //
  // Vérifie que la rule `match /{document=**} { allow read, write: if false }`
  // attrape bien les collections qu'on aurait oublié de scoper explicitement
  // (ex: `cache_*`, `temp_*`, future collection ajoutée par erreur).
  // ───────────────────────────────────────────────────────────────────────

  describe("catchall {document=**} — collection arbitraire non scopée", () => {
    const ARBITRARY_COLLECTION = "random_test_collection_not_scoped";

    it("anonyme : write refusé sur collection arbitraire", async () => {
      const db = actors().anon.firestore();
      await assertFails(db.collection(ARBITRARY_COLLECTION).doc("x").set(STUB_PAYLOAD));
    });

    it("signed (no role) : write refusé sur collection arbitraire", async () => {
      const db = actors().signed.firestore();
      await assertFails(db.collection(ARBITRARY_COLLECTION).doc("x").set(STUB_PAYLOAD));
    });

    it("commercial Custom Claim : write refusé sur collection arbitraire", async () => {
      const db = actors().commercial.firestore();
      await assertFails(db.collection(ARBITRARY_COLLECTION).doc("x").set(STUB_PAYLOAD));
    });

    it("admin Custom Claim : write refusé sur collection arbitraire", async () => {
      const db = actors().admin.firestore();
      await assertFails(db.collection(ARBITRARY_COLLECTION).doc("x").set(STUB_PAYLOAD));
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Sanity — withSecurityRulesDisabled bypass functionne (preuve que les
  // tests assertFails ne sont pas des "ça crash quand même" déguisés)
  //
  // Pattern de seed pour les tests futurs S9+ : quand on activera
  // isCommercial() en read, on devra seed via withSecurityRulesDisabled
  // pour préparer les fixtures (sinon la query lit un doc inexistant et
  // ne prouve rien). Ce test sanity garantit que ce path fonctionne.
  // ───────────────────────────────────────────────────────────────────────

  describe("sanity — withSecurityRulesDisabled bypass (préparation S9+)", () => {
    it("withSecurityRulesDisabled permet de seed un doc + le relire", async () => {
      const seededValue = { sentinel: "ok", kind: "seed-sanity" };

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().collection("contacts").doc("sanity").set(seededValue);
      });

      // Re-lecture VIA le même bypass (les rules disent if false côté
      // client normal, le bypass passe outre). Prouve que le seed s'est
      // bien posé.
      let observed: { sentinel?: string; kind?: string } | undefined;
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const doc = await ctx.firestore().collection("contacts").doc("sanity").get();
        observed = doc.data();
      });
      expect(observed).toEqual(seededValue);
    });

    it("sans bypass : même un admin Custom Claim ne lit pas le doc seedé", async () => {
      // Seed via bypass.
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().collection("contacts").doc("blocked").set({ x: 1 });
      });
      // Tente la lecture via admin client → refusée par rules.
      const db = actors().admin.firestore();
      await assertFails(db.collection("contacts").doc("blocked").get());
    });
  });
});
