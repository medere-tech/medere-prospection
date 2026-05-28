/**
 * Validation des variables d'environnement — PARESSEUSE PAR SERVICE.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Architecture
 *
 *   - Un Zod schema par service (`anthropic`, `ovh`, `twilio`, `hubspot`,
 *     `lusha`, `slack`, `firebase`, `inngest`, `sentry`, `upstash`, `clerk`,
 *     `core`).
 *   - Un getter exporté par service, qui parse SON sous-ensemble de
 *     `process.env` au PREMIER appel et memoize.
 *   - **Aucun appel au boot** : tant qu'aucun getter n'est invoqué, l'app
 *     démarre sans crasher. En Phase 1 aucun wrapper externe n'est encore
 *     branché → `npm run dev` tourne sans secrets.
 *   - Échec → `ConfigError` (de `utils/errors`) avec message SANITISÉ :
 *     uniquement `champ (codeZod)`, JAMAIS la valeur ni le pattern attendu.
 *     `cause` volontairement `undefined` (la `ZodError` contient la valeur
 *     dans `issue.message` — on ne la propage pas).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Vars marquées `optional` (Phase 1 / MVP non-bloquantes mais validées si
 * fournies — cohérent avec la décision « validation paresseuse ») :
 *
 *   - `NEXT_PUBLIC_APP_URL`, `APP_SECRET` (non utilisées Phase 1)
 *   - `HUBSPOT_PORTAL_ID` (URLs UI uniquement, pas requise par l'API client)
 *   - `SLACK_HANDOFF_CHANNEL_ID`, `SLACK_USER_IDS` (Phase 4 hand-off)
 *   - `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` (S8 différée)
 *
 * Tout le reste est REQUIRED : appeler `getXxxEnv()` sans les vars → throw clair.
 */

import { z } from "zod";

import { ConfigError } from "@/lib/utils/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schémas par service
// ─────────────────────────────────────────────────────────────────────────────

const coreEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]),
  /** Optional Phase 1 : default localhost dev, set par Vercel en prod. */
  NEXT_PUBLIC_APP_URL: z.url().optional(),
  /** Optional Phase 1 : non utilisée (signatures internes à venir en P2+). */
  APP_SECRET: z.string().min(32).optional(),
});

const anthropicEnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().startsWith("sk-ant-"),
});

const OVH_ENDPOINTS = [
  "ovh-eu",
  "ovh-ca",
  "ovh-us",
  "soyoustart-eu",
  "soyoustart-ca",
  "kimsufi-eu",
  "kimsufi-ca",
  "runabove-ca",
] as const;

const ovhEnvSchema = z.object({
  OVH_ENDPOINT: z.enum(OVH_ENDPOINTS),
  OVH_APP_KEY: z.string().min(1),
  OVH_APP_SECRET: z.string().min(1),
  OVH_CONSUMER_KEY: z.string().min(1),
  OVH_SMS_SERVICE_NAME: z.string().min(1),
  /** Sender ID OVH : limite documentée à 11 caractères alphanumériques. */
  OVH_SMS_SENDER: z.string().min(1).max(11),
  /** Secret du webhook OVH entrant — min 16 chars pour résister à la brute force. */
  OVH_WEBHOOK_SECRET: z.string().min(16),
});

const twilioEnvSchema = z.object({
  /**
   * SID Twilio : préfixe `AC` + 32 chars (longueur totale 34) confirmé par
   * la doc officielle. Le caractère set exact (hex ou base32) n'est PAS
   * publié, on ne le contraint pas par regex.
   */
  TWILIO_ACCOUNT_SID: z.string().startsWith("AC").length(34),
  /**
   * Auth Token : format non publié officiellement par Twilio (sécurité).
   * Vérification minimale (longueur usuelle observée = 32). À durcir si une
   * source interne confirme le pattern.
   */
  TWILIO_AUTH_TOKEN: z.string().min(32),
});

const hubspotEnvSchema = z.object({
  HUBSPOT_ACCESS_TOKEN: z.string().startsWith("pat-"),
  /** Optional Phase 1 : URLs UI uniquement (pas requise par l'API client). */
  HUBSPOT_PORTAL_ID: z.string().regex(/^\d+$/, "portal id must be numeric").optional(),
});

const lushaEnvSchema = z.object({
  LUSHA_API_KEY: z.string().min(1),
});

/**
 * `SLACK_USER_IDS` est stocké en string JSON dans `.env`. On le parse en
 * `Record<string, string>` à la volée ; un JSON invalide ou de mauvaise
 * forme produit un `issue` Zod (donc une `ConfigError` sanitisée).
 */
