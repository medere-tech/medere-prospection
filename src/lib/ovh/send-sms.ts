/**
 * Wrapper d'envoi SMS via l'API OVH http2sms (S7a.3.2).
 *
 * Endpoint cible : `POST /sms/{serviceName}/jobs` — création d'un job
 * d'envoi SMS. La réponse OVH expose `ids`, `totalCreditsRemoved`,
 * `validReceivers`, `invalidReceivers`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ⚠️ TODO GUARD-003 / S7c — Loi 30 juin 2025
 *
 * **Deadline LÉGALE** : 11 août 2026 (entrée en vigueur de la mention
 * obligatoire de l'annonceur dans tout SMS de prospection).
 *
 * **Deadline INTERNE** : **1er juillet 2026** (marge sécurité — Médéré
 * fermé 10-21 août, déploiement urgent impossible durant cette fenêtre).
 *
 * Cette fonction NE VALIDE PAS la présence de la mention « Médéré » dans
 * `payload.message`. C'est la responsabilité de `lib/compliance/
 * pre-send-check.ts` (extension S7c — module
 * `advertiser-identification.ts` à créer) qui doit checker le body
 * AVANT d'appeler `sendSms`.
 *
 * Risque : tout SMS sortant Médéré sans la mention nominale à partir
 * du 1er juillet 2026 = violation L.121-26 Code de la consommation =
 * amende administrative.
 *
 * NE PAS CÂBLER ici (séparation responsabilité — wrapper OVH = I/O bas
 * niveau, compliance = règles métier).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ⚠️ Décision MVP `noStopClause: false` (filet OVH actif)
 *
 * OVH ajoute automatiquement « STOP au [shortcode] » en fin de SMS.
 * Coût : potentiellement 1 segment SMS supplémentaire si le body était
 * déjà proche de 160 chars. Bénéfice : filet de sécurité conforme
 * L.34-5 CPCE même si Claude oubliait la mention STOP dans le body
 * généré (le pre-send-check `hasOptOut` reste le premier filet, OVH
 * est le second).
 *
 * Bascule vers `noStopClause: true` ENVISAGÉE en S7c/S8 SOUS CONDITION
 * CUMULATIVE :
 *   (a) Confirmation du wording exact attendu par le compliance counsel
 *       ("STOP au 38080" ? "Envoyez STOP au …" ? autre ?).
 *   (b) Ajout d'une sentinelle code stricte dans pre-send-check :
 *       `bodyContainsActionableOptOut(message)` qui valide une FORME
 *       précise, pas juste `\bSTOP\b`.
 *   (c) Compliance-auditor GREEN sur la nouvelle chaîne.
 *
 * Voir ticket INFRA-SMS-001 dans le backlog Notion (3 options arbitrées :
 * short code OVH / page web Webflow / bypass hardcodé).
 *
 * Voir test `lib/compliance/opt-out.test.ts:10-11` qui assume actuellement
 * le format OVH "STOP au [shortcode]" — cohérent avec `noStopClause: false`.
 *
 * Divergence assumée vs skill `medere-ovh-sms` ligne 485 qui recommande
 * `noStopClause: true` (skill à mettre à jour post-S7a via INFRA-SMS-001).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Mapping erreurs SDK → AppError (cohérent S7a.1 Claude) :
 *
 *   - 401/403/400/404 (HTTP status number) → `ConfigError` (noRetry)
 *   - 429                                   → `RateLimitError` (retry)
 *   - 5xx                                   → `ExternalServiceError`
 *   - errno réseau (string : ENOTFOUND…)    → `ExternalServiceError`
 *   - OAuth object                          → `ExternalServiceError`
 *   - Reject de shape inattendu             → `InternalError`
 *   - 200 + invalidReceivers.length > 0     → `ValidationError`
 *   - 200 + validReceivers.length === 0     → `ValidationError`
 *   - 200 + shape inattendu (Zod fail)      → `ExternalServiceError`
 *
 * Rationale "4xx → ConfigError noRetry" : un 400 OVH = payload mal formé
 * (bug code) ; 401/403 = clé invalide / consumer key révoquée (config
 * morte) ; 404 = serviceName inexistant (config morte). Retry inutile.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Idempotence
 *
 * L'API OVH SMS **n'a pas d'idempotency-key native**. La protection
 * contre les doubles envois (retry Inngest, reload UI, etc.) est gérée
 * UPSTREAM :
 *
 *   1. `withContactLock` (S6.6) — concurrence intra-Inngest, un contact
 *      ne peut pas être en cours d'envoi en parallèle.
 *   2. Inngest event deduplication par `eventId` (S8+).
 *   3. Audit log post-envoi — alerte si `messageIds` dupliqué pour un
 *      même contact dans une fenêtre courte.
 *
 * Si `sendSms()` est appelé deux fois pour le même payload par mégarde,
 * OVH envoie deux SMS et facture deux fois. Le wrapper n'intervient pas.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Sécurité — anti-fuite credentials & PII
 *
 *   - Aucun `receivers[]` ni `message` n'apparaît dans les logs ou les
 *     `AppError.message`. Le `context` des erreurs SDK ne propage que
 *     HTTP status / errno category / op / service name.
 *   - `mapOvhError` ne propage JAMAIS le `err.message` brut du SDK
 *     (qui pourrait embarquer le consumer key tronqué ou la signature).
 *   - Le `sender` (OVH_SMS_SENDER) est lu de l'env à chaque appel,
 *     immuable par paramètre `SmsPayload` (cf. S7a.0 types.ts — anti-
 *     spoofing : empêche un caller de tester avec un autre nom qui
 *     partirait en prod).
 */

