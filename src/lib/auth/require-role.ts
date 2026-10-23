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
 *       "role":         "{{user.public_metadata.role}}",
 *       "firstName":    "{{user.first_name}}",
 *       "lastName":     "{{user.last_name}}",
 *       "slackUserId":  "{{user.public_metadata.slackUserId}}",
 *       "testAccount":  "{{user.public_metadata.testAccount}}"
 *     }
 *
 *   `testAccount` est posé par `scripts/setup-e2e-clerk-users.mjs` sur
 *   les comptes du harnais Playwright (`e2e-commercial`,
 *   `e2e-commercial-owner`, `e2e-admin`). En production (`VERCEL_ENV ===
 *   "production"`), tout `testAccount === true` est refusé par
 *   `requireRole` → impossible pour un compte test de s'authentifier
 *   contre le dashboard prod même si quelqu'un a provisionné les comptes
 *   dans Clerk live par erreur (défense en profondeur du refus
 *   `sk_live_` du script). Cf. finding M1 security-reviewer PR1.14.1.
 *
 *   Chaque utilisateur Clerk doit avoir `publicMetadata.role` ∈
 *   `{"admin", "commercial"}`. Si absent ou mal formé, l'utilisateur est
 *   refusé avec un message FR explicite + un `logger.warn` côté serveur
 *   pour faciliter le debug en dev (sentinelle de config).
 *
 *   `publicMetadata.slackUserId` est OPTIONNEL (format `U[A-Z0-9]+`,
 *   validé Zod). Permet la correspondance Clerk ↔ Slack pour la vue
 *   conversation (titulaire d'un hand-off = `conversation.handoff.assignedTo`
 *   Slack userId → résolution Clerk via ce claim). Si absent, le commercial
 *   ne verra PAS l'onglet « Mes conversations » rempli (fallback onglet
 *   « À traiter »). Peuplement initial via le script
 *   `scripts/sync-clerk-slack-ids.mjs` qui lit Airtable Commerciaux
 *   et écrit `publicMetadata.slackUserId` via Clerk Backend API.
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
// S10.1.8 — ceinture + bretelles (security-reviewer M-2, PR1.14.2) :
// empêche toute importation accidentelle depuis un Client Component. Le
// build Next.js throw si un fichier `"use client"` importe (directement
// ou transitivement) ce module. Protection complémentaire du poisoning
// implicite via `@clerk/nextjs/server` ci-dessous.
//
// Côté vitest, `server-only` est aliasé vers `tests/mocks/server-only.ts`
// (stub vide) — cf. `vitest.config.ts::resolve.alias`.
import "server-only";

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
 * SENTINELLE — liste exacte des claims attendus par ce code depuis le
 * JWT template Clerk (dashboard → Sessions → Customize session token).
 *
 * Le template Clerk doit émettre EXACTEMENT ces 5 clés et pas d'autres :
 *
 *   {
 *     "role":        "{{user.public_metadata.role}}",
 *     "firstName":   "{{user.first_name}}",
 *     "lastName":    "{{user.last_name}}",
 *     "slackUserId": "{{user.public_metadata.slackUserId}}",
 *     "testAccount": {{user.public_metadata.testAccount}}
 *   }
 *
 * ⚠ `testAccount` est intentionnellement SANS guillemets dans le template
 *   pour que Clerk préserve le type JSON natif (boolean) depuis
 *   publicMetadata. Les 4 autres sont des chaînes (ou null si metadata
 *   absent). Le Zod `SessionClaimsSchema` ci-dessous reflète ces types.
 *
 * Cette constante est utilisée par `clerk-jwt-template.test.ts` pour
 * détecter tout drift : si un claim est ajouté au template sans mettre
 * à jour `SessionClaimsSchema` (ou l'inverse), le test échoue.
 */
export const EXPECTED_CLERK_JWT_CLAIMS = [
  "role",
  "firstName",
  "lastName",
  "slackUserId",
  "testAccount",
] as const satisfies readonly string[];

/**
 * Zod schema strict — TOUT autre rôle (`"superadmin"`, `""`, `null`,
 * etc.) est refusé. Sentinelle anti-bypass : un dev qui essaie d'écrire
 * `publicMetadata.role = "superadmin"` pensant escalader sera refusé
 * avec un `ForbiddenError`, pas autorisé par défaut.
 */
export const RoleSchema = z.enum(["admin", "commercial"]);

/**
 * Regex Slack user ID. Format `U` suivi de 1+ caractères `[A-Z0-9]`
 * (ex: `U05UVHGBURX`). Alignée avec `assertSlackUserId` et le scrubber
 * logger `TECHNICAL_ID_KEYS["slackUserId"]`.
 */
const SLACK_USER_ID_REGEX = /^U[A-Z0-9]+$/;

/**
 * Schéma des sessionClaims attendus du JWT Clerk. `firstName` / `lastName`
 * / `slackUserId` optionnels (Clerk les remplit si le compte les a — sinon
 * `undefined`, on dégrade gracieusement côté UI).
 *
 * ⚠ PR1.14.2 (fix FAIT 1) — null-safety des claims optionnels.
 *   Clerk JWT templates remplacent `{{user.public_metadata.X}}` par :
 *     - la chaîne vide `""` si X est explicitement présent et vaut `""`
 *     - **`null`** si X est absent de publicMetadata (comportement
 *       documenté Clerk, pour conserver un JSON valide)
 *   Un `.optional()` seul laisse Zod rejeter `null`, ce qui bloquait tout
 *   admin sans `slackUserId` (le user `e2e-admin` et par symétrie Déthié
 *   / Harry / Justine qui n'ont pas de compte Slack Médéré) :
 *     "requireRole: invalid sessionClaims (role missing or malformed)"
 *   On accepte explicitement `null` et on le normalise en `undefined` via
 *   `.transform()` pour tous les claims optionnels (`firstName`,
 *   `lastName`, `slackUserId`, `testAccount`). `role` reste strict —
 *   c'est l'invariant sécuritaire : pas de role = pas d'accès.
 */
const SessionClaimsSchema = z.object({
  role: RoleSchema,
  firstName: z
    .string()
    .min(1)
    .nullish()
    .transform((v) => v ?? undefined),
  lastName: z
    .string()
    .min(1)
    .nullish()
    .transform((v) => v ?? undefined),
  slackUserId: z
    .union([z.string().regex(SLACK_USER_ID_REGEX), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v === "" || v === null || v === undefined ? undefined : v)),
  /**
   * PR1.14.1 — flag posé par `scripts/setup-e2e-clerk-users.mjs` sur les
   * comptes du harnais Playwright. En prod, `requireRole` refuse tout
   * compte avec `testAccount === true`.
   *
   * ⚠ PR1.14.2 — fail-closed strict. Le JWT template Clerk émet ce claim
   *   SANS guillemets (cf. `EXPECTED_CLERK_JWT_CLAIMS` ci-dessus) → le
   *   type natif boolean est préservé par Clerk. On accepte UNIQUEMENT :
   *     - `true`         (compte test provisionné)
   *     - `false`        (compte réel qui a eu testAccount=false pour une raison)
   *     - `null`         (metadata absent — compte réel historique)
   *     - `undefined`    (claim absent du JWT — compte historique sans ce claim)
   *   Toute autre valeur (`"true"`, `"TRUE"`, `1`, `"yes"`, `{}`, ...) fait
   *   échouer Zod → ForbiddenError (fail-closed). Garantit qu'un
   *   changement d'API Clerk ou une tentative de bypass ne peut pas
   *   neutraliser silencieusement la garde `testAccount && production`.
   */
  testAccount: z
    .union([z.boolean(), z.null()])
    .optional()
    .transform((v) => v === true),
});

/** Contexte utilisateur retourné par `requireRole`. */
export interface RoleContext {
  userId: string;
  role: Role;
  firstName?: string;
  lastName?: string;
  /**
   * Slack user ID du commercial (`U...`), si configuré dans
   * `publicMetadata.slackUserId`. Utilisé pour résoudre le titulaire d'une
   * conversation (vue conversation, onglet « Mes conversations »).
   * Absent pour les admins Déthié/Harry/Justine qui n'ont pas de compte
   * Slack Médéré, OU pour tout utilisateur dont le metadata n'est pas
   * encore seedé (fallback propre — pas de crash).
   */
  slackUserId?: string;
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

  const { role, firstName, lastName, slackUserId, testAccount } = parsed.data;

  // PR1.14.1 — défense en profondeur : un compte test ne peut JAMAIS
  // s'authentifier contre le dashboard prod. Garantit que si quelqu'un
  // provisionne `e2e-admin` / `e2e-commercial-owner` dans Clerk live par
  // erreur (le script refuse par défaut, mais garde-fou en couche app),
  // ces comptes restent inoffensifs.
  if (testAccount && process.env.VERCEL_ENV === "production") {
    throw new ForbiddenError({
      message: `requireRole: testAccount=true refusé en VERCEL_ENV=production (userId=${userId})`,
      clientMessage: "Compte de test non autorisé en production.",
      context: { userId },
    });
  }

  // Hiérarchie : admin couvre tout, commercial couvre uniquement commercial.
  const allowed = role === "admin" || role === required;
  if (!allowed) {
    throw new ForbiddenError({
      message: `requireRole: role "${role}" insufficient for required "${required}"`,
      context: { userId, role, required },
    });
  }

  return { userId, role, firstName, lastName, slackUserId };
}
