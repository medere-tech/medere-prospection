/**
 * Fixtures Playwright PR1.14 — signin via Clerk testing + lectures d'env
 * pour les IDs de conversation réels (fournis par l'opérateur, jamais
 * commités).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Note PR1.14.1 — nommage "commercial-owner"
 *
 *   `e2e-commercial-owner` n'a PAS de rôle Clerk particulier
 *   (`role: "commercial"` tout court, idem `e2e-commercial`). Le suffixe
 *   "owner" signifie uniquement que son `publicMetadata.slackUserId`
 *   partage DÉLIBÉRÉMENT la valeur `U05UVHGBURX` (celle de Déthié) : la
 *   logique serveur `loadConversationDetail` compare slackUserId du
 *   viewer à `handoff.assignedTo` du doc Firestore pour calculer
 *   `viewerIsOwner`, donc ce compte devient titulaire des conversations
 *   réelles assignées à Déthié SANS qu'on ait à écrire un seul doc
 *   Firestore pour les tests. Cf. M2 security-reviewer PR1.14.1.
 */
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect as pwExpect, type Page, test as base } from "@playwright/test";

const DOMAIN = process.env.E2E_EMAIL_DOMAIN ?? "example.com";

export const E2E_EMAIL_COMMERCIAL = `e2e-commercial+clerk_test@${DOMAIN}`;
export const E2E_EMAIL_COMMERCIAL_OWNER = `e2e-commercial-owner+clerk_test@${DOMAIN}`;
export const E2E_EMAIL_ADMIN = `e2e-admin+clerk_test@${DOMAIN}`;
// PR1.14.2 — compte sans role ni slackUserId, pour tester la page de
// refus propre (`src/app/admin/forbidden.tsx`) via le scénario S10.
export const E2E_EMAIL_NO_ROLE = `e2e-no-role+clerk_test@${DOMAIN}`;

export const CONV_ID_ADMIN_NON_OWNER = process.env.E2E_CONV_ID_FOR_ADMIN_NON_OWNER ?? null;
export const CONV_ID_INEXISTANT = process.env.E2E_CONV_ID_INEXISTANT ?? "inexistant-pr1-test";

/**
 * F2 compliance-auditor PR1.14 — regexes de détection numéro FR étendues.
 *
 *   - `0X XX XX XX XX` (séparateurs espace, point, tiret ou aucun)
 *   - `+33 X XX XX XX XX` et `0033 X XX XX XX XX` (format international)
 */
const PHONE_PATTERNS: readonly RegExp[] = [
  /\b0[1-9](?:[\s.\-]?\d{2}){4}\b/,
  /\+33\s?[1-9](?:[\s.\-]?\d{2}){4}\b/,
  /\b0033\s?[1-9](?:[\s.\-]?\d{2}){4}\b/,
];

/** Pattern email suffisamment conservateur pour un scrubber. */
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

/** Scrubbe toute PII (phone/email) d'une chaîne avant stockage/affichage. */
export function scrubPii(input: string): string {
  let out = input;
  for (const re of PHONE_PATTERNS) out = out.replace(new RegExp(re, "g"), "[REDACTED_PHONE]");
  out = out.replace(new RegExp(EMAIL_PATTERN, "gi"), "[REDACTED_EMAIL]");
  return out;
}

/**
 * Vérifie qu'aucun numéro de téléphone français ne transparaît dans
 * `text` (DOM, body JSON, console). Message d'erreur SANS reproduire le
 * numéro détecté (SRP compliance : jamais rejouer la PII dans l'assertion).
 */
export function assertNoFrenchPhone(text: string, context: string): void {
  for (const re of PHONE_PATTERNS) {
    pwExpect(
      text,
      `Fuite numéro FR détectée (pattern ${re}) dans : ${context}. Contenu scrubbé non reproduit.`,
    ).not.toMatch(re);
  }
}

/**
 * Patterns d'identifiants techniques qui ne devraient JAMAIS être visibles
 * dans l'UI admin — PR2b-2 P1. Si l'un apparaît dans `document.body.innerText`,
 * c'est que le trigger d'un Select / une ligne / une puce rend l'id brut
 * au lieu du libellé humain résolu.
 *
 *   - `\bU[A-Z0-9]{8,}\b` : Slack userId (U… en majuscules, 9+ chars).
 *   - `\bhubspot-list-\d+\b` : HubSpot list id canonique Médéré.
 */
const TECHNICAL_ID_PATTERNS: readonly RegExp[] = [
  /\bU[A-Z0-9]{8,}\b/,
  // security-reviewer PR2b-2 LOW : Slack Enterprise Grid IDs commencent
  // par `W`. Médéré n'y est pas aujourd'hui mais filet trivial.
  /\bW[A-Z0-9]{8,}\b/,
  /\bhubspot-list-\d+\b/,
  // security-reviewer PR2b-2 LOW : Clerk user IDs — défense si l'UI
  // commence à exposer un compte Clerk directement.
  /\buser_[A-Za-z0-9]{20,}\b/,
];

