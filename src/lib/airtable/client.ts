/**
 * Client HTTP bas niveau pour Airtable REST v0 (S9.9-PR2).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rôle
 *
 *   - `fetchAirtableRecords(tableId, fields[])` : GET paginé
 *     `https://api.airtable.com/v0/{baseId}/{tableId}?fields[]=...&offset=...`
 *     Bearer PAT depuis `getAirtableEnv()`.
 *   - Retourne l'union de toutes les pages (aujourd'hui 1 page ~18 lignes
 *     max pour la table Commerciaux, mais la pagination est gérée
 *     proprement pour scaler sans surprise).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Résilience (retry + timeout)
 *
 *   - Timeout par requête : `AIRTABLE_TIMEOUT_MS` (10s) via
 *     `AbortSignal.timeout()`. Aligné CLAUDE.md « fetch sans timeout ».
 *
 *   - Retry backoff exponentiel : 4 tentatives (100ms, 500ms, 2s, 5s
 *     entre elles) sur les 3 catégories transient :
 *       * 429 (rate limit)
 *       * 5xx (erreur serveur)
 *       * Network / TimeoutError (fetch throw)
 *
 *   - Pas de retry sur les erreurs déterministes :
 *       * 401 / 403 (PAT invalide / scope manquant → retry = perte de temps)
 *       * 404 (base id ou table id incorrect)
 *       * autres 4xx (400 malformé, 422, etc.)
 *     → throw `ExternalServiceError` immédiatement avec message explicite.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Sécurité
 *
 *   - Le PAT est LU depuis `getAirtableEnv()` à chaque appel et injecté
 *     dans l'header `Authorization: Bearer ...`. JAMAIS loggé, même
 *     tronqué. Les headers ne transitent nulle part hors du fetch.
 *   - Le body d'erreur Airtable est tronqué à `ERROR_BODY_MAX_CHARS` (200)
 *     avant d'atterrir dans `context` — protège contre un body 5xx anormal
 *     très volumineux (log spam). Le logger scrube aussi par valeur si un
 *     PII apparaissait, mais Airtable ne retourne pas de PII dans ses
 *     erreurs.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Testabilité — back-door
 *
 *   Aucun raw-fetch existant dans le repo → j'introduis un back-door
 *   `__setAirtableTransportForTests({ fetch?, sleep? } | null)` avec la
 *   garde runtime `NODE_ENV === "test"` (cohérent avec le pattern
 *   `__setOvhClientForTests`, `__setHubspotClientForTests`, etc.).
 *
 *   Injecter `fetch` → mock des réponses. Injecter `sleep` → skip les
 *   backoffs (100ms + 500ms + 2s + 5s = 7.6s de wait réel évité).
 */

