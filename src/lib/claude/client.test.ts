import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError as SdkRateLimitError,
  UnprocessableEntityError,
} from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { __resetEnvCacheForTests } from "@/lib/security/env";
import {
  ConfigError,
  ExternalServiceError,
  InternalError,
  RateLimitError,
  ValidationError,
} from "@/lib/utils/errors";

import {
  __setAnthropicClientForTests,
  type AnthropicClient,
  generate,
  generateWithTool,
  getAnthropicClient,
} from "./client";
import { CLAUDE_MODELS } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Fake client minimal : `messages.create` mocké. */
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

/** Réponse "ok" minimaliste type `Anthropic.Messages.Message`. */
function makeTextResponse(text: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: CLAUDE_MODELS.HAIKU_4_5,
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    container: null,
    ...overrides,
  };
}

function makeToolUseResponse(
  name: string,
  input: unknown,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: CLAUDE_MODELS.HAIKU_4_5,
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
    usage: { input_tokens: 12, output_tokens: 8 },
    container: null,
    ...overrides,
  };
}

/** Capture champs énumérables d'une erreur (anti-fuite). */
function captureErrorPayload(e: unknown): string {
  if (!(e instanceof Error)) return JSON.stringify(e);
  return JSON.stringify({
    message: e.message,
    cause: (e as { cause?: unknown }).cause,
    stack: e.stack,
    context: (e as { context?: unknown }).context,
    ...(e as object),
  });
}

