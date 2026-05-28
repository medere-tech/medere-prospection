import { afterEach, describe, expect, it, vi } from "vitest";

import { buildLogger, createLogger, maskEmail, maskPhone } from "./logger";

/** Destination Pino qui capture la sortie JSON pour inspection. */
function captureDestination() {
  const chunks: string[] = [];
  return {
    stream: { write: (s: string) => void chunks.push(s) },
    output: () => chunks.join(""),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Couche 3 : redact.paths (existant)
// ─────────────────────────────────────────────────────────────────────────────

describe("logger — redaction par NOM DE CLÉ (filet redact.paths)", () => {
  it("remplace les champs PII par [REDACTED], à plusieurs niveaux", () => {
    const cap = captureDestination();
    const log = buildLogger({ level: "debug" }, cap.stream);

    log.info(
      {
        email: "john.doe@example.com",
        contact: {
          firstName: "Jean",
          lastName: "Dupont",
          phone: { e164: "+33612345678", raw: "0612345678" },
        },
        payload: { contact: { email: "nested@example.com" } },
        body: "Bonjour Jean, ...",
        keep: "valeur-neutre",
      },
      "message",
    );

    const out = cap.output();
    expect(out).not.toContain("john.doe@example.com");
    expect(out).not.toContain("nested@example.com");
    expect(out).not.toContain("+33612345678");
    expect(out).not.toContain("0612345678");
    expect(out).not.toContain("Jean");
    expect(out).not.toContain("Dupont");
    expect(out).not.toContain("Bonjour");
    expect(out).toContain("valeur-neutre");
  });

  it("redacte aussi les champs PII dans un logger enfant", () => {
    const cap = captureDestination();
    const parent = buildLogger({ level: "debug" }, cap.stream);
    const child = parent.child({ requestId: "req-123" });

    child.info({ email: "secret@example.com" }, "child log");

    const out = cap.output();
    expect(out).toContain("req-123");
    expect(out).not.toContain("secret@example.com");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Couche 2 : scrub par VALEUR (formatters.log + hooks.logMethod)
// ─────────────────────────────────────────────────────────────────────────────

describe("logger — scrub par VALEUR : variantes E.164", () => {
  // Toutes les variantes listées par Déthié + une "national sans +33".
  const variants = [
    "+33612345678",
    "+33 6 12 34 56 78",
    "+33-6-12-34-56-78",
    "+33.6.12.34.56.78",
    "+33(0)612345678",
    "0612345678",
  ];

  it.each(variants)("scrube la variante %s dans un champ non listé", (raw) => {
    const cap = captureDestination();
    const log = buildLogger({ level: "debug" }, cap.stream);
    // `note` n'est PAS dans PII_KEYS → c'est le scrub par valeur qui doit attraper.
    log.info({ note: `Tentative envoi à ${raw} en échec` }, "ovh");
    const out = cap.output();
    // Les chiffres bruts du numéro ne doivent pas apparaître.
    const digitsOnly = raw.replace(/\D/g, "");
    expect(out).not.toContain(digitsOnly);
    // Aucune variante ne doit subsister textuellement.
    expect(out).not.toContain(raw);
    expect(out).toContain("[PHONE]");
  });

  it("scrube une variante E.164 dans le msg interpolé (anti-pattern)", () => {
    const cap = captureDestination();
    const log = buildLogger({ level: "debug" }, cap.stream);
    log.info(`SMS envoyé à +33 6 12 34 56 78 OK`);
    const out = cap.output();
    expect(out).not.toContain("612345678");
    expect(out).toContain("[PHONE]");
  });
});

describe("logger — scrub par VALEUR : profondeur arbitraire et tableaux", () => {
  it("scrube un téléphone à 4 niveaux d'imbrication", () => {
    const cap = captureDestination();
    const log = buildLogger({ level: "debug" }, cap.stream);
    log.info({ a: { b: { c: { note: "+33612345678" } } } }, "deep");
    const out = cap.output();
    expect(out).not.toContain("612345678");
    expect(out).toContain("[PHONE]");
  });

  it("scrube un email à 4 niveaux d'imbrication", () => {
    const cap = captureDestination();
    const log = buildLogger({ level: "debug" }, cap.stream);
    log.info({ a: { b: { c: { detail: "contact: jean@example.com" } } } });
    const out = cap.output();
    expect(out).not.toContain("jean@example.com");
    expect(out).toContain("[EMAIL]");
  });

  it("scrube les valeurs dans un tableau", () => {
    const cap = captureDestination();
    const log = buildLogger({ level: "debug" }, cap.stream);
    log.info({ notes: ["call +33 6 12 34 56 78", "mail jean@x.fr"] });
    const out = cap.output();
    expect(out).not.toContain("612345678");
    expect(out).not.toContain("jean@x.fr");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Secrets HTTP — BUG-002 résolu (pre-task S3)
// ─────────────────────────────────────────────────────────────────────────────

describe("logger — secrets HTTP (BUG-002)", () => {
  it("redacte req.headers.authorization (Bearer …)", () => {
    const cap = captureDestination();
    const log = buildLogger({ level: "debug" }, cap.stream);
    log.info({ req: { headers: { authorization: "Bearer sk-real-xyz" } } });
    const out = cap.output();
    expect(out).not.toContain("Bearer");
    expect(out).not.toContain("sk-real-xyz");
    expect(out).toContain("[REDACTED]");
  });

  it("redacte req.headers['x-ovh-signature']", () => {
    const cap = captureDestination();
    const log = buildLogger({ level: "debug" }, cap.stream);
    log.info({ req: { headers: { "x-ovh-signature": "abc123" } } });
    const out = cap.output();
    expect(out).not.toContain("abc123");
    expect(out).toContain("[REDACTED]");
  });

  it("redacte config.apiKey", () => {
    const cap = captureDestination();
    const log = buildLogger({ level: "debug" }, cap.stream);
    log.info({ config: { apiKey: "real-secret" } });
    const out = cap.output();
    expect(out).not.toContain("real-secret");
    expect(out).toContain("[REDACTED]");
  });
});

describe("logger — clés tiers (variantes HubSpot/Lusha/FR)", () => {
  it("redacte les clés alternatives via redact.paths ET le scrub valeur", () => {
    const cap = captureDestination();
    const log = buildLogger({ level: "debug" }, cap.stream);
    log.info({
      tel: "+33612345678",
      mobile: "+33655667788",
      phoneNumber: "+33611223344",
      phoneNumbers: ["+33611111111", "+33622222222"],
      firstname: "Jean", // HubSpot minuscule
      prenom: "Marie",
      nom: "Dupont",
    });
    const out = cap.output();
    // Aucune valeur en clair, peu importe que ce soit [REDACTED] ou [PHONE].
    expect(out).not.toContain("612345678");
    expect(out).not.toContain("655667788");
    expect(out).not.toContain("611223344");
    expect(out).not.toContain("611111111");
    expect(out).not.toContain("Jean");
    expect(out).not.toContain("Marie");
    expect(out).not.toContain("Dupont");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Couche 1 : serializers.err / serializers.error
// ─────────────────────────────────────────────────────────────────────────────

describe("logger — serializer err : scrub message et stack", () => {
  it("scrube un E.164 dans err.message (logger.error(err))", () => {
    const cap = captureDestination();
    const log = buildLogger({ level: "debug" }, cap.stream);
    log.error(new Error("send to +33612345678 failed for OVH"));
    const out = cap.output();
    expect(out).not.toContain("+33612345678");
    expect(out).not.toContain("612345678");
    expect(out).toContain("[PHONE]");
  });

  it("scrube un email dans err.stack", () => {
    const cap = captureDestination();
    const log = buildLogger({ level: "debug" }, cap.stream);
    const err = new Error("ovh refused: target jean.doe@example.com");
    log.error({ err }, "send failed");
    const out = cap.output();
    // La stack inclut le message → l'email doit en disparaître.
    expect(out).toContain('"stack"');
    expect(out).not.toContain("jean.doe@example.com");
    expect(out).toContain("[EMAIL]");
  });

  it("la clé `error` (non standard Pino) est aussi serializée et scrubée", () => {
    const cap = captureDestination();
    const log = buildLogger({ level: "debug" }, cap.stream);
    log.error({ error: new Error("call +33 6 12 34 56 78 failed") });
    const out = cap.output();
    expect(out).not.toContain("612345678");
    expect(out).toContain("[PHONE]");
  });

  it("err non-Error : on ne casse pas, on scrube en valeur", () => {
    const cap = captureDestination();
    const log = buildLogger({ level: "debug" }, cap.stream);
    log.error({ err: { detail: "+33612345678 down" } });
    const out = cap.output();
    expect(out).not.toContain("612345678");
  });

  it("en production, err.stack est supprimée", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const cap = captureDestination();
      const log = buildLogger({ level: "debug" }, cap.stream);
      log.error(new Error("boom +33612345678"));
      const out = cap.output();
      // message scrubé visible, stack absente.
      expect(out).toContain("[PHONE]");
      expect(out).not.toContain('"stack":"');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Non-régression : texte sans PII
// ─────────────────────────────────────────────────────────────────────────────

describe("logger — non-régression : pas de PII = pas de modification", () => {
  it("un msg sans téléphone ni email passe tel quel", () => {
    const cap = captureDestination();
    const log = buildLogger({ level: "debug" }, cap.stream);
    log.info("user logged in");
    const out = cap.output();
    expect(out).toContain("user logged in");
    expect(out).not.toContain("[PHONE]");
    expect(out).not.toContain("[EMAIL]");
  });

  it("un objet de contexte neutre passe tel quel", () => {
    const cap = captureDestination();
    const log = buildLogger({ level: "debug" }, cap.stream);
    log.info({ requestId: "req-abc", durationMs: 42, ok: true }, "ok");
    const out = cap.output();
    expect(out).toContain("req-abc");
    expect(out).toContain("durationMs");
    expect(out).toContain('"ok":true');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Niveau selon environnement (existant)
// ─────────────────────────────────────────────────────────────────────────────

describe("logger — niveau selon l'environnement", () => {
  // Tous les tests stubent NODE_ENV / LOG_LEVEL via vi.stubEnv ; restauration
  // automatique en afterEach. Évite l'assignation directe sur process.env
  // (NODE_ENV typé readonly par @types/node).
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("LOG_LEVEL explicite a priorité", () => {
    vi.stubEnv("LOG_LEVEL", "warn");
    const cap = captureDestination();
    expect(buildLogger({}, cap.stream).level).toBe("warn");
  });

  it("production → info", () => {
    vi.stubEnv("LOG_LEVEL", "");
    vi.stubEnv("NODE_ENV", "production");
    const cap = captureDestination();
    expect(buildLogger({}, cap.stream).level).toBe("info");
  });

  it("test → silent", () => {
    vi.stubEnv("LOG_LEVEL", "");
    vi.stubEnv("NODE_ENV", "test");
    const cap = captureDestination();
    expect(buildLogger({}, cap.stream).level).toBe("silent");
  });

  it("development → debug", () => {
    vi.stubEnv("LOG_LEVEL", "");
    vi.stubEnv("NODE_ENV", "development");
    const cap = captureDestination();
    expect(buildLogger({}, cap.stream).level).toBe("debug");
  });

  it("valeur NODE_ENV inconnue → development (fallback)", () => {
    vi.stubEnv("LOG_LEVEL", "");
    vi.stubEnv("NODE_ENV", "staging");
    const cap = captureDestination();
    expect(buildLogger({}, cap.stream).level).toBe("debug");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (existant)
// ─────────────────────────────────────────────────────────────────────────────

describe("createLogger", () => {
  it("retourne un logger enfant fonctionnel", () => {
    const child = createLogger({ module: "test" });
    expect(typeof child.info).toBe("function");
  });
});

describe("maskEmail", () => {
  it("masque la partie locale, garde le domaine", () => {
    expect(maskEmail("john.doe@example.com")).toBe("j*******@example.com");
    expect(maskEmail("a@b.com")).toBe("a*@b.com");
  });

  it("ne révèle pas la partie locale complète", () => {
    expect(maskEmail("john.doe@example.com")).not.toContain("john.doe");
  });

  it("masque entièrement une chaîne sans @", () => {
    expect(maskEmail("pasunemail")).toBe("**********");
    expect(maskEmail("@nolocal.com")).toBe("************");
  });
});

describe("maskPhone (ré-export)", () => {
  it("est disponible depuis le logger", () => {
    expect(maskPhone("+33612345678")).toBe("+33*******78");
  });
});
