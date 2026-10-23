/**
 * Logger structuré (Pino) avec redaction PII multi-couches.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * RÈGLE CLAUDE.md #9 — aucun téléphone, email ou nom complet en clair dans
 * les logs. Trois lignes de défense, par ordre de couverture :
 *
 *   1. `serializers.err` / `serializers.error` — scrube `err.message` et
 *      `err.stack`. Couvre le piège le plus invisible : `logger.error(err)`
 *      où le message d'erreur du SDK tiers contient un numéro/email.
 *      Stack supprimée en production (Sentry la capture par ailleurs).
 *
 *   2. `hooks.logMethod` + `formatters.log` — scrub PAR VALEUR (regex E.164
 *      + email) appliqué récursivement à toutes les strings, à toute
 *      profondeur, dans les objets ET les tableaux, ET au message texte.
 *      Couvre les clés inconnues des tiers (`tel` HubSpot, `phoneNumbers[]`
 *      Lusha, `from`/`to` OVH…).
 *
 *   3. `redact.paths` — filet supplémentaire par NOM DE CLÉ pour les PII
 *      sans signature regex (firstName / prenom / nom / civilité).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CONVENTION D'APPEL (impérative)
 *
 * Le scrub par valeur est un FILET DE SÉCURITÉ, pas une excuse pour logger
 * n'importe quoi. Discipline obligatoire :
 *
 *   - JAMAIS de téléphone ni d'email dans un `msg` interpolé.
 *     ❌  logger.info(`SMS envoyé à ${e164}`)
 *     ✅  logger.info({ to: maskPhone(e164) }, "SMS envoyé")
 *
 *   - JAMAIS de PII dans un `new Error(...)` ou `throw new XxxError({ message })`.
 *     ❌  throw new Error(`OVH refused SMS to ${e164}: ${ovhResponse}`)
 *     ✅  throw new ExternalServiceError({
 *           message: "OVH refused SMS",
 *           context: { phone: maskPhone(e164), ovhCode },
 *         })
 *
 *   - Pour une trace partielle en debug, utiliser `maskPhone` / `maskEmail`.
 *   - Passer une erreur via la clé `err` (convention Pino) : `logger.error({ err })`.
 *
 * `LOG_LEVEL` et `NODE_ENV` sont lus directement via `process.env` (runtime
 * non secret, pas de couplage à `lib/security/env.ts`).
 *
 * Secrets HTTP couverts (BUG-002 résolu en pre-task S3) : authorization,
 * cookie, signatures webhooks (`x-ovh-signature`, `x-slack-signature`,
 * `x-inngest-signature`, `x-slack-request-timestamp`), apiKey/api_key/token/
 * accessToken/refreshToken — cf. `PII_KEYS` et `HEADER_SIGNATURE_KEYS`.
 */
import pino from "pino";

import { maskPhone } from "./phone";
import { containsFrenchPhoneNumber, scrubPiiFromText } from "./pii-scrubber";

export type AppLogger = pino.Logger;

const REDACTED = "[REDACTED]";

/**
 * Liste blanche : noms de clés dont la valeur est intégralement redactée
 * en `[REDACTED]`. Couvre les variantes de nommage des tiers (HubSpot
 * `firstname` minuscule, conventions FR `prenom`/`nom`, etc.).
 */
const PII_KEYS = [
  // Téléphone (canonique + variantes tiers)
  "phone",
  "e164",
  "raw",
  "tel",
  "mobile",
  "phoneNumber",
  "phoneNumbers",
  // Email
  "email",
  "mail",
  // Identité
  "firstName",
  "lastName",
  "fullName",
  "firstname",
  "lastname",
  "fullname",
  "prenom",
  "nom",
  "civilite",
  // Contenu de message (potentiellement personnel)
  "body",
  // Secrets HTTP (BUG-002 — backlog Notion résolu) : Authorization,
  // Cookie, et signatures de webhooks. Headers Node sont en lowercase ;
  // on couvre aussi les variantes capitalisées par sécurité.
  "authorization",
  "Authorization",
  "cookie",
  "Cookie",
  // Tokens applicatifs (clé/api d'un wrapper, OAuth, Inngest, etc.)
  "apiKey",
  "api_key",
  "apikey",
  "token",
  "accessToken",
  "refreshToken",
  "access_token",
  "refresh_token",
  // Signature générique (pour les payloads qui auraient `signature` au
  // top-level plutôt que dans un header — ex. Inngest body verify)
  "signature",
] as const;

