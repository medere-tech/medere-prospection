/**
 * Format Block Kit des notifications Slack "SMS entrant sur conversation
 * inactive / contact inconnu / parse ou enqueue en echec" (PR-NO-DROPPED-SMS).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Fonction PURE — aucun acces reseau, aucun SDK, aucun env. Testable
 * directement en asservissant la sortie exacte.
 *
 * Reutilise strictement les patterns de `format-inbound-after-handoff.ts`
 * (PR-A, deja en prod) :
 *   - echappement mrkdwn via `escapeSlackMrkdwn` sur TOUT champ externe ;
 *   - troncature `lastInboundBody` a `LAST_INBOUND_MAX_CHARS = 300` ;
 *   - blockquote ligne par ligne ;
 *   - zero emoji.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * EN-TETES CONDITIONNELS (selon `reason`)
 *
 * Decisions scellees par Dethie :
 *   - `opted_out`                   : "Contact desabonne : aucune sollicitation
 *                                      SMS sans nouveau consentement explicite."
 *   - `blocked`                     : "Contact bloque : ne pas recontacter par SMS."
 *   - `closed`                      : "Conversation cloturee : le contact a reecrit."
 *   - `conversation_became_terminal` (race P6) :
 *                                     "Desabonnement recu pendant un changement
 *                                      de statut : verifier la fiche."
 *   - `handed_off_no_assignee`      : "Lead sans commercial attribue : SMS recu,
 *                                      a traiter manuellement."
 *   - `no_conversation`             : "Contact sans conversation ouverte : SMS
 *                                      recu, a rattacher manuellement."
 *   - `unknown_contact`             : "Numero inconnu : SMS recu depuis un
 *                                      contact non reference."
 *   - `parse_failed`                : "Webhook SMS illisible : payload recu
 *                                      avec un token valide mais non parsable."
 *   - `enqueue_failed`              : "Mise en file Inngest en echec : SMS recu
 *                                      mais pipeline non lance."
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * DECISION PII — MINIMUM VITAL
 *
 * La signature `OrphanNotifInput` interdit au COMPILE-TIME les champs
 * `lastName`, `phone`, `email`, `hubspotId`, `ovhMessageId`. Ce qui EST
 * expose :
 *   - `firstName` (optionnel), `speciality` (optionnel), `city` (optionnel)
 *     — presents quand on a un contact resolu, absents sinon.
 *   - `lastInboundBody` (tronque 300 chars) — le texte du SMS.
 *   - `phoneLast4` (optionnel) — forensic humain pour les cas sans contact
 *     (unknown_contact / parse_failed). 4 derniers chiffres, pas PII au sens
 *     RGPD (impossible de retrouver un PS a partir de 4 chiffres isoles).
 *   - `conversationId` (optionnel) — footer discret quand une conv existe.
 *   - `orphanDocId` (optionnel) — trace stockage inbound_messages_orphans/
 *     pour correlation admin.
 *   - `dashboardUrl` — lien vers le dashboard conv ou canal admin.
 *   - `wasOptOut` — boolean discriminant la mention "desabonnement detecte".
 *
 * Sentinelles anti-PII dans les tests : cast `as any` pour verifier qu'une
 * valeur lastName/phone/email/hubspotId/ovhMessageId N'APPARAIT PAS dans les
 * blocks generes.
 */

import type { InboundOnInactiveConversationReason } from "@/types/audit-log";

import { escapeSlackMrkdwn } from "./escape-mrkdwn";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes — bornes I/O
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cap sur le corps du dernier message inbound inclus dans le block. Aligne
 * sur `format-inbound-after-handoff.ts::LAST_INBOUND_MAX_CHARS` (300).
 *
 * 🔒 SENTINEL — verrouille par test `respecte le cap de 300 chars`.
 */
export const LAST_INBOUND_MAX_CHARS = 300;

