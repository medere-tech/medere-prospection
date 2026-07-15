/**
 * Parser du payload BRUT du CALLBACK PUSH OVH inbound → contrat event
 * Inngest `medere/sms.reply.received` (S9.6-FIX2, INFRA-SMS-001).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * PUR — pas d'I/O. Testable isolément. Throw `ValidationError` sur toute
 * anomalie de shape ou de format. Le caller (route webhook
 * `/api/webhooks/ovh-sms/route.ts`) mappe le throw en HTTP 400.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * FORMAT SOURCE — CALLBACK PUSH OVH (capturé en prod S9.6-FIX diag)
 *
 *   Content-Type : application/x-www-form-urlencoded
 *   Champs       :
 *     id         : number  — ID OVH unique du SMS entrant
 *     senderid   : string  — numéro expéditeur (le PS qui répond)
 *     message    : string  — corps brut du SMS
 *     keyword    : string  — optionnel, mot-clef configuré côté OVH
 *     shortcode  : string  — optionnel, numéro Time2Chat de destination
 *     tag        : string  — optionnel, tag OVH (souvent vide)
 *     token      : string  — optionnel, shared secret dupliqué du query
 *
 * ⚠️ IMPORTANT — Ce format DIFFÈRE du GET `/sms/{svc}/incoming/{id}` (qui
 * renvoie `sender` et non `senderid`, sans `keyword`/`shortcode`/`token`).
 * Ce parser est utilisé UNIQUEMENT par le callback push (route webhook,
 * seul consommateur — vérifié via grep repo-wide). Si un futur poller
 * consomme le GET incoming, écrire un parser SÉPARÉ, ne PAS ajouter de
 * compat ici (single responsibility, éviter la conflation des 2 formats).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * MAPPING vers `SmsReplyReceivedData` (schema Inngest `events.ts:188-195`)
 *
 *   phone         ← toE164(senderid, "FR")  (normalise 0033XXX / 33XXX /
 *                                             +33XXX / 06XX → +33XXX, ou
 *                                             null si numéro invalide)
 *   body          ← message                  (1-1600 chars — aligné S8.3)
 *   ovhMessageId  ← String(id)               (id est NUMBER → cast strict)
 *
 * `token` du body est **ignoré** — c'est un doublon du query param, dont la
 * vérification est le rôle exclusif de la route (`verifyOvhWebhookToken`
 * step 2). On ne s'appuie pas sur sa présence côté parser (contrat auth =
 * query param uniquement).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * NORMALISATION E.164 vs VALIDATION STRICTE
 *
 * OVH livre parfois le numéro en format non-E.164 (`0033XXX`, `33XXX`,
 * `06XX`) selon la source du SMS. On utilise `toE164('FR')` qui :
 *   1. Parse via `libphonenumber-js`.
 *   2. Retourne l'E.164 canonique SI le numéro est valide pour son pays.
 *   3. Retourne `null` si invalide (aucun préfixe reconnu, longueur hors
 *      bornes, etc.).
 *
 * Le parser fait donc la normalisation ET la validation en une passe. Cela
 * diverge intentionnellement de la doc pré-S9.6 (qui validait `sender`
 * directement contre `E164_REGEX` sans normalisation) : le format callback
 * n'est PAS garanti E.164 par OVH, cf. capture prod.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * DEUX COUCHES DE VALIDATION EN DÉFENSE
 *
 *   1. Ici (fail-fast avec message clair côté route → 400 dédié).
 *   2. `smsReplyReceived.create()` côté route re-valide via Zod avant
 *      émission (Inngest Standard Schema hook). Une régression du parser
 *      qui laisserait passer un payload mal formé serait attrapée là ;
 *      elle ferait remonter un throw brut → 500 générique.
 */
import { z } from "zod";

import type { SmsReplyReceivedData } from "@/lib/inngest/events";
import { ValidationError } from "@/lib/utils/errors";
import { toE164 } from "@/lib/utils/phone";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Borne haute du `message` — alignée avec :
 *   - `src/lib/inngest/events.ts::BODY_MAX_LENGTH`  = 1600
 *   - `src/lib/firestore/messages.ts::BODY_MAX_LENGTH` = 1600
 *   - `src/lib/ovh/send-sms.ts::BODY_MAX_LENGTH`    = 1600
 *
 * 1600 = 10 segments SMS GSM-7. Discipline visuelle (pas de constante
 * partagée entre modules — cf. `events.ts:78-88`).
 */
const MESSAGE_MAX_LENGTH = 1600;

// ─────────────────────────────────────────────────────────────────────────────
// Schema Zod
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schema Zod du payload BRUT du CALLBACK PUSH OVH.
 *
 * Choix :
 *   - `id`, `senderid`, `message` : REQUIRED (les 3 seuls champs qui
 *     alimentent l'event `medere/sms.reply.received`).
 *   - `keyword`, `shortcode`, `tag`, `token` : OPTIONAL — présents dans la
 *     capture prod mais non requis en aval. On les tolère explicitement
 *     pour rester compatible si OVH les omet ponctuellement (ex: shortcode
 *     absent si le SMS entrant vient d'un canal non-Time2Chat).
 *   - `id` strict NUMBER : reflète le format capturé. La route convertit
 *     déjà `id` string→number côté form-urlencoded (`route.ts:143-144`).
 *   - Champs surnuméraires : Zod strip par défaut (pas `.strict()`) →
 *     tolérance à un futur ajout OVH sans casser la validation.
 */
const OvhCallbackPushSchema = z.object({
  id: z.number().int(),
  senderid: z.string().min(1),
  message: z.string().min(1).max(MESSAGE_MAX_LENGTH),
  keyword: z.string().optional(),
  shortcode: z.string().optional(),
  tag: z.string().optional(),
  token: z.string().optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Fonction publique
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse et valide un payload BRUT du callback push OVH, retourne un objet
 * strict `SmsReplyReceivedData` (= 3 champs Inngest event
 * `medere/sms.reply.received`).
 *
 * @throws {ValidationError} Si la shape OVH est invalide (champ manquant,
 *   type incorrect, longueur `message` hors bornes) OU si `senderid` n'est
 *   pas un numéro FR reconnaissable par `libphonenumber-js` (soit déjà
 *   E.164 valide, soit convertible via defaultCountry='FR').
 *
 * Le caller (route webhook) mappe systématiquement le throw en HTTP 400
 * générique (`{error: {code: "VALIDATION", message: "Données invalides."}}`)
 * sans fuiter le détail technique côté client — le `context` reste pour
 * le log serveur uniquement.
 */
export function parseIncomingOvhSms(raw: unknown): SmsReplyReceivedData {
  const parsed = OvhCallbackPushSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError({
      message: "parseIncomingOvhSms: payload OVH shape invalid",
      context: {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          code: i.code,
        })),
      },
    });
  }

  const { id, senderid, message } = parsed.data;

  // Normalisation E.164 via libphonenumber-js (defaultCountry='FR' pour
  // supporter les formats nationaux `06XX`). `toE164` retourne `null` si
  // le numéro n'est pas valide pour son pays — on 400 dans ce cas.
  const phone = toE164(senderid, "FR");
  if (phone === null) {
    throw new ValidationError({
      message: "parseIncomingOvhSms: senderid could not be normalized to E.164",
      // Anti-PII : jamais le numéro complet dans le log. Seul length.
      context: { senderidLength: senderid.length },
    });
  }

  return {
    phone,
    body: message,
    ovhMessageId: String(id),
  };
}
