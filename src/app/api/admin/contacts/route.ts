/**
 * GET /api/admin/contacts — liste paginée des contacts (RBAC admin).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rôle métier (S10.1.4.a)
 *
 *   Première route `/api/admin/*` du projet. Sert la pagination cursor +
 *   filtres status/campaignId du futur dashboard admin (S10.1.5+). Pas de
 *   write, pas d'effet de bord — lecture pure de Firestore via le wrapper
 *   `listContacts` (S10.1.2.c).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Sécurité — 3 couches
 *
 *   1. Middleware Clerk (`src/middleware.ts`) protège `/api/admin/(.*)` →
 *      `auth.protect()` renvoie 404 opaque sans session.
 *   2. `requireRole("admin")` côté handler — defense-in-depth + check
 *      rôle (un commercial authentifié ne doit PAS accéder à cette route,
 *      le middleware ne distingue pas les rôles).
 *   3. Zod strict sur les query params — anti-injection (cursor opaque,
 *      campaignId regex `^hubspot-list-\d+$`, status enum verrouillé).
 *
 *   Cf. CLAUDE.md "Sécurité §6 — Auth requise" + "§7 — Authz par action".
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Décisions S10.1.4.a (arbitrages Déthié)
 *
 *   D1 — Default `status="ready"` appliqué côté ROUTE (Zod default), pas
 *        hérité du default silencieux de `listContacts`. Si le default
 *        wrapper change un jour, cette route reste prévisible. La route
 *        passe TOUJOURS `status` explicite à `listContacts` (jamais
 *        `filters: { status: undefined }`).
 *
 *   D2 — PAS de masquage des phones (`phone.e164`/`phone.raw`) côté
 *        response. Admin authentifié RBAC doit voir le numéro complet
 *        (validation, call-back). Le masquage UX éventuel est de la
 *        responsabilité du frontend (S10.1.5+). Anti-leak Pino/Sentry géré
 *        en aval par le sanitizer logger.
 *
 *   Pas d'audit log sur READ — lecture pure sans impact compliance
 *   critique. Si un jour la compliance exige un audit READ, on l'ajoutera
 *   via `appendAuditLog({ action: "contacts_listed", ... })` avec payload
 *   PII-free.
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import {
  CONTACT_STATUS_VALUES,
  LIST_CONTACTS_DEFAULT_LIMIT,
  LIST_CONTACTS_MAX_LIMIT,
  listContacts,
} from "@/lib/firestore/contacts";
import { AppError } from "@/lib/utils/errors";
import { logger } from "@/lib/utils/logger";

// ─────────────────────────────────────────────────────────────────────────────
// Query schema (Zod strict — anti-injection)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pattern strict des `campaignId` Médéré : `hubspot-list-<numericId>`. Les
 * campagnes courantes (S10.1.3 seed) suivent ce format. Une regex stricte
 * ici protège contre l'injection (un `campaignId` arbitraire serait
 * propagé jusqu'à la query Firestore `where("campaignId", "==", X)` —
 * Firestore résiste, mais on coupe la chaîne d'attaque au plus tôt).
 *
 * 🔒 Si un futur format de campaignId apparaît (ex: campagnes ciblées
 * manuelles `manual-2026Q3-...`), élargir cette regex via une union
 * explicite, jamais via `z.string().min(1)`.
 */
const CAMPAIGN_ID_REGEX = /^hubspot-list-\d+$/;

const QuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  /**
   * `z.coerce` car les valeurs venant de `URLSearchParams` sont des strings.
   * Si la clé est ABSENTE de l'URL, `Object.fromEntries(searchParams)` ne
   * crée pas la clé → Zod applique `.default()` (jamais Number(undefined)).
   */
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(LIST_CONTACTS_MAX_LIMIT)
    .default(LIST_CONTACTS_DEFAULT_LIMIT),
  campaignId: z.string().regex(CAMPAIGN_ID_REGEX).optional(),
  /**
   * D1 — default route-level (PAS hérité du default silencieux de
   * `listContacts`). Source de vérité enum : `CONTACT_STATUS_VALUES`
   * (réexporté de `lib/firestore/contacts.ts`, dérivé de `ContactSchema`).
   */
  status: z.enum(CONTACT_STATUS_VALUES).default("ready"),
});

// ─────────────────────────────────────────────────────────────────────────────
// Handler GET
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // ── 1. Auth Clerk + RBAC admin ────────────────────────────────────────
    await requireRole("admin");

    // ── 2. Parse + valide query params ────────────────────────────────────
    const url = new URL(req.url);
    const queryResult = QuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!queryResult.success) {
      return NextResponse.json(
        {
          error: { code: "VALIDATION", message: "Paramètres de requête invalides." },
          issues: queryResult.error.issues.map((i) => ({
            path: i.path.join("."),
            code: i.code,
          })),
        },
        { status: 400 },
      );
    }

    // ── 3. Fetch via wrapper Firestore ────────────────────────────────────
    const { cursor, limit, campaignId, status } = queryResult.data;
    const result = await listContacts({
      filters: { status, campaignId },
      cursor,
      limit,
    });

    // ── 4. Response — phones EN CLAIR (D2 arbitrage Déthié) ───────────────
    return NextResponse.json({
      contacts: result.contacts,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    });
  } catch (err) {
    // AppError = surface client connue (401, 403, 400 cursor invalide…).
    // On expose `code` + `clientMessage` via `toClientBody()`, jamais
    // `message` technique ni `context` (qui pourrait contenir des hints PII).
    if (err instanceof AppError) {
      logger.warn(err.toLogObject(), "[GET /api/admin/contacts] AppError");
      return NextResponse.json(err.toClientBody(), { status: err.statusCode });
    }

    // Inattendu → 500 générique. On log un message court SANS sérialiser
    // `err` brut (la stack Firestore pourrait fuiter des fragments d'IDs
    // semi-PII dans Vercel logs / Sentry). Le sanitizer Pino couvre déjà,
    // mais on ajoute une couche : log juste `err.message`.
    logger.error(
      { errName: err instanceof Error ? err.name : "unknown" },
      "[GET /api/admin/contacts] unexpected error",
    );
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Une erreur est survenue. Réessayez plus tard." } },
      { status: 500 },
    );
  }
}