beforeEach(() => {
  __setAnthropicClientForTests(null);
  __resetEnvCacheForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────
// getAnthropicClient — singleton + env paresseuse
// ─────────────────────────────────────────────────────────────────────────────

describe("getAnthropicClient", () => {
  it("construit le client au premier appel quand l'env est valide", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-key-for-build");
    const c1 = getAnthropicClient();
    expect(c1).toBeDefined();
    expect(c1.messages).toBeDefined();
  });

  it("memoize : deux appels successifs retournent la même instance", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-memoize");
    const c1 = getAnthropicClient();
    const c2 = getAnthropicClient();
    expect(c1).toBe(c2);
  });

  it("throw ConfigError quand ANTHROPIC_API_KEY manquante (sans fuite de valeur)", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    expect(() => getAnthropicClient()).toThrow(ConfigError);
    try {
      getAnthropicClient();
    } catch (e) {
      const payload = captureErrorPayload(e);
      // La valeur (même undefined) ne doit pas apparaître ailleurs que comme
      // mention de champ — surtout pas la clé d'un autre service mémorisée.
      expect(payload).not.toContain("sk-ant-");
    }
  });

  it("__setAnthropicClientForTests retourne le fake injecté", () => {
    const { client: fake } = makeFakeClient();
    __setAnthropicClientForTests(fake);
    expect(getAnthropicClient()).toBe(fake);
  });

  it("__setAnthropicClientForTests refuse en NODE_ENV non-test", () => {
    vi.stubEnv("NODE_ENV", "production");
    const { client: fake } = makeFakeClient();
    expect(() => __setAnthropicClientForTests(fake)).toThrow(/outside of tests/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generate — happy paths
// ─────────────────────────────────────────────────────────────────────────────

describe("generate — happy paths", () => {
  it("retourne le texte concaténé + usage + stopReason", async () => {
    const { client, create } = makeFakeClient();
    create.mockResolvedValueOnce(makeTextResponse("Bonjour Médéré."));
    __setAnthropicClientForTests(client);

    const result = await generate({
      system: "sys",
      user: "hi",
      model: CLAUDE_MODELS.HAIKU_4_5,
    });

    expect(result.text).toBe("Bonjour Médéré.");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(result.stopReason).toBe("end_turn");
  });

  it("concatène plusieurs text blocks (ignore les autres types)", async () => {
    const { client, create } = makeFakeClient();
    create.mockResolvedValueOnce({
      ...makeTextResponse(""),
      content: [
        { type: "text", text: "A" },
        { type: "thinking", thinking: "internal" }, // ignoré
        { type: "text", text: "B" },
      ],
    });
    __setAnthropicClientForTests(client);

    const result = await generate({
      system: "sys",
      user: "hi",
      model: CLAUDE_MODELS.HAIKU_4_5,
    });

    expect(result.text).toBe("AB");
  });

  it("applique les defaults (temperature, maxTokens, timeoutMs) si absents", async () => {
    const { client, create } = makeFakeClient();
    create.mockResolvedValueOnce(makeTextResponse("ok"));
    __setAnthropicClientForTests(client);

    await generate({
      system: "sys",
      user: "hi",
      model: CLAUDE_MODELS.HAIKU_4_5,
    });

    const [body, options] = create.mock.calls[0]!;
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(1024);
    expect(options.timeout).toBe(10_000);
  });

  it("propage les overrides (temperature, maxTokens, timeoutMs) explicites", async () => {
    const { client, create } = makeFakeClient();
    create.mockResolvedValueOnce(makeTextResponse("ok"));
    __setAnthropicClientForTests(client);

    await generate({
      system: "sys",
      user: "hi",
      model: CLAUDE_MODELS.HAIKU_4_5,
      temperature: 0,
      maxTokens: 256,
      timeoutMs: 5_000,
    });

    const [body, options] = create.mock.calls[0]!;
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(256);
    expect(options.timeout).toBe(5_000);
  });

  it("default stopReason = end_turn si SDK retourne null", async () => {
    const { client, create } = makeFakeClient();
    create.mockResolvedValueOnce(makeTextResponse("ok", { stop_reason: null }));
    __setAnthropicClientForTests(client);

    const result = await generate({
      system: "sys",
      user: "hi",
      model: CLAUDE_MODELS.HAIKU_4_5,
    });
    expect(result.stopReason).toBe("end_turn");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generate — validation des inputs
// ─────────────────────────────────────────────────────────────────────────────

describe("generate — validation inputs", () => {
  it("throw ValidationError si system vide", async () => {
    const { client } = makeFakeClient();
    __setAnthropicClientForTests(client);

    await expect(
      generate({
        system: "",
        user: "hi",
        model: CLAUDE_MODELS.HAIKU_4_5,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("throw ValidationError si user vide", async () => {
    const { client } = makeFakeClient();
    __setAnthropicClientForTests(client);

    await expect(
      generate({
        system: "sys",
        user: "",
        model: CLAUDE_MODELS.HAIKU_4_5,
      }),
    ).rejects.toThrow(ValidationError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generate — mapping erreurs SDK
// ─────────────────────────────────────────────────────────────────────────────

describe("generate — mapping erreurs SDK", () => {
  it("AuthenticationError → ConfigError (noRetry)", async () => {
    const { client, create } = makeFakeClient();
    const sdkErr = new AuthenticationError(
      401,
      { error: { type: "authentication_error" } },
      "auth msg",
      new Headers(),
    );
    create.mockRejectedValueOnce(sdkErr);
    __setAnthropicClientForTests(client);

    try {
      await generate({
        system: "sys",
        user: "hi",
        model: CLAUDE_MODELS.HAIKU_4_5,
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const err = e as ConfigError;
      expect(err.noRetry).toBe(true);
      expect(err.context?.status).toBe(401);
      // anti-fuite : message SDK brut ne doit pas être propagé
      expect(err.message).not.toContain("auth msg");
    }
  });

  it("PermissionDeniedError → ConfigError", async () => {
    const { client, create } = makeFakeClient();
    create.mockRejectedValueOnce(
      new PermissionDeniedError(
        403,
        { error: { type: "permission_error" } },
        "denied",
        new Headers(),
      ),
    );
    __setAnthropicClientForTests(client);

    await expect(
      generate({ system: "sys", user: "hi", model: CLAUDE_MODELS.HAIKU_4_5 }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("NotFoundError → ConfigError (model_not_found / snapshot déprécié)", async () => {
    const { client, create } = makeFakeClient();
    create.mockRejectedValueOnce(
      new NotFoundError(404, { error: { type: "not_found_error" } }, "no model", new Headers()),
    );
    __setAnthropicClientForTests(client);

    try {
      await generate({ system: "sys", user: "hi", model: CLAUDE_MODELS.HAIKU_4_5 });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toMatch(/model not found/i);
    }
  });

  it("BadRequestError → ConfigError", async () => {
    const { client, create } = makeFakeClient();
    create.mockRejectedValueOnce(
      new BadRequestError(
        400,
        { error: { type: "invalid_request_error" } },
        "bad req",
        new Headers(),
      ),
    );
    __setAnthropicClientForTests(client);

    await expect(
      generate({ system: "sys", user: "hi", model: CLAUDE_MODELS.HAIKU_4_5 }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("UnprocessableEntityError → ConfigError", async () => {
    const { client, create } = makeFakeClient();
    create.mockRejectedValueOnce(
      new UnprocessableEntityError(422, {}, "unprocessable", new Headers()),
    );
    __setAnthropicClientForTests(client);

    await expect(
      generate({ system: "sys", user: "hi", model: CLAUDE_MODELS.HAIKU_4_5 }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("SdkRateLimitError → RateLimitError applicatif", async () => {
    const { client, create } = makeFakeClient();
    create.mockRejectedValueOnce(
      new SdkRateLimitError(429, { error: { type: "rate_limit_error" } }, "rate", new Headers()),
    );
    __setAnthropicClientForTests(client);

    try {
      await generate({ system: "sys", user: "hi", model: CLAUDE_MODELS.HAIKU_4_5 });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RateLimitError);
      expect((e as RateLimitError).context?.status).toBe(429);
    }
  });

  it("InternalServerError → ExternalServiceError", async () => {
    const { client, create } = makeFakeClient();
    create.mockRejectedValueOnce(new InternalServerError(500, {}, "boom", new Headers()));
    __setAnthropicClientForTests(client);

    await expect(
      generate({ system: "sys", user: "hi", model: CLAUDE_MODELS.HAIKU_4_5 }),
    ).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("APIConnectionError → ExternalServiceError", async () => {
    const { client, create } = makeFakeClient();
    create.mockRejectedValueOnce(new APIConnectionError({ message: "net" }));
    __setAnthropicClientForTests(client);

    try {
      await generate({ system: "sys", user: "hi", model: CLAUDE_MODELS.HAIKU_4_5 });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExternalServiceError);
      expect((e as ExternalServiceError).context?.kind).toBe("APIConnectionError");
    }
  });

  it("APIConnectionTimeoutError (sous-classe APIConnectionError) → ExternalServiceError", async () => {
    const { client, create } = makeFakeClient();
    create.mockRejectedValueOnce(new APIConnectionTimeoutError({ message: "timeout" }));
    __setAnthropicClientForTests(client);

    try {
      await generate({ system: "sys", user: "hi", model: CLAUDE_MODELS.HAIKU_4_5 });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExternalServiceError);
      expect((e as ExternalServiceError).context?.kind).toBe("APIConnectionTimeoutError");
    }
  });

  it("APIUserAbortError → ExternalServiceError (sous-classe APIError)", async () => {
    const { client, create } = makeFakeClient();
    create.mockRejectedValueOnce(new APIUserAbortError({ message: "abort" }));
    __setAnthropicClientForTests(client);

    await expect(
      generate({ system: "sys", user: "hi", model: CLAUDE_MODELS.HAIKU_4_5 }),
    ).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("APIError catch-all (status non-couvert ailleurs) → ExternalServiceError", async () => {
    const { client, create } = makeFakeClient();
    // ConflictError 409 n'est pas explicitement mappé → tombe sur le catch-all APIError.
    create.mockRejectedValueOnce(new ConflictError(409, {}, "conflict", new Headers()));
    __setAnthropicClientForTests(client);

    try {
      await generate({ system: "sys", user: "hi", model: CLAUDE_MODELS.HAIKU_4_5 });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExternalServiceError);
      expect((e as ExternalServiceError).context?.status).toBe(409);
    }
  });

  it("erreur non-SDK (TypeError exotique) → InternalError", async () => {
    const { client, create } = makeFakeClient();
    create.mockRejectedValueOnce(new TypeError("weird"));
    __setAnthropicClientForTests(client);

    try {
      await generate({ system: "sys", user: "hi", model: CLAUDE_MODELS.HAIKU_4_5 });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InternalError);
      expect((e as InternalError).cause).toBeInstanceOf(TypeError);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generateWithTool — happy paths
// ─────────────────────────────────────────────────────────────────────────────

describe("generateWithTool — happy paths", () => {
  const schema = z.object({
    intent: z.enum(["STOP", "NEUTRE"]),
    confidence: z.number().min(0).max(1),
  });

  it("retourne le tool input validé par Zod", async () => {
    const { client, create } = makeFakeClient();
    create.mockResolvedValueOnce(
      makeToolUseResponse("classify", { intent: "STOP", confidence: 0.95 }),
    );
    __setAnthropicClientForTests(client);

    const result = await generateWithTool({
      system: "sys",
      user: "msg",
      model: CLAUDE_MODELS.HAIKU_4_5,
      tool: {
        name: "classify",
        description: "Classify intent",
        inputSchema: schema,
      },
    });

    expect(result.toolInput).toEqual({ intent: "STOP", confidence: 0.95 });
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 8 });
  });

  it("passe le JSON Schema converti depuis Zod au SDK + force tool_choice", async () => {
    const { client, create } = makeFakeClient();
    create.mockResolvedValueOnce(
      makeToolUseResponse("classify", { intent: "NEUTRE", confidence: 0.5 }),
    );
    __setAnthropicClientForTests(client);

    await generateWithTool({
      system: "sys",
      user: "msg",
      model: CLAUDE_MODELS.HAIKU_4_5,
      tool: {
        name: "classify",
        description: "Classify intent",
        inputSchema: schema,
      },
    });

    const [body] = create.mock.calls[0]!;
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].name).toBe("classify");
    expect(body.tools[0].input_schema).toMatchObject({ type: "object" });
    expect(body.tool_choice).toEqual({ type: "tool", name: "classify" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generateWithTool — robustesse (tool block manquant / Zod-invalide)
// ─────────────────────────────────────────────────────────────────────────────

describe("generateWithTool — robustesse", () => {
  const schema = z.object({ intent: z.enum(["STOP", "NEUTRE"]) });

  it("throw ExternalServiceError si la réponse ne contient pas de tool_use block", async () => {
    const { client, create } = makeFakeClient();
    create.mockResolvedValueOnce(makeTextResponse("Sorry, no tool"));
    __setAnthropicClientForTests(client);

    try {
      await generateWithTool({
        system: "sys",
        user: "msg",
        model: CLAUDE_MODELS.HAIKU_4_5,
        tool: { name: "classify", description: "x", inputSchema: schema },
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExternalServiceError);
      expect((e as ExternalServiceError).message).toMatch(/tool_use block/);
    }
  });

  it("throw ExternalServiceError si le tool_use a un name différent", async () => {
    const { client, create } = makeFakeClient();
    create.mockResolvedValueOnce(makeToolUseResponse("other_tool", { intent: "STOP" }));
    __setAnthropicClientForTests(client);

    await expect(
      generateWithTool({
        system: "sys",
        user: "msg",
        model: CLAUDE_MODELS.HAIKU_4_5,
        tool: { name: "classify", description: "x", inputSchema: schema },
      }),
    ).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("throw ExternalServiceError si le payload du tool ne respecte pas le schéma Zod", async () => {
    const { client, create } = makeFakeClient();
    create.mockResolvedValueOnce(makeToolUseResponse("classify", { intent: "INVALID_VALUE" }));
    __setAnthropicClientForTests(client);

    try {
      await generateWithTool({
        system: "sys",
        user: "msg",
        model: CLAUDE_MODELS.HAIKU_4_5,
        tool: { name: "classify", description: "x", inputSchema: schema },
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExternalServiceError);
      const ctx = (e as ExternalServiceError).context;
      expect(ctx?.tool).toBe("classify");
      // anti-fuite : la VALEUR ("INVALID_VALUE") ne doit pas remonter,
      // uniquement path + code Zod.
      const payload = captureErrorPayload(e);
      expect(payload).not.toContain("INVALID_VALUE");
    }
  });

  it("throw ValidationError si user vide (avant appel SDK)", async () => {
    const { client, create } = makeFakeClient();
    __setAnthropicClientForTests(client);

    await expect(
      generateWithTool({
        system: "sys",
        user: "",
        model: CLAUDE_MODELS.HAIKU_4_5,
        tool: { name: "classify", description: "x", inputSchema: schema },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(create).not.toHaveBeenCalled();
  });

  it("mappe les erreurs SDK aussi sur generateWithTool", async () => {
    const { client, create } = makeFakeClient();
    create.mockRejectedValueOnce(new AuthenticationError(401, {}, "auth", new Headers()));
    __setAnthropicClientForTests(client);

    await expect(
      generateWithTool({
        system: "sys",
        user: "msg",
        model: CLAUDE_MODELS.HAIKU_4_5,
        tool: { name: "classify", description: "x", inputSchema: schema },
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
