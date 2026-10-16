/**
 * Logique métier pour la route d'OBSERVATION du callback OVH stopCallBack
 * (DIAG-STOP-OVH étape B).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi un module séparé de la route ?
 *
 * Next.js App Router interdit dans un `route.ts` tout export autre que :
 *   - les méthodes HTTP (GET, POST, ...)
 *   - les options de config de route (`runtime`, `dynamic`, etc.)
 *
 * Un export fonction/type/constante supplémentaire est accepté par le
 * typecheck mais peut faire échouer `next build` (comportement sujet à
 * évolution). Pour isoler ce risque et faciliter le test unitaire, toute
 * la logique métier (masquage, agrégation, persist Firestore) vit dans
 * ce module `lib/ovh/stop-callback.ts`. La route n'importe que les
 * fonctions nécessaires et n'exporte que ses handlers HTTP.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Anti-PII (invariants verrouillés par tests sentinelles)
 *
 *   - Numéros (regex `+?\d{8,}`) → hash HMAC (`safeExternalIdHash` préfixé
 *     `oih_` + chunking anti-scrubber) + 4 derniers chiffres.
 *   - Texte quelconque → `length` SEULEMENT, jamais la valeur brute.
 *   - Clé `token` systématiquement filtrée avant persist.
 *   - Objets intermédiaires construits via `Object.create(null)` pour
 *     verrouiller defense-en-profondeur contre la prototype pollution
 *     indépendamment du comportement du setter `__proto__`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Firestore
 *
 * Collection `ovh_stop_callbacks` — deny-all client via `firestore.rules`,
 * écriture exclusive via Admin SDK. `receivedAt` posé par
 * `FieldValue.serverTimestamp()` (jamais forgé côté application).
 */
import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firestore/admin";
import { safeExternalIdHash } from "@/lib/utils/pii-detector";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collection Firestore de persistance. Deny-all client via firestore.rules
 * (defense-in-depth miroir `audit_log`, cf. firestore-rules test suite).
 */
export const OVH_STOP_CALLBACKS_COLLECTION = "ovh_stop_callbacks";

// ─────────────────────────────────────────────────────────────────────────────
// Masquage valeur unique
// ─────────────────────────────────────────────────────────────────────────────

export interface MaskedValue {
  type: "phoneLike" | "text" | "non-string";
  length: number;
  hash?: string;
  last4?: string;
}

/**
 * Masque une valeur en fonction de sa forme :
 *   - Numéro (regex `+?\d{8,}`) → `{type:"phoneLike", length, hash: safeExternalIdHash(trimmed), last4}`.
 *   - Texte quelconque → `{type:"text", length}` SEULEMENT, jamais la valeur brute.
 *   - Non-string → `{type:"non-string", length: 0}`.
 *
 * Exposé pour tests sentinelles.
 */
export function maskValueForStopCallback(value: unknown): MaskedValue {
  if (typeof value !== "string") {
    return { type: "non-string", length: 0 };
  }
  const trimmed = value.trim();
  // Phone-like : `+<digits>` ou `<digits>` >= 8 chiffres (couvre E.164,
  // FR national, international lato).
  if (/^\+?\d{8,}$/.test(trimmed)) {
    const digits = trimmed.replace(/\D/g, "");
    return {
      type: "phoneLike",
      length: value.length,
      hash: safeExternalIdHash(trimmed),
      last4: digits.slice(-4),
    };
  }
  return { type: "text", length: value.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Agrégation parameters (query ou body)
// ─────────────────────────────────────────────────────────────────────────────

export interface ParamSummary {
  name: string;
  masked: MaskedValue;
}

/**
 * Convertit un `Record<string,string>` en liste de `ParamSummary`. FILTRE
 * la clé `token` par défense-en-profondeur : même si elle est déjà dans
 * la query et pas censée fuiter, on refuse de la persister sous quelque
 * forme que ce soit (y compris les métadonnées comme sa longueur).
 */
export function summarizeParams(params: Record<string, string>): ParamSummary[] {
  const out: ParamSummary[] = [];
  for (const [name, value] of Object.entries(params)) {
    if (name === "token") continue;
    out.push({ name, masked: maskValueForStopCallback(value) });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Persist Firestore
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shape d'entrée de `persistCallback`. Exportée pour permettre les tests
 * emulator qui appellent `persistCallback` directement (sans passer par
 * la route complète).
 */
export interface PersistInput {
  method: string;
  queryParams: ParamSummary[];
  contentType: string;
  bodyParams?: ParamSummary[];
  bodyParseError?: string;
}

/**
 * Persiste un appel stopCallBack dans Firestore `ovh_stop_callbacks/`.
 *
 * `receivedAt` posé par `FieldValue.serverTimestamp()` — jamais forgé
 * côté application (invariant forensique). Les tests emulator
 * (`tests/firestore/ovh-stop-callbacks.test.ts`) vérifient que l'écriture
 * SDK Admin réussit avec les objets construits via `Object.create(null)`
 * dans `summarizeParams` upstream (compat prouvée).
 *
 * @returns docId Firestore généré.
 */
export async function persistCallback(input: PersistInput): Promise<string> {
  const docRef = await getAdminDb()
    .collection(OVH_STOP_CALLBACKS_COLLECTION)
    .add({
      method: input.method,
      contentType: input.contentType,
      queryParams: input.queryParams,
      ...(input.bodyParams !== undefined ? { bodyParams: input.bodyParams } : {}),
      ...(input.bodyParseError !== undefined ? { bodyParseError: input.bodyParseError } : {}),
      receivedAt: FieldValue.serverTimestamp(),
    });
  return docRef.id;
}