/**
 * Signatures de webhooks qui vivent dans `headers[...]` avec des tirets
 * dans le nom de clé : non couvertes par les wildcards simples, on liste
 * les paths explicitement avec la notation bracket (single quotes).
 */
const HEADER_SIGNATURE_KEYS = [
  "x-ovh-signature",
  "x-slack-signature",
  "x-slack-request-timestamp",
  "x-inngest-signature",
] as const;

const REDACT_PATHS = [
  ...PII_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
  ...HEADER_SIGNATURE_KEYS.flatMap((key) => [
    `headers['${key}']`,
    `*.headers['${key}']`,
    `*.*.headers['${key}']`,
  ]),
];

/**
 * Scrub par VALEUR sur une string. Email scruber appliqué en premier (un
 * email peut contenir des chiffres dans le local part — on évite que la
 * regex phone le mange).
 *
 * Délégué à `pii-scrubber.ts` depuis PR2a (source unique de vérité pour
 * les regex PII). Même sémantique que l'ancienne implémentation locale.
 */
function scrubString(value: string): string {
  return scrubPiiFromText(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// R4-Point2 PR-NO-DROPPED-SMS : exemption par clé + format + anti-segment FR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whitelist stricte des clés techniques dont la valeur est un IDENTIFIANT
 * applicatif, PAS un numéro de téléphone. Pour chaque clé, un VALIDATOR
 * de format strict qui définit ce qu'un vrai ID peut être. Si clé ∈ map
 * ET valeur matche le validator ET aucun segment ne match un numéro FR
 * (cf. `containsFrenchPhoneSegment`), on bypass `scrubString`.
 *
 * Sinon → scrub normal (PHONE_REGEX + EMAIL_REGEX).
 *
 * ⚠️ Ces IDs sont écrits en clair dans les logs forensic — ils DOIVENT
 * rester lisibles. Les clés PII (`PII_KEYS`) restent prioritaires et
 * remplacent la valeur par `[REDACTED]` via `redact.paths` Pino.
 */
const TECHNICAL_ID_KEYS: ReadonlyMap<string, RegExp> = new Map([
  // hubspotId numérique OU sentinelles tests `hs_...`.
  //
  // R4-Point2-fix PR-NO-DROPPED-SMS : regex élargie pour accepter `.`, `:`
  // et espace comme séparateurs. Un vrai contactId n'en contient jamais,
  // mais permettre la validation à cette classe large laisse la
  // NORMALISATION + ANTI-NUMERO décider en aval : un numéro FR formaté
  // (`06-12-34-56-78`, `06.12.34.56.78`, `06 12 34 56 78`) est capté par
  // `containsFrenchPhoneNumber`, un ID technique arbitraire sans numéro
  // (`"127.0.0.1"`, `"1.2.3"`) passe en bypass sans leak.
  ["contactId", /^(hs_)?[A-Za-z0-9][A-Za-z0-9_.\-: ]{0,63}$/],
  ["hubspotId", /^[0-9]{1,30}$/],
  // conversationId = `${contactId}_${campaignId}` : regex élargie (idem contactId).
  ["conversationId", /^(hs_)?[A-Za-z0-9][A-Za-z0-9_.\-: ]{0,100}$/],
  // Firestore auto-ID OU oih_... hash + chunks underscore.
  ["messageId", /^(oih_[a-f0-9_]{32,}|[A-Za-z0-9]{20})$/],
  ["draftMessageId", /^[A-Za-z0-9]{20}$/],
  ["duplicateOfMessageId", /^(oih_[a-f0-9_]{32,}|[A-Za-z0-9]{20})$/],
  ["orphanDocId", /^(oih_[a-f0-9_]{32,}|orphan_[a-z_]+_[a-f0-9]{8})$/],
  // Slack ts : "1234567890.XXXX..." - 10 digits + "." + 1 à 10 décimales
  ["slackTs", /^[0-9]{10}\.[0-9]{1,10}$/],
  ["ts", /^[0-9]{10}\.[0-9]{1,10}$/],
  // Slack IDs
  ["assignedTo", /^U[A-Z0-9]+$/],
  ["slackUserId", /^U[A-Z0-9]+$/],
  ["slackChannel", /^[CDGT][A-Z0-9]+$/],
  // Inngest event IDs — scrubber-safe (events.ts:49-73 interdit déjà PII)
  ["eventId", /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/],
  // Fingerprints djb2 (8 chars hex)
  ["ovhMessageIdFingerprint", /^[a-f0-9]{8}$/],
  ["phoneFingerprint", /^[a-f0-9]{8}$/],
  ["contactIdFingerprint", /^[a-f0-9]{8}$/],
  // Campaign ID slug
  ["campaignId", /^[a-z0-9][a-z0-9-]{0,80}$/i],
  // Phone hashes (préfixe `hph_` prouve que ce n'est pas un vrai numéro)
  ["phoneHash", /^hph_[A-Za-z0-9_-]+$/],
]);

/**
 * Règle anti-segment numéro FR (R4-Point2 PR-NO-DROPPED-SMS décision scellée).
 *
 * Même si la clé matche TECHNICAL_ID_KEYS, on refuse le bypass si la valeur
 * contient un segment (découpé sur `_`, `.`, `-`, `:`) qui match un vrai
 * numéro français. Protège contre :
 *   - `"0612345678"` posé par erreur sous `contactId`.
 *   - `"33612345678"` (E.164 sans +) sous `conversationId`.
 *   - `"sms.reply.0612345678"` sous `eventId`.
 *   - `"0612345678_campagne"` sous `conversationId`.
 */
/**
 * `true` si la valeur, après normalisation inter-chiffres, contient un
 * numéro FR (national, E.164 sans +, ou préfixe 00+33) délimité par des
 * non-chiffres. Déclenche un REFUS DE BYPASS → la valeur sera scrubbée
 * par `PHONE_REGEX` en aval. Nom conservé pour cohérence historique
 * (découverte initiale via split, désormais via normalisation +
 * anywhere-match).
 *
 * Délégué à `pii-scrubber.containsFrenchPhoneNumber` depuis PR2a.
 */
function containsFrenchPhoneSegment(value: string): boolean {
  return containsFrenchPhoneNumber(value);
}

/**
 * Décide si une paire `(key, value)` string doit bypasser le scrub par
 * valeur. Trois conditions cumulatives :
 *   1. `key` ∈ `TECHNICAL_ID_KEYS`.
 *   2. `value` matche le validator strict de la clé.
 *   3. `value` ne contient AUCUN segment numéro FR (anti-leak humain).
 *
 * @internal exposé pour tests sentinelles.
 */
export function shouldBypassScrubForTechnicalId(key: string, value: string): boolean {
  const validator = TECHNICAL_ID_KEYS.get(key);
  if (validator === undefined) return false;
  if (!validator.test(value)) return false;
  if (containsFrenchPhoneSegment(value)) return false;
  return true;
}

/**
 * Scrub récursif : strings → `scrubString` ; arrays → map récursif ;
 * objets ordinaires → tous les champs récursivement.
 *
 * Les instances d'`Error` sont PRÉSERVÉES (retournées telles quelles) car
 * `formatters.log` tourne AVANT `serializers.err` dans la pipeline Pino :
 * recurse dessus ici les mangerait (la plupart des props d'une Error ne sont
 * pas énumérables) et priverait le serializer de la vraie instance.
 *
 * Les autres types (number, boolean, null, Date…) sont laissés tels quels.
 */
function scrubValue(value: unknown): unknown {
  if (value instanceof Error) return value;
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // R4-Point2 : bypass scrub par valeur si la paire (clé, valeur)
      // matche un identifiant technique strict ET aucun segment ne
      // ressemble à un numéro FR. Les clés PII_KEYS restent prioritaires
      // via redact.paths (traité en amont par Pino, pas par scrubValue).
      if (typeof v === "string" && shouldBypassScrubForTechnicalId(k, v)) {
        out[k] = v;
      } else {
        out[k] = scrubValue(v);
      }
    }
    return out;
  }
  return value;
}