import { z } from "zod";

import { getOvhEnv } from "@/lib/security/env";
import {
  ConfigError,
  ExternalServiceError,
  InternalError,
  RateLimitError,
  ValidationError,
} from "@/lib/utils/errors";

import { getOvhClient } from "./client";
import type { SmsPayload, SmsResult } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes — bornes défensives
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Borne haute du body SMS — cohérence cross-module avec
 * `lib/firestore/messages.ts::BODY_MAX_LENGTH` (S6.5).
 *
 * 1600 chars ≈ 10 segments SMS GSM-7 ≈ 0.40 € plafond OVH FR. OVH accepte
 * techniquement plus mais on borne pour éviter un body explosif accidentel
 * (bug template, fuite Claude long-form, etc.).
 *
 * Si modifié, MAJ aussi `messages.ts` pour éviter le drift.
 */
const BODY_MAX_LENGTH = 1600;

/**
 * Classe SMS OVH : "phoneDisplay" = SMS standard affiché au destinataire.
 * (vs "flash" = affichage transitoire non stocké).
 *
 * ⚠️ FIX 5 juin 2026 : la valeur précédente `1` (référence GSM 03.38 DCS)
 * était invalide pour l'API OVH `POST /sms/{serviceName}/jobs` qui attend
 * un string énuméré ("phoneDisplay" | "flash"). Confirmation via 3 sources
 * doc OVH indépendantes (ovh/php-ovh issue #135, Fotolia/ovh-rest README,
 * gierschv/node-ovh issue #3). Bug détecté au premier vrai envoi OVH
 * en cloud Vercel (HTTP 400 "bad input"). Tracé INFRA-FIX-OVH-CLASS.
 */
const SMS_CLASS_STANDARD = "phoneDisplay";

/** Durée de validité du SMS côté OVH avant expiration (minutes — 48h default). */
const SMS_VALIDITY_PERIOD_MINUTES = 2880;

/**
 * Borne haute défensive sur le nombre de receivers par appel.
 *
 * En pratique, Médéré envoie **1 receiver / 1 appel** (cf. skill
 * `medere-ovh-sms` et `types.ts` JSDoc — audit log + traçabilité). Cette
 * borne à 1000 est ultra-large et sert de garde-fou contre un bug
 * upstream qui passerait un tableau monstrueux (boucle non bornée,
 * payload corrompu, etc.).
 *
 * Bénéfices :
 *   - Protection mémoire / stringification (tableau de 100k strings →
 *     stringification ≥ 5 MB → réponse OVH idem → consommation RAM).
 *   - Facturation : OVH facture 1 SMS par receiver — un envoi accidentel
 *     à 10k receivers = ~400 €. Cette borne capse à 40 € le max
 *     d'erreur facturable par appel.
 *
 * Si on doit un jour envoyer en masse légitime, repenser le pattern
 * (batch + idempotency upstream Inngest) plutôt que bumper cette borne.
 */
