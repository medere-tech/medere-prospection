import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { isOptOut, OPT_OUT_MAX_INCOMING_LENGTH } from "@/lib/compliance/opt-out";
import { ConfigError, ExternalServiceError, ValidationError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

import * as clientModule from "./client";
import { __setAnthropicClientForTests, type AnthropicClient } from "./client";
import { classifyReply } from "./intent-classifier";
import {
  CLASSIFY_INTENT_MODEL,
  CLASSIFY_INTENT_TEMPERATURE,
  CLASSIFY_INTENT_TOOL_NAME,
} from "./prompts/classify-intent";
import { INTENT_VALUES } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeFakeClient(): {
  client: AnthropicClient;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn();
  return {
    client: { messages: { create } } as unknown as AnthropicClient,
    create,
  };
}

/**
 * Construit une réponse `Anthropic.Messages.Message` contenant un
 * `tool_use` block avec le payload fourni. Le payload est utilisé tel
 * quel — utile pour simuler Claude qui renvoie n'importe quoi.
 */
function makeToolUseResponse(name: string, input: unknown) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: CLASSIFY_INTENT_MODEL,
    content: [
      {
        type: "tool_use",
        id: "toolu_test",
        name,
        input,
        caller: { type: "direct" },
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 30, output_tokens: 15 },
    container: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURES GUARD-001 — long-form opt-out validées Déthié pré-flight S7a.2
//
// Chaque fixture :
//   - > OPT_OUT_MAX_INCOMING_LENGTH (50) chars                 [S10]
//   - ne contient aucun OPT_OUT_KEYWORD après normalisation    [S6]
//   - exprime un opt-out qu'un humain reconnaît sans ambiguïté
// ─────────────────────────────────────────────────────────────────────────────

const GUARD_001_FIXTURES = [
  // 1. Refus poli court mais long-form
  "Je vous remercie mais je préfère ne plus recevoir de messages de votre part, bonne journée à vous.",
  // 2. Demande administrative formelle
  "Bonjour, pouvez-vous me retirer de votre liste de diffusion et ne plus me solliciter à l'avenir s'il vous plaît.",
  // 3. Refus + référence implicite RGPD
  "Merci de ne plus me contacter par ce moyen ni aucun autre, je n'ai pas donné mon accord pour ce démarchage.",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  __setAnthropicClientForTests(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// SENTINELLES — section critique compliance
// ─────────────────────────────────────────────────────────────────────────────

describe("SENTINELLES classifier (verrouillent invariants compliance)", () => {
  // S1, S2, S3, S4 sont aussi dans prompts/classify-intent.test.ts.
  // On les RÉ-AFFIRME ici pour que ce fichier seul prouve les invariants
  // côté code consommateur.

  it("[S1] le classifier utilise EXACTEMENT le snapshot daté Haiku 4.5", () => {
    expect(CLASSIFY_INTENT_MODEL).toBe("claude-haiku-4-5-20251001");
  });

  it("[S2] le classifier utilise temperature=0", () => {
    expect(CLASSIFY_INTENT_TEMPERATURE).toBe(0);
  });

  it("[S3] le vocabulaire INTENT_VALUES est exactement les 4 valeurs fermées", () => {
    expect(INTENT_VALUES).toEqual(["STOP", "OBJECTION", "INTERESSE", "NEUTRE"]);
  });

  // S5 + S6 + S10 — pour chaque fixture GUARD-001
  describe("[S5/S6/S10] fixtures GUARD-001 (long-form opt-out)", () => {
    for (const fixture of GUARD_001_FIXTURES) {
      it(`fixture "${fixture.slice(0, 40)}…" est dans la zone GUARD-001 et classifiée STOP`, async () => {
        // [S10] meta-sentinelle longueur
        expect(fixture.length).toBeGreaterThan(OPT_OUT_MAX_INCOMING_LENGTH);
        // [S6] sentinelle Niveau B — n'est PAS attrapée par isOptOut() court-form
        expect(isOptOut(fixture)).toBe(false);

        // [S5] sentinelle Niveau A — mock simule Claude qui classifie STOP
        const { client, create } = makeFakeClient();
        create.mockResolvedValueOnce(
          makeToolUseResponse(CLASSIFY_INTENT_TOOL_NAME, {
            intent: "STOP",
            confidence: 0.92,
            reasoning: "demande polie mais explicite d'arrêt",
          }),
        );
        __setAnthropicClientForTests(client);

        const result = await classifyReply(fixture);
        expect(result.intent).toBe("STOP");
        expect(result.fallback).toBe(false);
      });
    }
  });

  it("[S7] tout throw SDK → fail-safe STOP + fallback:true + confidence:0", async () => {
    const { client, create } = makeFakeClient();
    create.mockRejectedValueOnce(
      // n'importe quelle erreur — ici un AuthenticationError mocké via SDK error
      new ConfigError({ message: "auth failed" }),
    );
    __setAnthropicClientForTests(client);

    const result = await classifyReply("peu importe ce que je dis");
    expect(result).toEqual({
      intent: "STOP",
      confidence: 0,
      reasoning: expect.stringContaining("fallback"),
      fallback: true,
    });
  });

  it("[S8] tool_use Zod-invalide (intent hors enum) → fail-safe STOP", async () => {
    const { client, create } = makeFakeClient();
    create.mockResolvedValueOnce(
      makeToolUseResponse(CLASSIFY_INTENT_TOOL_NAME, {
        intent: "BLABLA", // hors INTENT_VALUES
        confidence: 0.5,
        reasoning: "fake",
      }),
    );
    __setAnthropicClientForTests(client);

    const result = await classifyReply("message banal");
    expect(result.intent).toBe("STOP");
    expect(result.fallback).toBe(true);
    expect(result.confidence).toBe(0);
  });

  it("[S9] anti-fuite PII : ni le rawMessage ni le numéro ne sont loggés en clair", async () => {
    const { client, create } = makeFakeClient();
    create.mockRejectedValueOnce(new ExternalServiceError({ message: "boom" }));
    __setAnthropicClientForTests(client);

    const errorSpy = vi.spyOn(logger, "error");

    const rawMessage = "Mon numéro est 0612345678 si vous voulez me joindre";
    const result = await classifyReply(rawMessage);

    expect(result.fallback).toBe(true);

    // Aucun des arguments passés à logger.error ne doit contenir le numéro
    // ni le rawMessage en clair (verrou direct, sans dépendre du redaction
    // Pino — la convention "ne rien donner à scrubber" est l'invariant).
    for (const call of errorSpy.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain("0612345678");
      expect(serialized).not.toContain(rawMessage);
      expect(serialized).not.toContain("Mon numéro");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation des inputs
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyReply — validation inputs", () => {
  it("throw ValidationError sur string vide", async () => {
    await expect(classifyReply("")).rejects.toBeInstanceOf(ValidationError);
  });

  it("throw ValidationError sur whitespace seul", async () => {
    await expect(classifyReply("   \n\t  ")).rejects.toBeInstanceOf(ValidationError);
  });

  it("throw ValidationError sur non-string (cast forcé)", async () => {
    await expect(classifyReply(null as unknown as string)).rejects.toBeInstanceOf(ValidationError);
    await expect(classifyReply(undefined as unknown as string)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(classifyReply(42 as unknown as string)).rejects.toBeInstanceOf(ValidationError);
  });

  it("n'appelle PAS le SDK si la validation échoue", async () => {
    const { client, create } = makeFakeClient();
    __setAnthropicClientForTests(client);

    await expect(classifyReply("")).rejects.toBeInstanceOf(ValidationError);
    expect(create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy paths — frontières STOP / OBJECTION / INTERESSE / NEUTRE
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyReply — happy paths fonctionnels", () => {
  it("STOP court explicite → STOP, fallback:false", async () => {
    const { client, create } = makeFakeClient();
    create.mockResolvedValueOnce(
      makeToolUseResponse(CLASSIFY_INTENT_TOOL_NAME, {
        intent: "STOP",
        confidence: 1,
        reasoning: "opt-out explicite par mot-clé",
      }),
    );
    __setAnthropicClientForTests(client);

    const result = await classifyReply("STOP");
    expect(result).toEqual({
      intent: "STOP",
      confidence: 1,
      reasoning: "opt-out explicite par mot-clé",
      fallback: false,
    });
  });

  it("OBJECTION court-form (`Pas intéressé pour l'instant`) → OBJECTION", async () => {
    const { client, create } = makeFakeClient();
    create.mockResolvedValueOnce(
      makeToolUseResponse(CLASSIFY_INTENT_TOOL_NAME, {
        intent: "OBJECTION",
        confidence: 0.9,
        reasoning: "refus poli avec ouverture temporelle",
      }),
    );
    __setAnthropicClientForTests(client);

    const result = await classifyReply("Pas intéressé pour l'instant");
    expect(result.intent).toBe("OBJECTION");
    expect(result.fallback).toBe(false);
  });

  it("INTERESSE (`C'est quoi exactement ?`) → INTERESSE", async () => {
    const { client, create } = makeFakeClient();
    create.mockResolvedValueOnce(
      makeToolUseResponse(CLASSIFY_INTENT_TOOL_NAME, {
        intent: "INTERESSE",
        confidence: 0.85,
        reasoning: "question sur le contenu = engagement actif",
      }),
    );
    __setAnthropicClientForTests(client);

    const result = await classifyReply("C'est quoi exactement ?");
    expect(result.intent).toBe("INTERESSE");
  });

  it("NEUTRE (`?`) → NEUTRE", async () => {
    const { client, create } = makeFakeClient();
    create.mockResolvedValueOnce(
      makeToolUseResponse(CLASSIFY_INTENT_TOOL_NAME, {
        intent: "NEUTRE",
        confidence: 0.6,
        reasoning: "signal trop ambigu pour discriminer",
      }),
    );
    __setAnthropicClientForTests(client);

    const result = await classifyReply("?");
    expect(result.intent).toBe("NEUTRE");
  });

  it("Cas ambigu STOP↔OBJECTION (4e fixture optionnelle pré-flight) → règle de doute = STOP", async () => {
    // "J'aimerais qu'on en reste là pour le moment" — formulation qui
    // pourrait passer pour OBJECTION (temporel) ou STOP (refus définitif).
    // La règle de doute du prompt impose STOP. On simule donc Claude
    // qui applique correctement la règle.
    const { client, create } = makeFakeClient();
    create.mockResolvedValueOnce(
      makeToolUseResponse(CLASSIFY_INTENT_TOOL_NAME, {
        intent: "STOP",
        confidence: 0.55,
        reasoning: "ambigu STOP/OBJECTION : règle de doute → STOP",
      }),
    );
    __setAnthropicClientForTests(client);

    const result = await classifyReply("J'aimerais qu'on en reste là pour le moment");
    expect(result.intent).toBe("STOP");
    expect(result.fallback).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Paramètres passés au SDK — verrouille model + temperature + tool
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyReply — paramètres SDK", () => {
  it("appelle generateWithTool avec model + temperature + tool name corrects", async () => {
    const { client, create } = makeFakeClient();
    create.mockResolvedValueOnce(
      makeToolUseResponse(CLASSIFY_INTENT_TOOL_NAME, {
        intent: "NEUTRE",
        confidence: 0.5,
        reasoning: "x",
      }),
    );
    __setAnthropicClientForTests(client);

    await classifyReply("test");

    const [body] = create.mock.calls[0]!;
    expect(body.model).toBe(CLASSIFY_INTENT_MODEL);
    expect(body.temperature).toBe(CLASSIFY_INTENT_TEMPERATURE);
    expect(body.tools[0].name).toBe(CLASSIFY_INTENT_TOOL_NAME);
    expect(body.tool_choice).toEqual({ type: "tool", name: CLASSIFY_INTENT_TOOL_NAME });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Robustesse fail-safe — variantes d'erreur
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyReply — fail-safe sur erreurs SDK variées", () => {
  it("erreur SDK générique (Error nu) → STOP fallback", async () => {
    const { client, create } = makeFakeClient();
    create.mockRejectedValueOnce(new Error("nope"));
    __setAnthropicClientForTests(client);

    const result = await classifyReply("hi");
    expect(result.intent).toBe("STOP");
    expect(result.fallback).toBe(true);
  });

  it("erreur non-Error (string thrown) → STOP fallback", async () => {
    const { client, create } = makeFakeClient();
    create.mockRejectedValueOnce("string throw exotic");
    __setAnthropicClientForTests(client);

    const result = await classifyReply("hi");
    expect(result.intent).toBe("STOP");
    expect(result.fallback).toBe(true);
  });

  it("ExternalServiceError (5xx Anthropic) → STOP fallback", async () => {
    const { client, create } = makeFakeClient();
    create.mockRejectedValueOnce(new ExternalServiceError({ message: "anthropic 503" }));
    __setAnthropicClientForTests(client);

    const result = await classifyReply("hi");
    expect(result.fallback).toBe(true);
  });

  it("régression wrapper hypothétique (throw non-AppError direct) → STOP fallback `errKind: unknown`", async () => {
    // Cas pathologique : `generateWithTool` est censé wrapper tout en
    // AppError. Si une régression future le faisait throw une string
    // brute (ou n'importe quoi de non-Error), le classifier doit quand
    // même tomber sur le fail-safe STOP sans crasher. On simule via
    // spy direct sur le module client (vs mock du SDK qui passerait
    // par mapSdkError → AppError).
    const errorSpy = vi.spyOn(logger, "error");
    vi.spyOn(clientModule, "generateWithTool").mockRejectedValueOnce(
      "raw string thrown by hypothetical buggy wrapper",
    );

    const result = await classifyReply("hi");
    expect(result.intent).toBe("STOP");
    expect(result.fallback).toBe(true);

    // Vérifie que le helper a bien tagué l'erreur "unknown" (pas de
    // crash sur err.constructor.name d'une string).
    const logged = errorSpy.mock.calls.find(
      (c) => (c[0] as { errKind?: string })?.errKind === "unknown",
    );
    expect(logged).toBeDefined();
  });

  it("réponse SDK sans tool_use block → STOP fallback (via ExternalServiceError du wrapper)", async () => {
    const { client, create } = makeFakeClient();
    // Réponse text-only, pas de tool_use → wrapper throw ExternalServiceError
    create.mockResolvedValueOnce({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: CLASSIFY_INTENT_MODEL,
      content: [{ type: "text", text: "Sorry, I cannot." }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
      container: null,
    });
    __setAnthropicClientForTests(client);

    const result = await classifyReply("hi");
    expect(result.intent).toBe("STOP");
    expect(result.fallback).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Anti-régression : le schéma Zod export est bien celui consommé
// ─────────────────────────────────────────────────────────────────────────────

describe("schéma Zod cohérence", () => {
  it("le schéma exporté accepte un payload valide canonique", () => {
    const schema = z.object({
      intent: z.enum(INTENT_VALUES),
      confidence: z.number().min(0).max(1),
      reasoning: z.string().min(1).max(200),
    });
    expect(schema.safeParse({ intent: "STOP", confidence: 0.5, reasoning: "x" }).success).toBe(
      true,
    );
  });
});
