/**
 * Générateur de réponse SMS conversationnelle (S9.3.2).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rôle métier
 *
 * Génère le body d'un SMS de réponse à envoyer au PS APRÈS classification
 * de son inbound par le classifier S7a.2. Cible UNIQUEMENT les branches
 * non-STOP (INTERESSE / OBJECTION / NEUTRE) — la branche STOP NE doit
 * PAS être envoyée ici (le PS a demandé d'arrêter, on respecte).
 *
 * Le wrapper dispatche sur l'intent vers le bon prompt verrouillé
 * (`generate-reply-{intent}.ts`), appelle Claude Sonnet 4.6, et valide
 * post-génération que la mention "Médéré" (obligation L.34-5 al. 5 CPCE)
 * est bien présente (triple garde Q3).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Décisions de design (S9.3.0 validées par Déthié)
 *
 *   - **Modèle** : `CLAUDE_MODELS.SONNET_4_6` (`"claude-sonnet-4-6"`,
 *     dateless pinned post-4.6 — pas d'alias mouvant côté Anthropic).
 *     Snapshot strict pour déterminisme compliance, cohérent S7a.2
 *     CORR-3. Verrouillé par sentinelle.
 *
 *   - **Temperature** : 0.5 — compromis entre déterminisme (cohérence
 *     du ton) et naturel (éviter le robotique). Verrouillée par
 *     sentinelle.
 *
 *   - **Max tokens** : 200 — borne de sécurité large pour 1 SMS ~140
 *     chars (env. 50-60 tokens en français). Au-delà, signal d'un prompt
 *     mal calibré.
 *
 *   - **Pas de mention IA** : verdict S9.3.0 section 3.F — le 1er SMS
 *     prod identifie "Léa, assistante virtuelle" (garde code
 *     `pre-send-check.ts:479`). Réévaluer Q2 si la garde est retirée
 *     en S9.5+ (caveat compliance-auditor S9.3.4).
 *
 *   - **Triple garde Médéré** (Q3 S9.3.0) :
 *       1. SYSTEM prompt instruit Claude d'inclure "Médéré".
 *       2. **Ce wrapper** ré-assert via `hasAdvertiserIdentification`
 *          post-génération (defense-in-depth — `ExternalServiceError`
 *          retry-friendly si oubli LLM → Inngest re-génère).
 *       3. `preSendCheck` rule 4 ré-vérifie avant envoi OVH (S9.4).
 *
 *   - **Pas de fallback artificiel** : si Claude est down (timeout,
 *     429, 5xx) OU si Claude omet "Médéré", on **THROW** une
 *     `AppError` retry-friendly → Inngest retry naturel (4 tentatives,
 *     backoff exponentiel). Un faux SMS commercial serait pire qu'un
 *     retry.
 *
 *   - **Historique limité** : 3 derniers messages max (décision Déthié
 *     S9.3.0). Validé en garde d'entrée pour empêcher un caller futur
 *     de passer 50 messages → coût Claude + risque dilution intent.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Sécurité — anti-fuite PII (sentinelle S9)
 *
 *   - Le `rawMessage` du PS et l'historique NE SONT JAMAIS loggés en
 *     clair, à aucun niveau, dans aucun chemin. Un PS peut écrire son
 *     numéro / email dans sa réponse — log non scrubé = fuite RGPD.
 *
 *   - Le wrapper `client.ts` est discipliné (pas de log de
 *     system/user/text). Ce générateur ne logge rien lui-même — il se
 *     limite à propager les `AppError` vers le caller (Inngest function
 *     S9.3.3) qui décidera du logging scrubber-safe.
 *
 *   - En cas d'erreur SDK ou de violation triple garde Médéré, l'AppError
 *     thrown N'INCLUT PAS le `result.text` brut (potentiellement PII miroir
 *     du message PS). Seul `bodyLength` est exposé pour télémétrie.
 */

import { hasAdvertiserIdentification } from "@/lib/compliance/advertiser-identification";
import { ExternalServiceError, ValidationError } from "@/lib/utils/errors";