import { getAirtableEnv } from "@/lib/security/env";
import { ExternalServiceError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

/** Base URL API Airtable REST v0 (hardcodée — pas d'endpoint alternatif). */
const AIRTABLE_API_BASE = "https://api.airtable.com/v0";

/** Timeout HTTP par tentative. Aligné OVH/Claude (10s). */
const AIRTABLE_TIMEOUT_MS = 10_000;

/**
 * Backoff exponentiel entre les tentatives (4 tentatives = 3 retries).
 * Somme worst-case : 7.6s. Au-delà, on considère Airtable down et on
 * propage l'erreur au caller (le module commerciaux propagera à l'orchestrateur
 * hand-off, qui basculera vers le canal orphelins).
 *
 * 🔒 SENTINEL — modification = re-validation Déthié (impact latence hand-off).
 */
const RETRY_DELAYS_MS = [100, 500, 2_000, 5_000] as const;

/** Codes HTTP transient → retry pertinent. Sinon fail-fast. */
const RETRYABLE_HTTP_STATUS = new Set<number>([
  429, // Too Many Requests
  500,
  502,
  503,
  504,
]);

/** Cap sur la taille du body d'erreur incluse dans le context ExternalServiceError. */
const ERROR_BODY_MAX_CHARS = 200;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enregistrement Airtable brut. `fields` est un dict libre (les valeurs
 * peuvent être string | number | boolean | array selon le type de champ).
 * Le mapping typé est fait par le module caller (`commerciaux.ts`).
 */
export interface AirtableRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

interface AirtableListResponse {
  records: AirtableRecord[];
  /** Cursor opaque pour la page suivante. Absent = dernière page. */
  offset?: string;
}

type FetchLike = typeof globalThis.fetch;
type SleepLike = (ms: number) => Promise<void>;

// ─────────────────────────────────────────────────────────────────────────────
// Transport injectable (fetch + sleep)
// ─────────────────────────────────────────────────────────────────────────────

const defaultSleep: SleepLike = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let currentFetch: FetchLike = globalThis.fetch;
let currentSleep: SleepLike = defaultSleep;

/**
 * Test-only : injecte un `fetch` fake et/ou un `sleep` no-op. Passer `null`
 * pour restaurer les defaults (`globalThis.fetch` + `setTimeout`).
 *
 * Garde runtime : refuse en dehors de `NODE_ENV === "test"` (identique
 * pattern `__setOvhClientForTests`, `__setHubspotClientForTests`).
 */
export function __setAirtableTransportForTests(
  transport: { fetch?: FetchLike; sleep?: SleepLike } | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setAirtableTransportForTests called outside of tests");
  }
  currentFetch = transport?.fetch ?? globalThis.fetch;
  currentSleep = transport?.sleep ?? defaultSleep;
}

// ─────────────────────────────────────────────────────────────────────────────
// Erreurs — helpers
// ─────────────────────────────────────────────────────────────────────────────

function truncateBody(body: string): string {
  if (body.length <= ERROR_BODY_MAX_CHARS) return body;
  return body.slice(0, ERROR_BODY_MAX_CHARS) + "…[truncated]";
}

/**
 * Lit le body de la Response en best-effort (sans throw). Une erreur de
 * lecture body ne doit pas masquer l'erreur HTTP d'origine.
 */
async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<body read failed>";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Une passe HTTP (une tentative)
// ─────────────────────────────────────────────────────────────────────────────

interface SingleAttemptResult {
  /** Réponse OK 2xx parsée. */
  data?: AirtableListResponse;
  /** Erreur non-retryable → propager immédiatement au caller. */
  fatalError?: ExternalServiceError;
  /**
   * Erreur transient → retry si tentatives restantes, sinon propager cette
   * erreur au caller.
   */
  transientError?: ExternalServiceError;
}

