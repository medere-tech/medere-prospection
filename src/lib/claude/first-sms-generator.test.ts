/**
 * Tests `first-sms-generator.ts` (S10.1.2.a + v2.0.0 S10.1.14).
 *
 * Pattern : mock `generateWithTool()` via `vi.mock("./client")` (cohérent
 * intent-classifier S7a.2 + reply-generator S9.3).
 *
 * Couverture v2.0.0 :
 *   - Gardes d'entrée (firstName/lastName/speciality vides)
 *   - Happy path : body ASSEMBLÉ + tokens + promptVersion + durationMs
 *   - assembleFirstSms isolé : structure préfixe/suffixe + garde-fou ≤ 160
 *   - Sentinelle fuzz ~50 cas worst-case réels (nom long, civilité, accroche)
 *   - Triple-garde post-gen par construction (passe TOUJOURS en v2)
 *   - Propagation erreurs SDK (RateLimit/Config/External/Internal)
 *   - Anti-fuite PII : firstName/lastName/body brut JAMAIS dans erreur
 *   - Sentinelles return values (promptVersion 2.0.0, model, temperature)
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

import { generateWithTool } from "./client";
import {
  ASSEMBLE_FIRST_SMS_OP,
  assembleFirstSms,
  FIRST_SMS_GENERATOR_OP,
  generateFirstSms,
  type GenerateFirstSmsArgs,
} from "./first-sms-generator";
import {
  FIRST_SMS_MAX_ACCROCHE_CHARS,
  FIRST_SMS_MAX_BODY_CHARS,
  FIRST_SMS_MAX_TOKENS,
  FIRST_SMS_MIN_ACCROCHE_CHARS,
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

/**
 * Accroche conforme v2.0.1 (30-50 chars). Le SMS final est assemblé en
 * code-side avec préfixe restauré "assistante virtuelle" (AI Act explicite).
 * Combinée à VALID_CONTACT (Dr Dupuis), donne un body assemblé de
 * `"Bonjour Dr Dupuis, je suis Léa, assistante virtuelle de Médéré. {ACCROCHE} STOP."`
 * = 71 + 45 = 116 chars (largement ≤ 160).
 */
const CONFORMING_ACCROCHE = "DPC 660€/an indemnisée. Cela vous intéresse ?"; // 45 chars

/**
 * Body que `assembleFirstSms()` retourne pour VALID_CONTACT + CONFORMING_ACCROCHE.
 * Sentinelle des 3 marqueurs compliance (Léa + assistante virtuelle + Médéré
 * + STOP) par construction.
 */
const EXPECTED_ASSEMBLED_BODY =
  "Bonjour Dr Dupuis, je suis Léa, assistante virtuelle de Médéré. DPC 660€/an indemnisée. Cela vous intéresse ? STOP.";

function makeToolUseResult(
  accroche: string = CONFORMING_ACCROCHE,
  reasoning: string = "Test reasoning court.",
  usageOverrides: Partial<{ inputTokens: number; outputTokens: number }> = {},
): ToolUseResult<FirstSmsToolInput> {
  return {
    toolInput: { accroche, reasoning },
    usage: {
      inputTokens: usageOverrides.inputTokens ?? 250,
      outputTokens: usageOverrides.outputTokens ?? 60,
    },
  };
}

beforeEach(() => {
  mockedGenerate.mockReset();
});