import { generate } from "./client";
import {
  buildGenerateReplyInteressePrompt,
  GENERATE_REPLY_INTERESSE_PROMPT_VERSION,
  type ReplyHistoryEntry,
} from "./prompts/generate-reply-interesse";
import {
  buildGenerateReplyNeutrePrompt,
  GENERATE_REPLY_NEUTRE_PROMPT_VERSION,
} from "./prompts/generate-reply-neutre";
import {
  buildGenerateReplyObjectionPrompt,
  GENERATE_REPLY_OBJECTION_PROMPT_VERSION,
} from "./prompts/generate-reply-objection";
import { CLAUDE_MODELS, type ClaudeModel } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes verrouillées par sentinelles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 🔒 SENTINEL — Modèle figé. Dateless pinned snapshot Anthropic post-4.6
 * (cf. `CLAUDE_MODELS.SONNET_4_6` JSDoc). Toute modification DOIT
 * (a) parler à Déthié, (b) re-validation compliance-auditor,
 * (c) re-validation prompt-engineer sur les 3 prompts gen-reply.
 */
export const GENERATE_REPLY_MODEL: ClaudeModel = CLAUDE_MODELS.SONNET_4_6;

/**
 * 🔒 SENTINEL — Temperature 0.5 (compromis naturel + cohérence).
 * Modification = bump VERSION des 3 prompts + re-validation.
 */
export const GENERATE_REPLY_TEMPERATURE = 0.5 as const;

/**
 * 🔒 SENTINEL — Max tokens. 200 = ~150 mots en français, large pour
 * 1 SMS ~140 chars (~50-60 tokens). Borne de sécurité contre runaway.
 */
export const GENERATE_REPLY_MAX_TOKENS = 200 as const;

/**
 * Borne stricte sur la taille de l'historique (décision Déthié S9.3.0).
 * Au-delà : `ValidationError` (signal d'un bug d'orchestration côté
 * caller — un pipeline qui chargerait 50 messages dans le contexte
 * dégrade l'intent + coût Claude inutile).
 */
const HISTORY_MAX_ENTRIES = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Types publics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Intents autorisés pour la génération de reply. Sous-ensemble fermé
 * de `INTENT_VALUES` (`./types`) qui EXCLUT volontairement "STOP" — le
 * caller (Inngest function S9.3.3) doit déjà avoir court-circuité les
 * STOP avant d'appeler `generateReply`. Si "STOP" arrive ici, le
 * dispatch switch lèvera (cas non couvert volontairement).
 */
export type GenerateReplyIntent = "INTERESSE" | "OBJECTION" | "NEUTRE";

export interface GenerateReplyArgs {
  intent: GenerateReplyIntent;
  /** Texte brut du dernier inbound PS (= ce qu'on classifie + à quoi on répond). */
  rawMessage: string;
  /**
   * 3 derniers messages de la conversation (max). Ordre chronologique
   * croissant attendu (les plus anciens en premier) — c'est le caller
   * qui décide de l'ordre, ce wrapper ne re-trie pas.
   */
  history: ReplyHistoryEntry[];
  /** Optionnel — "Dr", "Docteur", "Pr". Injecté dans le prompt si présent. */
  contactCivility?: string;
}

/**
 * Résultat de `generateReply()`. Le `body` retourné est PRÊT à être
 * stocké en Firestore comme draft (S9.3.3) puis envoyé via OVH (S9.4).
 * Le `preSendCheck` (S5) sera réappliqué côté envoi en defense-in-depth.
 *
 * `tokensInput`/`tokensOutput` exposés pour audit S9.3.3 + télémétrie
 * coût Claude.
 */
