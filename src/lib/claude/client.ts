/**
 * Wrapper du SDK officiel `@anthropic-ai/sdk` (v0.99.0) pour Médéré.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Surface publique :
 *
 *   - `generate(opts)`        : texte libre (génération SMS, réponses…).
 *   - `generateWithTool(opts)`: tool use (sortie structurée garantie
 *                               par schéma Zod — utilisé par le classifier
 *                               d'intent S7a.2).
 *
 * Hors scope S7a : streaming, parallel tools, prompt caching, vision.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Singleton + back-door tests — pattern identique à S2 (`getXxxEnv`) et
 * S6 (`getAdminDb`). Le client SDK est instancié au PREMIER appel et
 * memoize. La clé API est lue paresseusement via `getAnthropicEnv()` —
 * si la var manque, on throw `ConfigError` (message sanitisé, pas de
 * fuite). En test, `__setAnthropicClientForTests(fake)` permet d'injecter
 * un fake typé sans toucher à `process.env` ni au SDK réel.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Mapping erreurs SDK → AppError (catégorisation par retry-affinity) :
 *
 *   - 401 / 403  → `ConfigError`   (clé invalide / pas d'accès au modèle)
 *   - 404        → `ConfigError`   (model_not_found — snapshot déprécié
 *                                   = un signal voulu, cf. CORR-3 S7a)
 *   - 400 / 422  → `ConfigError`   (mauvaise requête : un retry ne
 *                                   résoudra pas un payload corrompu)
 *   - 429        → `RateLimitError`(retry-friendly avec backoff)
 *   - 5xx        → `ExternalServiceError` (retry-friendly)
 *   - connexion  → `ExternalServiceError` (timeout, network, abort)
 *   - autres     → `ExternalServiceError` (catch-all SDK)
 *   - non-SDK    → `InternalError`        (bug interne ou throw exotique)
 *
 * Rationale "4xx → ConfigError noRetry" (validé Q5 plan S7a) : un 400
 * sur l'API Claude n'est pas un problème opérationnel transitoire — c'est
 * soit un bug de code (payload mal formé), soit une config morte (clé /
 * modèle invalide). Retry → boucle infinie inutile + spam Anthropic.
 * `ConfigError` est `noRetry: true` → Inngest mappera vers
 * `NonRetriableError` automatiquement.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Sécurité :
 *
 *   - Aucun log de `opts.system` / `opts.user` / `result.text` (PII
 *     potentielle). Le wrapper ne logge JAMAIS le contenu — seulement
 *     model + tokens + duration côté caller.
 *   - Aucune fuite de clé API dans les messages d'erreur : on n'inclut
 *     pas `err.message` du SDK dans nos `AppError.message` (le SDK
 *     pourrait y embarquer la clé tronquée). Seul le HTTP status est
 *     propagé.
 */

import Anthropic, {
  APIConnectionError,
  APIError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError as SdkRateLimitError,
  UnprocessableEntityError,
} from "@anthropic-ai/sdk";
import { z } from "zod";

import { getAnthropicEnv } from "@/lib/security/env";
import {
  ConfigError,
  ExternalServiceError,
  InternalError,
  RateLimitError,
  ValidationError,
} from "@/lib/utils/errors";

