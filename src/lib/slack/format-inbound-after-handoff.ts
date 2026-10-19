/**
 * Format Block Kit des DM Slack "SMS entrant sur conv handed_off"
 * (PR-A-INBOUND-HANDED-OFF).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Fonction PURE — aucun accès réseau, aucun appel SDK, aucun accès env.
 * Testable directement en asservissant la sortie exacte.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * DÉCISION PII — MINIMUM VITAL (strictement aligné `HandoffInput` PR3)
 *
 * La signature `InboundAfterHandoffInput` interdit au COMPILE-TIME de passer :
 *   - `lastName`             (nom complet — reste derrière le lien dashboard)
 *   - `phone`, `email`       (coordonnées — accessibles via le dashboard)
 *   - `hubspotId`            (identifiant technique — pas utile au commercial)
 *   - `ovhMessageId`         (identifiant externe semi-sensible)
 *
 * Ce qui EST exposé dans les blocks :
 *   - `firstName`            (prénom seul, courtoisie humaine)
 *   - `speciality`           (contexte métier — pas une donnée personnelle sensible)
 *   - `city`                 (contexte géographique — pas de rue/CP)
 *   - `lastInboundBody`      (dernier message du PS, tronqué à 300 chars)
 *   - `dashboardUrl`         (le nom complet + coordonnées vivent derrière ce lien,
 *                             protégé par Clerk auth côté dashboard)
 *   - `conversationId`       (opaque, non-PII — footer discret pour correlation
 *                             support/debug uniquement)
 *   - `isOptOut`             (boolean discriminant — variante STOP de la notif)
 *
 * ⚠️ Test sentinelle `format-inbound-after-handoff.test.ts` : passe un
 * `lastName` / `phone` / `email` / `hubspotId` / `ovhMessageId` via cast
 * `as any` et vérifie que ces valeurs N'APPARAISSENT PAS dans les blocks
 * générés. Si quelqu'un ajoute un jour un champ PII à la sortie, le test
 * casse.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * DÉCISIONS DE FORMAT
 *
 *   - DM uniquement (cibles toujours `handoff.assignedTo`) → pas de
 *     `<!here>` ni `<!channel>`.
 *   - Variante `isOptOut=true` : header distinct ("Demande d'arret (STOP)")
 *     + ligne d'action explicite "Ne plus recontacter.". Le commercial
 *     doit comprendre en 2 secondes qu'il ne doit PAS repondre.
 *   - Zero emoji — contrainte brief PR-A appliquee a tout code nouveau
 *     (le builder `format-handoff.ts` existant garde ses emojis legacy,
 *     pas touche).
 *   - mrkdwn Slack : `*gras*`, `>` blockquote (ligne par ligne).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 SECURITE — ECHAPPEMENT MRKDWN (fix HIGH security-reviewer PR-A)
 *
 * TOUT champ interpole dans un block `type: "mrkdwn"` et provenant d'une
 * source externe (SMS entrant, HubSpot/Lusha) DOIT passer par
 * `escapeSlackMrkdwn`. Sinon un PS malveillant peut poster `<url|texte>`
 * / `<@U...>` / `<!here>` dans un SMS et faire apparaitre un lien
 * phishing cliquable OU une mention active dans le DM du commercial,
 * poste par le bot Medere (= fort trust visuel).
 *
 * Champs couverts ici : `firstName`, `speciality`, `city`, `lastInboundBody`.
 * `conversationId` est opaque par construction (`${contactId}_${campaignId}`
 * ne contient ni `<` ni `>` ni `|` par convention) ; `dashboardUrl` est
 * construit via `encodeURIComponent` dans `dashboard-url.ts`. Ces deux
 * champs restent inchanges mais une regression de leur formation serait
 * couverte par les sentinelles anti-phishing dans les tests.
 */