const MAX_RECEIVERS_PER_CALL = 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Schémas Zod — validation INPUT (payload) et OUTPUT (réponse SDK)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validation du payload côté wrapper. `receivers` doit être un tableau
 * non vide de strings non vides, borné à `MAX_RECEIVERS_PER_CALL` ;
 * `message` non vide, borné à `BODY_MAX_LENGTH`.
 *
 * Validation E.164 sémantique = caller's responsibility (cf. S7a.0 JSDoc :
 * le wrapper trust le format et passe la chaîne telle quelle à OVH ; si
 * OVH refuse, on remonte ValidationError via `invalidReceivers`).
 *
 * ⚠️ `z.strictObject` (vs `z.object`) — anti-spoofing belt-and-braces.
 * Si un caller passe `{ ..., sender: "PHISH" }` via un cast TS forcé
 * (`as unknown as SmsPayload`), Zod throw `ValidationError` immédiat
 * plutôt que de strip silencieusement le champ inconnu. Verrouille la
 * décision design S7a.0 « sender immuable côté env, jamais paramétrable »
 * avec un signal de code explicite (4e filet anti-spoofing après : type
 * TS sans `sender`, env-driven sender, hardcoding `sender: env.X` dans
 * l'appel SDK).
 */
const SmsPayloadSchema = z.strictObject({
  receivers: z.array(z.string().min(1)).min(1).max(MAX_RECEIVERS_PER_CALL),
  message: z.string().min(1).max(BODY_MAX_LENGTH),
});

/**
 * Schéma de la réponse OVH http2sms (shape `POST /sms/{serviceName}/jobs`).
 * Source : skill `medere-ovh-sms` ligne 108-113 + doc API console OVH.
 *
 * Tous les champs sont required en succès — si OVH renvoie un shape
 * différent (changement breaking API), on throw `ExternalServiceError`
 * plutôt que d'avaler silencieusement.
 */
const OvhSmsResponseSchema = z.object({
  ids: z.array(z.number()),
  totalCreditsRemoved: z.number(),
  validReceivers: z.array(z.string()),
  invalidReceivers: z.array(z.string()),
});

// ─────────────────────────────────────────────────────────────────────────────
// Mapping erreurs SDK OVH → AppError
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Forme du rejet SDK `@ovhcloud/node-ovh` v3 (cf. `lib/ovh.es5.js` ligne 504).
 *
 * Le champ `error` peut être :
 *   - `number`  : HTTP status code (1xx/4xx/5xx réponse OVH)
 *   - `string`  : errno réseau Node (`ENOTFOUND`, `ETIMEDOUT`, `ECONNREFUSED`)
 *   - `object`  : payload OAuth-like (rare en mode appKey/consumerKey)
 *
 * Le champ `message` est le corps texte de la réponse OVH (s'il existe).
 * On n'utilise JAMAIS `message` dans nos `AppError.message` côté wrapper
 * (anti-fuite — voir JSDoc en-tête).
 */
interface OvhReject {
  error: unknown;
  message?: unknown;
}

function isOvhReject(value: unknown): value is OvhReject {
  return typeof value === "object" && value !== null && "error" in value;
}

/**
 * Transforme une rejection SDK en `AppError` typée. Toujours `throw`,
 * signature `never`. Le `context` ne contient que des informations sûres
 * (op, service name, HTTP status / errno category) — JAMAIS le message
 * SDK brut ni les credentials.
 */
function mapOvhError(rejected: unknown, context: Record<string, unknown>): never {
  if (!isOvhReject(rejected)) {
    throw new InternalError({
      message: "Unexpected non-OVH rejection during SMS send",
      context,
    });
  }
  const err = rejected.error;

  if (typeof err === "number") {
    if (err === 401 || err === 403) {
      throw new ConfigError({
        message: "OVH API auth denied",
        context: { ...context, status: err },
      });
    }
    if (err === 400) {
      throw new ConfigError({
        message: "OVH API rejected request (bad input)",
        context: { ...context, status: err },
      });
    }
    if (err === 404) {
      throw new ConfigError({
        message: "OVH API route or service not found",
        context: { ...context, status: err },
      });
    }
    if (err === 429) {
      throw new RateLimitError({
        message: "OVH API rate limit hit",
        context: { ...context, status: err },
      });
    }
    if (err >= 500) {
      throw new ExternalServiceError({
        message: "OVH API internal error",
        context: { ...context, status: err },
      });
    }
    // Autres 4xx non-couverts (410 Gone, 422, etc.) → catch-all config.
    throw new ConfigError({
      message: "OVH API client error",
      context: { ...context, status: err },
    });
  }

  if (typeof err === "string") {
    // errno réseau Node : ENOTFOUND / ETIMEDOUT / ECONNREFUSED / etc.
    throw new ExternalServiceError({
      message: "OVH API connection failure",
      context: { ...context, errno: err },
    });
  }

  if (typeof err === "object" && err !== null) {
    // OAuth-like error (très rare en mode appKey/consumerKey).
    throw new ExternalServiceError({
      message: "OVH API auth/oauth failure",
      context: { ...context, kind: "oauth-error" },
    });
  }

  throw new InternalError({
    message: "Unexpected OVH rejection shape",
    context,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// sendSms — surface publique
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Envoie un SMS via OVH http2sms.
 *
 * @throws ValidationError  - payload invalide (receivers vide, body vide/trop long)
 *                          - OVH a rejeté un ou plusieurs receivers
 *                            (context.reason = "ovh_rejected_receivers" ou
 *                            "no_valid_receivers")
 * @throws ConfigError      - OVH 4xx (auth, payload, service inexistant) — noRetry
 * @throws RateLimitError   - OVH 429 — retry-friendly avec backoff
 * @throws ExternalServiceError - OVH 5xx, errno réseau, OAuth, shape réponse inattendu
 * @throws InternalError    - rejection SDK de shape inattendu (bug interne)
 */
export async function sendSms(payload: SmsPayload): Promise<SmsResult> {
  // ── 1. Validation du payload (Zod, AVANT tout appel SDK) ───────────────
  const parsed = SmsPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError({
      message: "sendSms: payload invalid",
      context: {
        op: "sendSms",
        // path + code uniquement — JAMAIS la valeur invalide
        // (anti-fuite : le payload contient receivers + message PII).
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          code: i.code,
        })),
      },
    });
  }

  // ── 2. Préparation de l'appel ──────────────────────────────────────────
  const env = getOvhEnv();
  const client = getOvhClient();

  // ── 3. Appel SDK + mapping erreur ──────────────────────────────────────
  let response: unknown;
  try {
    response = await client.requestPromised("POST", `/sms/${env.OVH_SMS_SERVICE_NAME}/jobs`, {
      message: parsed.data.message,
      // ⚠️ Sender lu de l'env, JAMAIS du payload (anti-spoofing — décision
      // S7a.0). Validé Zod max 11 chars en S2.
      sender: env.OVH_SMS_SENDER,
      receivers: parsed.data.receivers,
      class: SMS_CLASS_STANDARD,
      // ⚠️ noStopClause: false — filet OVH actif (décision MVP S7a.3,
      // cf. JSDoc en-tête). OVH ajoute "STOP au [shortcode]" en fin.
      noStopClause: false,
      validityPeriod: SMS_VALIDITY_PERIOD_MINUTES,
    });
  } catch (rejected) {
    // Note : ni `receivers` ni `message` dans le context (PII / coordonnées).
    mapOvhError(rejected, {
      op: "sendSms",
      service: env.OVH_SMS_SERVICE_NAME,
    });
  }

  // ── 4. Validation de la réponse SDK ────────────────────────────────────
  const parsedResponse = OvhSmsResponseSchema.safeParse(response);
  if (!parsedResponse.success) {
    throw new ExternalServiceError({
      message: "OVH response has unexpected shape",
      context: {
        op: "sendSms",
        issues: parsedResponse.error.issues.map((i) => ({
          path: i.path.join("."),
          code: i.code,
        })),
      },
    });
  }

  const data = parsedResponse.data;

  // ── 5. Vérification du statut des receivers ────────────────────────────
  // Cas A : partial (certains receivers refusés par OVH) — surface visible.
  // Cas B : total reject (validReceivers vide mais 200 OK) — edge case.
  // Les deux remontent en ValidationError (cohérent S7a.3 Q3 — l'appelant
  // Inngest doit catch et acter "envoi raté" avec forensic precise).
  if (data.invalidReceivers.length > 0) {
    throw new ValidationError({
      message: "OVH rejected one or more receivers",
      context: {
        op: "sendSms",
        invalidReceivers: data.invalidReceivers,
        validReceivers: data.validReceivers,
        reason: "ovh_rejected_receivers",
      },
    });
  }
  if (data.validReceivers.length === 0) {
    throw new ValidationError({
      message: "OVH accepted no receivers",
      context: {
        op: "sendSms",
        invalidReceivers: data.invalidReceivers,
        validReceivers: data.validReceivers,
        reason: "no_valid_receivers",
      },
    });
  }

  // ── 6. Mapping vers SmsResult (cohérence S7a.0) ────────────────────────
  // OVH renvoie `ids: number[]` ; on convertit en `string[]` pour cohérence
  // avec Firestore `messages.externalId: string` (S6.4).
  return {
    messageIds: data.ids.map(String),
    creditsRemoved: data.totalCreditsRemoved,
  };
}
