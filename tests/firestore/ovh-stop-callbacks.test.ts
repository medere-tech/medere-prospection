/**
 * Tests emulator — persistance reelle dans `ovh_stop_callbacks/` via
 * `persistCallback` (DIAG-STOP-OVH etape B, post-review security).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi ce fichier existe
 *
 * Les tests unitaires `src/app/api/webhooks/ovh-sms-stop/route.test.ts`
 * MOCKENT `.add()` et ne touchent PAS le SDK Admin reel. Apres le patch
 * M1 (defense-en-profondeur `Object.create(null)` sur les 3 maps),
 * on doit verifier que le SDK Firestore Admin ACCEPTE l'ecriture de
 * payloads construits via `summarizeParams` qui transite par des objets
 * sans prototype. Un rejet SDK silencieux casserait la persist en prod
 * sans qu'aucun test unitaire ne le detecte.
 *
 * Chaque test :
 *   1. Construit une entree hostile (PII brutes dans les params).
 *   2. Appelle `summarizeParams` (comme la route).
 *   3. Appelle `persistCallback` -> Firestore emulator.
 *   4. Relit le doc.
 *   5. Verifie : ecriture reussie, receivedAt = Timestamp, aucune
 *      valeur brute dans le doc.
 */
import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __APP_NAME_FOR_TESTS,
  __getAppByName,
  __resetFirestoreAdminForTests,
  getAdminDb,
} from "@/lib/firestore/admin";
import {
  OVH_STOP_CALLBACKS_COLLECTION,
  persistCallback,
  summarizeParams,
} from "@/lib/ovh/stop-callback";
import { __resetEnvCacheForTests } from "@/lib/security/env";

const PEPPER = "a".repeat(64);

async function fullReset() {
  vi.restoreAllMocks();
  __resetFirestoreAdminForTests();
  const app = __getAppByName(__APP_NAME_FOR_TESTS);
  if (app) {
    await deleteApp(app);
  }
  __resetEnvCacheForTests();
}

