/**
 * Classifier d'intent pour les messages INBOUND (réponses des PS).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Ferme GUARD-001 (Notion) — `isOptOut()` court-form rate les opt-out
 * longs ou détournés. Le classifier comble ce trou avec un appel Claude
 * Haiku 4.5 + tool use forcé (sortie structurée garantie).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Contrat fonctionnel
 *
 *   - Input  : `rawMessage` (string non vide) — le texte brut de la
 *              réponse SMS du PS.
 *   - Output : `ClassificationResult` (TOUJOURS — jamais d'exception sur
 *              erreur SDK).
 *
 * Le contrat "toujours retourner un résultat" est intentionnel :
 *
 *   - Le caller (Inngest function `process-reply`, S8+) doit pouvoir
 *     décider une action déterministe sans à avoir à wrap le call dans
 *     un try/catch supplémentaire.
 *
 *   - En cas d'échec SDK (clé invalide, rate limit, timeout, tool_use
 *     malformé…), le classifier bascule en **fail-safe STOP** :
 *       `{ intent: "STOP", confidence: 0, reasoning: "fallback: ...",
 *          fallback: true }`
 *
 *   - Le flag `fallback: true` permet au caller d'acter "STOP par défaut
 *     technique" différemment d'un STOP authentique (audit log, métrique
 *     Sentry, alerte ops si taux > 5%).
 *
 *   - Précaution juridique (cf. `isOptOut` JSDoc) : on préfère un faux
 *     positif STOP (couper la conversation) à un faux négatif (rater un
 *     opt-out → sanction CNIL jusqu'à 20 M€).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Le SEUL cas où on throw : `rawMessage` vide ou non-string. C'est un
 * bug de code amont (l'appelant n'aurait pas dû arriver là avec un
 * payload corrompu) → `ValidationError` 400 pour faire surface.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Sécurité — anti-fuite PII (sentinelle S9)
 *
 *   - Le `rawMessage` n'est JAMAIS loggé en clair, à aucun niveau, dans
 *     aucun chemin (succès, fallback, validation). Un PS peut écrire son
 *     numéro / email dans sa réponse — log non scrubé = fuite RGPD.
 *
 *   - Le wrapper `client.ts` est déjà discipliné (pas de log de
 *     system/user/text). Le classifier ne fait QUE logger ce qui est sûr :
 *     model + promptVersion + duration + kind d'erreur.
 *
 *   - Le logger Pino (S1) a un filet de redaction multicouche mais on ne
 *     compte PAS dessus : on ne lui donne rien à scrubber.
 */

import { isAppError } from "@/lib/utils/errors";
import { ValidationError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

import { generateWithTool } from "./client";
import {
  buildClassifyIntentPrompt,
  CLASSIFY_INTENT_MODEL,
  CLASSIFY_INTENT_PROMPT_VERSION,
  CLASSIFY_INTENT_TEMPERATURE,
  CLASSIFY_INTENT_TOOL_DESCRIPTION,
  CLASSIFY_INTENT_TOOL_NAME,
  classifyIntentToolInputSchema,
} from "./prompts/classify-intent";
import type { ClassificationResult } from "./types";

/**
 * Reasoning figé du fail-safe — garde court, sans interpolation, pour
 * éviter d'y embarquer accidentellement quoi que ce soit du contexte
 * d'erreur (qui pourrait contenir des bouts du payload SDK).
 */
const FALLBACK_REASONING = "fallback: classifier failed, defaulting to STOP";

/**
 * Classifie une réponse SMS entrante en l'un des 4 `INTENT_VALUES`.
 *
 * @throws ValidationError si `rawMessage` est vide / whitespace-only.
 *         Aucune autre exception possible (fail-safe STOP sinon).
 */
export async function classifyReply(rawMessage: string): Promise<ClassificationResult> {
  if (typeof rawMessage !== "string" || rawMessage.trim().length === 0) {
    throw new ValidationError({
      message: "classifyReply: rawMessage is empty or not a string",
      context: { op: "classifyReply" },
    });
  }

  const { system, user } = buildClassifyIntentPrompt(rawMessage);

  try {
    const result = await generateWithTool({
      system,
      user,
      model: CLASSIFY_INTENT_MODEL,
      temperature: CLASSIFY_INTENT_TEMPERATURE,
      tool: {
        name: CLASSIFY_INTENT_TOOL_NAME,
        description: CLASSIFY_INTENT_TOOL_DESCRIPTION,
        inputSchema: classifyIntentToolInputSchema,
      },
    });

    return {
      intent: result.toolInput.intent,
      confidence: result.toolInput.confidence,
      reasoning: result.toolInput.reasoning,
      fallback: false,
    };
  } catch (err) {
    // ⚠️ Aucune information du rawMessage / system / user / payload SDK
    // ne passe dans le log. On loggue uniquement ce qui est sûr.
    const { errKind, errCode } = describeError(err);
    logger.error(
      {
        module: "intent-classifier",
        op: "classifyReply",
        promptVersion: CLASSIFY_INTENT_PROMPT_VERSION,
        model: CLASSIFY_INTENT_MODEL,
        errKind,
        errCode,
      },
      "intent classifier fallback to STOP",
    );

    return {
      intent: "STOP",
      confidence: 0,
      reasoning: FALLBACK_REASONING,
      fallback: true,
    };
  }
}

/**
 * Caractérise une valeur catchée pour logging sûr.
 *
 * Justification de la simplicité (juste 2 cas) :
 *
 *   - Le wrapper `generateWithTool` (S7a.1) catche TOUTES les erreurs
 *     SDK et les wrap en `AppError` typée (`ConfigError`,
 *     `RateLimitError`, `ExternalServiceError`, `InternalError`). Il
 *     normalise aussi les `tool_use` malformés en `ExternalServiceError`
 *     et la conversion Zod en `ValidationError`. Conclusion : tout ce
 *     qui sort de `generateWithTool` EST une `AppError`.
 *
 *   - Le seul cas où le `catch` peut recevoir autre chose qu'une
 *     `AppError` est un bug qui contredit cette garantie (régression
 *     wrapper, monkey-patch en test, throw exotique non attrapé). Pas
 *     besoin de discriminer `Error` nu vs `string` thrown : un
 *     `errKind: "unknown"` est un sentinel suffisant pour déclencher
 *     l'alerte ops + l'investigation Sentry.
 *
 * Une branche "Error nu mais pas AppError" serait dead code détectable
 * uniquement via test bypass — on évite. Si la garantie wrapper change
 * (hypothèse S8+), bumper le helper en conséquence.
 */
function describeError(err: unknown): { errKind: string; errCode: string | undefined } {
  if (isAppError(err)) {
    return { errKind: err.constructor.name, errCode: err.code };
  }
  return { errKind: "unknown", errCode: undefined };
}
