/**
 * Wrapper de génération du PREMIER SMS de prospection (S10.1.2.a).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rôle métier — sprint le plus risqué compliance
 *
 * Pipeline :
 *   1. Gardes d'entrée (firstName/lastName/speciality non vides)
 *   2. Build prompt via `buildFirstSmsPrompt` (escapeXml sur tous champs)
 *   3. Appel Claude `generateWithTool` (tool_use forcé + Zod validation)
 *   4. Triple-garde post-gen :
 *        a. `hasAIDisclosure(body)`              — AI Act art. 50
 *        b. `hasOptOut(body)`                     — L.34-5 CPCE
 *        c. `hasAdvertiserIdentification(body)`   — L.34-5 al. 5 CPCE
 *      Si UN seul check fail → `ExternalServiceError` retry-friendly,
 *      Inngest re-génère.
 *   5. Retour `GenerateFirstSmsResult` (body + metadata forensic)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Defense-in-depth — pourquoi 3 couches de validation
 *
 *   Couche 1 (SYSTEM prompt)    : instruit Claude d'inclure les 3 marqueurs
 *   Couche 2 (Zod schema tool)   : valide la STRUCTURE (50-160 chars)
 *   Couche 3 (Triple-garde wrap) : valide le CONTENU (3 marqueurs regex)
 *   Couche 4 (preSendCheck S5)   : ré-vérifie AVANT dispatch OVH (S10.1.4+)
 *
 * 4 couches : si une couche est compromise (LLM hallucine, dev oublie un
 * check, regex évolue), les autres tiennent. Coût marginal négligeable
 * (regex O(1)), bénéfice juridique majeur (sanctions cumulées : AI Act
 * 15 M€ + CNIL 20 M€ + L.34-5 375 k€).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pas de fallback artificiel — propagation SDK telle quelle
 *
 *   Contrairement à `intent-classifier` (S7a.2) qui retourne TOUJOURS un
 *   `ClassificationResult` (fallback STOP en cas d'erreur SDK), ce
 *   wrapper THROW sur toute erreur. Rationale :
 *
 *   - Le classifier doit décider quoi faire d'un inbound, même en cas
 *     d'erreur Claude (fail-safe STOP juridique).
 *
 *   - Le générateur 1er SMS NE doit PAS envoyer un faux SMS commercial
 *     "par défaut". Pas de SMS > faux SMS. Inngest retry naturel (4
 *     tentatives, backoff exponentiel) reprend si transitoire.
 *
 *   Les erreurs SDK Claude (`generateWithTool`) sont déjà typées
 *   `AppError` par `mapSdkError` (S7a.1). Le wrapper laisse remonter.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Sécurité — anti-fuite PII (sentinelle S9.3 reply-generator mimée)
 *
 *   - `args.contact` (firstName, lastName, city, etc.) JAMAIS loggé brut.
 *     Le wrapper ne log RIEN (cohérent reply-generator).
 *
 *   - `result.toolInput.body` (qui contient le prénom/nom du PS) JAMAIS
 *     loggé brut. L'AppError thrown N'INCLUT PAS le body — seul
 *     `bodyLength` est exposé pour télémétrie.
 *
 *   - `result.toolInput.reasoning` JAMAIS loggé brut (Claude pourrait
 *     citer indirectement le PS dans son explication).
 *
 *   - Si Claude fail Zod, `generateWithTool` throw `ExternalServiceError`
 *     avec `issues: [{path, code}]` sanitisé (déjà fait côté wrapper
 *     client.ts:370 — defense en profondeur).
 */