/**
 * Serializer Pino pour les clés `err` / `error` : passe par le serializer
 * standard puis scrube `message`, `stack`, ET les autres champs propres
 * (ex: `context` d'une `AppError` peut contenir une PII). La stack est
 * supprimée en production (réduit la surface ; Sentry capture côté APM).
 */
function errSerializer(err: unknown): unknown {
  if (!(err instanceof Error)) return scrubValue(err);

  const base = pino.stdSerializers.err(err) as Record<string, unknown>;
  const msg = base.message;
  const stk = base.stack;

  // Scrub des autres champs propres (ex: AppError.context). message/stack
  // sont traités explicitement juste après.
  const others: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(base)) {
    if (k === "message" || k === "stack") continue;
    others[k] = scrubValue(v);
  }

  return {
    ...others,
    message: typeof msg === "string" ? scrubString(msg) : msg,
    stack:
      process.env.NODE_ENV === "production"
        ? undefined
        : typeof stk === "string"
          ? scrubString(stk)
          : stk,
  };
}

function resolveEnv(): "development" | "production" | "test" {
  const value = process.env.NODE_ENV;
  if (value === "production" || value === "test") return value;
  return "development";
}

function resolveLevel(env: "development" | "production" | "test"): string {
  if (process.env.LOG_LEVEL) return process.env.LOG_LEVEL;
  if (env === "production") return "info";
  if (env === "test") return "silent";
  return "debug";
}