const slackUserIdsSchema = z.string().transform((value, ctx): Record<string, string> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "must be valid JSON" });
    return z.NEVER as never;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    ctx.addIssue({ code: "custom", message: "must be a JSON object" });
    return z.NEVER as never;
  }
  for (const v of Object.values(parsed)) {
    if (typeof v !== "string") {
      ctx.addIssue({
        code: "custom",
        message: "values must be strings",
      });
      return z.NEVER as never;
    }
  }
  return parsed as Record<string, string>;
});

const slackEnvSchema = z.object({
  SLACK_BOT_TOKEN: z.string().startsWith("xoxb-"),
  SLACK_SIGNING_SECRET: z.string().min(1),
  /** Optional Phase 1 : Phase 4 hand-off. Format = channel ID Slack (C…/G…). */
  SLACK_HANDOFF_CHANNEL_ID: z
    .string()
    .regex(/^[CG][A-Z0-9]+$/, "must be a Slack channel ID")
    .optional(),
  /** Optional Phase 1 : Phase 4 hand-off. JSON `{ specialty: slackUserId }`. */
  SLACK_USER_IDS: slackUserIdsSchema.optional(),
});

const firebaseEnvSchema = z.object({
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_CLIENT_EMAIL: z.email(),
  /**
   * Clé privée PEM. Dans `.env`, les `\n` sont souvent échappés en `\\n` ;
   * on les retransforme en vrais sauts de ligne pour que firebase-admin
   * puisse parser la PEM.
   */
  FIREBASE_PRIVATE_KEY: z
    .string()
    .includes("PRIVATE KEY")
    .transform((value) => value.replace(/\\n/g, "\n")),
});

const inngestEnvSchema = z.object({
  INNGEST_EVENT_KEY: z.string().min(1),
  INNGEST_SIGNING_KEY: z.string().startsWith("signkey-"),
});

const sentryEnvSchema = z.object({
  /** Optional : S8 différée. Format DSN attendu si fournie. */
  SENTRY_DSN: z.url().optional(),
  /** Optional : S8 différée. */
  NEXT_PUBLIC_SENTRY_DSN: z.url().optional(),
});

const upstashEnvSchema = z.object({
  UPSTASH_REDIS_REST_URL: z.url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
});

const clerkEnvSchema = z.object({
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().startsWith("pk_"),
  CLERK_SECRET_KEY: z.string().startsWith("sk_"),
});

// ─────────────────────────────────────────────────────────────────────────────
// Sanitisation des erreurs Zod (CŒUR de la garantie anti-fuite)
// ─────────────────────────────────────────────────────────────────────────────

interface SanitizedIssue {
  field: string;
  code: string;
}

/**
 * Construit un message + un contexte SANS la valeur invalide. Zod inclut par
 * défaut la valeur reçue dans `issue.message` (et parfois `issue.received`).
 * On n'utilise que `path` (nom du champ) et `code` (type de violation).
 */
function sanitizeZodError(
  error: z.ZodError,
  service: string,
): { message: string; context: { service: string; issues: SanitizedIssue[] } } {
  const issues: SanitizedIssue[] = error.issues.map((issue) => ({
    field: issue.path.join("."),
    code: issue.code,
  }));
  const fieldsList = issues.map((i) => `${i.field} (${i.code})`).join(", ");
  return {
    message: `Invalid env for ${service}: ${fieldsList}`,
    context: { service, issues },
  };
}

function parseOrThrow<T extends z.ZodTypeAny>(schema: T, service: string): z.infer<T> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const { message, context } = sanitizeZodError(result.error, service);
    // cause volontairement undefined : la ZodError contient la valeur.
    throw new ConfigError({ message, context });
  }
  return result.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache module-level + getters paresseux
// ─────────────────────────────────────────────────────────────────────────────

interface EnvCache {
  core?: z.infer<typeof coreEnvSchema>;
  anthropic?: z.infer<typeof anthropicEnvSchema>;
  ovh?: z.infer<typeof ovhEnvSchema>;
  twilio?: z.infer<typeof twilioEnvSchema>;
  hubspot?: z.infer<typeof hubspotEnvSchema>;
  lusha?: z.infer<typeof lushaEnvSchema>;
  slack?: z.infer<typeof slackEnvSchema>;
  firebase?: z.infer<typeof firebaseEnvSchema>;
  inngest?: z.infer<typeof inngestEnvSchema>;
  sentry?: z.infer<typeof sentryEnvSchema>;
  upstash?: z.infer<typeof upstashEnvSchema>;
  clerk?: z.infer<typeof clerkEnvSchema>;
}

const cache: EnvCache = {};

/**
 * Un seul point de mémoïsation pour les 12 getters. Concentre la branche
 * « cache hit / miss » à un seul endroit (testable une fois pour tous).
 */
function memoize<K extends keyof EnvCache>(
  key: K,
  parse: () => NonNullable<EnvCache[K]>,
): NonNullable<EnvCache[K]> {
  if (cache[key] === undefined) {
    cache[key] = parse();
  }
  return cache[key] as NonNullable<EnvCache[K]>;
}

