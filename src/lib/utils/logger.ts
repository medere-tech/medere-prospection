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
 * TODO(post-S1, backlog Notion BUG-002) : ajouter à `redact.paths` les chemins
 * standards pour les secrets HTTP (authorization, cookie, signature,
 * `headers["x-ovh-signature"]`, `headers["x-slack-signature"]`, apiKey, token).
 */
import pino from "pino";

import { maskPhone } from "./phone";

export type AppLogger = pino.Logger;

const REDACTED = "[REDACTED]";
const PHONE_PLACEHOLDER = "[PHONE]";
const EMAIL_PLACEHOLDER = "[EMAIL]";

/**
 * Détecte un numéro de téléphone international ou national FR avec les
 * séparateurs réels rencontrés en prod : espaces, points, tirets, parenthèses.
 *   +33612345678 / +33 6 12 34 56 78 / +33-6-12-34-56-78 / +33.6.12.34.56.78
 *   +33(0)612345678 / 0612345678 (national sans +33)
 *
 * Compromis assumé : possibles false positives sur des suites de chiffres
 * longues purement décoratives (ex: certains IDs externes > 9 chiffres avec
 * séparateurs). On préfère sur-scrubber qu'oublier un numéro réel.
 */
const PHONE_REGEX = /\+?\d[\d\s.\-()]{6,18}\d/g;

/** RFC 5322 simplifié — suffisant pour la détection courante. */
const EMAIL_REGEX = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}/g;

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
] as const;

const REDACT_PATHS = PII_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]);

/**
 * Scrub par VALEUR sur une string. Email scruber appliqué en premier (un
 * email peut contenir des chiffres dans le local part — on évite que la
 * regex phone le mange).
 */
function scrubString(value: string): string {
  return value.replace(EMAIL_REGEX, EMAIL_PLACEHOLDER).replace(PHONE_REGEX, PHONE_PLACEHOLDER);
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
    for (const [k, v] of Object.entries(value)) out[k] = scrubValue(v);
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