// ─────────────────────────────────────────────────────────────────────────────
// Headers par reason — table source de verite
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Table des en-tetes par `reason`. Exposee pour les tests sentinelles
 * (verrou de l'ensemble des valeurs).
 */
export const HEADERS_BY_REASON: Readonly<Record<InboundOnInactiveConversationReason, string>> = {
  opted_out: "Contact désabonné : aucune sollicitation SMS sans nouveau consentement explicite.",
  blocked: "Contact bloqué : ne pas recontacter par SMS.",
  closed: "Conversation clôturée : le contact a réécrit.",
  conversation_became_terminal:
    "Désabonnement reçu pendant un changement de statut : vérifier la fiche.",
  handed_off_no_assignee: "Lead sans commercial attribué : SMS reçu, à traiter manuellement.",
  no_conversation: "Contact sans conversation ouverte : SMS reçu, à rattacher manuellement.",
  unknown_contact: "Numéro inconnu : SMS reçu depuis un contact non référencé.",
  parse_failed: "Webhook SMS illisible : payload reçu avec un token valide mais non parsable.",
  enqueue_failed: "Mise en file Inngest en échec : SMS reçu mais pipeline non lancé.",
};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input strictement type pour un orphan notif Slack. La liste EXHAUSTIVE
 * des champs autorises empeche au compile-time l'ajout de PII (`lastName`,
 * `phone`, `email`, `hubspotId`, `ovhMessageId`).
 *
 * Tous les champs optionnels : present quand resolu, absent sinon. Le
 * formatter adapte sa sortie en consequence sans jamais crasher.
 */
export interface OrphanNotifInput {
  reason: InboundOnInactiveConversationReason;
  wasOptOut: boolean;
  lastInboundBody: string;
  dashboardUrl: string;
  /**
   * `true` si cette notif va sur le canal orphelins ET qu'on veut pinger
   * `<!here>`. Jamais utilise pour un DM. Les callers passent `false` par
   * defaut, `true` uniquement sur les reasons critiques (handed_off_no_assignee,
   * parse_failed, enqueue_failed).
   */
  includeHereMention?: boolean;
  firstName?: string;
  speciality?: string;
  city?: string;
  /** 4 derniers chiffres du numero (forensic humain, pas PII). */
  phoneLast4?: string;
  conversationId?: string;
  orphanDocId?: string;
  /**
   * LOW-1 PR-NO-DROPPED-SMS : callback invoque si un ID footer
   * (`conversationId` / `orphanDocId`) ne matche pas
   * `/^[A-Za-z0-9_-]+$/`. Le formatter OMIT alors cet ID du footer
   * (safe-by-default) mais signale la deviation pour Sentry/log.
   * Volontairement injecte en callback (fonction pure, pas d'IO direct).
   */
  onInvalidFooterId?: (invalidFields: readonly string[]) => void;
}

/** Structure Block Kit generique. Pattern identique a `format-handoff.ts`. */
export type OrphanNotifBlock = Record<string, unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers internes
// ─────────────────────────────────────────────────────────────────────────────

/** Tronque `text` a `max` chars et ajoute `...` si effectivement tronque. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

/**
 * Formate un texte en blockquote Slack : prefixe chaque ligne par `> `.
 * Slack mrkdwn traite `> ` en debut de ligne comme un blockquote.
 */
function toBlockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Builder Block Kit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Construit les blocks Block Kit d'une notification Slack orphan (DM
 * titulaire OU canal orphelins — c'est le caller qui route, le formatter
 * est agnostique).
 *
 * Structure (ordre fige, sentinelle test) :
 *   [0] header       — en-tete depuis `HEADERS_BY_REASON[reason]`
 *   [1] section      — identite si firstName+speciality+city dispo,
 *                      sinon ligne `Numero: ...4` ou `Payload non parsable`
 *   [2] section      — blockquote du dernier message (si body non vide)
 *   [3] section      — (opt-out detecte) "*Desabonnement detecte dans le
 *                      texte.* Appliquer STOP si besoin."
 *   [4] section      — (includeHereMention) `<!here>` ligne dediee
 *   [5] section      — lien `Voir la conversation` (dashboardUrl)
 *   [6] context      — footer `conv \`<id>\` / orphan \`<docId>\``
 *                      (champs presents uniquement si fournis)
 */
