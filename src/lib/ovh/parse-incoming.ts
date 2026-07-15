/**
 * Parser du payload BRUT OVH inbound → contrat event Inngest
 * `medere/sms.reply.received` (S9.6, INFRA-SMS-001).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * PUR — pas d'I/O. Testable isolément. Throw `ValidationError` sur toute
 * anomalie de shape ou de format. Le caller (route webhook
 * `/api/webhooks/ovh-sms/route.ts`) mappe le throw en HTTP 400.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * FORMAT SOURCE (capturé en réel S9.6-EXPLORE sur `sms-ng66707-1`)
 *
 *   {
 *     credits: 0,
 *     creationDatetime: "2026-07-15T12:24:10+02:00",
 *     id: 118791103,               // NUMBER
 *     sender: "+33775745453",      // DÉJÀ E.164
 *     message: "Test réception Medere 1",
 *     tag: ""
 *   }
 *
 * Cf. `src/lib/ovh/types.ts::OvhInboundSms` — type structurel documenté.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * MAPPING vers `SmsReplyReceivedData` (schema Inngest `events.ts:188-195`)
 *
 *   phone         ← sender      (VALIDÉ E164_REGEX, NON re-normalisé)
 *   body          ← message     (1-1600 chars — aligné cross-module S8.3)
 *   ovhMessageId  ← String(id)  (id est NUMBER → cast obligatoire pour
 *                                matcher `z.string().min(1)` côté event)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * DEUX COUCHES DE VALIDATION EN DÉFENSE
 *
 *   1. Ici (fail-fast avec message clair côté route → 400 dédié).
 *   2. `smsReplyReceived.create()` côté route re-valide via Zod avant
 *      émission (Inngest Standard Schema hook). Une régression du parser
 *      qui laisserait passer un payload mal formé serait attrapée là ;
 *      elle ferait remonter un throw brut → 500 générique.
 *
 * On tient à garder les 2 : ici pour l'ergonomie (400 explicite avec
 * `context.issues`), là pour la garantie forte de type au moment de la
 * livraison à Inngest.
 */
import { z } from "zod";

import type { SmsReplyReceivedData } from "@/lib/inngest/events";
import { ValidationError } from "@/lib/utils/errors";
import { E164_REGEX } from "@/lib/utils/phone";

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
 * Schema Zod du payload BRUT OVH inbound.
 *
 * Choix :
 *   - `id`, `sender`, `message` : REQUIRED (les 3 seuls champs qui
 *     alimentent l'event `medere/sms.reply.received`).
 *   - `credits`, `creationDatetime`, `tag` : OPTIONAL — présents dans la
 *     capture réelle sur GET incoming/id mais non garantis dans le POST
 *     callback (format non confirmé). On tolère leur absence pour rester
 *     compatible avec un payload de callback minimaliste.
 *   - `id` strict NUMBER : reflète le format capturé. Si OVH livrait en
 *     string via un futur callback, `route.ts` convertit avant d'appeler
 *     le parser (single-source-of-truth format côté route).
 *   - Champs surnuméraires : Zod strip par défaut (pas `.strict()`) →
 *     tolérance à un futur ajout OVH sans casser la validation.
 *
 * ⚠️ La validation E164 STRICTE de `sender` se fait EN AVAL (après le
 * safeParse) et non via `.regex(E164_REGEX)` dans le schema. Motif :
 * message d'erreur `context` plus clair pour distinguer "shape invalide"
 * (400 générique) de "sender non E.164" (400 avec cause explicite).
 */
const OvhInboundRawSchema = z.object({
  id: z.number().int(),
  sender: z.string().min(1),
  message: z.string().min(1).max(MESSAGE_MAX_LENGTH),
  credits: z.number().optional(),
  creationDatetime: z.string().optional(),
  tag: z.string().optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Fonction publique
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse et valide un payload BRUT OVH inbound, retourne un objet strict
 * `SmsReplyReceivedData` (= 3 champs Inngest event `medere/sms.reply.received`).
 *
 * @throws {ValidationError} Si la shape OVH est invalide (champ manquant,
 *   type incorrect, longueur `message` hors bornes) OU si `sender` n'est
 *   pas au format E.164 strict (regex `^\+[1-9]\d{6,14}$`).
 *
 * Le caller (route webhook) mappe systématiquement le throw en HTTP 400
 * générique (`{error: {code: "VALIDATION", message: "Données invalides."}}`)
 * sans fuiter le détail technique côté client — le `context.issues` reste
 * pour le log serveur.
 */
export function parseIncomingOvhSms(raw: unknown): SmsReplyReceivedData {
  const parsed = OvhInboundRawSchema.safeParse(raw);
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

  const { id, sender, message } = parsed.data;

  if (!E164_REGEX.test(sender)) {
    throw new ValidationError({
      message: "parseIncomingOvhSms: sender is not a strict E.164",
      context: { senderLength: sender.length },
    });
  }

  return {
    phone: sender,
    body: message,
    ovhMessageId: String(id),
  };
}