/**
 * Construit un logger Pino. Exporté surtout pour les tests (injection d'une
 * destination capturant la sortie). En usage normal, importer `logger`.
 */
export function buildLogger(
  options: { level?: string } = {},
  destination?: pino.DestinationStream,
): AppLogger {
  const env = resolveEnv();
  const baseOptions: pino.LoggerOptions = {
    level: options.level ?? resolveLevel(env),
    base: { service: "medere-prospection" },
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    serializers: { err: errSerializer, error: errSerializer },
    formatters: {
      log: (obj) => scrubValue(obj) as Record<string, unknown>,
    },
    hooks: {
      logMethod(inputArgs, method) {
        // Pino, sur `logger.error(err)`, prend `err.message` brut comme `msg`
        // avant que notre serializer ne tourne → PII fuiterait via `msg`.
        // Si le premier arg est une Error, on la rebascule dans `{ err }` et
        // on injecte un `msg` scrubé explicitement.
        const args: unknown[] = [...inputArgs];
        if (args[0] instanceof Error) {
          const err = args[0];
          args[0] = { err };
          args.splice(1, 0, scrubString(err.message));
        }
        const scrubbed = args.map((a) => (typeof a === "string" ? scrubString(a) : a));
        // pino.LogFn est surchargée ; cast explicite pour passer la liste.
        (method as (...args: unknown[]) => void).apply(this, scrubbed);
      },
    },
    // TODO(S8) : brancher un transport/stream Sentry pour les niveaux >= error.
  };

  // En dev (et sans destination de test), sortie colorée lisible.
  if (!destination && env === "development") {
    return pino({
      ...baseOptions,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard" },
      },
    });
  }

  return destination ? pino(baseOptions, destination) : pino(baseOptions);
}

/** Logger applicatif partagé. */
export const logger: AppLogger = buildLogger();

/** Crée un logger enfant avec des champs liés (ex: `{ requestId }`). */
export function createLogger(bindings: pino.Bindings): AppLogger {
  return logger.child(bindings);
}

/**
 * Masque un email pour un log volontairement partiel : `j***@example.com`.
 * Renvoie une chaîne entièrement masquée si l'entrée n'est pas un email.
 */
export function maskEmail(value: string): string {
  const at = value.indexOf("@");
  if (at <= 0) return "*".repeat(value.length);
  const local = value.slice(0, at);
  const domain = value.slice(at);
  const first = local[0] ?? "";
  return first + "*".repeat(Math.max(local.length - 1, 1)) + domain;
}

export { maskPhone };