import type {
  GenerateOptions,
  GenerateResult,
  StopReason,
  ToolDefinition,
  ToolUseResult,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes — defaults appliqués si l'appelant ne les fournit pas
// ─────────────────────────────────────────────────────────────────────────────

/** Default conservateur (CLAUDE.md piège « fetch sans timeout »). */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Default génératif. Le classifier (S7a.2) force 0 explicitement. */
const DEFAULT_TEMPERATURE = 0.7;

/** Default suffisant pour SMS + classifications. Génération longue ⇒ surcharger. */
const DEFAULT_MAX_TOKENS = 1024;

// ─────────────────────────────────────────────────────────────────────────────
// Singleton + back-door tests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Type structurel minimal du client utilisé par le wrapper. Permet aux
 * tests d'injecter un fake `{ messages: { create: vi.fn() } }` sans
 * recréer l'intégralité de l'instance `Anthropic`.
 */
export type AnthropicClient = Pick<Anthropic, "messages">;

let cachedClient: AnthropicClient | null = null;

function buildClient(): AnthropicClient {
  const env = getAnthropicEnv();
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

/**
 * Retourne le client SDK Anthropic singleton. Premier appel lit l'env
 * (`getAnthropicEnv`) et instancie le SDK ; les suivants retournent
 * l'instance mémoïsée. Throw `ConfigError` si `ANTHROPIC_API_KEY`
 * manquante ou mal formée.
 */
export function getAnthropicClient(): AnthropicClient {
  if (cachedClient === null) {
    cachedClient = buildClient();
  }
  return cachedClient;
}

/**
 * Test-only : injecte un client fake. À utiliser dans `beforeEach()`
 * pour les tests qui veulent contrôler la réponse SDK. Passer `null`
 * pour forcer la prochaine résolution via `getAnthropicEnv()` (utile
 * pour tester le code path "env manquante → ConfigError").
 *
 * Garde runtime : refuse en dehors de `NODE_ENV === "test"` pour éviter
 * un usage applicatif accidentel.
 */
export function __setAnthropicClientForTests(client: AnthropicClient | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setAnthropicClientForTests called outside of tests");
  }
  cachedClient = client;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapping erreurs SDK → AppError
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Transforme une erreur SDK Anthropic en `AppError` typée. Ne propage
 * jamais le `err.message` brut (risque de fuite de clé si le SDK y
 * embarque l'auth header tronqué) — uniquement les codes HTTP et la
 * classe de l'erreur.
 *
 * Toujours `throw`, jamais return — signature `never` aide TS à comprendre
 * que le caller n'a pas à gérer un retour.
 */
function mapSdkError(err: unknown, context: Record<string, unknown>): never {
  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
    throw new ConfigError({
      message: "Anthropic API auth/permission denied",
      context: { ...context, status: err.status },
    });
  }
  if (err instanceof NotFoundError) {
    // Souvent = model_not_found (snapshot déprécié). Cf. CORR-3 :
    // comportement défensif voulu vs migration silencieuse.
    throw new ConfigError({
      message: "Anthropic API model not found (snapshot deprecated?)",
      context: { ...context, status: err.status },
    });
  }
  if (err instanceof BadRequestError || err instanceof UnprocessableEntityError) {
    throw new ConfigError({
      message: "Anthropic API rejected request",
      context: { ...context, status: err.status },
    });
  }
  if (err instanceof SdkRateLimitError) {
    throw new RateLimitError({
      message: "Anthropic API rate limit hit",
      context: { ...context, status: err.status },
    });
  }
  if (err instanceof InternalServerError) {
    throw new ExternalServiceError({
      message: "Anthropic API internal server error",
      context: { ...context, status: err.status },
    });
  }
  if (err instanceof APIConnectionError) {
    // Inclut APIConnectionTimeoutError + APIUserAbortError (sous-classes).
    throw new ExternalServiceError({
      message: "Anthropic API connection failure",
      context: { ...context, kind: err.constructor.name },
    });
  }
  if (err instanceof APIError) {
    // Catch-all pour autres erreurs HTTP non-couvertes ci-dessus.
    throw new ExternalServiceError({
      message: "Anthropic API error",
      context: { ...context, status: err.status },
    });
  }
  throw new InternalError({
    message: "Unexpected error during Anthropic call",
    context,
    cause: err,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation des options communes (DRY entre generate et generateWithTool)
// ─────────────────────────────────────────────────────────────────────────────

function assertNonEmpty(value: string, field: "system" | "user"): void {
  if (value.length === 0) {
    throw new ValidationError({
      message: `Anthropic generate: ${field} prompt is empty`,
      context: { field },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// generate() — sortie texte libre
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Appel "messages.create" non-streaming → texte concaténé de tous les
 * `text` blocks de la réponse. Les autres types de content blocks
 * (`thinking`, `tool_use`, etc.) sont ignorés silencieusement — utiliser
 * `generateWithTool` si tu attends une sortie structurée.
 */
export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  assertNonEmpty(opts.system, "system");
  assertNonEmpty(opts.user, "user");

  const client = getAnthropicClient();
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  let response: Anthropic.Messages.Message;
  try {
    response = await client.messages.create(
      {
        model: opts.model,
        max_tokens: maxTokens,
        temperature,
        system: opts.system,
        messages: [{ role: "user", content: opts.user }],
      },
      { timeout },
    );
  } catch (err) {
    mapSdkError(err, { op: "generate", model: opts.model });
  }

  const textParts: string[] = [];
  for (const block of response.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    }
  }

  return {
    text: textParts.join(""),
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
    // `stop_reason` est `StopReason | null` côté SDK. Le `null` arrive en
    // pratique sur des streams interrompus — hors scope ici. Default
    // `end_turn` si jamais le SDK retourne null sur un non-streaming.
    stopReason: (response.stop_reason ?? "end_turn") as StopReason,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// generateWithTool() — sortie structurée garantie via tool use
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Force Claude à appeler le tool fourni et retourne son payload validé
 * par le schéma Zod. Deux validations en cascade :
 *
 *   1. **Push (à l'envoi)** : `z.toJSONSchema` convertit le schéma Zod
 *      en JSON Schema attendu par le SDK Anthropic.
 *   2. **Pull (à la réception)** : on RE-VALIDE le payload `tool_use`
 *      retourné par Claude avec le SAME schéma Zod. Si Claude renvoie
 *      un payload non-conforme (rare, mais possible sur prompt
 *      ambigu), on throw `ExternalServiceError` plutôt que d'avaler
 *      silencieusement — le classifier d'intent S7a.2 catch et bascule
 *      en fail-safe STOP.
 *
 * On force `tool_choice: { type: "tool", name }` pour empêcher Claude
 * de répondre en texte libre — sortie structurée garantie ou exception.
 */
export async function generateWithTool<TInput>(
  opts: GenerateOptions & { tool: ToolDefinition<TInput> },
): Promise<ToolUseResult<TInput>> {
  assertNonEmpty(opts.system, "system");
  assertNonEmpty(opts.user, "user");

  const client = getAnthropicClient();
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  // Conversion Zod → JSON Schema (zod v4). Le `as` est nécessaire car
  // `z.toJSONSchema` retourne un type générique tandis qu'Anthropic
  // attend un shape `{ type: "object", properties, required, ... }`.
  // En pratique le converter zod produit exactement ce shape pour un
  // `z.object({...})`. Documenté + verrouillé par tests.
  const jsonSchema = z.toJSONSchema(
    opts.tool.inputSchema,
  ) as Anthropic.Messages.Tool["input_schema"];

  let response: Anthropic.Messages.Message;
  try {
    response = await client.messages.create(
      {
        model: opts.model,
        max_tokens: maxTokens,
        temperature,
        system: opts.system,
        messages: [{ role: "user", content: opts.user }],
        tools: [
          {
            name: opts.tool.name,
            description: opts.tool.description,
            input_schema: jsonSchema,
          },
        ],
        tool_choice: { type: "tool", name: opts.tool.name },
      },
      { timeout },
    );
  } catch (err) {
    mapSdkError(err, { op: "generateWithTool", model: opts.model, tool: opts.tool.name });
  }

  const toolBlock = response.content.find(
    (block): block is Extract<Anthropic.Messages.ContentBlock, { type: "tool_use" }> =>
      block.type === "tool_use" && block.name === opts.tool.name,
  );

  if (toolBlock === undefined) {
    throw new ExternalServiceError({
      message: "Anthropic response missing expected tool_use block",
      context: {
        op: "generateWithTool",
        tool: opts.tool.name,
        stopReason: response.stop_reason,
      },
    });
  }

  const parsed = opts.tool.inputSchema.safeParse(toolBlock.input);
  if (!parsed.success) {
    throw new ExternalServiceError({
      message: "Anthropic tool_use payload failed Zod validation",
      context: {
        op: "generateWithTool",
        tool: opts.tool.name,
        // On ne propage QUE path + code (jamais la valeur) — anti-fuite
        // d'inputs partiels si le payload de Claude contenait des données
        // sensibles miroirées depuis le prompt.
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          code: i.code,
        })),
      },
    });
  }

  return {
    toolInput: parsed.data,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}
