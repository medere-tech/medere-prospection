/**
 * Format Block Kit — notification Slack dédiée au rattachement manuel
 * d'un SMS orphelin à une conversation (PR2c tour 2b bloc C sexies).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi un format dédié ?
 *
 *   Avant ce bloc, la notif de rattachement réutilisait
 *   `buildInboundAfterHandoffBlocks` (titre « Nouveau message d'un lead
 *   que vous suivez ») — ce qui laissait penser au commercial que le
 *   médecin venait d'envoyer un SMS à l'instant. Faux : il peut s'agir
 *   d'un SMS reçu il y a plusieurs jours, qu'un admin vient d'identifier
 *   et de rattacher manuellement. Ce format dédié dit explicitement :
 *     - QUI (admin résolu via Clerk `firstName lastName`),
 *     - QUAND à l'origine (date de réception OVH, pas date d'attach),
 *     - QUOI (le texte du SMS, scrubbé mrkdwn),
 *     - CAS SPÉCIAL opt-out : la mention « Désabonnement appliqué ».
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Lien → conversation, pas orphelins
 *
 *   `dashboardUrl` doit être construit avec `getDashboardConversationUrl`
 *   (vers `/admin/conversations/<id>`). Avant le fix, l'orchestrateur
 *   pointait vers `/admin/orphan-inbounds?id=<orphanId>` — en contradiction
 *   avec le libellé « Voir la conversation ». Les callers posent le lien
 *   via la seule fonction d'URL, pas de concaténation inline.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pas de footer `conv \`<id>\``
 *
 *   Les notifs destinées aux commerciaux (DM ou canal de test) ne portent
 *   plus l'id technique de la conversation en pied — le lien suffit.
 *   Sentinelle `format-orphan-attached.test.ts` : la payload sérialisée
 *   ne contient AUCUN pattern `<contactId>_hubspot-list-<n>` matchable.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Échappement mrkdwn
 *
 *   TOUT champ interpolé dans un `type: "mrkdwn"` passe par
 *   `escapeSlackMrkdwn`. Les sources externes couvertes :
 *   `firstName`, `speciality`, `city`, `lastInboundBody`, `adminName`.
 *   Les timestamps rendus sont formatés par `formatDateTimeParis`
 *   (chaîne contrôlée côté serveur) et ne contiennent par construction
 *   ni `<` ni `|`, mais on les échappe quand même par défense en profondeur.
 */
import { formatDateTimeParis } from "@/lib/utils/format-paris";

import { escapeSlackMrkdwn } from "./escape-mrkdwn";

/**
 * Cap sur le corps du SMS inclus dans le block. Aligne sur
 * `format-handoff.ts::LAST_INBOUND_MAX_CHARS` et
 * `format-inbound-after-handoff.ts::LAST_INBOUND_MAX_CHARS` (300).
 */
export const LAST_INBOUND_MAX_CHARS = 300;

export interface OrphanAttachedInput {
  /** Prénom (ou chaîne vide → section médecin omise). */
  readonly firstName: string;
  /** Spécialité médicale (ou chaîne vide). */
  readonly speciality: string;
  /** Ville (ou chaîne vide). */
  readonly city: string;
  /** Corps du SMS orphelin tel que posté dans la conv. */
  readonly lastInboundBody: string;
  /**
   * Nom résolu de l'admin qui a rattaché (`<firstName> <lastName>` depuis
   * Clerk). `null` → libellé générique « un administrateur » (fail-safe
   * si la résolution Clerk échoue).
   */
  readonly adminName: string | null;
  /**
   * Date de réception D'ORIGINE de l'orphan (`orphan.receivedAt`), PAS
   * la date d'attach. ISO 8601 — le builder la rend via
   * `formatDateTimeParis`.
   */
  readonly originalReceivedAtIso: string;
  /** `true` → mention « Désabonnement appliqué » visible. */
  readonly isOptOut: boolean;
  /**
   * URL dashboard vers la **conversation** (pas vers la vue orphelins).
   * Construite via `getDashboardConversationUrl`.
   */
  readonly dashboardUrl: string;
}

export type OrphanAttachedBlock = Record<string, unknown>;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

function toBlockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/**
 * Construit les blocks Block Kit de la notif rattachement. Structure :
 *
 *   [0] header       — titre dédié (« SMS orphelin rattaché manuellement »)
 *   [1] section      — `*Firstname* -- Speciality` + `City`
 *   [2] section      — blockquote du corps SMS (scrubbé + tronqué)
 *   [3] section      — ligne « Rattaché par <adminName> · reçu le <date> »
 *   [4] section      — (isOptOut only) « *Désabonnement appliqué* »
 *   [5] section      — lien « Voir la conversation » → `dashboardUrl`
 *
 *   Pas de footer `conv \`<id>\`` (voir doc en tête de fichier).
 */
export function buildOrphanAttachedBlocks(input: OrphanAttachedInput): OrphanAttachedBlock[] {
  const header = input.isOptOut
    ? "SMS orphelin rattaché manuellement — demande d'arrêt (STOP)"
    : "SMS orphelin rattaché manuellement à une conversation";

  const safeFirstName = escapeSlackMrkdwn(input.firstName);
  const safeSpeciality = escapeSlackMrkdwn(input.speciality);
  const safeCity = escapeSlackMrkdwn(input.city);
  const safeBody = escapeSlackMrkdwn(input.lastInboundBody);
  const truncatedBody = truncate(safeBody, LAST_INBOUND_MAX_CHARS);
  const blockquotedBody = toBlockquote(truncatedBody);

  // Admin name : null → libellé générique. Jamais le Clerk userId brut.
  const safeAdminName = escapeSlackMrkdwn(
    input.adminName !== null && input.adminName.length > 0 ? input.adminName : "un administrateur",
  );

  // Date de réception d'origine, rendue en Paris. `formatDateTimeParis`
  // retourne une chaîne contrôlée (jamais de `<` ni `|`), mais on
  // échappe en défense en profondeur.
  const receivedAtDisplay = (() => {
    try {
      return escapeSlackMrkdwn(formatDateTimeParis(new Date(input.originalReceivedAtIso)));
    } catch {
      // ISO invalide (ne devrait jamais arriver — invariant côté serveur).
      // Fallback neutre pour ne pas casser l'envoi de la notif.
      return "date inconnue";
    }
  })();

  const blocks: OrphanAttachedBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: header, emoji: false },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${safeFirstName}* -- ${safeSpeciality}\n${safeCity}`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: blockquotedBody },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Rattaché par *${safeAdminName}* · reçu le ${receivedAtDisplay}`,
      },
    },
  ];

  if (input.isOptOut) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Désabonnement appliqué.* Le consentement a été retiré (STOP).",
      },
    });
  }

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `<${input.dashboardUrl}|Voir la conversation>`,
    },
  });

  return blocks;
}
