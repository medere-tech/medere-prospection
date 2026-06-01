/**
 * Détecteur PII pour les payloads d'audit log (Médéré Prospection IA).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Mission : empêcher tout téléphone ou email **en clair** d'entrer dans
 * la collection Firestore `audit_log/`. Le module audit-log appelle
 * `detectPiiInPayload` AVANT toute écriture et throw `AuditPiiError` si
 * une violation est détectée. Cf. arbitrage Déthié S6.2 (approche (a)
 * "refuse + throw", garantie technique > mitigation runtime).
 *
 * `hashPii()` est l'utilitaire prévu pour le caller qui veut quand même
 * un identifiant traçable : HMAC-SHA256 avec un **pepper serveur**
 * (`AUDIT_PII_PEPPER`, env requise, validée S6.2.1) qui rend le hash
 * irréversible même en cas d'exfiltration complète de la collection.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Anti-bypass — décision Déthié S6.2 :
 *   Chaque string scannée est testée DEUX FOIS :
 *     - sur la valeur brute (preserve email & boundaries naturelles)
 *     - sur la valeur strippée de `\s.-` (déjoue les téléphones
 *       camouflés en `06 12 34 56 78` ou `+33.6.12.34.56.78`)
 *   Un kind ne produit qu'UNE violation par path (dédoublonnage des hits
 *   raw vs strippé).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Faux positifs gérés (alignement BUG-003) :
 *   - ISO 8601 timestamps avec offset `+02:00` ou `+33:00` : la regex
 *     E.164 exige ≥10 chiffres consécutifs après `+`, jamais le cas
 *     d'un offset (max 4 chiffres avant `:`).
 *   - UUIDs hex : la regex FR national exige `0[1-9]` (digit non-zéro
 *     après le 0 initial) + lookahead/lookbehind anti-hex pour exclure
 *     les séquences dans un UUID v4.
 *   - IDs HubSpot numériques purs (10+ chiffres sans 0 initial suivi
 *     de [1-9]) : ne matchent ni la regex E.164 (pas de `+`) ni la FR
 *     (boundary 10 chiffres exact requise).
 */
import { createHmac } from "node:crypto";

import { getAuditEnv } from "@/lib/security/env";
import { logger } from "@/lib/utils/logger";

// ─────────────────────────────────────────────────────────────────────────────
// Types publics
// ─────────────────────────────────────────────────────────────────────────────

export type PiiKind = "phone_e164" | "phone_fr_national" | "email";

export interface PiiViolation {
  /** Chemin JSON-pointer-like dans le payload (ex: `contact.phone`, `recipients[2].email`). */
  path: string;
  /** Type de PII détecté. */
  kind: PiiKind;
  /**
   * Trace courte (4 chars + "…") pour debug humain SEULEMENT.
   * JAMAIS la valeur complète — la promesse de ce module est qu'il
   * ne propage AUCUNE PII en aval, même en cas d'erreur.
   */
  sample: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Regex de détection — testées contre BUG-003 faux positifs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * E.164 : `+` suivi de 10 à 15 chiffres consécutifs. Suffisant pour
 * exclure les offsets ISO 8601 (`+02:00` = 2 chiffres avant `:`).
 */
const RE_E164 = /\+\d{10,15}/;

/**
 * FR national : 10 chiffres `0[1-9]\d{8}` avec frontières anti-digit.
 *   - `(?<!\d)` avant : pas un digit juste avant
 *   - `(?!\d)` après : pas un digit juste après
 *
 * Fix HIGH-1 S6.2 (security-reviewer) : la version précédente utilisait
 * `(?<![0-9a-fA-F])`/`(?![0-9a-fA-F])` qui ratait les téléphones collés à
 * un identifiant hexadécimal (`"msg0612345678abc"`, docId Firestore
 * alphanumérique fréquent). La version anti-digit pure capture ces cas.
 *
 * Le faux positif UUID v4 reste exclu via une combinaison : sur la version
 * RAW, les `-` cassent les 10 chiffres consécutifs ; sur la version
 * STRIPPÉE, un UUID v4 contient `4xxx` au 3e groupe et un timestamp
 * pseudo-random ailleurs, le pattern `0[1-9]\d{8}` n'y apparaît
 * statistiquement pas (la sous-chaîne `0e8400e29b` n'est pas un match :
 * `0` suivi de `e` n'est pas digit).
 */
const RE_FR_NATIONAL = /(?<!\d)0[1-9]\d{8}(?!\d)/;

/**
 * Email RFC-light. Suffisant pour la détection (pas pour la validation).
 * Le `.` est obligatoire dans le domaine → exclut les chaînes type
 * "user@somewhere" sans TLD.
 */
const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * Caractères de formatage à strip avant détection de téléphone.
 *
 * Fix HIGH-2 S6.2 (security-reviewer) : ajout des parenthèses `()`. La
 * notation E.123 ITU §6.2.1 utilise `+CC(0)NNN` en Europe et `+1 (NPA) NXX-XXXX`
 * aux US — sans `()` dans le strip, ces formats bypassent le scrubber.
 *
 * Justification anti-faux-positif : il n'existe aucun cas réel où 10 chiffres
 * consécutifs entre parenthèses dans un payload d'audit log soient AUTRE
 * chose qu'un téléphone (les nombres comptables, IDs, etc. ne sont pas mis
 * entre parenthèses en JSON).
 */
