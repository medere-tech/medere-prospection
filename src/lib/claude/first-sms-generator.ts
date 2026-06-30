/**
 * Wrapper de génération du PREMIER SMS de prospection (S10.1.2.a + v2.0.0 S10.1.14).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rôle métier — sprint le plus risqué compliance
 *
 * Pipeline v2.0.0 (refactor architectural S10.1.14) :
 *   1. Gardes d'entrée (firstName/lastName/speciality non vides)
 *   2. Build prompt via `buildFirstSmsPrompt` (escapeXml sur tous champs)
 *   3. Appel Claude `generateWithTool` (tool_use forcé + Zod schema v3.0.1 :
 *      { accroche: 30-50 } — `reasoning` retiré v3.0.1 S10.2-REASONING-REMOVAL)
 *   4. **Assemble code-side via `assembleFirstSms()`** :
 *        `"Bonjour {civilité} {nom}, je suis Léa de Médéré. {accroche} STOP."`
 *      Garantie mathématique ≤ 160 chars pour 99%+ noms FR (nom ≤ 52 chars).
 *      Garde-fou code : throw `ExternalServiceError` si > 160 (nom extrême).
 *   5. Triple-garde post-gen :
 *        a. `hasAIDisclosure(body)`              — AI Act art. 50
 *        b. `hasOptOut(body)`                     — L.34-5 CPCE
 *        c. `hasAdvertiserIdentification(body)`   — L.34-5 al. 5 CPCE
 *      Passent PAR CONSTRUCTION en v2 (l'assemble inclut TOUJOURS "je suis
 *      Léa de Médéré." + "STOP."), mais préservés en defense-in-depth si
 *      `assembleFirstSms()` est cassé dans un refactor futur.
 *   6. Retour `GenerateFirstSmsResult` (body assemblé + metadata forensic)
 *
 * Pipeline v1.0.x (REMPLACÉ) :
 *   Claude générait le SMS COMPLET avec triple obligation embedded
 *   (annonce IA + Médéré + STOP). Cas vulnérable : > 160 chars Zod
 *   too_big sur edge cases (noms longs, civilités/spécialités/villes
 *   longues). Retry naïf du commit a 7f45105 INSUFFISANT (~50% 502 finaux
 *   en smoke test : la fluctuation est SYSTÉMIQUE, pas aléatoire).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Defense-in-depth — 4 couches de validation v2.0.0
 *
 *   Couche 1 (SYSTEM prompt v2)  : instruit Claude de générer SEULEMENT
 *                                   l'accroche personnalisée
 *   Couche 2 (Zod schema v2)     : valide la STRUCTURE accroche (30-65 chars)
 *   Couche 3 (assembleFirstSms)  : assemble le body final + garde-fou ≤ 160
 *   Couche 4 (Triple-garde wrap) : valide les 3 marqueurs regex (passe par
 *                                   construction post-assemble, alerte si cassé)
 *   Couche 5 (preSendCheck S5)   : ré-vérifie AVANT dispatch OVH
 *
 * Coût marginal négligeable, bénéfice juridique majeur (sanctions cumulées :
 * AI Act 15 M€ + CNIL 20 M€ + L.34-5 375 k€).
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
 *     tentatives, backoff exponentiel) reprend si transitoire (réseau /
 *     5xx Claude).
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
 *   - `result.toolInput.accroche` (qui peut inclure le nom du PS si Claude
 *     dérive) JAMAIS loggé brut. L'AppError thrown N'INCLUT NI accroche
 *     NI body assemblé — seuls les LONGUEURS sont exposées pour télémétrie.
 *
 *   - Si Claude fail Zod, `generateWithTool` throw `ExternalServiceError`
 *     avec `issues: [{path, code}]` sanitisé (déjà fait côté wrapper
 *     client.ts:370 — defense en profondeur).
 *
 *   - `assembleFirstSms()` garde-fou : si body > 160 → throw context
 *     contient `assembledLength` + `accrocheLength` + `nameLength` mais
 *     PAS le body assemblé ni le nom brut (PII).
 */

import { hasAdvertiserIdentification } from "@/lib/compliance/advertiser-identification";
import { hasAIDisclosure } from "@/lib/compliance/ai-disclosure";
import { hasOptOut } from "@/lib/compliance/opt-out";
import { ExternalServiceError, ValidationError } from "@/lib/utils/errors";

