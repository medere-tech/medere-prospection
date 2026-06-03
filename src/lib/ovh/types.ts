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