async function attemptFetch(url: string, pat: string): Promise<SingleAttemptResult> {
  let response: Response;
  try {
    response = await currentFetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(AIRTABLE_TIMEOUT_MS),
    });
  } catch (cause) {
    // fetch throw = network error, DNS, timeout AbortSignal, TypeError… →
    // toujours transient (on ne peut pas distinguer proprement). Le context
    // capture juste le message (pas la stack) pour diag.
    const msg = cause instanceof Error ? cause.message : String(cause);
    return {
      transientError: new ExternalServiceError({
        message: `Airtable network error: ${msg}`,
        context: { service: "airtable", cause: "network" },
        cause,
      }),
    };
  }

  if (response.ok) {
    // 2xx : parse JSON. Si le JSON est malformé (ne devrait pas arriver
    // côté Airtable), on remonte une erreur non-retryable — retry ne
    // ferait qu'aggraver l'incident.
    try {
      const data = (await response.json()) as AirtableListResponse;
      return { data };
    } catch (cause) {
      return {
        fatalError: new ExternalServiceError({
          message: "Airtable returned malformed JSON",
          context: { service: "airtable", status: response.status },
          cause,
        }),
      };
    }
  }

  const body = truncateBody(await safeReadBody(response));

  if (RETRYABLE_HTTP_STATUS.has(response.status)) {
    return {
      transientError: new ExternalServiceError({
        message: `Airtable HTTP ${response.status}`,
        context: { service: "airtable", status: response.status, body },
      }),
    };
  }

  // Erreurs déterministes : 401 (PAT invalide), 403 (scope manquant),
  // 404 (base id / table id incorrect), 4xx divers → retry inutile.
  return {
    fatalError: new ExternalServiceError({
      message: `Airtable HTTP ${response.status} (non-retryable)`,
      context: { service: "airtable", status: response.status, body },
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch avec retry (une page)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchOnePageWithRetry(url: string, pat: string): Promise<AirtableListResponse> {
  let lastTransient: ExternalServiceError | undefined;

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    const result = await attemptFetch(url, pat);

    if (result.data) return result.data;
    if (result.fatalError) throw result.fatalError;

    // Reste : transientError
    lastTransient = result.transientError;
    const isLastAttempt = attempt === RETRY_DELAYS_MS.length - 1;
    if (isLastAttempt) break;

    // Log d'observabilité (sans PAT, sans body PII — Airtable n'en retourne
    // pas de toute façon, mais le logger scrube par sécurité).
    logger.warn(
      {
        service: "airtable",
        attempt: attempt + 1,
        totalAttempts: RETRY_DELAYS_MS.length,
        nextRetryMs: RETRY_DELAYS_MS[attempt + 1],
        cause: lastTransient?.context?.cause ?? lastTransient?.context?.status,
      },
      "Airtable transient error, retrying",
    );
    await currentSleep(RETRY_DELAYS_MS[attempt + 1]!);
  }

  // Toutes les tentatives ont épuisé : propage la dernière transient.
  // lastTransient est forcément défini ici (sinon on aurait return/throw plus tôt).
  throw lastTransient!;
}

// ─────────────────────────────────────────────────────────────────────────────
// API publique — fetch complet (avec pagination)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Récupère TOUS les records d'une table Airtable en suivant la pagination
 * `offset`. Ne fetch QUE les `fields` demandés (data minimization + moins
 * de trafic réseau).
 *
 * Throw `ExternalServiceError` :
 *   - après épuisement des 4 tentatives sur transient (429/5xx/network),
 *   - immédiatement sur erreur déterministe (401/403/404/autres 4xx).
 *
 * Throw `ConfigError` (via `getAirtableEnv()`) si les vars Airtable
 * manquent au moment du premier appel.
 *
 * ⚠️ Cap défensif `MAX_PAGES` (100) contre une boucle infinie théorique
 * si Airtable retournait toujours un `offset` non-null (bug SDK/proxy).
 * 100 pages × 100 records/page = 10 000 records — bien au-delà des besoins
 * Médéré (~18 commerciaux aujourd'hui).
 */
export async function fetchAirtableRecords(
  tableId: string,
  fields: readonly string[],
): Promise<AirtableRecord[]> {
  const env = getAirtableEnv();
  const baseUrl = `${AIRTABLE_API_BASE}/${env.AIRTABLE_BASE_ID}/${tableId}`;

  const records: AirtableRecord[] = [];
  let offset: string | undefined;
  const MAX_PAGES = 100;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams();
    for (const field of fields) params.append("fields[]", field);
    if (offset !== undefined) params.set("offset", offset);
    const url = `${baseUrl}?${params.toString()}`;

    const pageData = await fetchOnePageWithRetry(url, env.AIRTABLE_PAT);
    records.push(...pageData.records);

    if (pageData.offset === undefined) return records;
    offset = pageData.offset;
  }

  // Cap atteint = anomalie côté Airtable ou usage inattendu. On propage
  // sans avaler pour ne pas masquer un problème structurel.
  throw new ExternalServiceError({
    message: `Airtable pagination exceeded ${MAX_PAGES} pages`,
    context: { service: "airtable", tableId, pages: MAX_PAGES },
  });
}
