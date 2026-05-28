/**
 * Enveloppes génériques pour les réponses des routes API Next.js.
 *
 * Convention :
 *   - Succès → `{ data: T }` (HTTP 2xx)
 *   - Erreur → `{ error: { code, message } }` (HTTP 4xx/5xx), forme stable
 *     côté client (cf. `AppError.toClientBody()` dans `lib/utils/errors.ts`).
 *   - Pagination → curseur opaque (string), `null` quand plus de résultats.
 *
 * Aucune dépendance Firestore ou serveur ici : ces types sont consommés par
 * les composants React du dashboard.
 */
import type { ClientErrorBody, ErrorCode } from "@/lib/utils/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Rôles utilisateur (dashboard Clerk)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rôles utilisés par Clerk + les `firestore.rules`. `admin` hérite des droits
 * de `commercial` (cf. helpers `isCommercial()` / `isAdmin()` dans les rules).
 */
export type Role = "admin" | "commercial";

// ─────────────────────────────────────────────────────────────────────────────
// Enveloppes succès / erreur
// ─────────────────────────────────────────────────────────────────────────────

/** Réponse API en succès. */
export interface ApiSuccess<T> {
  data: T;
}

/** Réponse API en erreur (forme stable, jamais de stack ni de message technique). */
export type ApiError = ClientErrorBody;

/** Union discriminée à matcher côté client via la présence de `data` ou `error`. */
export type ApiResponse<T> = ApiSuccess<T> | ApiError;

/** Helper de type guard côté consommateur (composants, hooks React Query). */
export function isApiError(value: ApiResponse<unknown>): value is ApiError {
  return "error" in value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pagination (curseur opaque)
// ─────────────────────────────────────────────────────────────────────────────

/** Page de résultats avec curseur opaque pour la page suivante. */
export interface Paginated<T> {
  items: T[];
  /** Curseur à fournir en query pour la prochaine page. `null` si fin. */
  nextCursor: string | null;
}

/** Paramètres de pagination communs (validés Zod côté route API en S5+). */
export interface PaginationParams {
  cursor?: string;
  limit?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ré-export utile (pour que le code consommateur n'ait pas à importer 2 modules
// quand il manipule des réponses d'erreur).
// ─────────────────────────────────────────────────────────────────────────────

export type { ErrorCode };