import { escapeSlackMrkdwn } from "./escape-mrkdwn";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes — bornes I/O
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cap sur le corps du dernier message inbound inclus dans le block.
 * Aligne sur `format-handoff.ts::LAST_INBOUND_MAX_CHARS` (300) pour cohérence
 * UX : les deux notifs Slack affichent le body du PS avec la même borne.
 *
 * 🔒 SENTINEL — verrouillé par test `respecte le cap de 300 chars`.
 */
export const LAST_INBOUND_MAX_CHARS = 300;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input strictement typé. La liste EXHAUSTIVE des champs autorisés empêche
 * au compile-time l'ajout accidentel de PII (`lastName`, `phone`, `email`,
 * `hubspotId`, `ovhMessageId`) — cf. sentinelle runtime dans les tests.
 */
export interface InboundAfterHandoffInput {
  firstName: string;
  speciality: string;
  city: string;
  lastInboundBody: string;
  conversationId: string;
  /**
   * `true` si le body a déclenché un opt-out (court-forme OU classifier
   * long-forme). Dans ce cas, header distinct + ligne "Ne plus recontacter."
   */
  isOptOut: boolean;
  dashboardUrl: string;
}

/**
 * Structure Block Kit générique. Pattern identique à `format-handoff.ts`.
 */
export type InboundAfterHandoffBlock = Record<string, unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Tronque `text` à `max` chars et ajoute `...` si effectivement tronqué. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

/**
 * Formate un texte en blockquote Slack : préfixe chaque ligne par `> `.
 * Slack mrkdwn traite `> ` en début de ligne comme un blockquote. Sans
 * cette transformation, une ligne 2/3/... du texte ne serait pas en
 * blockquote.
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
 * Construit les blocks Block Kit d'un DM Slack de relais inbound.
 *
 * Deux variantes selon `input.isOptOut` :
 *
 *   - `isOptOut=false` : "Nouveau message d'un lead que vous suivez"
 *   - `isOptOut=true`  : "Demande d'arret (STOP) sur un lead que vous
 *                        suivez" + ligne d'action "Ne plus recontacter."
 *
 * Structure :
 *   [0] header       — titre
 *   [1] section      — `*Firstname* -- Speciality` + `City`
 *   [2] section      — blockquote du dernier message PS (tronqué)
 *   [3] section      — (opt-out only) "Ne plus recontacter."
 *   [4] section      — lien "Voir la conversation" (dashboardUrl)
 *   [5] context      — footer discret `conv \`<id>\`` pour correlation debug
 */
export function buildInboundAfterHandoffBlocks(
  input: InboundAfterHandoffInput,
): InboundAfterHandoffBlock[] {
  const header = input.isOptOut
    ? "Demande d'arrêt (STOP) sur un lead que vous suivez"
    : "Nouveau message d'un lead que vous suivez";

  // 🚨 ECHAPPEMENT MRKDWN — tous les champs externes passent par
  // escapeSlackMrkdwn AVANT interpolation (fix HIGH security-reviewer).
  // Troncature APRES echappement est volontairement rejetee : un
  // echappement sur un corps DEJA tronque peut laisser un `<` orphelin
  // (si la troncature coupe au milieu d'une entite). On echappe puis on
  // tronque, borne appliquee a la chaine FINALE affichee par Slack.
  const safeFirstName = escapeSlackMrkdwn(input.firstName);
  const safeSpeciality = escapeSlackMrkdwn(input.speciality);
  const safeCity = escapeSlackMrkdwn(input.city);
  const safeBody = escapeSlackMrkdwn(input.lastInboundBody);
  const truncatedBody = truncate(safeBody, LAST_INBOUND_MAX_CHARS);
  const blockquotedBody = toBlockquote(truncatedBody);

  const blocks: InboundAfterHandoffBlock[] = [
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
  ];

  if (input.isOptOut) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Ne plus recontacter.* Le consentement a été retiré (STOP).",
      },
    });
  }

  blocks.push(
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `<${input.dashboardUrl}|Voir la conversation>`,
      },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `conv \`${input.conversationId}\`` }],
    },
  );

  return blocks;
}