const STRIP_CHARS = /[\s.\-()]/g;

/** Limite de profondeur du walk récursif. Décision Déthié S6.2 : 10. */
export const PII_WALK_MAX_DEPTH = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Détection
// ─────────────────────────────────────────────────────────────────────────────

interface ScanContext {
  violations: PiiViolation[];
  seenByPathKind: Set<string>;
}

/**
 * Sample constant `"[redacted]"` — JAMAIS de fraction de la valeur d'origine.
 *
 * Fix MED-1 S6.2 (security-reviewer, option 2) : la version précédente
 * exposait les 4 premiers chars de la valeur (ex: `"dr.d…"` pour
 * `"dr.dupont@cabinet.fr"`). Sur le segment dentistes IDF (26k contacts),
 * `"dr.d…"` reste très identifiable (Dr Dupont, Dr Dubois, Dr Dumas, …),
 * ce qui est une pseudonymisation faible au sens RGPD art. 4. Pour audit
 * forensic CNIL, on supprime toute fraction.
 *
 * Le `path` + le `kind` portés par `PiiViolation` suffisent au debug humain :
 * « phone_e164 à `recipients[2].phone` » localise le bug sans aucun risque
 * de fuite.
 */
const REDACTED_SAMPLE = "[redacted]" as const;

function recordViolation(ctx: ScanContext, path: string, kind: PiiKind): void {
  const dedupKey = `${path}::${kind}`;
  if (ctx.seenByPathKind.has(dedupKey)) return;
  ctx.seenByPathKind.add(dedupKey);
  ctx.violations.push({ path, kind, sample: REDACTED_SAMPLE });
}

/**
 * Teste une string contre les 3 regex en mode dual-pass (raw + strippé).
 * Chaque pass appelle `recordViolation` indépendamment ; le dédoublonnage
 * par `(path, kind)` dans `recordViolation` garantit qu'une seule
 * violation par kind ressort, même si raw ET strippé matchent tous les
 * deux. Cette structure rend la branche dedup observable (testée),
 * plutôt qu'inerte derrière un `||` court-circuit.
 *
 * `RE_EMAIL` n'est testée que sur la raw (le strip casserait l'email).
 */
function scanString(ctx: ScanContext, path: string, value: string): void {
  const stripped = value.replace(STRIP_CHARS, "");

  if (RE_E164.test(value)) recordViolation(ctx, path, "phone_e164");
  if (RE_E164.test(stripped)) recordViolation(ctx, path, "phone_e164");

  if (RE_FR_NATIONAL.test(value)) recordViolation(ctx, path, "phone_fr_national");
  if (RE_FR_NATIONAL.test(stripped)) recordViolation(ctx, path, "phone_fr_national");

  if (RE_EMAIL.test(value)) recordViolation(ctx, path, "email");
}

