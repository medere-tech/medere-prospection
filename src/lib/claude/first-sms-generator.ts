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

import { generateWithTool } from "./client";
import {
  buildFirstSmsPrompt,
  FIRST_SMS_MAX_TOKENS,
  FIRST_SMS_MODEL,
  FIRST_SMS_PROMPT_VERSION,
  FIRST_SMS_TEMPERATURE,
  FIRST_SMS_TOOL,
  type FirstSmsContact,
} from "./prompts/first-sms";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

/** Identifiant d'opération pour logs/erreurs (snake_case projet). */
export const FIRST_SMS_GENERATOR_OP = "first_sms.generate" as const;

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

  // ── 3. Appel Claude (propagation erreurs SDK telles quelles) ──────────
  // Pas de try/catch ici — les erreurs `generateWithTool` (ConfigError,
  // RateLimitError, ExternalServiceError, InternalError) sont déjà
  // typées AppError par `client.ts::mapSdkError`. Inngest mappera
  // ConfigError → NonRetriableError automatiquement.
  const startedAt = Date.now();
  const result = await generateWithTool({
    model: FIRST_SMS_MODEL,
    system,
    user,
    temperature: FIRST_SMS_TEMPERATURE,
    maxTokens: FIRST_SMS_MAX_TOKENS,
    tool: FIRST_SMS_TOOL,
  });
  const generationDurationMs = Date.now() - startedAt;

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