import { generateWithTool } from "./client";
import {
  buildFirstSmsPrompt,
  FIRST_SMS_MAX_BODY_CHARS,
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

/** Identifiant d'opération `assembleFirstSms` (snake_case projet). */
export const ASSEMBLE_FIRST_SMS_OP = "first_sms.assemble" as const;

// ─────────────────────────────────────────────────────────────────────────────
// Types publics
// ─────────────────────────────────────────────────────────────────────────────

export interface GenerateFirstSmsArgs {
  contact: FirstSmsContact;
}

/**
 * Résultat de `generateFirstSms()`. Le `body` est PRÊT à être stocké en
 * Firestore comme draft puis envoyé via OVH (Inngest).
 * Le `preSendCheck` (S5) sera réappliqué côté envoi en defense-in-depth.
 *
 * `promptVersion` + `model` + `temperature` exposés pour audit forensic :
 * stockés dans le message Firestore pour rejouabilité en cas de plainte.
 *
 * 🚨 Interface PUBLIQUE INCHANGÉE en v2.0.0 — `body` reste une string
 * complète (le SMS final assemblé), pour compat callers (`preview-first-sms`,
 * `send-first-sms` routes + UI). Le changement v1→v2 est purement INTERNE
 * (Claude génère désormais une accroche, le code assemble).
 */
export interface GenerateFirstSmsResult {
  body: string;
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
// assembleFirstSms — assemblage code-side (v2.0.0 S10.1.14)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assemble le body final du 1er SMS depuis l'accroche générée par Claude.
 *
 * Structure (v2.0.1 — annonce IA explicite restaurée AI Act art. 50) :
 *   "Bonjour {Civilité} {Nom}, je suis Léa, assistante virtuelle de Médéré. {accroche} STOP."
 *   (civilité présente)
 *
 *   "Bonjour {Prénom}, je suis Léa, assistante virtuelle de Médéré. {accroche} STOP."
 *   (civilité absente — prénom seul)
 *
 * Garantie mathématique (avec accroche 30-50 chars en v2.0.1) :
 *
 *   Préfixe constant : "Bonjour " (8) + ", je suis Léa, assistante virtuelle de Médéré. " (47) = 55 chars
 *   Suffixe constant : " STOP." (6 chars)
 *
 *   Worst-case avec civilité (Mme = 3 chars + 1 espace) :
 *     8 + 4 + nom + 47 + 50 + 6 = 115 + nom_length
 *     → ≤ 160 si nom_length ≤ 45 chars (couvre 99%+ noms FR réels :
 *       "de la Tour-Vandenberghe-Saint-Étienne" = 39 chars ✅)
 *
 *   Worst-case sans civilité :
 *     8 + prénom + 47 + 50 + 6 = 111 + prénom_length
 *     → ≤ 160 si prénom_length ≤ 49 chars
 *
 * Pour les < 1% cas extrêmes (noms HubSpot > 45 chars), le garde-fou code
 * throw `ExternalServiceError` avec context PII-safe (longueurs seulement,
 * pas le nom brut ni le body assemblé).
 *
 * 🚨 v2.0.1 — Restauration "assistante virtuelle" : la formulation v2.0.0
 * "je suis Léa de Médéré." était AMBIGUË (AI Act art. 50 non explicite —
 * un PS pouvait croire que Léa est humaine). Régression détectée smoke
 * test Déthié. Sentinelle anti-régression dans `first-sms-generator.test.ts`.
 *
 * @param input civilité optionnelle, lastName + firstName du contact, accroche Claude
 * @returns body assemblé prêt à être envoyé via OVH
 * @throws ExternalServiceError si body assemblé > FIRST_SMS_MAX_BODY_CHARS (160)
 *
 * @internal Exposé pour tests sentinelle fuzz.
 */
export function assembleFirstSms(input: {
  civilite: string | undefined;
  lastName: string;
  firstName: string;
  accroche: string;
}): string {
  const { civilite, lastName, firstName, accroche } = input;

  // Adressage : civilité + nom (si civ présente) OU prénom seul (si absente).
  // Cohérent avec la <règle_adressage> v1.0.1 (civilité abrégée Dr/Pr/M./Mme).
  const adressage =
    civilite !== undefined && civilite.length > 0 ? `${civilite} ${lastName}` : firstName;

  // 🚨 v2.0.1 — "assistante virtuelle" RESTAURÉ (AI Act art. 50 explicite).
  // Sentinelle sémantique dans `first-sms-generator.test.ts` verrouille la
  // présence littérale de cette sous-chaîne dans tout body assemblé.
  const assembled = `Bonjour ${adressage}, je suis Léa, assistante virtuelle de Médéré. ${accroche} STOP.`;

  if (assembled.length > FIRST_SMS_MAX_BODY_CHARS) {
    // 🚨 ANTI-PII — JAMAIS le nom/prénom/accroche/body brut dans le context.
    // Seulement les LONGUEURS pour télémétrie forensic.
    throw new ExternalServiceError({
      message: "assembleFirstSms: contact name too long for first SMS assembly (manual review)",
      context: {
        op: ASSEMBLE_FIRST_SMS_OP,
        assembledLength: assembled.length,
        maxLength: FIRST_SMS_MAX_BODY_CHARS,
        accrocheLength: accroche.length,
        adressageLength: adressage.length,
        hasCivilite: civilite !== undefined && civilite.length > 0,
      },
    });
  }

  return assembled;
}

// ─────────────────────────────────────────────────────────────────────────────
// generateFirstSms — pipeline complet
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Génère le body du PREMIER SMS de prospection pour un PS Médéré.
 *
 * @throws ValidationError       si `contact.firstName`, `contact.lastName`,
 *                               ou `contact.speciality` sont vides/non-string.
 * @throws ExternalServiceError  si un des 3 marqueurs compliance est
 *                               absent du body assemblé (triple-garde,
 *                               cas rare car passe par construction en v2 —
 *                               défense-in-depth si assemble cassé futur).
 * @throws ExternalServiceError  si body assemblé > 160 chars (nom HubSpot
 *                               extrême > 52 chars — manual review).
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

  // ── 2. Build prompt v2 (escapeXml sur tous champs externes) ───────────
  const { system, user } = buildFirstSmsPrompt({ contact: args.contact });

  // ── 3. Appel Claude single-shot (propagation erreurs SDK telles quelles) ──
  // Pas de try/catch/retry ici en v2.0.0 : la garantie mathématique de
  // l'assemble code-side couvre les cas qui faisaient échouer v1 (body >
  // 160). Les erreurs SDK transitoires (réseau, 5xx) sont gérées par
  // Inngest côté /send (4 retries backoff exponentiel) — pour /preview,
  // une 502 directe est acceptable (l'admin re-clique).
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

  const { accroche } = result.toolInput;

  // ── 4. Assemble code-side (garantie ≤ 160 chars + garde-fou nom extrême) ──
  const body = assembleFirstSms({
    civilite: args.contact.civilite,
    lastName: args.contact.lastName,
    firstName: args.contact.firstName,
    accroche,
  });

  // ── 5. Triple-garde post-gen ───────────────────────────────────────────
  // En v2.0.0, ces 3 checks passent PAR CONSTRUCTION (l'assemble inclut
  // toujours "je suis Léa de Médéré." + "STOP."). Conservés en
  // defense-in-depth pour alerter si l'assemble est cassé dans un refactor
  // futur (ex: dev qui modifie la chaîne d'assemble sans relire la regex).
  //
  // ⚠️ Le context NE CONTIENT JAMAIS `body` ni `args.contact`.
  // Seuls `bodyLength`, `op`, `model`, `promptVersion` sont exposés —
  // suffisants pour télémétrie, zéro fuite PII.

  if (!hasAIDisclosure(body)) {
    throw new ExternalServiceError({
      message:
        "generateFirstSms: assembled body missing AI disclosure (AI Act art. 50) — assemble cassé ?",
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
        "generateFirstSms: assembled body missing STOP opt-out (L.34-5 CPCE) — assemble cassé ?",
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
        "generateFirstSms: assembled body missing 'Médéré' identification (L.34-5 al. 5 CPCE) — assemble cassé ?",
      context: {
        op: FIRST_SMS_GENERATOR_OP,
        check: "hasAdvertiserIdentification",
        bodyLength: body.length,
        model: FIRST_SMS_MODEL,
        promptVersion: FIRST_SMS_PROMPT_VERSION,
      },
    });
  }

  // ── 6. Retour structuré ────────────────────────────────────────────────
  return {
    body,
    promptVersion: FIRST_SMS_PROMPT_VERSION,
    model: FIRST_SMS_MODEL,
    temperature: FIRST_SMS_TEMPERATURE,
    tokensInput: result.usage.inputTokens,
    tokensOutput: result.usage.outputTokens,
    generationDurationMs,
  };
}