function walk(ctx: ScanContext, node: unknown, path: string, depth: number): void {
  if (depth > PII_WALK_MAX_DEPTH) {
    // Fix LOW-1 S6.2 (security-reviewer) : on garde le graceful skip
    // (préfère un audit incomplet à un audit refusé pour profondeur),
    // MAIS on émet un signal observable. Permet à Sentry de capter un
    // caller qui pousse un payload anormalement deep en prod —
    // typiquement le wrapper récursif de log enrichi qui planque une
    // PII sans s'en rendre compte. Pas un throw : on ne bloque pas
    // l'écriture pour ce qui peut être un faux signal.
    logger.warn(
      {
        path,
        depth: PII_WALK_MAX_DEPTH,
        kind: "pii_walk_depth_exceeded",
      },
      "audit-log payload exceeded scrubber depth",
    );
    return;
  }

  if (typeof node === "string") {
    scanString(ctx, path, node);
    return;
  }

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      walk(ctx, node[i], `${path}[${i}]`, depth + 1);
    }
    return;
  }

  if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      const sub = path === "" ? k : `${path}.${k}`;
      walk(ctx, v, sub, depth + 1);
    }
    return;
  }

  // Autres types (number, boolean, null, undefined, symbol) : ignorés.
  // Un number ne peut pas porter de PII texte ; un téléphone numérique
  // serait déjà sérialisé en string par JSON.stringify côté Firestore,
  // mais on couvre la détection sur la **forme reçue par l'appelant**.
}

/**
 * Scanne récursivement un payload et retourne la liste des violations
 * PII détectées (vide si aucun hit). Ne throw JAMAIS — c'est le caller
 * (`audit-log.ts`) qui décide quoi faire avec la liste. Cette séparation
 * permet de tester la détection indépendamment de la politique d'écriture.
 *
 * @param payload n'importe quoi (objet, array, primitive, undefined).
 *                Typiquement un `Record<string, unknown>` côté caller.
 * @returns array vide si propre, sinon une violation par couple `path×kind`.
 */
export function detectPiiInPayload(payload: unknown): PiiViolation[] {
  const ctx: ScanContext = {
    violations: [],
    seenByPathKind: new Set(),
  };
  walk(ctx, payload, "", 0);
  return ctx.violations;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hash forensic — HMAC-SHA256 avec pepper serveur
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hash irréversible d'une valeur sensible (téléphone, email…) pour
 * stockage dans `audit_log/`. Utilise HMAC-SHA256 avec un pepper
 * serveur (`AUDIT_PII_PEPPER`, env requise).
 *
 * Propriétés :
 *   - **Déterministe** : même input + même pepper → même hash. Permet
 *     la corrélation forensic (retrouver toutes les actions liées à un
 *     contact donné si on connaît son téléphone + le pepper).
 *   - **Irréversible** : sans accès au pepper, impossible de retrouver
 *     la valeur d'origine même en bruteforce GPU dictionnaire (l'espace
 *     des téléphones FR mobiles ~80M serait cassé en quelques minutes
 *     avec un SHA-256 nu, mais devient infaisable avec un pepper 32+
 *     bytes random).
 *   - **Tronqué 32 chars hex** (= 128 bits) : assez pour unicité forensic
 *     sur 26k contacts MVP, anti-collision théorique sur 2^64 entrées.
 *
 * Throw `ConfigError` (propagation depuis `getAuditEnv`) si le pepper
 * n'est pas configuré ou trop court.
 */
export function hashPii(value: string): string {
  const { AUDIT_PII_PEPPER } = getAuditEnv();
  return createHmac("sha256", AUDIT_PII_PEPPER).update(value, "utf8").digest("hex").slice(0, 32);
}