export function buildInboundOnInactiveConversationBlocks(
  input: OrphanNotifInput,
): OrphanNotifBlock[] {
  const header = HEADERS_BY_REASON[input.reason];

  // 🚨 ECHAPPEMENT MRKDWN — tous les champs externes passent par
  // escapeSlackMrkdwn AVANT interpolation. Pattern miroir strict
  // format-inbound-after-handoff.ts (fix HIGH security-reviewer PR-A).
  const safeBody = escapeSlackMrkdwn(input.lastInboundBody);
  const truncatedBody = truncate(safeBody, LAST_INBOUND_MAX_CHARS);
  const blockquotedBody = toBlockquote(truncatedBody);

  const blocks: OrphanNotifBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: header, emoji: false },
    },
  ];

  // Section identite — selon ce qu'on a resolu.
  const hasContact =
    input.firstName !== undefined && input.speciality !== undefined && input.city !== undefined;
  if (hasContact) {
    const safeFirstName = escapeSlackMrkdwn(input.firstName!);
    const safeSpeciality = escapeSlackMrkdwn(input.speciality!);
    const safeCity = escapeSlackMrkdwn(input.city!);
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${safeFirstName}* -- ${safeSpeciality}\n${safeCity}`,
      },
    });
  } else if (input.phoneLast4 !== undefined) {
    // Format escape-safe : phoneLast4 ne doit contenir que des chiffres,
    // on echappe par defense-en-profondeur.
    const safeLast4 = escapeSlackMrkdwn(input.phoneLast4);
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Numéro inconnu (derniers chiffres : *${safeLast4}*)`,
      },
    });
  } else {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Contact non identifié (payload illisible ou numéro masqué).",
      },
    });
  }

  // Section body — seulement si body non vide.
  if (truncatedBody.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: blockquotedBody },
    });
  }

  // Mention opt-out detecte dans le texte (independant de la reason).
  if (input.wasOptOut) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Désabonnement détecté dans le texte.* Appliquer STOP si besoin.",
      },
    });
  }

  // Mention <!here> pour canal orphelins sur reasons critiques.
  if (input.includeHereMention === true) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "<!here>" },
    });
  }

  // Lien dashboard.
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `<${input.dashboardUrl}|Voir la conversation>`,
    },
  });

  // Footer discret conv + orphan docId quand presents.
  //
  // LOW-1 PR-NO-DROPPED-SMS : les IDs sont wrappes dans un `` `code` `` Slack
  // mrkdwn. Un backtick dans l'ID casserait le code-wrap visuellement (pas
  // une faille de securite — escape neutralise deja <>&, mais le `|` et le
  // `` ` `` ne sont pas des caracteres mrkdwn speciaux echappes). On
  // valide donc chaque ID contre un alphabet strictement sur (lettres,
  // chiffres, `_`, `-`). Si l'ID n'est pas conforme, on l'omet du footer
  // (le forensic reste disponible via l'audit `inbound_on_inactive_conversation`
  // ou le doc orphan) et un Sentry warning signale la deviation d'invariant.
  const FOOTER_ID_REGEX = /^[A-Za-z0-9_-]+$/;
  const invalidIds: string[] = [];
  const footerParts: string[] = [];
  if (input.conversationId !== undefined) {
    if (FOOTER_ID_REGEX.test(input.conversationId)) {
      footerParts.push(`conv \`${input.conversationId}\``);
    } else {
      invalidIds.push("conversationId");
    }
  }
  if (input.orphanDocId !== undefined) {
    if (FOOTER_ID_REGEX.test(input.orphanDocId)) {
      footerParts.push(`orphan \`${input.orphanDocId}\``);
    } else {
      invalidIds.push("orphanDocId");
    }
  }
  if (footerParts.length > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: footerParts.join(" / ") }],
    });
  }
  // Signal d'anomalie : un ID footer non conforme a l'invariant. Pas
  // d'emoji, canal via callback injecte si fourni (sinon no-op cote
  // tests purs). On ne log pas la valeur brute (pourrait leak PII si
  // futur ID derape).
  if (invalidIds.length > 0 && typeof input.onInvalidFooterId === "function") {
    input.onInvalidFooterId(invalidIds);
  }

  return blocks;
}
