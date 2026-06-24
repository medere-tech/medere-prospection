/**
 * RBAC — récupère le contexte utilisateur Clerk et vérifie le rôle requis.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Modèle de rôles
 *
 *   Deux rôles uniquement (MVP S10.1) — modélisés dès maintenant pour ne
 *   pas refactor plus tard (firestore.rules ont DÉJÀ `isAdmin()` et
 *   `isCommercial()` pré-câblés, c'est cohérent).
 *
 *     - "admin"      : Déthié, Harry, Justine. Voient tout, peuvent
 *                      envoyer 1er SMS, futur : voir audits + monitoring.
 *     - "commercial" : Vanessa, Zacharie, Jeremy, Sophie, etc. Voient
 *                      leurs contacts assignés, peuvent envoyer 1er SMS.
 *
 *   Hiérarchie :
 *     - `requireRole("admin")`      → autorise "admin" UNIQUEMENT
 *     - `requireRole("commercial")` → autorise "admin" OU "commercial"
 *
 *   Un admin est un commercial++ — c'est le pattern habituel et c'est ce
 *   que `firestore.rules::isCommercial()` reflète.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Source du rôle : Clerk JWT custom claim
 *
 *   Côté Clerk dashboard → Sessions → Customize session token, on définit :
 *     {
 *       "role":      "{{user.public_metadata.role}}",
 *       "firstName": "{{user.first_name}}",
 *       "lastName":  "{{user.last_name}}"
 *     }
 *
 *   Chaque utilisateur Clerk doit avoir `publicMetadata.role` ∈
 *   `{"admin", "commercial"}`. Si absent ou mal formé, l'utilisateur est
 *   refusé avec un message FR explicite + un `logger.warn` côté serveur
 *   pour faciliter le debug en dev (sentinelle de config).
 *
 *   Cf. `src/lib/auth/README.md` pour la procédure complète Clerk dashboard.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Usage
 *
 *   // Server Component
 *   const { userId, role, firstName, lastName } = await requireRole("commercial");
 *
 *   // Route Handler (API)
 *   try {
 *     const { userId } = await requireRole("admin");
 *     // ...
 *   } catch (err) {
 *     if (err instanceof UnauthorizedError) return new Response(...401);
 *     if (err instanceof ForbiddenError)    return new Response(...403);
 *     throw err;
 *   }
 *
 *   Les erreurs `UnauthorizedError` / `ForbiddenError` viennent de
 *   `@/lib/utils/errors`. Elles portent un `clientMessage` FR par défaut
 *   et un `statusCode` (401 / 403). Cf. CLAUDE.md "Sécurité §5 — Erreurs
 *   jamais renvoyées au client".
 */
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { ForbiddenError, UnauthorizedError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

// ─────────────────────────────────────────────────────────────────────────────
// Types + schémas
// ─────────────────────────────────────────────────────────────────────────────

/** Rôle applicatif. Aligné sur `firestore.rules::hasRole(...)`. */
export type Role = "admin" | "commercial";

/**
 * Zod schema strict — TOUT autre rôle (`"superadmin"`, `""`, `null`,
 * etc.) est refusé. Sentinelle anti-bypass : un dev qui essaie d'écrire
 * `publicMetadata.role = "superadmin"` pensant escalader sera refusé
 * avec un `ForbiddenError`, pas autorisé par défaut.
 */
export const RoleSchema = z.enum(["admin", "commercial"]);

/**
 * Schéma des sessionClaims attendus du JWT Clerk. `firstName` / `lastName`
 * optionnels (Clerk les remplit si le compte les a — sinon `undefined`,
 * on dégrade gracieusement côté UI).
 */
const SessionClaimsSchema = z.object({
  role: RoleSchema,
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
});

/** Contexte utilisateur retourné par `requireRole`. */
export interface RoleContext {
  userId: string;
  role: Role;
  firstName?: string;
  lastName?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// requireRole
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vérifie que l'utilisateur Clerk courant est authentifié ET porte le
 * rôle requis (ou un rôle supérieur dans la hiérarchie `admin > commercial`).
 *
 * @throws {UnauthorizedError} 401 — pas de session Clerk (utilisateur
 *   non connecté). Le middleware aurait dû intercepter en amont sur
 *   `/admin/*` et `/api/admin/*` — si on arrive ici sans userId, c'est
 *   soit (a) un caller dans un contexte non protégé par middleware
 *   (server component sur route publique), soit (b) un bug de matcher.
 *   Dans les deux cas, throw 401 propre.
 *
 * @throws {ForbiddenError} 403 — session valide mais sessionClaims
 *   invalides (JWT template Clerk mal configuré OU
 *   publicMetadata.role absent/mal formé OU rôle insuffisant pour la
 *   ressource).
 */
export async function requireRole(required: Role): Promise<RoleContext> {
  const { userId, sessionClaims } = await auth();

  if (!userId) {
    throw new UnauthorizedError({
      message: "requireRole: no userId returned by Clerk auth()",
    });
  }

  const parsed = SessionClaimsSchema.safeParse(sessionClaims);
  if (!parsed.success) {
    // Sentinelle de config : logge SANS PII (juste userId Clerk opaque + path/code
    // Zod sanitisés). Aucune fuite côté client (les détails Zod restent
    // côté serveur).
    logger.warn(
      {
        userId,
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          code: i.code,
        })),
      },
      "[requireRole] sessionClaims invalid — vérifie le JWT template Clerk dashboard (custom claim role/firstName/lastName + publicMetadata.role)",
    );
    throw new ForbiddenError({
      message: "requireRole: invalid sessionClaims (role missing or malformed)",
      clientMessage: "Rôle utilisateur non configuré. Contactez l'administrateur.",
      context: { userId },
    });
  }

  const { role, firstName, lastName } = parsed.data;

  // Hiérarchie : admin couvre tout, commercial couvre uniquement commercial.
  const allowed = role === "admin" || role === required;
  if (!allowed) {
    throw new ForbiddenError({
      message: `requireRole: role "${role}" insufficient for required "${required}"`,
      context: { userId, role, required },
    });
  }

  return { userId, role, firstName, lastName };
}
