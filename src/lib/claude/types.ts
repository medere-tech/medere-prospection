/**
 * Types partagés du wrapper Claude et du classifier d'intent (S7a).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Périmètre S7a.0 — surface TYPÉE consommée par :
 *
 *   - `src/lib/claude/client.ts`        (S7a.1) wrapper SDK Anthropic
 *   - `src/lib/claude/intent-classifier.ts` (S7a.2) classifyReply
 *   - `src/lib/claude/prompts/classify-intent.ts` (S7a.2) prompt + tool schema
 *
 * Aucune logique métier ici — uniquement des types et des constantes
 * runtime qui seront verrouillées par les sentinelles GUARD-001 en S7a.2.
 */

import type { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Modèles Claude — IDs pinned snapshots
// ─────────────────────────────────────────────────────────────────────────────

/**
 * IDs de modèles Claude utilisés par le wrapper.
 *
 * 🔒 **Convention "snapshot strict"** : on utilise UNIQUEMENT des IDs
 * pinned (déterminisme absolu), JAMAIS d'alias evergreen côté Anthropic.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Cas par génération :
 *
 *   - **Haiku 4.5** est génération PRÉ-4.6. Doc Anthropic (juin 2026) :
 *     « For models before the 4.6 generation, entries in the Claude API
 *     alias column are convenience pointers that resolve to a dated model
 *     ID. » → l'alias `claude-haiku-4-5` peut bouger côté Anthropic. On
 *     fige donc le snapshot daté `claude-haiku-4-5-20251001`.
 *
 *   - **Sonnet 4.6** et **Opus 4.7** sont gen 4.6+ : IDs dateless
 *     officiellement pinned par Anthropic (« a dateless format that is
 *     also a pinned snapshot, not an evergreen pointer »). On les utilise
 *     tels quels — déjà pinned, pas d'alias mouvant à craindre.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi snapshot strict pour le classifier (Haiku) :
 *
 *   1. **Déterminisme compliance** — GUARD-001 expose à 20 M€ CNIL. Un
 *      alias dérivant vers une newer snapshot peut altérer la
 *      classification de messages limite ("Arrêtez de me déranger merci")
 *      sans qu'aucune sentinelle ne le détecte.
 *
 *   2. **Sentinelles testables** — `=== "claude-haiku-4-5-20251001"`
 *      verrouille un ID immuable. `=== "claude-haiku-4-5"` ne détecterait
 *      PAS un changement de target côté Anthropic.
 *
 *   3. **Fail-loud à la dépréciation** — un snapshot déprécié plante
 *      `model_not_found` → ticket dédié, re-validation prompt par
 *      compliance-auditor sur la nouvelle snapshot. Comportement défensif
 *      voulu vs migration silencieuse + régression terrain.
 *
 * Source : https://docs.anthropic.com/en/docs/about-claude/models (consulté
 * juin 2026 — décision CORR-3 du plan S7a).
 */
export const CLAUDE_MODELS = {
  /** Classifier d'intent (S7a.2). Le moins cher + le plus rapide. */
  HAIKU_4_5: "claude-haiku-4-5-20251001",
  /** Génération SMS commerciaux (S8). Équilibre qualité/coût. */
  SONNET_4_6: "claude-sonnet-4-6",
  /** Cas complexes rares (rédaction sur-mesure, escalation). */
  OPUS_4_7: "claude-opus-4-7",
} as const;

export type ClaudeModel = (typeof CLAUDE_MODELS)[keyof typeof CLAUDE_MODELS];

// ─────────────────────────────────────────────────────────────────────────────
// Generate — sortie texte libre
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options de `generate()`. `system` et `user` séparés pour respecter le
 * format messages de l'API Anthropic (system prompt distinct du user
 * turn).
 *
 * `timeoutMs` est obligatoirement non-`undefined` côté wrapper (le wrapper
 * applique une valeur par défaut si absent) — cf. CLAUDE.md piège
 * « fetch sans timeout, toujours `AbortController` ».
 */
export interface GenerateOptions {
  system: string;
  user: string;
  model: ClaudeModel;
  /** ∈ [0, 1]. Default appliqué par le wrapper : 0.7. Classifier force 0. */
  temperature?: number;
  /** Default wrapper : 1024. */
  maxTokens?: number;
  /** Default wrapper : 10_000. */
  timeoutMs?: number;
}

/**
 * Raison d'arrêt de la complétion — copie 1:1 de l'enum Anthropic SDK
 * (`@anthropic-ai/sdk` v0.99.0, `resources/messages/messages.d.ts`).
 *
 * - `end_turn`      : Claude a terminé naturellement sa réponse.
 * - `max_tokens`    : `maxTokens` atteint — sortie potentiellement tronquée.
 * - `stop_sequence` : une stop sequence custom a déclenché.
 * - `tool_use`      : Claude a émis un tool_use block (cf. `generateWithTool`).
 * - `pause_turn`    : pause extended/adaptive thinking — sera repris dans
 *                     un follow-up. Hors flow S7a (on n'active pas thinking
 *                     sur Haiku), mais on le matérialise pour ne pas
 *                     surprendre un appelant qui change de modèle.
 * - `refusal`       : Claude a refusé de répondre (politique sécurité
 *                     Anthropic). À traiter côté appelant comme une erreur
 *                     métier — la sortie texte sera vide ou minimale.
 */
