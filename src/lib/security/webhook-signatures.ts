/**
 * Vérification des signatures de webhooks entrants.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Fonctions PURES : aucune dépendance à Next.js / Node `Request` / SDK
 * Slack / SDK OVH. Le caller (route handler) extrait les headers/query
 * params et passe les strings ; on rend `true` ou `false`. Aucun I/O ici.
 *
 * Garantie sécurité : toutes les comparaisons d'égalité (signature, token)
 * passent par `timingSafeStringEqual` — `node:crypto.timingSafeEqual` avec
 * un wrapper qui refuse une chaîne vide des deux côtés (anti-bypass d'un
 * secret mal configuré à `""`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Tableau des schémas par fournisseur
 *
 *   | Fournisseur | Mécanisme                         | Fonction              |
 *   |-------------|-----------------------------------|-----------------------|
 *   | Slack       | HMAC SHA-256 + anti-replay 5 min  | verifySlackSignature  |
 *   | OVH         | Shared secret en query param      | verifyOvhWebhookToken |
 *   | Générique   | HMAC SHA-256/SHA-512/SHA-1 sur body | verifyHmacSignature  |
 *
 * (Inngest a son propre format `x-inngest-signature: t=…&s=…` géré par
 * le SDK Inngest via `serve()` — pas nécessaire en Phase 1.)
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { ValidationError } from "@/lib/utils/errors";

/** Fenêtre anti-replay Slack : ±5 min autour de l'horloge serveur. */
export const SLACK_REPLAY_WINDOW_SECONDS = 60 * 5;

/**
 * Compare deux chaînes en temps constant (`crypto.timingSafeEqual`).
 *
 * GARANTIE ANTI-BYPASS : si l'une OU l'autre est vide, retourne `false`,
 * sans appel à `timingSafeEqual`. Justification : un secret attendu vide
 * (`OVH_WEBHOOK_SECRET=""` mal configuré) ne doit JAMAIS valider — sinon
 * un attaquant qui n'envoie pas de token passerait. La règle algébrique
 * `"" === ""` est volontairement enfreinte par sécurité. NE PAS « corriger ».
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ─────────────────────────────────────────────────────────────────────────────
// Slack — HMAC SHA-256 + anti-replay
// ─────────────────────────────────────────────────────────────────────────────

export interface VerifySlackSignatureOptions {
  /** Slack signing secret (env: `SLACK_SIGNING_SECRET`). */
  signingSecret: string;
  /**
   * Header `X-Slack-Request-Timestamp` (entier unix secondes en string).
   * Le caller extrait ce header lui-même ; cette fonction ne lit aucun
   * objet Request/Headers.
   */
  timestamp: string | null | undefined;
  /**
   * Header `X-Slack-Signature` (format `v0={hex sha256}`).
   * Le caller extrait ce header lui-même.
   */
  signature: string | null | undefined;
  /** Corps brut de la requête (avant tout parsing JSON). */
  rawBody: string;
  /**
   * Source d'horloge en millisecondes (défaut `Date.now`). Injection
   * réservée aux tests pour piloter l'anti-replay.
   */
  now?: () => number;
}

/**
 * Vérifie une signature Slack HMAC SHA-256 avec anti-replay 5 min.
 *
 * Algorithme officiel Slack : base string = `v0:{timestamp}:{rawBody}`,
 * HMAC SHA-256 avec le signing secret, comparaison `v0={hex}` constant-time.
 *
 * Retourne `false` (jamais throw) si :
 *   - un input est manquant / vide,
 *   - le timestamp n'est pas un entier valide,
 *   - le timestamp est hors fenêtre ±5 min (replay/clock skew),
 *   - la signature n'a pas le préfixe `v0=`,
 *   - le HMAC calculé ne match pas la signature reçue.
 */
