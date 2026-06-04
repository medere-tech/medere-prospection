import { Inngest } from "inngest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __INNGEST_APP_ID_FOR_TESTS, __setInngestClientForTests, getInngestClient } from "./client";

beforeEach(() => {
  __setInngestClientForTests(null);
});

afterEach(() => {
  __setInngestClientForTests(null);
});

describe("getInngestClient — singleton paresseux", () => {
  it("instancie un client Inngest natif au premier appel", () => {
    const client = getInngestClient();
    expect(client).toBeInstanceOf(Inngest);
    expect(client.id).toBe(__INNGEST_APP_ID_FOR_TESTS);
  });

  it("retourne la même instance sur appels successifs (mémoïsation)", () => {
    const a = getInngestClient();
    const b = getInngestClient();
    expect(a).toBe(b);
  });

  it("ré-instancie après reset via back-door tests", () => {
    const first = getInngestClient();
    __setInngestClientForTests(null);
    const second = getInngestClient();
    expect(second).not.toBe(first);
    expect(second).toBeInstanceOf(Inngest);
  });

  it("retourne le fake injecté via __setInngestClientForTests", () => {
    const fake = {
      id: "fake",
      send: vi.fn(),
      createFunction: vi.fn(),
    } as unknown as Inngest;
    __setInngestClientForTests(fake);
    expect(getInngestClient()).toBe(fake);
  });
});

describe("__setInngestClientForTests — garde runtime", () => {
  it("throw si NODE_ENV !== 'test'", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => __setInngestClientForTests(null)).toThrow(
      "__setInngestClientForTests called outside of tests",
    );
    vi.unstubAllEnvs();
  });

  it("autorise NODE_ENV='test' (ne throw pas)", () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(() => __setInngestClientForTests(null)).not.toThrow();
    vi.unstubAllEnvs();
  });
});

describe("INNGEST_APP_ID — constante stable", () => {
  it("est figée à 'medere-prospection' (changement breaking côté cloud)", () => {
    // ⚠️ Sentinelle anti-régression : modifier cette constante crée une
    // nouvelle app Inngest cloud et perd l'historique des exécutions.
    // Si ce test casse, c'est volontaire ? Documenter dans le PR.
    expect(__INNGEST_APP_ID_FOR_TESTS).toBe("medere-prospection");
  });
});
