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
// Réception SMS entrant (webhook OVH — S9.6, INFRA-SMS-001)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Payload BRUT d'un SMS entrant OVH, tel que capturé en réel sur le service
 * SMS `sms-ng66707-1` via `GET /sms/{serviceName}/incoming/{id}` lors de
 * S9.6-EXPLORE (numéro Time2Chat `+33939070545`).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ⚠️ POINTS D'ATTENTION FIGÉS PAR LA CAPTURE RÉELLE
 *
 *   - `id` est un **NUMBER**, pas une string (contrairement au guess du
 *     skill `medere-ovh-sms:284-291` qui documentait un `z.union([string,
 *     number])`). Le parser (`parse-incoming.ts`) le convertit en string
 *     via `String(id)` avant émission de l'event Inngest
 *     `medere/sms.reply.received` (schema `ovhMessageId: z.string().min(1)`).
 *
 *   - `sender` est **déjà en E.164** avec le préfixe `+` (ex: `+33775745453`).
 *     Le parser VALIDE via `E164_REGEX` mais ne RE-NORMALISE PAS —
 *     évite toute réinterprétation via `libphonenumber-js` d'un numéro
 *     déjà canonique côté OVH.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * DIVERGENCE ATTENDUE ENTRE CE TYPE ET LE SCHEMA ZOD DU PARSER
 *
 * Ce type reflète le format RÉEL COMPLET tel qu'OVH le renvoie sur GET.
 * Le schema Zod du parser (`OvhInboundRawSchema` dans `parse-incoming.ts`)
 * ne rend REQUIRED que les 3 champs qui alimentent l'event downstream
 * (`id`, `sender`, `message`) et rend OPTIONNELS les 3 champs de confort
 * (`creationDatetime`, `credits`, `tag`) — tolérance aux payloads
 * minimalistes qu'OVH pourrait émettre via son callback POST (format non
 * confirmé, cf. JSDoc route `/api/webhooks/ovh-sms/route.ts`).
 */
export interface OvhInboundSms {
  /** ID OVH unique du SMS entrant. NUMBER dans la réponse OVH. */
  id: number;
  /** Numéro de l'expéditeur du SMS entrant, déjà en E.164 (ex: `+33775745453`). */
  sender: string;
  /** Corps brut du SMS entrant, jusqu'à 1600 chars = 10 segments GSM-7. */
  message: string;
  /** ISO 8601 avec offset timezone (ex: `2026-07-15T12:24:10+02:00`). */
  creationDatetime: string;
  /** Crédits SMS consommés côté OVH (typiquement 0 pour un entrant). */
  credits: number;
  /** Tag OVH (souvent vide). */
  tag: string;
}
