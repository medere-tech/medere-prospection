/**
 * Tests `reply-generator.ts` (S9.3.2).
 *
 * Pattern : mock du wrapper `generate()` via `vi.mock("./client")` (cohérent
 * avec le pattern S7a.2 intent-classifier qui mock `generateWithTool`).
 *
 * Couverture :
 *   - Sentinelles constantes (MODEL, TEMPERATURE, MAX_TOKENS, HISTORY_MAX)
 *   - Gardes d'entrée (rawMessage, history.length)
 *   - Dispatch par intent (INTERESSE / OBJECTION / NEUTRE)
 *   - Happy path : body + tokens + promptVersion + durationMs cohérents
 *   - Triple garde Médéré : oubli LLM → ExternalServiceError retry-friendly
 *   - Propagation erreurs SDK (ExternalServiceError, ConfigError, etc.)
 *   - Sentinelle anti-PII : fixtures sans vrais numéros / noms réels
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hasOptOut } from "@/lib/compliance/opt-out";
import { ConfigError, ExternalServiceError, ValidationError } from "@/lib/utils/errors";

import type { GenerateResult } from "./types";

// ⚠️ vi.mock DOIT être déclaré AVANT l'import du module testé.
vi.mock("./client", () => ({
  generate: vi.fn(),
}));

import { generate } from "./client";
import {
  __HISTORY_MAX_ENTRIES_FOR_TESTS,
  assembleReplyBody,
  GENERATE_REPLY_MAX_TOKENS,
  GENERATE_REPLY_MODEL,
  GENERATE_REPLY_TEMPERATURE,
  generateReply,
  REPLY_STOP_SUFFIX,
} from "./reply-generator";

const mockedGenerate = generate as unknown as ReturnType<typeof vi.fn>;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Construit un GenerateResult par défaut avec mention "Médéré" présente. */
function makeGenerateResult(text: string, overrides: Partial<GenerateResult> = {}): GenerateResult {
  return {
    text,
    usage: { inputTokens: 100, outputTokens: 40 },
    stopReason: "end_turn",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sentinelles constantes
// ─────────────────────────────────────────────────────────────────────────────

describe("reply-generator — sentinelles constantes", () => {
  it("GENERATE_REPLY_MODEL === 'claude-sonnet-4-6' (dateless pinned post-4.6)", () => {
    expect(GENERATE_REPLY_MODEL).toBe("claude-sonnet-4-6");
  });

  it("GENERATE_REPLY_TEMPERATURE === 0.5 (compromis naturel + cohérence)", () => {
    expect(GENERATE_REPLY_TEMPERATURE).toBe(0.5);
  });

  it("GENERATE_REPLY_MAX_TOKENS === 200 (borne de sécurité contre runaway)", () => {
    expect(GENERATE_REPLY_MAX_TOKENS).toBe(200);
  });

  it("HISTORY_MAX_ENTRIES === 3 (décision Déthié S9.3.0)", () => {
    expect(__HISTORY_MAX_ENTRIES_FOR_TESTS).toBe(3);
  });

  it("REPLY_STOP_SUFFIX === ' STOP.' (identique au 1er SMS, règle 3 stop_present)", () => {
    // 🔒 Sentinelle format : espace + STOP + point, 6 chars. Verrouille
    // la cohérence avec `first-sms-generator.ts:259` (assemble du 1er SMS)
    // et avec `hasOptOut` dont le word boundary `\b` accepte ce format
    // (cf. `opt-out.test.ts:11,23` pour STOP suivi/précédé d'un point).
    expect(REPLY_STOP_SUFFIX).toBe(" STOP.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gardes d'entrée
// ─────────────────────────────────────────────────────────────────────────────

describe("reply-generator — gardes d'entrée", () => {
  beforeEach(() => {
    mockedGenerate.mockReset();
  });

  afterEach(() => {
    mockedGenerate.mockReset();
  });

  it("rawMessage vide → ValidationError (pas d'appel Claude)", async () => {
    await expect(
      generateReply({
        intent: "INTERESSE",
        rawMessage: "",
        history: [],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it("rawMessage non-string → ValidationError (pas d'appel Claude)", async () => {
    await expect(
      generateReply({
        intent: "INTERESSE",
        // @ts-expect-error volontaire : tester la garde runtime
        rawMessage: 42,
        history: [],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it("history.length > 3 → ValidationError (pas d'appel Claude)", async () => {
    await expect(
      generateReply({
        intent: "INTERESSE",
        rawMessage: "ok",
        history: [
          { direction: "outbound", body: "m1" },
          { direction: "inbound", body: "m2" },
          { direction: "outbound", body: "m3" },
          { direction: "inbound", body: "m4" },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it("history.length === 3 → OK (limite haute autorisée)", async () => {
    mockedGenerate.mockResolvedValueOnce(
      makeGenerateResult(
        "Bonjour Docteur, Médéré propose plusieurs cursus DPC. Quelle thématique ?",
      ),
    );

    await expect(
      generateReply({
        intent: "INTERESSE",
        rawMessage: "ok",
        history: [
          { direction: "outbound", body: "m1" },
          { direction: "inbound", body: "m2" },
          { direction: "outbound", body: "m3" },
        ],
      }),
    ).resolves.toBeDefined();
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch par intent
// ─────────────────────────────────────────────────────────────────────────────

describe("reply-generator — dispatch par intent", () => {
  beforeEach(() => {
    mockedGenerate.mockReset();
  });

  afterEach(() => {
    mockedGenerate.mockReset();
  });

  it("INTERESSE → system prompt contient l'objectif 'QUALIFIER'", async () => {
    mockedGenerate.mockResolvedValueOnce(
      makeGenerateResult(
        "Bonjour Docteur, ravi de votre intérêt pour Médéré. Quelle formation vise vous ?",
      ),
    );

    await generateReply({
      intent: "INTERESSE",
      rawMessage: "ça m'intéresse",
      history: [],
    });

    // 🔒 Sentinelle dispatch — le system passé à generate doit être celui
    // d'INTERESSE (contient l'objectif "QUALIFIER" spécifique à cet intent).
    const call = mockedGenerate.mock.calls[0]![0] as { system: string; user: string };
    expect(call.system).toContain("QUALIFIER");
    expect(call.user).toContain("ça m'intéresse");
  });

  it("OBJECTION → system prompt contient l'objectif 'ACCUSER RÉCEPTION'", async () => {
    mockedGenerate.mockResolvedValueOnce(
      makeGenerateResult(
        "Bonjour Docteur, je comprends. Chez Médéré, nos formations DPC sont prises en charge.",
      ),
    );

    await generateReply({
      intent: "OBJECTION",
      rawMessage: "Trop cher",
      history: [],
    });

    const call = mockedGenerate.mock.calls[0]![0] as { system: string; user: string };
    expect(call.system).toContain("ACCUSER RÉCEPTION");
    expect(call.user).toContain("Trop cher");
  });

  it("NEUTRE → system prompt contient l'objectif 'DÉSAMBIGUÏSER'", async () => {
    mockedGenerate.mockResolvedValueOnce(
      makeGenerateResult(
        "Bonjour Docteur, souhaitez-vous plus d'infos sur les formations Médéré ?",
      ),
    );

    await generateReply({
      intent: "NEUTRE",
      rawMessage: "OK je vais voir",
      history: [],
    });

    const call = mockedGenerate.mock.calls[0]![0] as { system: string; user: string };
    expect(call.system).toContain("DÉSAMBIGUÏSER");
    expect(call.user).toContain("OK je vais voir");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy paths — fixtures réalistes par intent
// ─────────────────────────────────────────────────────────────────────────────

describe("reply-generator — happy paths", () => {
  beforeEach(() => {
    mockedGenerate.mockReset();
  });

  afterEach(() => {
    mockedGenerate.mockReset();
  });

  it("INTERESSE happy path : body + tokens + promptVersion + duration cohérents", async () => {
    // 🔒 Sentinelle anti-PII fixture : "Dr Test" est un placeholder
    // évident, pas un vrai PS. Aucun vrai numéro / nom / email.
    const fixtureBody =
      "Bonjour Docteur, ravi de votre intérêt pour Médéré. Quelle formation vise vous en priorité ?";
    mockedGenerate.mockResolvedValueOnce(
      makeGenerateResult(fixtureBody, {
        usage: { inputTokens: 540, outputTokens: 38 },
      }),
    );

    const result = await generateReply({
      intent: "INTERESSE",
      rawMessage: "ça m'intéresse",
      history: [
        {
          direction: "outbound",
          body: "Bonjour Dr Test, je suis Léa, assistante virtuelle de Médéré.",
        },
      ],
      contactCivility: "Dr",
    });

    // Suffixe STOP concaténé en aval par `assembleReplyBody` (cf.
    // `reply-generator.ts`). La fixture ne contient PAS "STOP" → le body
    // final = fixture + " STOP.".
    expect(result.body).toBe(`${fixtureBody} STOP.`);
    expect(result.promptVersion).toBe("1.0.0");
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.temperature).toBe(0.5);
    expect(result.tokensInput).toBe(540);
    expect(result.tokensOutput).toBe(38);
    expect(result.generationDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("OBJECTION happy path : body + tokens + promptVersion cohérents", async () => {
    const fixtureBody =
      "Bonjour Docteur, je comprends votre objection. Chez Médéré, nos formations DPC sont prises en charge par l'ANDPC.";
    mockedGenerate.mockResolvedValueOnce(
      makeGenerateResult(fixtureBody, {
        usage: { inputTokens: 560, outputTokens: 42 },
      }),
    );

    const result = await generateReply({
      intent: "OBJECTION",
      rawMessage: "C'est cher !",
      history: [],
      contactCivility: "Docteur",
    });

    expect(result.body).toBe(`${fixtureBody} STOP.`);
    expect(result.promptVersion).toBe("1.0.0");
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.tokensInput).toBe(560);
    expect(result.tokensOutput).toBe(42);
  });

  it("NEUTRE happy path : body + tokens + promptVersion cohérents", async () => {
    const fixtureBody =
      "Bonjour Docteur, souhaitez-vous plus de précisions sur les formations Médéré DPC ?";
    mockedGenerate.mockResolvedValueOnce(
      makeGenerateResult(fixtureBody, {
        usage: { inputTokens: 480, outputTokens: 28 },
      }),
    );

    const result = await generateReply({
      intent: "NEUTRE",
      rawMessage: "OK",
      history: [],
    });

    expect(result.body).toBe(`${fixtureBody} STOP.`);
    expect(result.promptVersion).toBe("1.0.0");
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.tokensInput).toBe(480);
    expect(result.tokensOutput).toBe(28);
  });

  it("passe model, temperature, maxTokens fixés au wrapper generate", async () => {
    mockedGenerate.mockResolvedValueOnce(
      makeGenerateResult("Bonjour, formations Médéré disponibles. Une question ?"),
    );

    await generateReply({
      intent: "INTERESSE",
      rawMessage: "ok",
      history: [],
    });

    const call = mockedGenerate.mock.calls[0]![0] as {
      model: string;
      temperature: number;
      maxTokens: number;
    };
    expect(call.model).toBe("claude-sonnet-4-6");
    expect(call.temperature).toBe(0.5);
    expect(call.maxTokens).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Triple garde Médéré — defense-in-depth post-génération
// ─────────────────────────────────────────────────────────────────────────────

describe("reply-generator — triple garde Médéré", () => {
  beforeEach(() => {
    mockedGenerate.mockReset();
  });

  afterEach(() => {
    mockedGenerate.mockReset();
  });

  it("body SANS 'Médéré' → ExternalServiceError (retry-friendly)", async () => {
    // 🔒 Sentinelle compliance L.34-5 al. 5 CPCE — si le LLM oublie
    // d'inclure "Médéré", on REJETTE pour forcer la re-génération via
    // retry Inngest. Sanction CNIL SOLOCAL 900k€ (2025) si on laisse
    // passer.
    mockedGenerate.mockResolvedValueOnce(
      makeGenerateResult("Bonjour Docteur, quelle formation vous intéresse ?"),
    );

    await expect(
      generateReply({
        intent: "INTERESSE",
        rawMessage: "ok",
        history: [],
      }),
    ).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("body avec 'Medere' sans accent → accepté (pattern tolère accents libres)", async () => {
    // Le pattern GUARD-003 ADVERTISER_PATTERN tolère "Medere" (encodage
    // GSM-7 strip parfois les accents). Cf. advertiser-identification.ts:86.
    mockedGenerate.mockResolvedValueOnce(
      makeGenerateResult("Bonjour Docteur, formations Medere DPC. Quelle thematique ?"),
    );

    await expect(
      generateReply({
        intent: "INTERESSE",
        rawMessage: "ok",
        history: [],
      }),
    ).resolves.toBeDefined();
  });

  it("ExternalServiceError context contient intent + bodyLength + model + promptVersion (PAS le body brut)", async () => {
    // 🔒 Sentinelle anti-fuite PII : le body LLM peut contenir des
    // fragments PII miroirés du message PS. On NE doit JAMAIS exposer
    // result.text dans le context d'erreur — seulement bodyLength.
    const llmBody = "Bonjour Dr 0612345678 votre numéro est noté"; // (fictif, pas de Médéré)
    mockedGenerate.mockResolvedValueOnce(makeGenerateResult(llmBody));

    try {
      await generateReply({
        intent: "OBJECTION",
        rawMessage: "ok",
        history: [],
      });
      throw new Error("Should have thrown ExternalServiceError");
    } catch (err) {
      expect(err).toBeInstanceOf(ExternalServiceError);
      const ctx = (err as ExternalServiceError).context;
      expect(ctx).toBeDefined();
      expect(ctx!.intent).toBe("OBJECTION");
      expect(ctx!.bodyLength).toBe(llmBody.length);
      expect(ctx!.model).toBe("claude-sonnet-4-6");
      expect(ctx!.promptVersion).toBe("1.0.0");
      // Le body brut NE doit pas être présent.
      expect(JSON.stringify(ctx)).not.toContain(llmBody);
      // Et surtout pas le numéro PII fictif.
      expect(JSON.stringify(ctx)).not.toContain("0612345678");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Propagation erreurs SDK — pas de fallback artificiel
// ─────────────────────────────────────────────────────────────────────────────

describe("reply-generator — propagation erreurs SDK", () => {
  beforeEach(() => {
    mockedGenerate.mockReset();
  });

  afterEach(() => {
    mockedGenerate.mockReset();
  });

  it("ExternalServiceError SDK (timeout/5xx) → propagée telle quelle (retry naturel Inngest)", async () => {
    // 🔒 Sentinelle "pas de fallback artificiel" (décision S9.3.0) —
    // Inngest doit voir l'ExternalServiceError pour retry. Si on
    // absorbe et qu'on retourne un fallback safe, on perdrait la
    // visibilité observabilité (Sentry warn).
    const sdkErr = new ExternalServiceError({
      message: "Anthropic API connection failure",
      context: { kind: "APIConnectionError" },
    });
    mockedGenerate.mockRejectedValueOnce(sdkErr);

    await expect(
      generateReply({
        intent: "INTERESSE",
        rawMessage: "ok",
        history: [],
      }),
    ).rejects.toBe(sdkErr);
  });

  it("ConfigError SDK (auth/model not found) → propagée telle quelle (Inngest NonRetriableError)", async () => {
    // ConfigError.noRetry === true → Inngest la mappera en
    // NonRetriableError automatiquement → pas de retry inutile sur clé
    // morte ou snapshot déprécié.
    const cfgErr = new ConfigError({
      message: "Anthropic API auth/permission denied",
      context: { status: 401 },
    });
    mockedGenerate.mockRejectedValueOnce(cfgErr);

    await expect(
      generateReply({
        intent: "NEUTRE",
        rawMessage: "ok",
        history: [],
      }),
    ).rejects.toBe(cfgErr);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assembleReplyBody — unit tests du helper pur (règle 3 stop_present)
// ─────────────────────────────────────────────────────────────────────────────

describe("assembleReplyBody — suffixe STOP idempotent et pur", () => {
  it("texte sans STOP → ajout du suffixe ' STOP.'", () => {
    const text = "Bonjour Docteur, formations Médéré. Une question ?";
    const result = assembleReplyBody(text);
    expect(result).toBe(`${text} STOP.`);
    expect(result).toMatch(/ STOP\.$/);
    expect(hasOptOut(result)).toBe(true);
  });

  it("texte contenant déjà STOP → renvoyé TEL QUEL (idempotence, pas de doublon)", () => {
    // 🔒 Garantit qu'on ne produit JAMAIS "STOP STOP." si Claude a dérivé
    // et écrit sa propre mention. hasOptOut matche, règle 3 satisfaite.
    const text = "Formations Médéré. Pour vous désinscrire STOP.";
    const result = assembleReplyBody(text);
    expect(result).toBe(text);
    expect(hasOptOut(result)).toBe(true);
  });

  it("texte avec 'STOPPER' sans STOP isolé → suffixe ' STOP.' ajouté", () => {
    // 🔒 Le word boundary `\b` de `hasOptOut` refuse "STOPPER" (cf.
    // `opt-out.test.ts:27-31`). Un body qui ne contient QUE "STOPPER"
    // n'a donc pas de STOP isolé et doit recevoir le suffixe en aval.
    const text = "Formations Médéré. Pour STOPPER votre abonnement, voir web.";
    const result = assembleReplyBody(text);
    expect(result).toBe(`${text} STOP.`);
    expect(hasOptOut(result)).toBe(true);
  });

  it("texte avec espaces en fin → trimEnd → un seul espace avant ' STOP.'", () => {
    const text = "Formations Médéré, une question ?   ";
    const result = assembleReplyBody(text);
    expect(result).toBe("Formations Médéré, une question ? STOP.");
    // Un seul espace entre le "?" et "STOP" — pas de double espace.
    expect(result).not.toMatch(/  STOP/);
    expect(result).toMatch(/\? STOP\.$/);
  });

  it("texte avec retour ligne en fin → trimEnd → un seul espace avant ' STOP.'", () => {
    const text = "Formations Médéré, une question ?\n\n";
    const result = assembleReplyBody(text);
    expect(result).toBe("Formations Médéré, une question ? STOP.");
    expect(result).not.toContain("\n");
    expect(result).toMatch(/\? STOP\.$/);
  });

  it("texte avec mix espaces + tab + retour ligne en fin → trimEnd exhaustif", () => {
    const text = "Formations Médéré.\t  \n";
    const result = assembleReplyBody(text);
    expect(result).toBe("Formations Médéré. STOP.");
    expect(result).toMatch(/\. STOP\.$/);
  });

  it("texte avec STOP minuscule → traité comme déjà opt-out (case-insensitive)", () => {
    // `hasOptOut` est case-insensitive (opt-out.ts:92 : `/\bSTOP\b/i`).
    // Si Claude écrit "stop" en minuscules, on NE double PAS la mention.
    const text = "Formations Médéré. Tapez stop pour vous désinscrire.";
    const result = assembleReplyBody(text);
    expect(result).toBe(text);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generateReply — suffixe STOP en sortie, par intent (règle 3 stop_present)
// ─────────────────────────────────────────────────────────────────────────────

describe("generateReply — ajout du suffixe STOP sur chaque intent", () => {
  beforeEach(() => {
    mockedGenerate.mockReset();
  });

  afterEach(() => {
    mockedGenerate.mockReset();
  });

  it("INTERESSE — SDK renvoie texte avec 'Médéré' sans STOP → body finit par ' STOP.' + hasOptOut true", async () => {
    // 🔒 Sentinelle bout-en-bout pipeline reply. Le SYSTEM du prompt
    // INTERESSE interdit à Claude d'écrire STOP (cf. prompt l.169). On
    // simule donc un retour conforme au prompt : avec "Médéré", sans STOP.
    // Le body final DOIT contenir STOP (ajouté par le code).
    const fixture = "Bonjour Docteur, ravi de votre intérêt pour Médéré. Quelle formation ?";
    mockedGenerate.mockResolvedValueOnce(makeGenerateResult(fixture));

    const result = await generateReply({
      intent: "INTERESSE",
      rawMessage: "ça m'intéresse",
      history: [],
    });

    expect(result.body).toMatch(/ STOP\.$/);
    expect(hasOptOut(result.body)).toBe(true);
    expect(result.body).toBe(`${fixture} STOP.`);
  });

  it("NEUTRE — SDK renvoie texte avec 'Médéré' sans STOP → body finit par ' STOP.' + hasOptOut true", async () => {
    const fixture = "Bonjour Docteur, souhaitez-vous plus d'infos sur Médéré ?";
    mockedGenerate.mockResolvedValueOnce(makeGenerateResult(fixture));

    const result = await generateReply({
      intent: "NEUTRE",
      rawMessage: "OK",
      history: [],
    });

    expect(result.body).toMatch(/ STOP\.$/);
    expect(hasOptOut(result.body)).toBe(true);
    expect(result.body).toBe(`${fixture} STOP.`);
  });

  it("OBJECTION — SDK renvoie texte avec 'Médéré' sans STOP → body finit par ' STOP.' + hasOptOut true", async () => {
    const fixture = "Bonjour Docteur, je comprends. Chez Médéré, DPC pris en charge.";
    mockedGenerate.mockResolvedValueOnce(makeGenerateResult(fixture));

    const result = await generateReply({
      intent: "OBJECTION",
      rawMessage: "Trop cher",
      history: [],
    });

    expect(result.body).toMatch(/ STOP\.$/);
    expect(hasOptOut(result.body)).toBe(true);
    expect(result.body).toBe(`${fixture} STOP.`);
  });

  it("SDK renvoie texte contenant déjà STOP → body strictement égal au texte (idempotence)", async () => {
    // Si Claude dérape et inclut sa propre mention STOP malgré l'interdit
    // du prompt, on NE double PAS — body === texte brut, règle 3 OK.
    const fixture = "Bonjour Docteur, formations Médéré. Pour vous désinscrire STOP au 38080.";
    mockedGenerate.mockResolvedValueOnce(makeGenerateResult(fixture));

    const result = await generateReply({
      intent: "INTERESSE",
      rawMessage: "ok",
      history: [],
    });

    expect(result.body).toBe(fixture);
    expect(hasOptOut(result.body)).toBe(true);
  });

  it("SDK renvoie texte avec 'STOPPER' sans STOP isolé → suffixe ajouté (word boundary)", async () => {
    const fixture = "Bonjour Docteur, formations Médéré. Pour STOPPER votre abonnement, web.";
    mockedGenerate.mockResolvedValueOnce(makeGenerateResult(fixture));

    const result = await generateReply({
      intent: "OBJECTION",
      rawMessage: "ok",
      history: [],
    });

    expect(result.body).toBe(`${fixture} STOP.`);
    expect(result.body).toMatch(/ STOP\.$/);
    expect(hasOptOut(result.body)).toBe(true);
  });

  it("SDK renvoie texte avec espaces/retour ligne en fin → un seul espace avant ' STOP.'", async () => {
    const fixture = "Bonjour Docteur, formations Médéré.\n  ";
    mockedGenerate.mockResolvedValueOnce(makeGenerateResult(fixture));

    const result = await generateReply({
      intent: "NEUTRE",
      rawMessage: "ok",
      history: [],
    });

    expect(result.body).toBe("Bonjour Docteur, formations Médéré. STOP.");
    expect(result.body).not.toMatch(/  STOP/);
    expect(result.body).not.toContain("\n");
    expect(hasOptOut(result.body)).toBe(true);
  });

  it("non-régression triple garde Médéré : SDK renvoie texte SANS 'Médéré' → ExternalServiceError (pas de STOP ajouté avant throw)", async () => {
    // 🔒 Sentinelle ordre des étapes : triple garde Médéré est évaluée
    // AVANT `assembleReplyBody`. Un body sans Médéré doit lever
    // l'exception existante — même ligne, même code, même context —
    // SANS que le suffixe STOP soit appliqué (preuve via bodyLength qui
    // reste la longueur brute du texte LLM, pas +6 pour " STOP.").
    const llmBody = "Bonjour Docteur, quelle formation vous intéresse ?";
    mockedGenerate.mockResolvedValueOnce(makeGenerateResult(llmBody));

    try {
      await generateReply({
        intent: "INTERESSE",
        rawMessage: "ok",
        history: [],
      });
      throw new Error("Should have thrown ExternalServiceError");
    } catch (err) {
      expect(err).toBeInstanceOf(ExternalServiceError);
      const ctx = (err as ExternalServiceError).context;
      expect(ctx).toBeDefined();
      // bodyLength = longueur brute, pas `+ 6` : prouve que l'ajout STOP
      // n'a pas eu lieu avant le throw.
      expect(ctx!.bodyLength).toBe(llmBody.length);
    }
  });
});