export function getCoreEnv() {
  return memoize("core", () => parseOrThrow(coreEnvSchema, "core"));
}

export function getAnthropicEnv() {
  return memoize("anthropic", () => parseOrThrow(anthropicEnvSchema, "anthropic"));
}

export function getOvhEnv() {
  return memoize("ovh", () => parseOrThrow(ovhEnvSchema, "ovh"));
}

export function getTwilioEnv() {
  return memoize("twilio", () => parseOrThrow(twilioEnvSchema, "twilio"));
}

export function getHubspotEnv() {
  return memoize("hubspot", () => parseOrThrow(hubspotEnvSchema, "hubspot"));
}

export function getLushaEnv() {
  return memoize("lusha", () => parseOrThrow(lushaEnvSchema, "lusha"));
}

export function getSlackEnv() {
  return memoize("slack", () => parseOrThrow(slackEnvSchema, "slack"));
}

export function getFirebaseEnv() {
  return memoize("firebase", () => parseOrThrow(firebaseEnvSchema, "firebase"));
}

export function getInngestEnv() {
  return memoize("inngest", () => parseOrThrow(inngestEnvSchema, "inngest"));
}

export function getSentryEnv() {
  return memoize("sentry", () => parseOrThrow(sentryEnvSchema, "sentry"));
}

export function getUpstashEnv() {
  return memoize("upstash", () => parseOrThrow(upstashEnvSchema, "upstash"));
}

export function getClerkEnv() {
  return memoize("clerk", () => parseOrThrow(clerkEnvSchema, "clerk"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vide TOUT le cache. À utiliser UNIQUEMENT dans les tests (Vitest + stubEnv
 * change `process.env` mais ne ré-évalue pas un getter déjà appelé).
 * Une garde runtime contre les appels en dehors du contexte de test : si
 * `NODE_ENV !== 'test'`, on throw plutôt que de vider silencieusement.
 */
export function __resetEnvCacheForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__resetEnvCacheForTests called outside of tests");
  }
  for (const k of Object.keys(cache) as (keyof EnvCache)[]) {
    delete cache[k];
  }
}

export type EnvServiceName = keyof EnvCache;

/** Entrée d'un service vérifié par `validateAllEnvNow`. Exporté pour les
 * tests qui veulent injecter un service custom (ex: simulant une erreur). */
export interface EnvServiceEntry {
  name: EnvServiceName;
  fn: () => unknown;
}

/** Liste par défaut couverte par `validateAllEnvNow` (tous les 12 services). */
const DEFAULT_SERVICES: EnvServiceEntry[] = [
  { name: "core", fn: getCoreEnv },
  { name: "anthropic", fn: getAnthropicEnv },
  { name: "ovh", fn: getOvhEnv },
  { name: "twilio", fn: getTwilioEnv },
  { name: "hubspot", fn: getHubspotEnv },
  { name: "lusha", fn: getLushaEnv },
  { name: "slack", fn: getSlackEnv },
  { name: "firebase", fn: getFirebaseEnv },
  { name: "inngest", fn: getInngestEnv },
  { name: "sentry", fn: getSentryEnv },
  { name: "upstash", fn: getUpstashEnv },
  { name: "clerk", fn: getClerkEnv },
];

/**
 * Helper non câblé au boot : valide tous les services en best-effort et
 * retourne un rapport `"ok"` ou la liste sanitisée des champs en faute.
 * Cible : un futur endpoint health-check (S5, derrière auth admin
 * obligatoire — voir finding E1 du security-reviewer) ou un CI gate.
 *
 * Le paramètre `services` est principalement là pour les tests (injection
 * d'un service simulant une erreur non-`ConfigError`). En usage normal,
 * appeler sans argument.
 */
export function validateAllEnvNow(
  services: EnvServiceEntry[] = DEFAULT_SERVICES,
): Record<EnvServiceName, "ok" | SanitizedIssue[]> {
  const report = {} as Record<EnvServiceName, "ok" | SanitizedIssue[]>;
  for (const { name, fn } of services) {
    try {
      fn();
      report[name] = "ok";
    } catch (e) {
      // Nos getters ne throwent QUE des ConfigError. Tout autre throw =
      // bug interne ; on laisse remonter sans l'absorber (sinon on
      // masquerait un crash structurel derrière un rapport "tout va bien").
      if (!(e instanceof ConfigError)) throw e;
      // Le `context` est toujours produit par `sanitizeZodError`, dont la
      // forme est stable → cast strict, pas d'optional chaining.
      const ctx = e.context as { service: string; issues: SanitizedIssue[] };
      report[name] = ctx.issues;
    }
  }
  return report;
}
