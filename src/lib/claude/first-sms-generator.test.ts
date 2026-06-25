/**
 * Tests `first-sms-generator.ts` (S10.1.2.a).
 *
 * Pattern : mock `generateWithTool()` via `vi.mock("./client")` (cohérent
 * intent-classifier S7a.2 + reply-generator S9.3).
 *
 * Couverture :
 *   - Gardes d'entrée (firstName/lastName/speciality vides)
 *   - Happy path : body + tokens + promptVersion + durationMs cohérents
 *   - Triple-garde — 3 checks (hasAIDisclosure, hasOptOut, hasAdv) :
 *     - oubli AI Act → throw ExternalServiceError avec check="hasAIDisclosure"
 *     - oubli STOP   → throw avec check="hasOptOut"
 *     - oubli Médéré → throw avec check="hasAdvertiserIdentification"
 *   - Propagation erreurs SDK (RateLimit/Config/External/Internal)
 *   - Anti-fuite PII : firstName/lastName/body brut JAMAIS dans erreur
 *   - Sentinelles return values (promptVersion, model, temperature)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConfigError,
  ExternalServiceError,
  InternalError,
  RateLimitError,
  ValidationError,
} from "@/lib/utils/errors";

import type { FirstSmsToolInput } from "./prompts/first-sms";
import type { ToolUseResult } from "./types";

// ⚠️ vi.mock DOIT être déclaré AVANT l'import du module testé.
vi.mock("./client", () => ({
  generateWithTool: vi.fn(),
}));

// S10.1.14 : mock du logger pour assertions sur le retry path (logger.warn
// appelé entre tentatives). Pino n'écrit pas via console.* donc les autres
// sentinelles "Aucun log console.*" continuent à passer même avec ce mock.
vi.mock("@/lib/utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from "@/lib/utils/logger";

import { generateWithTool } from "./client";
import {
  FIRST_SMS_GENERATOR_OP,
  FIRST_SMS_MAX_ATTEMPTS,
  generateFirstSms,
  type GenerateFirstSmsArgs,
} from "./first-sms-generator";
import {
  FIRST_SMS_MAX_TOKENS,
  FIRST_SMS_MODEL,
  FIRST_SMS_PROMPT_VERSION,
  FIRST_SMS_TEMPERATURE,
  FIRST_SMS_TOOL,
} from "./prompts/first-sms";

const mockedGenerate = generateWithTool as unknown as ReturnType<typeof vi.fn>;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const VALID_CONTACT: GenerateFirstSmsArgs["contact"] = {
  firstName: "Marie",
  lastName: "Dupuis",
  civilite: "Dr",
  speciality: "Chirurgien-dentiste",
  city: "Paris",
};

/** Body conforme aux 3 marqueurs compliance (golden body S10.1.2.a.0). */
const CONFORMING_BODY =
  "Bonjour Dr Dupuis, je suis Léa, assistante virtuelle de Médéré. Formation DPC indemnisée jusqu'à 660€/an. Intéressée ? STOP pour arrêter.";

/** Body manquant l'annonce IA (AI Act art. 50 fail). */
const BODY_NO_AI =
  "Bonjour Dr Dupuis, agent de Médéré. Formation DPC indemnisée jusqu'à 660€/an. Intéressée ? STOP pour arrêter.";

/** Body manquant STOP (L.34-5 CPCE fail). */
const BODY_NO_STOP =
  "Bonjour Dr Dupuis, je suis Léa, assistante virtuelle de Médéré. Formation DPC indemnisée jusqu'à 660€/an. Intéressée ?";

/** Body manquant Médéré (L.34-5 al. 5 CPCE fail). */
const BODY_NO_ADVERTISER =
  "Bonjour Dr Dupuis, je suis Léa, assistante virtuelle. Formation DPC indemnisée jusqu'à 660€/an. Intéressée ? STOP pour arrêter.";