import { hasAdvertiserIdentification } from "@/lib/compliance/advertiser-identification";
import { hasAIDisclosure } from "@/lib/compliance/ai-disclosure";
import { hasOptOut } from "@/lib/compliance/opt-out";
import { ExternalServiceError, ValidationError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

import { generateWithTool } from "./client";
import {
  buildFirstSmsPrompt,
  FIRST_SMS_MAX_TOKENS,
  FIRST_SMS_MODEL,
  FIRST_SMS_PROMPT_VERSION,
  FIRST_SMS_TEMPERATURE,
  FIRST_SMS_TOOL,
  type FirstSmsContact,
  type FirstSmsToolInput,
} from "./prompts/first-sms";
import type { ToolUseResult } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

/** Identifiant d'opération pour logs/erreurs (snake_case projet). */
export const FIRST_SMS_GENERATOR_OP = "first_sms.generate" as const;

/**
 * 🔒 SENTINEL — Nombre max de tentatives `generateWithTool` (S10.1.14).
 *
 * Claude Sonnet 4.6 avec `temperature=0.3` génère parfois un body > 160 chars
 * malgré 3 emplacements de contrainte dans le SYSTEM prompt (golden test
 * couvre l'essentiel, mais des edge cases persistent : noms longs/composés,
 * spécialités longues, villes longues — cf. JSDoc `FIRST_SMS_PROMPT_VERSION`).
 *
 * 1 retry naïf (re-roll dice avec le même prompt) résout ~75% des cas
 * transitoires en pratique (mesure empirique Claude Sonnet). Au-delà de
 * 2 attempts, c'est un bug systémique du prompt — pas un transitoire —
 * et on laisse remonter l'erreur (Inngest reprendra côté `/send`, l'admin
 * verra une 502 explicite côté `/preview`).
 *
 * Latence ajoutée par le retry : +2-3s (acceptable preview UX avec spinner).
 */
export const FIRST_SMS_MAX_ATTEMPTS = 2 as const;

/**
 * Codes Zod éligibles au retry naïf — strictement les fluctuations LLM sur
 * la STRUCTURE du payload tool_use, pas les bugs de configuration :
 *
 *   - `too_big`       : body > FIRST_SMS_MAX_BODY_CHARS (cas principal Déthié)
 *   - `too_small`     : body < FIRST_SMS_MIN_BODY_CHARS (rare, prompt dégénéré)
 *   - `invalid_value` : enum mismatch (rare sur ce tool, défensif)
 *   - `invalid_type`  : type mismatch (rare, défensif — SDK assure le shape)
 *
 * Tout autre code Zod ou toute autre erreur (`ConfigError`, `RateLimitError`,
 * réseau, etc.) → PAS de retry, propagation directe.
 *
 * 🔒 Set readonly — modification = re-validation S10.1.14 + impact télémétrie.
 */
const RETRY_ELIGIBLE_ZOD_CODES: ReadonlySet<string> = new Set([
  "too_big",
  "too_small",
  "invalid_value",
  "invalid_type",
]);

/**
 * Détermine si une erreur de `generateWithTool` est due à une fluctuation
 * Claude sur la STRUCTURE Zod du tool_use payload (= retry-eligible).
 *
 * Pattern défensif : on inspecte `context.issues: Array<{path, code}>` qui
 * est posé par `client.ts:362-379` (déjà sanitisé là-bas — zéro PII).
 *
 * @returns `{ eligible: boolean, issues }` — `issues` est `[]` si l'erreur
 *          n'a pas la forme attendue (non-`ExternalServiceError` ou pas
 *          de `context.issues`), pour permettre un log forensique cohérent.
 */
function classifyZodFluctuation(err: unknown): {
  eligible: boolean;
  issues: Array<{ path: string; code: string }>;
} {
  if (!(err instanceof ExternalServiceError)) {
    return { eligible: false, issues: [] };
  }
  const ctx = err.context as { issues?: Array<{ path: string; code: string }> } | undefined;
  if (!ctx?.issues || !Array.isArray(ctx.issues)) {
    return { eligible: false, issues: [] };
  }
  const eligible = ctx.issues.some(
    (i) => typeof i.code === "string" && RETRY_ELIGIBLE_ZOD_CODES.has(i.code),
  );
  return { eligible, issues: ctx.issues };
}

// ─────────────────────────────────────────────────────────────────────────────
// Types publics
// ─────────────────────────────────────────────────────────────────────────────

export interface GenerateFirstSmsArgs {
  contact: FirstSmsContact;
}

/**
 * Résultat de `generateFirstSms()`. Le `body` est PRÊT à être stocké en
 * Firestore comme draft (S10.1.4+) puis envoyé via OVH (S10.1.4+ Inngest).
 * Le `preSendCheck` (S5) sera réappliqué côté envoi en defense-in-depth.
 *
 * `promptVersion` + `model` + `temperature` exposés pour audit forensic :
 * stockés dans le message Firestore pour rejouabilité en cas de plainte.
 */
export interface GenerateFirstSmsResult {
  body: string;
  reasoning: string;
  promptVersion: typeof FIRST_SMS_PROMPT_VERSION;
  model: typeof FIRST_SMS_MODEL;
  temperature: typeof FIRST_SMS_TEMPERATURE;
  tokensInput: number;
  tokensOutput: number;
  generationDurationMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers internes — gardes d'entrée
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Valide qu'un champ string est non vide après trim. Throw `ValidationError`
 * sans inclure la VALEUR du champ (anti-fuite PII : un caller buggué qui
 * passe un firstName potentiellement sensible ne doit pas le voir loggé).
 */
function assertNonEmptyField(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError({
      message: `generateFirstSms: contact.${field} is empty or not a string`,
      context: {
        op: FIRST_SMS_GENERATOR_OP,
        field,
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// generateFirstSms
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Génère le body du PREMIER SMS de prospection pour un PS Médéré.
 *
 * @throws ValidationError       si `contact.firstName`, `contact.lastName`,
 *                               ou `contact.speciality` sont vides/non-string.
 * @throws ExternalServiceError  si un des 3 marqueurs compliance est
 *                               absent du body généré (triple-garde —
 *                               retry Inngest naturel).
 * @throws AppError              propagée du wrapper `generateWithTool`
 *                               (ConfigError, RateLimitError,
 *                               ExternalServiceError, InternalError).
 *
 * ⚠️ NE log RIEN — cohérent reply-generator S9.3 (anti-fuite PII).
 */
export async function generateFirstSms(
  args: GenerateFirstSmsArgs,
): Promise<GenerateFirstSmsResult> {
  // ── 1. Gardes d'entrée ────────────────────────────────────────────────
  assertNonEmptyField(args.contact.firstName, "firstName");
  assertNonEmptyField(args.contact.lastName, "lastName");
  assertNonEmptyField(args.contact.speciality, "speciality");
  // `civilite` et `city` peuvent être undefined/vides (gérés par le builder).

  // ── 2. Build prompt (escapeXml sur tous champs externes) ──────────────
  const { system, user } = buildFirstSmsPrompt({ contact: args.contact });

  // ── 3. Appel Claude avec retry naïf sur fluctuation Zod (S10.1.14) ─────
  // Boucle bornée par FIRST_SMS_MAX_ATTEMPTS. Retry-eligibility STRICTE
  // (ExternalServiceError + issues Zod dans RETRY_ELIGIBLE_ZOD_CODES) —
  // les ConfigError/RateLimitError/InternalError/network errors propagent
  // tels quels (Inngest mappera ConfigError → NonRetriableError, RateLimit
  // est géré côté caller Upstash, etc.).
  //
  // Re-roll naïf (même prompt) car avec temperature=0.3, ~75% des cas
  // transitoires "body > 160 chars" passent au 2e dice. Pas d'injection
  // de prompt extra "fais plus court" — diminishing returns + risque de
  // dérive contenu.
  //
  // Latence : +2-3s par retry. Acceptable preview UX (loading state déjà
  // géré côté UI). /send route via Inngest gère ses propres retries au
  // niveau supérieur — le retry interne ici lui évite juste de gaspiller
  // un slot Inngest sur un transitoire.
  const startedAt = Date.now();
  let result: ToolUseResult<FirstSmsToolInput> | undefined;
  let attempt = 0;
  while (attempt < FIRST_SMS_MAX_ATTEMPTS) {
    attempt++;
    try {
      result = await generateWithTool({
        model: FIRST_SMS_MODEL,
        system,
        user,
        temperature: FIRST_SMS_TEMPERATURE,
        maxTokens: FIRST_SMS_MAX_TOKENS,
        tool: FIRST_SMS_TOOL,
      });
      break;
    } catch (err) {
      const { eligible, issues } = classifyZodFluctuation(err);
      // Eligible + il reste au moins 1 attempt → log + retry
      if (eligible && attempt < FIRST_SMS_MAX_ATTEMPTS) {
        // 🚨 ANTI-PII — `issues` est `[{path, code}]` déjà sanitisé par
        // `client.ts:374-377`. Pas de `body`, pas de `reasoning`, pas de
        // valeur reçue Zod. Le log Pino projet scrubber couvre en aval.
        logger.warn(
          {
            op: `${FIRST_SMS_GENERATOR_OP}.retry`,
            attempt,
            maxAttempts: FIRST_SMS_MAX_ATTEMPTS,
            issues,
            model: FIRST_SMS_MODEL,
            promptVersion: FIRST_SMS_PROMPT_VERSION,
          },
          "first-sms-generator: Anthropic Zod fluctuation, retrying",
        );
        continue;
      }
      // Non-eligible OU plus de retry disponible → propagation telle quelle
      throw err;
    }
  }
  const generationDurationMs = Date.now() - startedAt;

  // Invariant boucle : si on sort sans break OU throw, c'est un bug logique.
  // Le `break` post-success et le `throw` post-exhaustion couvrent les 2
  // chemins de sortie. Le `if (result === undefined)` ici est defense-in-
  // depth pour le typecheck strict (sinon TS ne peut pas narrow).
  if (result === undefined) {
    throw new ExternalServiceError({
      message: "generateFirstSms: retry loop exited without result (invariant violated)",
      context: { op: FIRST_SMS_GENERATOR_OP, attempt, maxAttempts: FIRST_SMS_MAX_ATTEMPTS },
    });
  }

  const { body, reasoning } = result.toolInput;

  // ── 4. Triple-garde post-gen ───────────────────────────────────────────
  // Les 3 marqueurs compliance sont validés par regex `compliance/*.ts`.
  // Si UN seul échoue → ExternalServiceError retry-friendly. Inngest
  // re-génère avec backoff exponentiel.
  //
  // ⚠️ Le context NE CONTIENT JAMAIS `body` ni `reasoning` ni `args.contact`.
  // Seuls `bodyLength`, `op`, `model`, `promptVersion` sont exposés —
  // suffisants pour télémétrie, zéro fuite PII.

  if (!hasAIDisclosure(body)) {
    throw new ExternalServiceError({
      message:
        "generateFirstSms: LLM omitted AI disclosure (AI Act art. 50) — triple-garde tripped, retry to regenerate",
      context: {
        op: FIRST_SMS_GENERATOR_OP,
        check: "hasAIDisclosure",
        bodyLength: body.length,
        model: FIRST_SMS_MODEL,
        promptVersion: FIRST_SMS_PROMPT_VERSION,
      },
    });
  }

  if (!hasOptOut(body)) {
    throw new ExternalServiceError({
      message:
        "generateFirstSms: LLM omitted STOP opt-out (L.34-5 CPCE) — triple-garde tripped, retry to regenerate",
      context: {
        op: FIRST_SMS_GENERATOR_OP,
        check: "hasOptOut",
        bodyLength: body.length,
        model: FIRST_SMS_MODEL,
        promptVersion: FIRST_SMS_PROMPT_VERSION,
      },
    });
  }

  if (!hasAdvertiserIdentification(body)) {
    throw new ExternalServiceError({
      message:
        "generateFirstSms: LLM omitted 'Médéré' identification (L.34-5 al. 5 CPCE) — triple-garde tripped, retry to regenerate",
      context: {
        op: FIRST_SMS_GENERATOR_OP,
        check: "hasAdvertiserIdentification",
        bodyLength: body.length,
        model: FIRST_SMS_MODEL,
        promptVersion: FIRST_SMS_PROMPT_VERSION,
      },
    });
  }

  // ── 5. Retour structuré ────────────────────────────────────────────────
  return {
    body,
    reasoning,
    promptVersion: FIRST_SMS_PROMPT_VERSION,
    model: FIRST_SMS_MODEL,
    temperature: FIRST_SMS_TEMPERATURE,
    tokensInput: result.usage.inputTokens,
    tokensOutput: result.usage.outputTokens,
    generationDurationMs,
  };
}