export function verifySlackSignature(opts: VerifySlackSignatureOptions): boolean {
  const { signingSecret, timestamp, signature, rawBody } = opts;

  // Anti-bypass : tout input manquant/vide → refus immédiat.
  if (!signingSecret || !timestamp || !signature) return false;

  // Timestamp doit être un entier unix (secondes).
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;

  // Anti-replay : refus si > 5 min dans le passé OU dans le futur.
  const nowSec = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  if (Math.abs(nowSec - ts) > SLACK_REPLAY_WINDOW_SECONDS) return false;

  // La signature doit avoir le préfixe `v0=`.
  if (!signature.startsWith("v0=")) return false;

  // Calcul attendu.
  const baseString = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(baseString).digest("hex")}`;

  return timingSafeStringEqual(signature, expected);
}

// ─────────────────────────────────────────────────────────────────────────────
// OVH — Shared secret en query param (OVH ne signe pas nativement)
// ─────────────────────────────────────────────────────────────────────────────

export interface VerifyOvhWebhookTokenOptions {
  /** Secret partagé attendu (env: `OVH_WEBHOOK_SECRET`). */
  expected: string;
  /** Token reçu en query string (ex: `req.nextUrl.searchParams.get("token")`). */
  received: string | null | undefined;
}

/**
 * Vérifie le token shared-secret OVH.
 *
 * OVH ne signe PAS nativement ses webhooks → on configure une URL de
 * callback de la forme `…/ovh-sms?token=<OVH_WEBHOOK_SECRET>` et on
 * vérifie l'égalité du token reçu en query param avec la valeur env.
 *
 * Comparaison constant-time. Garde anti-bypass : un `expected=""` ou
 * un `received=null` → toujours `false`.
 */
export function verifyOvhWebhookToken(opts: VerifyOvhWebhookTokenOptions): boolean {
  return timingSafeStringEqual(opts.expected, opts.received ?? "");
}

// ─────────────────────────────────────────────────────────────────────────────
// Générique — HMAC sur body (Inngest natif géré par SDK ; futurs webhooks)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Algorithmes HMAC supportés. SHA-1 volontairement EXCLU : aucun webhook
 * dans notre périmètre (Slack=SHA-256, OVH=pas de HMAC, Inngest=SHA-256)
 * n'en a besoin, et c'est une mauvaise norme à inscrire dans un projet
 * greenfield (footgun futur). À ajouter uniquement si un webhook tiers
 * legacy l'exige, et avec un test forçant un anti-replay côté caller.
 */
export type HmacAlgorithm = "sha256" | "sha512";
export type HmacEncoding = "hex" | "base64";

export interface VerifyHmacOptions {
  /** Secret partagé. */
  secret: string;
  /** Corps signé. */
  body: string;
  /** Signature reçue (déjà décodée en string hex ou base64). */
  signature: string | null | undefined;
  /** Algorithme HMAC. Défaut `sha256`. */
  algorithm?: HmacAlgorithm;
  /** Encodage de la signature attendue. Défaut `hex`. */
  encoding?: HmacEncoding;
}

const SUPPORTED_ALGORITHMS: ReadonlySet<HmacAlgorithm> = new Set(["sha256", "sha512"]);

/**
 * Vérifie un HMAC générique sur un body (algo + encodage paramétrables).
 *
 * Cas d'usage : tout futur webhook qui suit le pattern simple `signature =
 * HMAC(secret, body)`. Pour Slack (anti-replay) ou Inngest (format
 * composé), utiliser les fonctions dédiées.
 *
 * Throw `ValidationError` si l'algorithme demandé n'est pas dans la
 * allowlist (refus de MD5 et autres faibles). Retourne `false` dans tous
 * les autres cas d'échec.
 */
export function verifyHmacSignature(opts: VerifyHmacOptions): boolean {
  const { secret, body, signature, algorithm = "sha256", encoding = "hex" } = opts;

  // Allowlist : refus explicite des algorithmes faibles (MD5, etc.).
  if (!SUPPORTED_ALGORITHMS.has(algorithm)) {
    throw new ValidationError({
      message: `Unsupported HMAC algorithm: ${algorithm}`,
    });
  }

  if (!secret || !signature) return false;

  const computed = createHmac(algorithm, secret).update(body).digest(encoding);
  return timingSafeStringEqual(signature, computed);
}