afterEach(() => {
  mockedGenerate.mockReset();
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

  it("civilite undefined → OK, assemble utilise prénom seul", async () => {
    mockedGenerate.mockResolvedValue(makeToolUseResult());
    const result = await generateFirstSms({
      contact: { ...VALID_CONTACT, civilite: undefined },
    });
    expect(result.body).toBe(
      "Bonjour Marie, je suis Léa, assistante virtuelle de Médéré. DPC 660€/an indemnisée. Cela vous intéresse ? STOP.",
    );
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
// Happy path v2.0.0
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFirstSms — happy path v2.0.0 (body assemblé)", () => {
  it("accroche conforme → body ASSEMBLÉ + reasoning + metadata", async () => {
    mockedGenerate.mockResolvedValue(makeToolUseResult());

    const result = await generateFirstSms({ contact: VALID_CONTACT });

    expect(result.body).toBe(EXPECTED_ASSEMBLED_BODY);
    expect(result.reasoning).toBe("Test reasoning court.");
    expect(result.promptVersion).toBe(FIRST_SMS_PROMPT_VERSION);
    expect(result.model).toBe(FIRST_SMS_MODEL);
    expect(result.temperature).toBe(FIRST_SMS_TEMPERATURE);
    expect(result.tokensInput).toBe(250);
    expect(result.tokensOutput).toBe(60);
    expect(result.generationDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("body assemblé contient les 3 marqueurs compliance par construction", async () => {
    mockedGenerate.mockResolvedValue(makeToolUseResult());
    const { body } = await generateFirstSms({ contact: VALID_CONTACT });
    expect(body).toContain("je suis Léa");
    expect(body).toContain("Médéré");
    expect(/\bSTOP\b/.test(body)).toBe(true);
  });

  // 🚨 v2.0.1 SENTINELLE ANTI-RÉGRESSION AI Act art. 50 (CRITIQUE)
  // La formulation v2.0.0 "je suis Léa de Médéré." était AMBIGUË — un PS
  // pouvait croire Léa humaine. Régression détectée smoke test Déthié,
  // restaurée v2.0.1 avec "assistante virtuelle" littéralement.
  // Si quelqu'un retire cette sous-chaîne du préfixe assemblé dans un
  // refactor futur (économie chars, simplification), ce test ÉCHOUE
  // clairement avec un message d'erreur explicite.
  it("body assemblé contient LITTÉRALEMENT 'assistante virtuelle' (anti-régression AI Act v2.0.1)", () => {
    const result = assembleFirstSms({
      civilite: "Dr",
      lastName: "Test",
      firstName: "Jean",
      accroche: "X".repeat(30),
    });
    expect(result).toContain("assistante virtuelle");
  });

  it("body assemblé ≤ FIRST_SMS_MAX_BODY_CHARS (≤ 160)", async () => {
    mockedGenerate.mockResolvedValue(makeToolUseResult());
    const { body } = await generateFirstSms({ contact: VALID_CONTACT });
    expect(body.length).toBeLessThanOrEqual(FIRST_SMS_MAX_BODY_CHARS);
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

  it("metadata : tokens variés sont propagés correctement", async () => {
    mockedGenerate.mockResolvedValue(
      makeToolUseResult(CONFORMING_ACCROCHE, "Reasoning", {
        inputTokens: 503,
        outputTokens: 47,
      }),
    );
    const result = await generateFirstSms({ contact: VALID_CONTACT });
    expect(result.tokensInput).toBe(503);
    expect(result.tokensOutput).toBe(47);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assembleFirstSms — helper isolé (v2.0.0 S10.1.14)
// ─────────────────────────────────────────────────────────────────────────────

describe("assembleFirstSms — structure préfixe/suffixe v2.0.1", () => {
  it("civilité présente → 'Bonjour {civilité} {nom}, je suis Léa, assistante virtuelle de Médéré. {accroche} STOP.'", () => {
    const body = assembleFirstSms({
      civilite: "Dr",
      lastName: "Dupuis",
      firstName: "Marie",
      accroche: "DPC 660€/an. Cela vous intéresse ?",
    });
    expect(body).toBe(
      "Bonjour Dr Dupuis, je suis Léa, assistante virtuelle de Médéré. DPC 660€/an. Cela vous intéresse ? STOP.",
    );
  });

  it("civilité undefined → 'Bonjour {prénom}, je suis Léa, assistante virtuelle de Médéré. ...'", () => {
    const body = assembleFirstSms({
      civilite: undefined,
      lastName: "Bernard",
      firstName: "Sophie",
      accroche: "DPC 100% pris en charge. Plus d'infos ?",
    });
    expect(body).toBe(
      "Bonjour Sophie, je suis Léa, assistante virtuelle de Médéré. DPC 100% pris en charge. Plus d'infos ? STOP.",
    );
  });

  it("civilité '' (string vide) → traité comme undefined (prénom seul)", () => {
    const body = assembleFirstSms({
      civilite: "",
      lastName: "Bernard",
      firstName: "Sophie",
      accroche: "DPC indemnisée 660€/an. Cela vous tente ?",
    });
    expect(body.startsWith("Bonjour Sophie,")).toBe(true);
    expect(body.includes("Bernard")).toBe(false);
  });

  it.each([
    ["Dr", "Bonjour Dr Dupuis,"],
    ["Pr", "Bonjour Pr Dupuis,"],
    ["M.", "Bonjour M. Dupuis,"],
    ["Mme", "Bonjour Mme Dupuis,"],
  ] as const)("civilité abrégée '%s' → préfixe '%s'", (civilite, expectedPrefix) => {
    const body = assembleFirstSms({
      civilite,
      lastName: "Dupuis",
      firstName: "Marie",
      accroche: "DPC 660€/an. Plus d'infos ?",
    });
    expect(body.startsWith(expectedPrefix)).toBe(true);
  });

  it("body assemblé contient TOUJOURS 'je suis Léa, assistante virtuelle de Médéré.' (anti-drift assemble v2.0.1)", () => {
    const body = assembleFirstSms({
      civilite: "Dr",
      lastName: "X",
      firstName: "Y",
      accroche: "Z".repeat(FIRST_SMS_MIN_ACCROCHE_CHARS),
    });
    expect(body).toContain("je suis Léa, assistante virtuelle de Médéré.");
  });

  it("body assemblé finit TOUJOURS par ' STOP.' (anti-drift assemble)", () => {
    const body = assembleFirstSms({
      civilite: "Dr",
      lastName: "X",
      firstName: "Y",
      accroche: "Z".repeat(FIRST_SMS_MIN_ACCROCHE_CHARS),
    });
    expect(body.endsWith(" STOP.")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assembleFirstSms — garde-fou ≤ 160 chars (cas extrême nom long)
// ─────────────────────────────────────────────────────────────────────────────

describe("assembleFirstSms — garde-fou ExternalServiceError si > 160 chars", () => {
  it("nom très long + accroche max 65 → throw ExternalServiceError", () => {
    const TOO_LONG_NAME = "x".repeat(60); // > 52 chars limite worst-case
    expect(() =>
      assembleFirstSms({
        civilite: "Mme",
        lastName: TOO_LONG_NAME,
        firstName: "Marie",
        accroche: "y".repeat(FIRST_SMS_MAX_ACCROCHE_CHARS),
      }),
    ).toThrow(ExternalServiceError);
  });

  it("garde-fou context : longueurs SEULEMENT, PAS de nom/accroche/body brut (PII)", () => {
    const SECRET_LASTNAME = "SECRET-NAME-NEVER-LOG-PII-LEAK-DETECTOR-XYZ-LONG-ENOUGH-TO-TRIGGER";
    const SECRET_ACCROCHE = "SECRET-ACCROCHE-NEVER-LOG-PII-NEVER-PROPAGATE-IN-EXCEPTION-CTX";

    try {
      assembleFirstSms({
        civilite: "Mme",
        lastName: SECRET_LASTNAME,
        firstName: "Marie",
        accroche: SECRET_ACCROCHE,
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExternalServiceError);
      const ctx = (e as ExternalServiceError).context as Record<string, unknown>;
      const serialized = JSON.stringify({ message: (e as Error).message, context: ctx });

      // Anti-PII : aucune valeur brute dans context.
      expect(serialized).not.toContain(SECRET_LASTNAME);
      expect(serialized).not.toContain(SECRET_ACCROCHE);

      // Longueurs et metadata : présentes et utiles forensic.
      expect(ctx.op).toBe(ASSEMBLE_FIRST_SMS_OP);
      expect(ctx.assembledLength).toBeGreaterThan(FIRST_SMS_MAX_BODY_CHARS);
      expect(ctx.maxLength).toBe(FIRST_SMS_MAX_BODY_CHARS);
      expect(ctx.accrocheLength).toBe(SECRET_ACCROCHE.length);
      expect(ctx.adressageLength).toBeGreaterThan(0);
      expect(ctx.hasCivilite).toBe(true);
    }
  });

  it("nom exactement à la limite (assemble = 160) → OK (pas de throw) v2.0.1", () => {
    // v2.0.1 recalcul : "Bonjour Mme " (12) + nom_X (45) +
    // ", je suis Léa, assistante virtuelle de Médéré. " (47) +
    // accroche (50) + " STOP." (6) = 160 chars.
    const NAME_45_CHARS = "x".repeat(45);
    const ACCROCHE_50_CHARS = "y".repeat(FIRST_SMS_MAX_ACCROCHE_CHARS);
    const body = assembleFirstSms({
      civilite: "Mme",
      lastName: NAME_45_CHARS,
      firstName: "Z",
      accroche: ACCROCHE_50_CHARS,
    });
    expect(body.length).toBe(FIRST_SMS_MAX_BODY_CHARS); // exactement 160
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sentinelle fuzz — garantie ≤ 160 chars sur cas réalistes (~50 combinaisons)
// ─────────────────────────────────────────────────────────────────────────────

describe("assembleFirstSms — sentinelle fuzz ≤ 160 chars (cas réalistes FR)", () => {
  // 5 civilités × 10 noms × min/max accroche = 100 combinaisons
  const CIVILITES: ReadonlyArray<string | undefined> = [
    undefined, // → "Bonjour {prénom}"
    "Dr",
    "Pr",
    "M.",
    "Mme",
  ];

  // Noms FR réalistes — du plus court (Lê 2 chars) au plus long (50 chars
  // = "de la Tour-Vandenberghe-Saint-Étienne-Vauclair" qui est extrême
  // mais sous la limite mathématique 52 chars).
  const NOMS_REALISTES: readonly string[] = [
    "Lê",
    "Roy",
    "Dupuis",
    "Charrier",
    "Vandenberghe",
    "de Saint-Martin",
    "Marie-Christine Lemoine",
    "de la Tour-Vandenberghe",
    "Müller-Schmidt-Vauclair",
    "Saint-Étienne-du-Rouvray-Lévêque", // ~32 chars
  ];

  // ACCROCHE_MIN/MAX dimensionnés EXACTEMENT aux bornes Zod (30 et 65) :
  // c'est précisément le worst-case fuzz que la sentinelle doit couvrir.
  // Contenu arbitraire (répétition `x`/`y`) — la sentinelle teste la
  // garantie mathématique d'assembleFirstSms, pas la qualité commerciale
  // de l'accroche (tests few-shot s'en chargent dans first-sms.test.ts).
  const ACCROCHE_MIN = "x".repeat(FIRST_SMS_MIN_ACCROCHE_CHARS); // 30 chars
  const ACCROCHE_MAX_LEN = "y".repeat(FIRST_SMS_MAX_ACCROCHE_CHARS); // 65 chars
  expect(ACCROCHE_MIN.length).toBe(FIRST_SMS_MIN_ACCROCHE_CHARS);
  expect(ACCROCHE_MAX_LEN.length).toBe(FIRST_SMS_MAX_ACCROCHE_CHARS);

  it.each(
    CIVILITES.flatMap((civilite) =>
      NOMS_REALISTES.flatMap((nom) =>
        [ACCROCHE_MIN, ACCROCHE_MAX_LEN].map(
          (accroche) =>
            [
              `civilite=${civilite ?? "∅"} nom=${nom} accroche=${accroche.length}`,
              civilite,
              nom,
              accroche,
            ] as const,
        ),
      ),
    ),
  )("%s → body assemblé ≤ 160 chars", (_label, civilite, nom, accroche) => {
    const body = assembleFirstSms({
      civilite,
      lastName: nom,
      firstName: "Marie", // prénom court fixe (utilisé seulement si civ undefined)
      accroche,
    });
    expect(body.length).toBeLessThanOrEqual(FIRST_SMS_MAX_BODY_CHARS);
    // Sentinelle : les 3 marqueurs compliance sont TOUJOURS présents par construction.
    expect(body).toContain("je suis Léa, assistante virtuelle de Médéré.");
    expect(body.endsWith(" STOP.")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Propagation erreurs SDK (single-shot, pas de retry interne en v2.0.0)
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFirstSms — propagation erreurs SDK (v2.0.0 single-shot)", () => {
  it("RateLimitError SDK → propagée telle quelle (Inngest retry côté /send)", async () => {
    mockedGenerate.mockRejectedValueOnce(
      new RateLimitError({ message: "429 too many requests", context: {} }),
    );
    await expect(generateFirstSms({ contact: VALID_CONTACT })).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
  });

  it("ConfigError SDK → propagée (NonRetriableError Inngest)", async () => {
    mockedGenerate.mockRejectedValueOnce(
      new ConfigError({ message: "400 bad request", context: {} }),
    );
    await expect(generateFirstSms({ contact: VALID_CONTACT })).rejects.toBeInstanceOf(ConfigError);
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
  });

  it("ExternalServiceError SDK (timeout/5xx) → propagée telle quelle", async () => {
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
  });

  it("InternalError SDK → propagée telle quelle", async () => {
    mockedGenerate.mockRejectedValueOnce(new InternalError({ message: "Unexpected", context: {} }));
    await expect(generateFirstSms({ contact: VALID_CONTACT })).rejects.toBeInstanceOf(
      InternalError,
    );
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
  });

  it("Zod re-validation fail (accroche > 65) → ExternalServiceError du wrapper SDK propagée", async () => {
    // En v2.0.0, le tool schema interdit > 65 chars accroche. Le wrapper
    // generateWithTool transforme un Zod fail en ExternalServiceError (cf.
    // client.ts:362-379). Plus de retry interne (v2 single-shot).
    mockedGenerate.mockRejectedValueOnce(
      new ExternalServiceError({
        message: "Anthropic tool_use payload failed Zod validation",
        context: {
          op: "generateWithTool",
          tool: "first_sms_generator",
          issues: [{ path: "accroche", code: "too_big" }],
        },
      }),
    );
    await expect(generateFirstSms({ contact: VALID_CONTACT })).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Anti-fuite PII (sentinelles CRITIQUES)
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFirstSms — anti-fuite PII (sentinelles)", () => {
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
// Sentinelles return values
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFirstSms — sentinelles return values v2.0.0", () => {
  it("FIRST_SMS_GENERATOR_OP === 'first_sms.generate'", () => {
    expect(FIRST_SMS_GENERATOR_OP).toBe("first_sms.generate");
  });

  it("ASSEMBLE_FIRST_SMS_OP === 'first_sms.assemble'", () => {
    expect(ASSEMBLE_FIRST_SMS_OP).toBe("first_sms.assemble");
  });

  it("promptVersion retourné === '2.0.1' (commit c — AI Act explicite + clarté question)", async () => {
    mockedGenerate.mockResolvedValue(makeToolUseResult());
    const result = await generateFirstSms({ contact: VALID_CONTACT });
    expect(result.promptVersion).toBe("2.0.1");
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