function makeToolUseResult(
  body: string = CONFORMING_BODY,
  reasoning: string = "Test reasoning court.",
  usageOverrides: Partial<{ inputTokens: number; outputTokens: number }> = {},
): ToolUseResult<FirstSmsToolInput> {
  return {
    toolInput: { body, reasoning },
    usage: {
      inputTokens: usageOverrides.inputTokens ?? 250,
      outputTokens: usageOverrides.outputTokens ?? 60,
    },
  };
}

beforeEach(() => {
  mockedGenerate.mockReset();
  vi.mocked(logger.warn).mockReset();
});

afterEach(() => {
  mockedGenerate.mockReset();
  vi.mocked(logger.warn).mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
// Gardes d'entrée
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFirstSms — gardes d'entrée", () => {
  it("firstName vide → ValidationError (pas d'appel Claude)", async () => {
    await expect(
      generateFirstSms({ contact: { ...VALID_CONTACT, firstName: "" } }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it("firstName whitespace-only → ValidationError", async () => {
    await expect(
      generateFirstSms({ contact: { ...VALID_CONTACT, firstName: "   " } }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it("lastName vide → ValidationError (pas d'appel Claude)", async () => {
    await expect(
      generateFirstSms({ contact: { ...VALID_CONTACT, lastName: "" } }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it("speciality vide → ValidationError", async () => {
    await expect(
      generateFirstSms({ contact: { ...VALID_CONTACT, speciality: "" } }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it("civilite undefined → OK (pas une garde, géré par builder)", async () => {
    mockedGenerate.mockResolvedValue(makeToolUseResult());
    await expect(
      generateFirstSms({ contact: { ...VALID_CONTACT, civilite: undefined } }),
    ).resolves.toBeDefined();
  });

  it("city vide → OK (pas une garde, géré par builder)", async () => {
    mockedGenerate.mockResolvedValue(makeToolUseResult());
    await expect(
      generateFirstSms({ contact: { ...VALID_CONTACT, city: "" } }),
    ).resolves.toBeDefined();
  });

  it("ValidationError contient le field name (forensic) MAIS PAS la valeur PII", async () => {
    const SECRET_NAME = "Marie-PII-DO-NOT-LOG-9999";
    try {
      await generateFirstSms({ contact: { ...VALID_CONTACT, firstName: "" } });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      const ctx = (e as ValidationError).context;
      expect(ctx).toMatchObject({ field: "firstName", op: FIRST_SMS_GENERATOR_OP });
      expect(JSON.stringify(ctx)).not.toContain(SECRET_NAME);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFirstSms — happy path", () => {
  it("body conforme → retourne body + reasoning + metadata", async () => {
    mockedGenerate.mockResolvedValue(makeToolUseResult());

    const result = await generateFirstSms({ contact: VALID_CONTACT });

    expect(result.body).toBe(CONFORMING_BODY);
    expect(result.reasoning).toBe("Test reasoning court.");
    expect(result.promptVersion).toBe(FIRST_SMS_PROMPT_VERSION);
    expect(result.model).toBe(FIRST_SMS_MODEL);
    expect(result.temperature).toBe(FIRST_SMS_TEMPERATURE);
    expect(result.tokensInput).toBe(250);
    expect(result.tokensOutput).toBe(60);
    expect(result.generationDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("appelle generateWithTool avec MODEL + TEMPERATURE + MAX_TOKENS + TOOL", async () => {
    mockedGenerate.mockResolvedValue(makeToolUseResult());
    await generateFirstSms({ contact: VALID_CONTACT });

    expect(mockedGenerate).toHaveBeenCalledTimes(1);
    expect(mockedGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: FIRST_SMS_MODEL,
        temperature: FIRST_SMS_TEMPERATURE,
        maxTokens: FIRST_SMS_MAX_TOKENS,
        tool: FIRST_SMS_TOOL,
      }),
    );
  });

  it("appelle generateWithTool avec system + user prompts non vides", async () => {
    mockedGenerate.mockResolvedValue(makeToolUseResult());
    await generateFirstSms({ contact: VALID_CONTACT });

    const callArgs = mockedGenerate.mock.calls[0]?.[0] as {
      system: string;
      user: string;
    };
    expect(callArgs.system).toContain("<role>");
    expect(callArgs.system).toContain("Médéré");
    expect(callArgs.user).toContain("<destinataire>");
    expect(callArgs.user).toContain("Marie"); // firstName non-malicieux ok
  });

  it("metadata : tokens variés sont propagés correctement", async () => {
    mockedGenerate.mockResolvedValue(
      makeToolUseResult(CONFORMING_BODY, "ok", {
        inputTokens: 1234,
        outputTokens: 89,
      }),
    );

    const result = await generateFirstSms({ contact: VALID_CONTACT });
    expect(result.tokensInput).toBe(1234);
    expect(result.tokensOutput).toBe(89);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Triple-garde post-gen — les 3 checks compliance-critical
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFirstSms — triple-garde hasAIDisclosure (AI Act art. 50)", () => {
  it("body sans annonce IA → ExternalServiceError check='hasAIDisclosure'", async () => {
    mockedGenerate.mockResolvedValue(makeToolUseResult(BODY_NO_AI));

    await expect(generateFirstSms({ contact: VALID_CONTACT })).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
  });

  it("ExternalServiceError context.check === 'hasAIDisclosure'", async () => {
    mockedGenerate.mockResolvedValue(makeToolUseResult(BODY_NO_AI));

    try {
      await generateFirstSms({ contact: VALID_CONTACT });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExternalServiceError);
      const ctx = (e as ExternalServiceError).context as { check: string };
      expect(ctx.check).toBe("hasAIDisclosure");
    }
  });

  it("ExternalServiceError mentionne 'AI Act' dans message (retry hint)", async () => {
    mockedGenerate.mockResolvedValue(makeToolUseResult(BODY_NO_AI));
    try {
      await generateFirstSms({ contact: VALID_CONTACT });
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("AI Act");
      expect((e as Error).message).toContain("triple-garde");
      expect((e as Error).message).toContain("retry");
    }
  });
});

describe("generateFirstSms — triple-garde hasOptOut (L.34-5 CPCE)", () => {
  it("body sans STOP → ExternalServiceError check='hasOptOut'", async () => {
    mockedGenerate.mockResolvedValue(makeToolUseResult(BODY_NO_STOP));

    try {
      await generateFirstSms({ contact: VALID_CONTACT });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExternalServiceError);
      const ctx = (e as ExternalServiceError).context as { check: string };
      expect(ctx.check).toBe("hasOptOut");
    }
  });

  it("ExternalServiceError mentionne 'STOP opt-out' + 'L.34-5 CPCE'", async () => {
    mockedGenerate.mockResolvedValue(makeToolUseResult(BODY_NO_STOP));
    try {
      await generateFirstSms({ contact: VALID_CONTACT });
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("STOP");
      expect((e as Error).message).toContain("L.34-5 CPCE");
    }
  });
});

describe("generateFirstSms — triple-garde hasAdvertiserIdentification (L.34-5 al. 5 CPCE)", () => {
  it("body sans 'Médéré' → ExternalServiceError check='hasAdvertiserIdentification'", async () => {
    mockedGenerate.mockResolvedValue(makeToolUseResult(BODY_NO_ADVERTISER));

    try {
      await generateFirstSms({ contact: VALID_CONTACT });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExternalServiceError);
      const ctx = (e as ExternalServiceError).context as { check: string };
      expect(ctx.check).toBe("hasAdvertiserIdentification");
    }
  });

  it("ExternalServiceError mentionne 'Médéré' + 'L.34-5 al. 5 CPCE'", async () => {
    mockedGenerate.mockResolvedValue(makeToolUseResult(BODY_NO_ADVERTISER));
    try {
      await generateFirstSms({ contact: VALID_CONTACT });
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("Médéré");
      expect((e as Error).message).toContain("L.34-5 al. 5 CPCE");
    }
  });
});

describe("generateFirstSms — triple-garde court-circuite (ordre exact verrouillé)", () => {
  it("body manque les 3 marqueurs → fail au 1er check (hasAIDisclosure)", async () => {
    const ALL_MISSING = "Bonjour Dr Test. Une formation pour vous.";
    mockedGenerate.mockResolvedValue(makeToolUseResult(ALL_MISSING));

    try {
      await generateFirstSms({ contact: VALID_CONTACT });
      expect.fail("should have thrown");
    } catch (e) {
      const ctx = (e as ExternalServiceError).context as { check: string };
      // L'ordre est hasAI → hasOptOut → hasAdv. Premier qui fail throw.
      expect(ctx.check).toBe("hasAIDisclosure");
    }
  });

  it("body a AI mais manque STOP + Médéré → fail au 2e check (hasOptOut)", async () => {
    // Sentinelle ordre : si refactor inverse hasOptOut/hasAdvertiser,
    // ce test détecte le drift (fail attendu sur hasOptOut, pas hasAdv).
    const NO_STOP_NO_ADV =
      "Bonjour Dr Test, je suis Léa, assistante virtuelle. Une formation utile vous attend bientôt.";
    mockedGenerate.mockResolvedValue(makeToolUseResult(NO_STOP_NO_ADV));

    try {
      await generateFirstSms({ contact: VALID_CONTACT });
      expect.fail("should have thrown");
    } catch (e) {
      const ctx = (e as ExternalServiceError).context as { check: string };
      expect(ctx.check).toBe("hasOptOut");
    }
  });

  it("body a AI + STOP mais manque Médéré → fail au 3e check (hasAdv)", async () => {
    // Sentinelle ordre : verrouille que hasAdvertiserIdentification est le
    // DERNIER check (pas le 2e ou 1er).
    const NO_ADV =
      "Bonjour Dr Test, je suis Léa, assistante virtuelle. Formation DPC indemnisée 660€/an. STOP.";
    mockedGenerate.mockResolvedValue(makeToolUseResult(NO_ADV));

    try {
      await generateFirstSms({ contact: VALID_CONTACT });
      expect.fail("should have thrown");
    } catch (e) {
      const ctx = (e as ExternalServiceError).context as { check: string };
      expect(ctx.check).toBe("hasAdvertiserIdentification");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Propagation erreurs SDK Claude
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFirstSms — propagation erreurs SDK", () => {
  it("RateLimitError SDK → propagée telle quelle (Inngest retry)", async () => {
    mockedGenerate.mockRejectedValue(
      new RateLimitError({
        message: "Anthropic 429",
        context: { status: 429 },
      }),
    );
    await expect(generateFirstSms({ contact: VALID_CONTACT })).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });

  it("ConfigError SDK → propagée telle quelle (NonRetriable)", async () => {
    mockedGenerate.mockRejectedValue(
      new ConfigError({
        message: "Anthropic 401",
        context: { status: 401 },
      }),
    );
    await expect(generateFirstSms({ contact: VALID_CONTACT })).rejects.toBeInstanceOf(ConfigError);
  });

  it("ExternalServiceError SDK (timeout/5xx) → propagée telle quelle", async () => {
    mockedGenerate.mockRejectedValue(
      new ExternalServiceError({
        message: "Anthropic 500",
        context: { status: 500 },
      }),
    );
    await expect(generateFirstSms({ contact: VALID_CONTACT })).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
  });

  it("InternalError SDK → propagée telle quelle", async () => {
    mockedGenerate.mockRejectedValue(
      new InternalError({
        message: "Unexpected",
        context: {},
      }),
    );
    await expect(generateFirstSms({ contact: VALID_CONTACT })).rejects.toBeInstanceOf(
      InternalError,
    );
  });

  it("Zod re-validation fail (body > 160) sur 2 attempts → ExternalServiceError final propagée (retry exhausted)", async () => {
    // S10.1.14 : un seul fail Zod too_big déclencherait un retry naïf
    // (cf. section "retry on Zod too_big" plus bas). Pour atteindre le
    // throw final, il faut que les FIRST_SMS_MAX_ATTEMPTS (2) attempts
    // throwent. `mockRejectedValue` (vs `mockRejectedValueOnce`) couvre
    // toutes les invocations successives → retry exhausted → throw.
    mockedGenerate.mockRejectedValue(
      new ExternalServiceError({
        message: "Anthropic tool_use payload failed Zod validation",
        context: { issues: [{ path: "body", code: "too_big" }] },
      }),
    );
    await expect(generateFirstSms({ contact: VALID_CONTACT })).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
    // Vérification : les 2 attempts ont bien été tentés avant le throw final.
    expect(mockedGenerate).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Anti-fuite PII (sentinelles CRITIQUES)
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFirstSms — anti-fuite PII (sentinelles)", () => {
  it("ExternalServiceError triple-garde NE CONTIENT JAMAIS le body brut", async () => {
    const SECRET_BODY = "Bonjour Dr SECRETNAME99, je suis assistant. Formation. STOP.";
    // Body manque "Médéré" → triple-garde tripped.
    mockedGenerate.mockResolvedValue(makeToolUseResult(SECRET_BODY));

    try {
      await generateFirstSms({ contact: VALID_CONTACT });
      expect.fail("should have thrown");
    } catch (e) {
      const ext = e as ExternalServiceError;
      const serialized = JSON.stringify({
        message: ext.message,
        context: ext.context,
      });
      expect(serialized).not.toContain("SECRETNAME99");
      expect(serialized).not.toContain(SECRET_BODY);
    }
  });

  it("ExternalServiceError context contient bodyLength (pas body)", async () => {
    mockedGenerate.mockResolvedValue(makeToolUseResult(BODY_NO_AI));
    try {
      await generateFirstSms({ contact: VALID_CONTACT });
      expect.fail("should have thrown");
    } catch (e) {
      const ctx = (e as ExternalServiceError).context as {
        bodyLength: number;
      };
      expect(ctx.bodyLength).toBe(BODY_NO_AI.length);
      expect(ctx).not.toHaveProperty("body");
      expect(ctx).not.toHaveProperty("reasoning");
    }
  });

  it("ValidationError firstName vide NE CONTIENT JAMAIS contact brut", async () => {
    const SECRET_LASTNAME = "Dupuis-PII-SECRET-XYZ";
    try {
      await generateFirstSms({
        contact: { ...VALID_CONTACT, firstName: "", lastName: SECRET_LASTNAME },
      });
      expect.fail("should have thrown");
    } catch (e) {
      const ctx = (e as ValidationError).context;
      expect(JSON.stringify(ctx)).not.toContain(SECRET_LASTNAME);
    }
  });

  it("Aucun log appelé pendant le pipeline (zero PII surface)", async () => {
    // Sentinelle : si on ajoute un logger.* dans generateFirstSms,
    // ce test devra être adapté (et passer par le scrubber Pino).
    // En attendant, on vérifie qu'aucun appel console.* n'est fait.
    const consoleSpy = vi.spyOn(console, "log");
    const errSpy = vi.spyOn(console, "error");
    mockedGenerate.mockResolvedValue(makeToolUseResult());

    await generateFirstSms({ contact: VALID_CONTACT });

    expect(consoleSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
    errSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S10.1.14 — retry naïf sur fluctuation Zod (too_big/too_small/invalid_*)
// ─────────────────────────────────────────────────────────────────────────────
// Contexte : Claude Sonnet 4.6 avec temp=0.3 dépasse parfois la limite Zod
// `body.max(160)` malgré 3 contraintes dans le prompt SYSTEM. Cas vulnérables :
// noms longs, spécialités longues, villes longues. 1 retry naïf (re-roll
// dice avec même prompt) résout ~75% des transitoires en pratique.
//
// Comportement vérifié :
//   - Erreur Zod éligible (too_big/too_small/invalid_value/invalid_type)
//     + attempt < MAX → retry + log warn
//   - Erreur non-éligible (ConfigError, RateLimitError, InternalError,
//     ExternalServiceError sans issues Zod) → propagation directe, pas de retry
//   - Retry exhausted → propage l'erreur du dernier attempt
//   - logger.warn appelé EXACTEMENT 1 fois par retry (anti-spam log)
//   - Zéro PII dans le log warn (juste op + attempt + issues path/code)

function makeZodTooBigError(): ExternalServiceError {
  return new ExternalServiceError({
    message: "Anthropic tool_use payload failed Zod validation",
    context: {
      op: "generateWithTool",
      tool: "first_sms_generator",
      issues: [{ path: "body", code: "too_big" }],
    },
  });
}

describe("generateFirstSms — retry on Zod too_big (S10.1.14)", () => {
  it("FIRST_SMS_MAX_ATTEMPTS === 2 (sentinelle constante)", () => {
    expect(FIRST_SMS_MAX_ATTEMPTS).toBe(2);
  });

  it("retry-then-success : 1er attempt Zod too_big, 2e success → resolve avec body du 2e", async () => {
    const SECOND_BODY =
      "Bonjour Dr Dupuis, je suis Léa, assistante virtuelle de Médéré. Court SMS ok. STOP pour arrêter.";
    mockedGenerate
      .mockRejectedValueOnce(makeZodTooBigError())
      .mockResolvedValueOnce(makeToolUseResult(SECOND_BODY));

    const result = await generateFirstSms({ contact: VALID_CONTACT });

    expect(result.body).toBe(SECOND_BODY);
    expect(mockedGenerate).toHaveBeenCalledTimes(2);
    // Log warn appelé EXACTEMENT 1 fois (entre les 2 attempts), pas 2.
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("retry-then-fail : les 2 attempts Zod too_big → throw l'erreur du 2e attempt", async () => {
    const FIRST_ERR = makeZodTooBigError();
    const SECOND_ERR = makeZodTooBigError();
    mockedGenerate.mockRejectedValueOnce(FIRST_ERR).mockRejectedValueOnce(SECOND_ERR);

    let thrown: unknown;
    try {
      await generateFirstSms({ contact: VALID_CONTACT });
      expect.fail("should have thrown");
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBe(SECOND_ERR); // identity check — le 2e attempt propagé
    expect(mockedGenerate).toHaveBeenCalledTimes(2);
    // Log warn appelé EXACTEMENT 1 fois (avant le 2e attempt) — pas avant
    // le throw final (le 2e attempt fail n'a plus de retry disponible).
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("non-retry-eligible ConfigError → PAS de retry, throw direct (1 seul appel)", async () => {
    mockedGenerate.mockRejectedValueOnce(
      new ConfigError({ message: "400 bad request", context: {} }),
    );
    await expect(generateFirstSms({ contact: VALID_CONTACT })).rejects.toBeInstanceOf(ConfigError);
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("non-retry-eligible RateLimitError → PAS de retry (le caller Upstash gère)", async () => {
    mockedGenerate.mockRejectedValueOnce(
      new RateLimitError({ message: "429 too many requests", context: {} }),
    );
    await expect(generateFirstSms({ contact: VALID_CONTACT })).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("non-retry-eligible InternalError → PAS de retry, throw direct", async () => {
    mockedGenerate.mockRejectedValueOnce(new InternalError({ message: "unexpected", context: {} }));
    await expect(generateFirstSms({ contact: VALID_CONTACT })).rejects.toBeInstanceOf(
      InternalError,
    );
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("ExternalServiceError SANS issues Zod (network/5xx) → PAS de retry", async () => {
    // Cas typique : timeout réseau, 5xx Anthropic — wrapper mappe en
    // ExternalServiceError mais SANS `context.issues` (qui n'est posé que
    // par le code path Zod validation client.ts:362-379).
    mockedGenerate.mockRejectedValueOnce(
      new ExternalServiceError({
        message: "Anthropic timeout after 30s",
        context: { op: "generateWithTool", timeoutMs: 30000 },
      }),
    );
    await expect(generateFirstSms({ contact: VALID_CONTACT })).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("autres codes Zod éligibles (too_small/invalid_value/invalid_type) déclenchent aussi le retry", async () => {
    const codes = ["too_small", "invalid_value", "invalid_type"] as const;
    for (const code of codes) {
      mockedGenerate.mockReset();
      vi.mocked(logger.warn).mockReset();
      mockedGenerate
        .mockRejectedValueOnce(
          new ExternalServiceError({
            message: `Anthropic tool_use payload failed Zod validation (${code})`,
            context: { op: "generateWithTool", issues: [{ path: "body", code }] },
          }),
        )
        .mockResolvedValueOnce(makeToolUseResult());

      await expect(generateFirstSms({ contact: VALID_CONTACT })).resolves.toBeDefined();
      expect(mockedGenerate).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    }
  });

  it("ExternalServiceError avec code Zod NON-éligible → PAS de retry", async () => {
    // Ex: `custom` (issue Zod custom side-validators). Pas dans la whitelist
    // RETRY_ELIGIBLE_ZOD_CODES → propagation directe.
    mockedGenerate.mockRejectedValueOnce(
      new ExternalServiceError({
        message: "Custom Zod validation failure",
        context: {
          op: "generateWithTool",
          issues: [{ path: "reasoning", code: "custom" }],
        },
      }),
    );
    await expect(generateFirstSms({ contact: VALID_CONTACT })).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("log warn ne contient PAS de body ni de PII (zéro fuite télémétrie retry)", async () => {
    // Body conforme triple-garde (3 marqueurs : "je suis Léa" pour AI, Médéré
    // pour advertiser, STOP pour opt-out) avec marker secret SECRETNAME_NEVER_LOG
    // pour détecter une fuite éventuelle dans le log warn du retry.
    const FAKE_BODY =
      "Bonjour Dr SECRETNAME_NEVER_LOG, je suis Léa de Médéré. Formation 660€. STOP pour arrêter.";
    mockedGenerate
      .mockRejectedValueOnce(makeZodTooBigError())
      .mockResolvedValueOnce(makeToolUseResult(FAKE_BODY));

    await generateFirstSms({ contact: VALID_CONTACT });

    // Vérifie que TOUS les arguments passés à logger.warn sont PII-safe.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const firstCall = vi.mocked(logger.warn).mock.calls[0];
    const serialized = JSON.stringify(firstCall);
    expect(serialized).not.toContain("SECRETNAME_NEVER_LOG");
    expect(serialized).not.toContain(FAKE_BODY);
    // PII contact tests :
    expect(serialized).not.toContain(VALID_CONTACT.firstName);
    expect(serialized).not.toContain(VALID_CONTACT.lastName);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sentinelles return values
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFirstSms — sentinelles return values", () => {
  it("FIRST_SMS_GENERATOR_OP === 'first_sms.generate'", () => {
    expect(FIRST_SMS_GENERATOR_OP).toBe("first_sms.generate");
  });

  it("promptVersion retourné === FIRST_SMS_PROMPT_VERSION (audit forensic)", async () => {
    mockedGenerate.mockResolvedValue(makeToolUseResult());
    const result = await generateFirstSms({ contact: VALID_CONTACT });
    expect(result.promptVersion).toBe("1.0.1");
  });

  it("model retourné === FIRST_SMS_MODEL", async () => {
    mockedGenerate.mockResolvedValue(makeToolUseResult());
    const result = await generateFirstSms({ contact: VALID_CONTACT });
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  it("temperature retourné === FIRST_SMS_TEMPERATURE (0.3)", async () => {
    mockedGenerate.mockResolvedValue(makeToolUseResult());
    const result = await generateFirstSms({ contact: VALID_CONTACT });
    expect(result.temperature).toBe(0.3);
  });
});
