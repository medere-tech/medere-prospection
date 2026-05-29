import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetEnvCacheForTests } from "@/lib/security/env";
import { ConfigError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

import { detectPiiInPayload, hashPii, PII_WALK_MAX_DEPTH, type PiiViolation } from "./pii-detector";

const VALID_PEPPER = "a".repeat(64); // 32 bytes hex, simule openssl rand -hex 32

beforeEach(() => {
  __resetEnvCacheForTests();
  vi.stubEnv("AUDIT_PII_PEPPER", VALID_PEPPER);
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetEnvCacheForTests();
});

// ─────────────────────────────────────────────────────────────────────────────
// detectPiiInPayload — happy detection paths
// ─────────────────────────────────────────────────────────────────────────────

describe("detectPiiInPayload — détection happy paths", () => {
  it("détecte un téléphone E.164 en clair", () => {
    const v = detectPiiInPayload({ phone: "+33612345678" });
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe("phone_e164");
    expect(v[0]?.path).toBe("phone");
  });

  it("détecte un téléphone FR national en clair", () => {
    const v = detectPiiInPayload({ p: "0612345678" });
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe("phone_fr_national");
  });

  it("détecte un email en clair", () => {
    const v = detectPiiInPayload({ contact: "dr.dupont@cabinet.fr" });
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe("email");
  });

  it("détecte plusieurs PII dans le même payload (multi-kind, multi-path)", () => {
    const v = detectPiiInPayload({
      a: { phone: "+33612345678" },
      b: { email: "x@y.fr" },
    });
    const kinds = v.map((x) => x.kind).sort();
    expect(kinds).toContain("phone_e164");
    expect(kinds).toContain("email");
  });

  it("path reflète la structure (nesting + arrays)", () => {
    const v = detectPiiInPayload({
      recipients: [{ phone: "0612345678" }, { phone: "0712345678" }],
    });
    const paths = v.map((x) => x.path).sort();
    expect(paths).toEqual(["recipients[0].phone", "recipients[1].phone"]);
  });

  it("renvoie [] sur payload propre (IDs Firestore, hashes, libellés)", () => {
    const v = detectPiiInPayload({
      contactId: "xyz123abc",
      messageId: "msg_42",
      result: "blocked",
      code: "rate_limit_exceeded",
    });
    expect(v).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectPiiInPayload — anti-bypass (strip \s.-)
// ─────────────────────────────────────────────────────────────────────────────

describe("detectPiiInPayload — anti-bypass strip \\s.-", () => {
  it("détecte E.164 camouflé avec espaces", () => {
    const v = detectPiiInPayload({ p: "+33 6 12 34 56 78" });
    expect(v.some((x) => x.kind === "phone_e164")).toBe(true);
  });

  it("détecte E.164 camouflé avec points", () => {
    const v = detectPiiInPayload({ p: "+33.6.12.34.56.78" });
    expect(v.some((x) => x.kind === "phone_e164")).toBe(true);
  });

  it("détecte E.164 camouflé avec tirets", () => {
    const v = detectPiiInPayload({ p: "+33-6-12-34-56-78" });
    expect(v.some((x) => x.kind === "phone_e164")).toBe(true);
  });

  it("détecte FR national camouflé avec espaces", () => {
    const v = detectPiiInPayload({ p: "06 12 34 56 78" });
    expect(v.some((x) => x.kind === "phone_fr_national")).toBe(true);
  });

  it("détecte FR national au milieu d'une phrase", () => {
    const v = detectPiiInPayload({ notes: "appelle au 06 12 34 56 78 stp" });
    expect(v.some((x) => x.kind === "phone_fr_national")).toBe(true);
  });

  // ─── Fix HIGH-1 : téléphone FR collé à un identifiant hex (regex anti-digit) ───

  it("HIGH-1 : détecte phone FR collé à un docId Firestore alphanumérique 'msg…abc'", () => {
    const v = detectPiiInPayload({ ref: "msg0612345678abc" });
    expect(v.some((x) => x.kind === "phone_fr_national")).toBe(true);
  });

  it("HIGH-1 : détecte phone FR encadré par lettres hex (avant ET après)", () => {
    const v = detectPiiInPayload({ ref: "contact_ab0612345678cd" });
    expect(v.some((x) => x.kind === "phone_fr_national")).toBe(true);
  });

  it("HIGH-1 : détecte phone FR dans un slug hex pur 'fa…ef'", () => {
    const v = detectPiiInPayload({ ref: "fa0612345678ef" });
    expect(v.some((x) => x.kind === "phone_fr_national")).toBe(true);
  });

  it("HIGH-1 : UUID v4 strippé NE doit PAS matcher comme phone FR (faux positif évité)", () => {
    // UUID v4 sans tirets — pattern aléatoire hex. Pas de séquence
    // `0[1-9]\d{8}` consécutive (vérifié à la main : les `0` sont suivis
    // de `e`/`f`/`a` non-digits).
    const v = detectPiiInPayload({ id: "550e8400e29b41d4a716446655440000" });
    expect(v).toEqual([]);
  });

  // ─── Fix HIGH-2 : strip étendu aux parenthèses (notations E.123) ───

  it("HIGH-2 : détecte '+33(6)12345678' (notation FR officielle)", () => {
    const v = detectPiiInPayload({ p: "+33(6)12345678" });
    expect(v.some((x) => x.kind === "phone_e164")).toBe(true);
  });

  it("HIGH-2 : détecte '+33(0)6 12 34 56 78' (variante avec 0 entre parenthèses)", () => {
    const v = detectPiiInPayload({ p: "+33(0)6 12 34 56 78" });
    expect(v.some((x) => x.kind === "phone_e164")).toBe(true);
  });

  it("HIGH-2 : détecte '+1 (202) 555-1234' (notation US standard)", () => {
    const v = detectPiiInPayload({ p: "+1 (202) 555-1234" });
    expect(v.some((x) => x.kind === "phone_e164")).toBe(true);
  });

  it("HIGH-2 : détecte un FR national entre parenthèses dans une phrase", () => {
    const v = detectPiiInPayload({
      notes: "joignable au (06 12 34 56 78) en journée",
    });
    expect(v.some((x) => x.kind === "phone_fr_national")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectPiiInPayload — BUG-003 faux positifs à NE PAS matcher
// ─────────────────────────────────────────────────────────────────────────────

describe("detectPiiInPayload — faux positifs BUG-003 exclus", () => {
  it("ne match PAS un timestamp ISO 8601 avec offset +02:00", () => {
    const v = detectPiiInPayload({ ts: "2026-05-29T14:30:00.123+02:00" });
    expect(v).toEqual([]);
  });

  it("ne match PAS un timestamp ISO 8601 avec offset +33:00 (cas pathologique)", () => {
    // Forcé pour tester : un offset numériquement identique à un préfixe E.164.
    // L'absence de 10 chiffres consécutifs après `+` doit suffire à exclure.
    const v = detectPiiInPayload({ ts: "2026-01-01T00:00:00+33:00" });
    expect(v).toEqual([]);
  });

  it("ne match PAS un UUID v4 (hex avec tirets)", () => {
    const v = detectPiiInPayload({
      id: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(v).toEqual([]);
  });

  it("ne match PAS un ID HubSpot numérique pur (10+ chiffres sans 0[1-9] initial)", () => {
    const v = detectPiiInPayload({ hubspotId: "1234567890" });
    expect(v).toEqual([]);
  });

  it("ne match PAS un ID HubSpot 12 chiffres", () => {
    const v = detectPiiInPayload({ hubspotId: "123456789012" });
    expect(v).toEqual([]);
  });

  it("ne match PAS un token type 'sk-ant-...' (préfixe lettres)", () => {
    const v = detectPiiInPayload({ key: "sk-ant-fake-1234567890" });
    expect(v).toEqual([]);
  });

  it("ne match PAS un domaine sans email valide", () => {
    const v = detectPiiInPayload({ url: "https://medere.fr/api/v1" });
    expect(v).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectPiiInPayload — invariants techniques
// ─────────────────────────────────────────────────────────────────────────────

describe("detectPiiInPayload — invariants", () => {
  it("MED-1 : sample = '[redacted]' constant, AUCUNE fraction de la valeur", () => {
    // Fix MED-1 S6.2 : la version précédente exposait 4 chars + ellipsis
    // ("+336…"), encore identifiant pour le segment dentistes IDF. La
    // nouvelle implémentation rend une constante : path + kind suffisent
    // au debug, la valeur n'est NI tronquée NI hashée NI exposée.
    const v = detectPiiInPayload({ phone: "+33612345678" });
    expect(v).toHaveLength(1);
    expect(v[0]?.sample).toBe("[redacted]");
  });

  it("MED-1 : sample reste '[redacted]' même pour un email de PS médical", () => {
    const v = detectPiiInPayload({ email: "dr.dupont@cabinet.fr" });
    expect(v).toHaveLength(1);
    expect(v[0]?.sample).toBe("[redacted]");
    // Sanity check : aucune fraction du nom dans le sample.
    expect(v[0]?.sample).not.toContain("dr.");
    expect(v[0]?.sample).not.toContain("dupont");
  });

  it("dédoublonne par (path, kind) si raw + strippée matchent toutes les deux", () => {
    // "+33 6 12 34 56 78" : la version strippée match aussi bien E.164. Une
    // seule violation `phone_e164` doit ressortir (pas 2).
    const v = detectPiiInPayload({ p: "+33 6 12 34 56 78" });
    const e164 = v.filter((x) => x.kind === "phone_e164");
    expect(e164).toHaveLength(1);
  });

  it("stoppe gracieusement à profondeur > PII_WALK_MAX_DEPTH (pas de throw)", () => {
    // Construit un objet de profondeur 12 (au-delà des 10 autorisés).
    // La PII est planquée à la couche 12 → ne doit PAS être détectée.
    type Deep = { next?: Deep; leak?: string };
    let cursor: Deep = { leak: "+33612345678" };
    for (let i = 0; i < 12; i++) {
      cursor = { next: cursor };
    }
    // Spy le logger pour ne pas polluer la sortie test (le warn LOW-1
    // sera ré-émis ici en plus du test dédié ci-dessous).
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    expect(() => detectPiiInPayload(cursor)).not.toThrow();
    const v = detectPiiInPayload(cursor);
    expect(v).toEqual([]);
    warnSpy.mockRestore();
  });

  it("LOW-1 : émet logger.warn avec kind='pii_walk_depth_exceeded' à depth max+1", () => {
    // Fix LOW-1 S6.2 (security-reviewer) : visibilité runtime obligatoire
    // pour détecter qu'un caller pousse anormalement deep en prod. Pas un
    // throw (garde graceful), juste un signal observable.
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    let payload: unknown = "+33612345678";
    for (let i = 0; i < 13; i++) {
      payload = { wrap: payload };
    }
    detectPiiInPayload(payload);
    expect(warnSpy).toHaveBeenCalled();
    // Vérifie la signature exacte du log : { path, depth, kind }
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "pii_walk_depth_exceeded",
        depth: PII_WALK_MAX_DEPTH,
        path: expect.any(String),
      }),
      expect.any(String),
    );
    warnSpy.mockRestore();
  });

  it("détecte une PII à exactement PII_WALK_MAX_DEPTH (limite incluse)", () => {
    // Sanity check : depth 10 doit matcher. On part de la racine `{a:{...}}`
    // = depth 1, etc. PII à depth 10 (== max) → matchable.
    let payload: unknown = "0612345678";
    for (let i = 0; i < PII_WALK_MAX_DEPTH - 1; i++) {
      payload = { wrap: payload };
    }
    const v = detectPiiInPayload(payload);
    expect(v.length).toBeGreaterThan(0);
  });

  it("ignore les types non-string (number, boolean, null, undefined)", () => {
    const v = detectPiiInPayload({
      count: 612345678, // number, pas string
      active: true,
      nothing: null,
      missing: undefined,
    });
    expect(v).toEqual([]);
  });

  it("descend dans les arrays imbriqués", () => {
    const v = detectPiiInPayload([{ phone: "+33612345678" }]);
    expect(v).toHaveLength(1);
    expect(v[0]?.path).toBe("[0].phone");
  });

  it("scrute payload primitif racine (string seule)", () => {
    const v = detectPiiInPayload("+33612345678");
    expect(v).toHaveLength(1);
    expect(v[0]?.path).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// hashPii — HMAC-SHA256 avec pepper, irréversibilité forensic
// ─────────────────────────────────────────────────────────────────────────────

describe("hashPii — HMAC-SHA256 avec pepper", () => {
  it("déterministe : 2 appels avec même input + même pepper → même hash", () => {
    const a = hashPii("+33612345678");
    const b = hashPii("+33612345678");
    expect(a).toBe(b);
  });

  it("retourne 32 chars hex (= 128 bits, anti-collision sur ~26k contacts)", () => {
    const h = hashPii("+33612345678");
    expect(h).toHaveLength(32);
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });

  it("inputs différents → hashes différents (anti-collision pratique)", () => {
    const a = hashPii("+33612345678");
    const b = hashPii("+33712345678");
    expect(a).not.toBe(b);
  });

  it("peppers différents → hashes différents pour le même input (preuve d'agissement du pepper)", () => {
    const value = "+33612345678";
    const hashA = hashPii(value);

    // Switch pepper + vide cache env pour forcer une nouvelle lecture
    __resetEnvCacheForTests();
    vi.stubEnv("AUDIT_PII_PEPPER", "b".repeat(64));
    const hashB = hashPii(value);

    expect(hashA).not.toBe(hashB);
  });

  it("throw ConfigError si AUDIT_PII_PEPPER manquant", () => {
    // On clear le cache puis on coupe la var pour reproduire le cas
    // "déploiement prod sans secret configuré".
    __resetEnvCacheForTests();
    vi.stubEnv("AUDIT_PII_PEPPER", undefined);
    expect(() => hashPii("+33612345678")).toThrow(ConfigError);
  });

  it("throw ConfigError si AUDIT_PII_PEPPER trop court", () => {
    __resetEnvCacheForTests();
    vi.stubEnv("AUDIT_PII_PEPPER", "tooshort");
    expect(() => hashPii("+33612345678")).toThrow(ConfigError);
  });

  it("le hash ne contient JAMAIS la valeur d'origine (sanity check)", () => {
    const phone = "+33612345678";
    const h = hashPii(phone);
    expect(h).not.toContain(phone);
    expect(h).not.toContain("612345678");
  });

  it("PiiViolation contient bien path + kind + sample (forme stable)", () => {
    const v: PiiViolation[] = detectPiiInPayload({ phone: "+33612345678" });
    expect(v[0]).toMatchObject({
      path: "phone",
      kind: "phone_e164",
      sample: expect.any(String),
    });
  });
});
