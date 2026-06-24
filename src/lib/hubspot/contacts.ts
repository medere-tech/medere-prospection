/**
 * Récupération des contacts HubSpot (S10.1.2.b) — paginé via memberships
 * d'une liste OU fetch direct par ID.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Rôle métier
 *
 *   - `getContactsInList(listId, opts)` : alimente le seed S10.1.3
 *     (importer 200 contacts dentistes IDF depuis la liste HubSpot SMS
 *     correspondante).
 *   - `getContact(hubspotId)` : utilitaire de re-fetch ponctuel (futur
 *     UI admin pour rafraîchir un contact, debug, etc.).
 *
 * Le mapping HubSpot → ContactSchema Firestore est fait par
 * `mapper.ts::mapHubSpotContactToFirestoreContact` (pure function),
 * appelée par le caller (seed) après réception du `HubspotContactRaw`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pattern 2-steps `getContactsInList`
 *
 *   1. `membershipsApi.getPage(listId, after, _, limit)` → liste les
 *      `recordId`s de la liste (paginé, cursor opaque `after`).
 *   2. `contacts.batchApi.read({ inputs, properties })` → fetch les
 *      détails des recordIds en 1 round-trip.
 *
 *   Pourquoi pas `contacts.basicApi.getById` × N ?
 *     - basicApi : 1 req par contact = 100 contacts × 1 req = 100 reqs,
 *       saturé par la rate limit HubSpot (100/10s).
 *     - batchApi : 1 req pour 100 contacts = 1 req. ~100× moins de
 *       calls API.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Sécurité
 *
 *   - Les `properties` retournées contiennent des PII (firstname, email,
 *     phone). Le caller est responsable de ne PAS logger le retour brut
 *     (pattern aligné `getContactByPhone` JSDoc Firestore).
 *
 *   - Erreurs SDK → `ExternalServiceError` retry-friendly. Le `cause` SDK
 *     préserve la stack interne mais le message custom NE FUITE PAS
 *     d'éventuel snippet PII dans une `err.message` HubSpot.
 */

import { ExternalServiceError, ValidationError } from "@/lib/utils/errors";

import { getHubspotClient } from "./client";

/**
 * Hash court (8 chars hex) — diagnostic forensic dans
 * ExternalServiceError context sans fuite de l'identifiant brut.
 * djb2 — suffisant pour fingerprint diag, pas garantie crypto.
 *
 * TODO S10.X+ : migrer vers `hashPii()` (HMAC-SHA256 + pepper, cf.
 * GUARD-002 / `getAuditEnv().AUDIT_PII_PEPPER`) pour cohérence projet.
 */
function shortFingerprint(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) & 0xffffffff;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ─────────────────────────────────────────────────────────────────────────────
// Constantes — properties whitelistées (cf. A-b2 S10.1.2.b.0)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Properties HubSpot fetchées pour mapping vers ContactSchema Firestore.
 * Liste figée S10.1.2.b — décision A-b2 arbitrée Déthié.
 *
 * 🔒 SENTINEL — modification = re-validation Déthié + impact mapper.ts
 *    + impact compliance (les opt-out ci-dessous pilotent le filtre seed
 *    S10.1.9 OPTOUT-FILTER-001 ; une suppression accidentelle masquerait
 *    silencieusement les opt-out → import de contacts opposés au démarchage
 *    → 375 k€ L.34-5 CPCE / 75 k€ Bloctel selon le canal).
 *
 * Ordre : standard HubSpot d'abord, custom Médéré ensuite. Pas de
 * dépendance à l'ordre côté API (l'API HubSpot retourne un dict, pas
 * un array ordonné).
 *
 * Note format API : l'API HubSpot v3 sérialise les bool natifs comme
 * STRINGS "true"/"false" dans `properties{}`. Le mapper/seed-runner doit
 * parser explicitement (cf. `extractOptOutFlags` dans mapper.ts).
 */