export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "pause_turn"
  | "refusal";

/**
 * Comptage de tokens facturés. Le wrapper Pino loggera UNIQUEMENT ces
 * compteurs + le modèle + la durée, JAMAIS `system`/`user`/`text` qui
 * peuvent contenir PII (CLAUDE.md : pas de PII dans les logs).
 */
export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
}

export interface GenerateResult {
  text: string;
  usage: UsageStats;
  stopReason: StopReason;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool use — sortie structurée garantie
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Définition d'un "tool" Claude (function calling). Le schéma d'entrée
 * est exprimé en Zod ; le wrapper (S7a.1) le convertit en JSON Schema
 * avant de le passer au SDK. Côté retour, le wrapper RE-VALIDE la sortie
 * de Claude avec le même schéma Zod — un payload tool_use malformé n'a
 * AUCUNE chance de remonter au code applicatif.
 *
 * Cette double validation (push schema down + pull validate up) est la
 * raison pour laquelle le classifier d'intent (S7a.2) peut affirmer un
 * fail-safe robuste vers `STOP` : si Claude renvoie n'importe quoi, le
 * wrapper throw → classifier catch → fallback STOP + log Sentry.
 */
export interface ToolDefinition<TInput> {
  /** Identifiant tool. Convention : `snake_case` pour cohérence Anthropic. */
  name: string;
  /** Description rédigée passée à Claude (impacte le comportement). */
  description: string;
  /** Schéma Zod du payload d'entrée que Claude DOIT produire. */
  inputSchema: z.ZodType<TInput>;
}

/** Résultat de `generateWithTool()` : payload tool validé + compteurs. */
export interface ToolUseResult<TInput> {
  toolInput: TInput;
  usage: UsageStats;
}

// ─────────────────────────────────────────────────────────────────────────────
// Intent classifier (S7a.2) — vocabulaire fermé
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 🔒 **SENTINEL GUARD-001** — Vocabulaire fermé des intents.
 *
 * Le classifier d'intent (S7a.2) ferme le trou GUARD-001 (long-form
 * opt-out > 50 caractères non détecté par `isOptOut()`). Sa décision se
 * fait STRICTEMENT sur ces 4 valeurs.
 *
 * Sémantique :
 *   - `STOP`      → opt-out explicite ou implicite. Inngest (S8+) appelle
 *                   `markOptedOut()` via la voie compliance S6.
 *   - `OBJECTION` → refus poli ou différé ("pas intéressé pour
 *                   l'instant"). Pas un STOP juridique mais on coupe
 *                   gracieusement la campagne pour ce contact.
 *   - `INTERESSE` → signe d'intérêt clair (question, demande de
 *                   tarifs, RDV). Hand-off Slack vers commercial.
 *   - `NEUTRE`    → réponse non discriminante. On enchaîne avec le
 *                   prochain SMS du séquençage (sous réserve compliance).
 *
 * Modifier (ajout/retrait/réordo) DOIT passer par :
 *   (a) parler à Déthié,
 *   (b) re-validation compliance-auditor,
 *   (c) mise à jour GUARD-001 Notion,
 *   (d) re-validation prompt-engineer du prompt classifier.
 *
 * Verrouillé par un test sentinelle dans
 * `intent-classifier.test.ts` (S7a.2) qui fera échouer le build si la
 * liste change.
 */
export const INTENT_VALUES = ["STOP", "OBJECTION", "INTERESSE", "NEUTRE"] as const;

export type Intent = (typeof INTENT_VALUES)[number];

/**
 * Résultat de `classifyReply(rawMessage)`. Toujours retourné, JAMAIS
 * d'exception sur une réponse Claude correcte — les erreurs SDK sont
 * absorbées et matérialisées via `fallback: true`.
 *
 * - `confidence` ∈ [0, 1] : retournée par Claude via le tool schema.
 *   Utilisée pour télémétrie/observabilité ; PAS pour la décision (on
 *   trust l'intent). Une confidence basse sur "STOP" reste un STOP.
 *
 * - `reasoning` : explication courte (≤ 200 chars) écrite par Claude.
 *   Persistée dans l'audit log pour traçabilité juridique d'une coupure
 *   de conversation. Ne JAMAIS y inclure le message d'origine en clair
 *   (le prompt l'interdit côté Claude, le wrapper le tronque côté code).
 *
 * - `fallback` : `true` SSI la classification Claude a échoué (timeout,
 *   tool_use invalide, intent hors-enum…) ET qu'on a forcé `STOP` par
 *   précaution juridique. Doit déclencher une alerte Sentry/Slack — pas
 *   de fallback silencieux sinon on masque une dérive du SDK.
 */
export interface ClassificationResult {
  intent: Intent;
  confidence: number;
  reasoning: string;
  fallback: boolean;
}