describe("ovh_stop_callbacks — persist emulator", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_PII_PEPPER", PEPPER);
    await fullReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fullReset();
  });

  it("GET + query hostile -> ecriture reussie, receivedAt Timestamp, zero valeur brute", async () => {
    const query = summarizeParams({
      token: "SHOULD_NEVER_PERSIST",
      number: "+33612345678",
      shortcode: "+33939070545",
    });

    const docId = await persistCallback({
      method: "GET",
      queryParams: query,
      contentType: "",
    });
    expect(docId).toMatch(/^[A-Za-z0-9]{10,30}$/); // Firestore auto-ID

    const snap = await getAdminDb().collection(OVH_STOP_CALLBACKS_COLLECTION).doc(docId).get();
    expect(snap.exists).toBe(true);

    const data = snap.data();
    expect(data).toBeDefined();
    if (!data) return;

    // Shape attendue
    expect(data.method).toBe("GET");
    expect(Array.isArray(data.queryParams)).toBe(true);
    expect(data.bodyParams).toBeUndefined();

    // receivedAt = Timestamp serveur
    expect(data.receivedAt).toBeInstanceOf(Timestamp);

    // Token filtre par summarizeParams -> pas present
    const names = (data.queryParams as Array<{ name: string }>).map((p) => p.name);
    expect(names).not.toContain("token");

    // SENTINELLE anti-PII : aucune valeur brute (numeros, token)
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain("SHOULD_NEVER_PERSIST");
    expect(serialized).not.toContain("+33612345678");
    expect(serialized).not.toContain("33612345678");
    expect(serialized).not.toContain("+33939070545");
    expect(serialized).not.toContain("33939070545");

    // Hashes `oih_` present pour les phoneLike
    const numberParam = (
      data.queryParams as Array<{
        name: string;
        masked: { type: string; hash?: string; last4?: string };
      }>
    ).find((p) => p.name === "number");
    expect(numberParam?.masked.type).toBe("phoneLike");
    expect(numberParam?.masked.hash).toMatch(/^oih_/);
    expect(numberParam?.masked.last4).toBe("5678");
  });

  it("POST form-urlencoded body hostile -> ecriture reussie, bodyParams masques", async () => {
    const query = summarizeParams({ token: "x" });
    const body = summarizeParams({
      id: "118791103",
      senderid: "+33612345678",
      message: "Je m'appelle Dupont et refuse vos SMS",
    });

    const docId = await persistCallback({
      method: "POST",
      queryParams: query,
      contentType: "application/x-www-form-urlencoded",
      bodyParams: body,
    });

    const snap = await getAdminDb().collection(OVH_STOP_CALLBACKS_COLLECTION).doc(docId).get();
    const data = snap.data();
    expect(data).toBeDefined();
    if (!data) return;

    expect(data.method).toBe("POST");
    expect(data.contentType).toBe("application/x-www-form-urlencoded");
    expect(Array.isArray(data.bodyParams)).toBe(true);
    expect(data.receivedAt).toBeInstanceOf(Timestamp);

    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain("+33612345678");
    expect(serialized).not.toContain("118791103");
    expect(serialized).not.toContain("Dupont");
    expect(serialized).not.toContain("Je m'appelle");

    // message est "text" + length seulement, pas de hash ni de valeur
    const messageParam = (
      data.bodyParams as Array<{
        name: string;
        masked: { type: string; length: number };
      }>
    ).find((p) => p.name === "message");
    expect(messageParam?.masked.type).toBe("text");
    expect(messageParam?.masked.length).toBe("Je m'appelle Dupont et refuse vos SMS".length);
  });

  it("POST JSON body hostile -> ecriture reussie via SDK Admin (verifie compat Object.create(null))", async () => {
    // Teste explicitement le patch M1 : `summarizeParams` transite par
    // un objet construit via `Object.create(null)` dans la route. Ce
    // test confirme que le SDK Admin ACCEPTE l'ecriture d'un
    // `queryParams: [{name, masked}]` ou `masked` est aussi une
    // structure sans prototype.
    const body = summarizeParams({
      id: "999888777",
      senderid: "0612345678",
      message: "STOP",
    });

    const docId = await persistCallback({
      method: "POST",
      queryParams: [],
      contentType: "application/json",
      bodyParams: body,
    });

    const snap = await getAdminDb().collection(OVH_STOP_CALLBACKS_COLLECTION).doc(docId).get();
    expect(snap.exists).toBe(true);

    const data = snap.data();
    if (!data) throw new Error("doc data missing");
    expect(data.contentType).toBe("application/json");
    expect(data.receivedAt).toBeInstanceOf(Timestamp);

    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain("999888777");
    expect(serialized).not.toContain("0612345678");

    // Verifie que l'objet persisted a bien un prototype `Object.prototype`
    // apres relecture Firestore (le SDK re-materialise les docs). Les
    // tests sur l'objet SOURCE (sans prototype) sont dans route.test.ts.
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
  });

  it("GET sans parametres (queryParams=[]) -> doc minimal valide", async () => {
    const docId = await persistCallback({
      method: "GET",
      queryParams: [],
      contentType: "",
    });
    const snap = await getAdminDb().collection(OVH_STOP_CALLBACKS_COLLECTION).doc(docId).get();
    expect(snap.exists).toBe(true);
    const data = snap.data();
    if (!data) throw new Error("doc data missing");
    expect(data.queryParams).toEqual([]);
    expect(data.bodyParams).toBeUndefined();
    expect(data.receivedAt).toBeInstanceOf(Timestamp);
  });

  it("POST avec parseError -> field persistance (observation diagnostic)", async () => {
    const docId = await persistCallback({
      method: "POST",
      queryParams: [],
      contentType: "application/xml",
      bodyParams: [],
      bodyParseError: "unknown-content-type",
    });
    const snap = await getAdminDb().collection(OVH_STOP_CALLBACKS_COLLECTION).doc(docId).get();
    const data = snap.data();
    if (!data) throw new Error("doc data missing");
    expect(data.bodyParseError).toBe("unknown-content-type");
  });
});