export const HUBSPOT_CONTACT_PROPERTIES = [
  "firstname", // → firstName
  "lastname", // → lastName
  "email", // → email (optional)
  "phone", // → phone.raw fallback
  "mobilephone", // → phone.raw priorité
  "city", // → city
  "zip", // → postalCode
  "civilite", // custom → civilite (via HUBSPOT_CIVILITE_MAP)
  "profession", // custom → speciality (via 21-enum CONTACT_SPECIALITY_VALUES)
  // S10.1.9 OPTOUT-FILTER-001 — filtrées dans seed-runner.ts (étape A.0,
  // AVANT mapping). Pas mappées vers Contact Firestore : le filtre est
  // pre-import, l'info ne sert qu'au seed pour skip.
  "hs_email_optout", // standard HubSpot, bool natif (API renvoie string)
  "sms_opted_out", // custom Médéré (créé par Déthié S10.1.9), bool natif
] as const;

/**
 * Max records par appel `membershipsApi.getPage`. HubSpot limite à 250
 * par page côté API ; on borne à 100 pour cohérence avec le pattern
 * Firestore `listContacts` (S10.1.2.c LIST_CONTACTS_MAX_LIMIT) et
 * confort UI (page 100 contacts).
 *
 * 🔒 SENTINEL — verrouillé par test sentinelle.
 */
export const GET_CONTACTS_IN_LIST_DEFAULT_LIMIT = 100;

/** Max strict — anti-DoS HubSpot quota. */
export const GET_CONTACTS_IN_LIST_MAX_LIMIT = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Types publiques
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Forme brute d'un contact HubSpot retourné par `batchApi.read()`. Le
 * mapping vers ContactSchema Firestore est fait par `mapper.ts`.
 *
 * `properties` peut contenir des `null` (HubSpot retourne null pour les
 * champs vides). Le mapper traite cela en `undefined`.
 */
export interface HubspotContactRaw {
  /** recordId HubSpot (= `hubspotId` Firestore). */
  id: string;
  /** Dict des properties fetchées (subset de HUBSPOT_CONTACT_PROPERTIES). */
  properties: Record<string, string | null>;
}

export interface GetContactsInListInput {
  /** Cursor opaque HubSpot — passer `nextCursor` de la page précédente. */
  cursor?: string;
  /** Default 100, max 100. */
  limit?: number;
}