/**
 * Pattern snake_case style `AuditAction` (`backfill_conversation_list_fields`,
 * `handoff_unassigned`, …). SÉPARÉ de `TECHNICAL_ID_PATTERNS` car il peut
 * matcher du contenu légitime écrit par un médecin dans un SMS entrant
 * (ex. `jean_dupont@…`). On l'applique UNIQUEMENT sur l'UI hors fil des
 * messages (hors `role="log"`) via `assertNoAuditActionCode`.
 */
const AUDIT_ACTION_CODE_PATTERN = /\b[a-z]{3,}(?:_[a-z]+){1,}\b/;

export function assertNoTechnicalId(text: string, context: string): void {
  for (const re of TECHNICAL_ID_PATTERNS) {
    pwExpect(
      text,
      `Identifiant technique visible (${re}) dans : ${context}. Vérifier le trigger du Select ou le fallback de rendu.`,
    ).not.toMatch(re);
  }
}

/**
 * Scope restreint : à appeler sur `innerText` d'un extrait du DOM qui
 * EXCLUT le fil des messages (`role="log"`). Pour obtenir cet extrait,
 * utiliser `innerTextWithoutMessageThread(page)` ci-dessous.
 */
export function assertNoAuditActionCode(text: string, context: string): void {
  pwExpect(
    text,
    `Code snake_case brut visible dans : ${context}. Vérifier le libellé d'audit (sanitize.ts).`,
  ).not.toMatch(AUDIT_ACTION_CODE_PATTERN);
}

/**
 * Retourne `document.body.innerText` AVEC le fil des messages retiré.
 * Permet d'appliquer `assertNoAuditActionCode` sans faux positif d'un
 * SMS entrant qui contient un underscore (ex. `jean_dupont@…`).
 */
export async function innerTextWithoutMessageThread(page: Page): Promise<string> {
  return page.evaluate(() => {
    const clone = document.body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[role="log"]').forEach((el) => el.remove());
    return clone.innerText;
  });
}

/**
 * Installe un listener réseau sur `/api/admin/conversations/*` qui
 * échoue immédiatement si une réponse contient un numéro FR. C'est le
 * vrai filet de sécurité anti-régression côté backend.
 */
export function installApiPhoneSentinel(page: Page): void {
  page.on("response", async (resp) => {
    const url = resp.url();
    if (!/\/api\/admin\/conversations\//.test(url)) return;
    try {
      const body = await resp.text();
      for (const re of PHONE_PATTERNS) {
        if (re.test(body)) {
          throw new Error(
            `Fuite numéro FR dans la réponse API (pattern ${re}) : ${url}. ` +
              `Contenu scrubbé non reproduit — vérifier sanitize.ts côté serveur.`,
          );
        }
      }
    } catch (err) {
      // Rejeté par Playwright : la promise non-handled fera échouer le test.
      if (err instanceof Error && err.message.startsWith("Fuite numéro")) throw err;
      // Autre erreur (body stream fermé, etc.) : silent-ignore, pas de
      // false positive.
    }
  });
}

/** Signin via code OTP figé (`424242`) — mode test Clerk. */
async function signInAs(page: Page, identifier: string): Promise<void> {
  await setupClerkTestingToken({ page });
  await page.goto("/sign-in");
  await clerk.signIn({
    page,
    signInParams: { strategy: "email_code", identifier },
  });
}

interface Fixtures {
  signInAsCommercial: () => Promise<void>;
  signInAsCommercialOwner: () => Promise<void>;
  signInAsAdmin: () => Promise<void>;
  signInAsNoRole: () => Promise<void>;
}

// Nommer `provide` (et non `use`) le callback de setup Playwright
// évite un faux-positif `react-hooks/rules-of-hooks` qui pense que
// `use(...)` est un hook React. L'API Playwright accepte n'importe quel
// nom (c'est le 2ᵉ argument positionnel).
export const test = base.extend<Fixtures>({
  signInAsCommercial: async ({ page }, provide) => {
    await provide(() => signInAs(page, E2E_EMAIL_COMMERCIAL));
  },
  signInAsCommercialOwner: async ({ page }, provide) => {
    await provide(() => signInAs(page, E2E_EMAIL_COMMERCIAL_OWNER));
  },
  signInAsAdmin: async ({ page }, provide) => {
    await provide(() => signInAs(page, E2E_EMAIL_ADMIN));
  },
  signInAsNoRole: async ({ page }, provide) => {
    await provide(() => signInAs(page, E2E_EMAIL_NO_ROLE));
  },
});

export { expect } from "@playwright/test";
