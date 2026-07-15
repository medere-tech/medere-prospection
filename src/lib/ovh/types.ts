/**
 * Types partagés du wrapper OVH SMS (S7a).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Périmètre S7a.0 — surface TYPÉE consommée par :
 *
 *   - `src/lib/ovh/client.ts`   (S7a.3) singleton SDK @ovhcloud/node-ovh
 *   - `src/lib/ovh/send-sms.ts` (S7a.3) wrapper endpoint http2sms
 *
 * Pas de logique ici — types externes uniquement. Le mapping vers le
 * format http2sms (params query string OVH historique) est encapsulé en
 * S7a.3 et invisible des consommateurs.
 *
 * Référence : skill `medere-ovh-sms` (auth, http2sms, parsing E.164,
 * gestion d'erreurs).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Envoi SMS sortant
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Payload d'envoi SMS sortant via OVH `/sms/{serviceName}/jobs`.
 *
 * `receivers` : un OU plusieurs numéros au format E.164. La VALIDATION
 * du format est de la responsabilité du CALLER (via `libphonenumber-js`
 * ou wrapper Twilio Lookup en S7b). Le wrapper OVH trust le format et
 * passe la chaîne telle quelle à OVH — si OVH refuse, on remonte une
 * `ExternalServiceError` côté wrapper.
 *
 * Plusieurs `receivers` en un seul appel = OVH facture un SMS par
 * receiver, mais nous économisons un round-trip API. À utiliser
 * uniquement pour des envois LOT identiques (campagne à payload uniforme,
 * cas rare ici). Le flow standard reste 1 receiver / 1 appel.
 *
 * `message` : texte du SMS. **La compliance est vérifiée EN AMONT par
 * `pre-send-check.ts` (S5/S6)** — annonce IA, présence STOP, plage
 * horaire, plafond 3/30j, opt-out, Bloctel. Le wrapper OVH ne re-vérifie
 * RIEN (single responsibility — sinon on duplique la logique compliance
 * à deux endroits et on risque la divergence).
 *
 * ⚠️ Aucun champ `sender` ici : le sender ID OVH est lu de l'env
 * (`OVH_SMS_SENDER`) côté wrapper. Le rendre paramétrable ouvrirait un
 * vecteur de spoofing accidentel (callers qui se trompent et envoient
 * avec un mauvais sender → confusion commerciale + risque CNIL).
 */
export interface SmsPayload {
  receivers: readonly string[];
  message: string;
}

/**
 * Résultat d'un envoi SMS OVH réussi.
 *
 * - `messageIds` : IDs OVH renvoyés, un par receiver, dans le même ordre
 *   que `payload.receivers`. Utilisés pour corréler les rapports de
 *   livraison reçus via webhook OVH (à câbler en S7b ou S8).
 *
 * - `creditsRemoved` : nombre de crédits SMS débités pour l'envoi
 *   (1 crédit = 1 SMS facturé OVH). Sert à la télémétrie coût et au
 *   suivi de quota mensuel.
 *
 * Cas partiel (certains receivers acceptés, d'autres rejetés par OVH)
 * traité en S7a.3 : le wrapper throw `ExternalServiceError` avec contexte
 * détaillant les receivers en faute, plutôt que de renvoyer un succès
 * silencieux. Cohérent avec « erreurs jamais avalées » (CLAUDE.md).
 */
export interface SmsResult {
  messageIds: readonly string[];
  creditsRemoved: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Réception SMS entrant — CALLBACK PUSH (webhook OVH, S9.6-FIX2, INFRA-SMS-001)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Payload BRUT du CALLBACK PUSH OVH inbound, tel que capturé en prod via le
 * log diagnostic S9.6-FIX sur le webhook `/api/webhooks/ovh-sms`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * FORMAT RÉEL FIGÉ (S9.6-FIX2)
 *
 *   Content-Type : application/x-www-form-urlencoded
 *   Champs       :
 *     id         : number  — ID OVH unique du SMS entrant
 *     senderid   : string  — numéro expéditeur (PS qui répond)
 *     message    : string  — corps brut du SMS (1-1600 chars)
 *     keyword    : string  — optionnel, mot-clef configuré côté OVH
 *     shortcode  : string  — optionnel, numéro Time2Chat de destination
 *     tag        : string  — optionnel, tag OVH (souvent vide)
 *     token      : string  — optionnel, shared secret dupliqué du query
 *
 * ⚠️ POINTS D'ATTENTION
 *
 *   - `id` est un NUMBER dans le body form-urlencoded (converti par la
 *     route `route.ts:143-144` avant passage au parser).
 *
 *   - `senderid` (PAS `sender`) est le nom du champ dans le callback push.
 *     Ce format DIFFÈRE du `GET /sms/{svc}/incoming/{id}` qui renvoie
 *     `sender`. Le parser `parseIncomingOvhSms` cible EXCLUSIVEMENT le
 *     callback push — si un futur poller consomme le GET incoming, écrire
 *     un parser SÉPARÉ (single responsibility, éviter la conflation).
 *
 *   - `senderid` n'est PAS garanti E.164 par OVH — le parser le normalise
 *     via `toE164('FR')` (supporte `0033XXX`, `33XXX`, `+33XXX`, `06XX`).
 *
 *   - `token` du body est IGNORÉ par le parser — l'authentification vit
 *     dans le query param (`route.ts` step 2, `verifyOvhWebhookToken`).
 *     Ne pas s'appuyer sur sa présence côté parser.
 */
export interface OvhCallbackPush {
  /** ID OVH unique du SMS entrant. NUMBER dans le payload OVH. */
  id: number;
  /** Numéro de l'expéditeur (PS). Format non garanti E.164 — normalisé par le parser. */
  senderid: string;
  /** Corps brut du SMS, jusqu'à 1600 chars = 10 segments GSM-7. */
  message: string;
  /** Mot-clef OVH configuré (optionnel). */
  keyword?: string;
  /** Numéro Time2Chat de destination (optionnel, ex: `+33939070545`). */
  shortcode?: string;
  /** Tag OVH (souvent vide, optionnel). */
  tag?: string;
  /** Shared secret dupliqué du query param `?token=` (ignoré par le parser). */
  token?: string;
}