export interface GenerateReplyResult {
  body: string;
  promptVersion: string;
  model: ClaudeModel;
  temperature: number;
  tokensInput: number;
  tokensOutput: number;
  generationDurationMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fonction publique
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Génère le body d'un SMS de réponse au PS, conformément à la branche
 * d'intent (INTERESSE / OBJECTION / NEUTRE). Voir JSDoc en-tête du
 * fichier pour le contrat complet (modèle, temperature, triple garde
 * Médéré, propagation erreurs SDK).
 *
 * @throws ValidationError       si `rawMessage` vide / non-string, ou si
 *                               `history.length > HISTORY_MAX_ENTRIES`.
 * @throws ExternalServiceError  si Claude omet "Médéré" (triple garde
 *                               defense-in-depth — retry Inngest naturel).
 * @throws AppError              propagée du wrapper `generate` (ConfigError,
 *                               RateLimitError, ExternalServiceError,
 *                               InternalError selon le cas SDK).
 */
export async function generateReply(args: GenerateReplyArgs): Promise<GenerateReplyResult> {
  // ── 1. Gardes d'entrée ──────────────────────────────────────────────
  if (typeof args.rawMessage !== "string" || args.rawMessage.length === 0) {
    throw new ValidationError({
      message: "generateReply: rawMessage is empty or not a string",
      context: { intent: args.intent, op: "generateReply" },
    });
  }
  if (args.history.length > HISTORY_MAX_ENTRIES) {
    throw new ValidationError({
      message: `generateReply: history must contain at most ${HISTORY_MAX_ENTRIES} entries`,
      context: {
        intent: args.intent,
        historyLength: args.history.length,
        maxEntries: HISTORY_MAX_ENTRIES,
        op: "generateReply",
      },
    });
  }

  // ── 2. Dispatch sur intent → prompt builder verrouillé ──────────────
  const dispatch = dispatchPrompt(args);

  // ── 3. Appel Claude (propagation erreurs SDK telles quelles) ────────
  // Aucun try/catch ici. Les erreurs `generate()` (ConfigError,
  // RateLimitError, ExternalServiceError, InternalError) sont déjà
  // typées AppError par `client.ts::mapSdkError` — les laisser remonter
  // au caller Inngest qui décidera (NonRetriableError vs retry naturel).
  const startedAt = Date.now();
  const result = await generate({
    model: GENERATE_REPLY_MODEL,
    system: dispatch.prompts.system,
    user: dispatch.prompts.user,
    temperature: GENERATE_REPLY_TEMPERATURE,
    maxTokens: GENERATE_REPLY_MAX_TOKENS,
  });
  const generationDurationMs = Date.now() - startedAt;

  // ── 4. Triple garde Médéré — assertion code post-génération ─────────
  // Le SYSTEM prompt instruit Claude d'inclure "Médéré" (étape 1 de la
  // triple garde). Ici on ré-assert (étape 2) avant de retourner le body
  // au caller — defense-in-depth. Si Claude oublie (rare mais possible),
  // on throw une ExternalServiceError retry-friendly → Inngest re-génère.
  //
  // ⚠️ NE PAS inclure `result.text` dans le context — le body LLM peut
  // contenir des fragments PII miroirés du message PS (rare mais
  // possible si Claude reformule). Seul `bodyLength` est exposé.
  if (!hasAdvertiserIdentification(result.text)) {
    throw new ExternalServiceError({
      message:
        "generateReply: LLM omitted 'Médéré' identification — triple garde tripped, retry to regenerate",
      context: {
        intent: args.intent,
        bodyLength: result.text.length,
        model: GENERATE_REPLY_MODEL,
        promptVersion: dispatch.promptVersion,
        op: "generateReply",
      },
    });
  }

  return {
    body: result.text,
    promptVersion: dispatch.promptVersion,
    model: GENERATE_REPLY_MODEL,
    temperature: GENERATE_REPLY_TEMPERATURE,
    tokensInput: result.usage.inputTokens,
    tokensOutput: result.usage.outputTokens,
    generationDurationMs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers internes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dispatche les `args` vers le bon prompt builder selon l'intent.
 * Retourne `{ prompts: {system, user}, promptVersion }` directement
 * utilisable par `generate()` + `result.promptVersion`.
 *
 * Le `switch` exhaustif sur `GenerateReplyIntent` (3 valeurs) garantit
 * au compile-time qu'on n'oublie pas un cas si un nouvel intent est
 * ajouté à l'union — TS lèvera "Function lacks ending return statement".
 */
function dispatchPrompt(args: GenerateReplyArgs): {
  prompts: { system: string; user: string };
  promptVersion: string;
} {
  const builderArgs = {
    rawMessage: args.rawMessage,
    history: args.history,
    ...(args.contactCivility !== undefined && { contactCivility: args.contactCivility }),
  };

  switch (args.intent) {
    case "INTERESSE":
      return {
        prompts: buildGenerateReplyInteressePrompt(builderArgs),
        promptVersion: GENERATE_REPLY_INTERESSE_PROMPT_VERSION,
      };
    case "OBJECTION":
      return {
        prompts: buildGenerateReplyObjectionPrompt(builderArgs),
        promptVersion: GENERATE_REPLY_OBJECTION_PROMPT_VERSION,
      };
    case "NEUTRE":
      return {
        prompts: buildGenerateReplyNeutrePrompt(builderArgs),
        promptVersion: GENERATE_REPLY_NEUTRE_PROMPT_VERSION,
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exposés pour tests sentinelles
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export const __HISTORY_MAX_ENTRIES_FOR_TESTS = HISTORY_MAX_ENTRIES;