export interface GetContactsInListOutput {
  contacts: HubspotContactRaw[];
  /** Cursor pour la page suivante (`undefined` si dernière page). */
  nextCursor: string | undefined;
  hasMore: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Type guards (typage défensif — SDK retourne `unknown`)
// ─────────────────────────────────────────────────────────────────────────────

interface RawMembershipsPage {
  results: Array<{ recordId: string; membershipTimestamp?: Date | string }>;
  paging?: { next?: { after?: string } };
}

function isMembershipsPage(raw: unknown): raw is RawMembershipsPage {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as { results?: unknown };
  if (!Array.isArray(r.results)) return false;
  return r.results.every((item) => {
    if (typeof item !== "object" || item === null) return false;
    return typeof (item as { recordId?: unknown }).recordId === "string";
  });
}

interface RawBatchReadResponse {
  results: Array<{ id: string; properties: Record<string, string | null> }>;
}

function isBatchReadResponse(raw: unknown): raw is RawBatchReadResponse {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as { results?: unknown };
  if (!Array.isArray(r.results)) return false;
  return r.results.every((item) => {
    if (typeof item !== "object" || item === null) return false;
    const obj = item as Record<string, unknown>;
    return (
      typeof obj.id === "string" && typeof obj.properties === "object" && obj.properties !== null
    );
  });
}

interface RawSimplePublicObject {
  id: string;
  properties: Record<string, string | null>;
}

function isSimplePublicObject(raw: unknown): raw is RawSimplePublicObject {
  if (typeof raw !== "object" || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  return (
    typeof obj.id === "string" && typeof obj.properties === "object" && obj.properties !== null
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// getContactsInList
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Récupère une page de contacts d'une liste HubSpot.
 *
 * Pipeline 2-steps :
 *   1. `membershipsApi.getPage(listId, after=cursor, limit=N)` → recordIds + paging
 *   2. `contacts.batchApi.read({ inputs, properties })` → détails
 *
 * Pas de cache : chaque appel hit l'API HubSpot. Le caller (seed
 * S10.1.3) doit boucler avec le `nextCursor` jusqu'à `hasMore === false`.
 *
 * @throws ValidationError si `listId` vide ou `limit` hors bornes.
 * @throws ExternalServiceError si l'appel SDK échoue OU si le retour
 *                              est mal formé.
 *
 * @example
 *   let cursor: string | undefined;
 *   const allContacts: HubspotContactRaw[] = [];
 *   do {
 *     const page = await getContactsInList("1234", { cursor });
 *     allContacts.push(...page.contacts);
 *     cursor = page.nextCursor;
 *   } while (cursor !== undefined);
 */
export async function getContactsInList(
  listId: string,
  opts: GetContactsInListInput = {},
): Promise<GetContactsInListOutput> {
  if (typeof listId !== "string" || listId.trim() === "") {
    throw new ValidationError({
      message: "getContactsInList: listId must be a non-empty string",
      context: { op: "getContactsInList" },
    });
  }

  const limit = opts.limit ?? GET_CONTACTS_IN_LIST_DEFAULT_LIMIT;
  if (limit < 1 || limit > GET_CONTACTS_IN_LIST_MAX_LIMIT) {
    throw new ValidationError({
      message: `getContactsInList: limit must be in [1, ${GET_CONTACTS_IN_LIST_MAX_LIMIT}]`,
      context: { op: "getContactsInList", limit },
    });
  }

  const client = getHubspotClient();

  // ── Step 1 : memberships → recordIds + paging ────────────────────────────
  let membershipsRaw: unknown;
  try {
    membershipsRaw = await client.crm.lists.membershipsApi.getPage(
      listId,
      opts.cursor,
      undefined,
      limit,
    );
  } catch {
    // SDK throw sur 401, 5xx, network. On wrap en ExternalServiceError
    // retry-friendly SANS attacher `cause: err` (S10.1.7-SECURITY-CAUSE-
    // LEAK-001) : le SDK HubSpot peut embarquer le token Bearer dans
    // `err.message`, et si un caller logue `logger.error({ err: ext })`
    // (sérialiseur Pino par défaut), la chaîne `err.cause.message` est
    // sérialisée et fuit le token. Cohérent avec lists.ts:243-260.
    // Forensic via context op/listId + Sentry côté serveur.
    throw new ExternalServiceError({
      message: "getContactsInList: HubSpot membershipsApi.getPage failed",
      context: {
        service: "hubspot",
        op: "getContactsInList.memberships",
        // listId OK dans context (opaque ID interne HubSpot, pas PII).
        listId,
      },
    });
  }

  if (!isMembershipsPage(membershipsRaw)) {
    throw new ExternalServiceError({
      message: "getContactsInList: malformed memberships response",
      context: { service: "hubspot", op: "getContactsInList.memberships.parse", listId },
    });
  }

  const recordIds = membershipsRaw.results.map((r) => r.recordId);
  const nextCursor = membershipsRaw.paging?.next?.after;

  // Liste vide → court-circuit (pas d'appel batchApi.read inutile).
  if (recordIds.length === 0) {
    return { contacts: [], nextCursor: undefined, hasMore: false };
  }

  // ── Step 2 : batchApi.read → détails ─────────────────────────────────────
  let batchRaw: unknown;
  try {
    batchRaw = await client.crm.contacts.batchApi.read({
      inputs: recordIds.map((id) => ({ id })),
      properties: [...HUBSPOT_CONTACT_PROPERTIES],
      propertiesWithHistory: [],
    });
  } catch {
    // SDK throw sur 401, 5xx, network. PAS de `cause: err` (S10.1.7-SECURITY-
    // CAUSE-LEAK-001) — même rationale que membershipsApi.getPage ci-dessus :
    // le SDK HubSpot peut embarquer le token Bearer dans `err.message`.
    throw new ExternalServiceError({
      message: "getContactsInList: HubSpot contacts.batchApi.read failed",
      context: {
        service: "hubspot",
        op: "getContactsInList.batchRead",
        listId,
        // recordIds.length OK (count), pas les IDs eux-mêmes (semi-PII).
        recordIdsCount: recordIds.length,
      },
    });
  }

  if (!isBatchReadResponse(batchRaw)) {
    throw new ExternalServiceError({
      message: "getContactsInList: malformed batch read response",
      context: { service: "hubspot", op: "getContactsInList.batchRead.parse", listId },
    });
  }

  return {
    contacts: batchRaw.results.map((r) => ({
      id: r.id,
      properties: r.properties,
    })),
    nextCursor,
    hasMore: nextCursor !== undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// getContact (fetch ponctuel)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch un contact HubSpot par son recordId.
 *
 * Utilité : re-fetch ponctuel depuis l'UI admin (rafraîchir un contact
 * après modification HubSpot), debug, validation manuelle.
 *
 * Pour un import mass, préférer `getContactsInList` (batchApi = 100×
 * moins de calls API).
 *
 * @throws ValidationError si `hubspotId` vide.
 * @throws ExternalServiceError si l'appel SDK échoue OU si le retour
 *                              est mal formé. Note : HubSpot retourne
 *                              404 pour un id inexistant — wrappé en
 *                              `ExternalServiceError` SANS `cause`
 *                              (S10.1.7-SECURITY-CAUSE-LEAK-001). Le
 *                              statusCode original n'est plus surfacé ;
 *                              utiliser un wrapper dédié `getContactOrNull`
 *                              si la distinction 404 vs 5xx est nécessaire.
 */
export async function getContact(hubspotId: string): Promise<HubspotContactRaw> {
  if (typeof hubspotId !== "string" || hubspotId.trim() === "") {
    throw new ValidationError({
      message: "getContact: hubspotId must be a non-empty string",
      context: { op: "getContact" },
    });
  }

  const client = getHubspotClient();

  let raw: unknown;
  try {
    raw = await client.crm.contacts.basicApi.getById(hubspotId, [...HUBSPOT_CONTACT_PROPERTIES]);
  } catch {
    // SDK throw sur 401, 404, 5xx, network. PAS de `cause: err` (S10.1.7-
    // SECURITY-CAUSE-LEAK-001) — le SDK HubSpot peut embarquer le token
    // Bearer dans `err.message`. Forensic via context + Sentry.
    //
    // Note 404 : le statusCode original n'est plus extractible côté caller
    // sans `cause`. Si un caller a besoin de distinguer 404 d'autres
    // erreurs (cas rare), il faudra introduire un wrapper dédié
    // `getContactOrNull()` qui catch et retourne null sur 404.
    throw new ExternalServiceError({
      message: "getContact: HubSpot contacts.basicApi.getById failed",
      context: {
        service: "hubspot",
        op: "getContact.basic",
        // Fingerprint au lieu de hubspotId brut — l'ID HubSpot identifie
        // UN contact PS spécifique côté CRM Médéré (semi-PII). Le forensic
        // se fait via corrélation timestamp + fingerprint côté admin.
        hubspotIdFingerprint: shortFingerprint(hubspotId),
      },
    });
  }

  if (!isSimplePublicObject(raw)) {
    throw new ExternalServiceError({
      message: "getContact: malformed contact response",
      context: {
        service: "hubspot",
        op: "getContact.basic.parse",
        hubspotIdFingerprint: shortFingerprint(hubspotId),
      },
    });
  }

  return { id: raw.id, properties: raw.properties };
}
