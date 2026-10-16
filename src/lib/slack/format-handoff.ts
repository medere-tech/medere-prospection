/**
 * Format Block Kit des notifications hand-off Slack (S9.9-PR3).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Fonction PURE — aucun accès réseau, aucun appel SDK, aucun accès env.
 * Testable directement en asservissant la sortie exacte.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * DÉCISION PII (D2) — MINIMUM VITAL
 *
 * La signature `HandoffInput` interdit au COMPILE-TIME de passer :
 *   - `lastName`      (nom de famille complet — reste derrière le lien)
 *   - `phone`, `email` (données de contact — accessibles via le dashboard)
 *   - `hubspotId`     (identifiant technique — pas utile au commercial)
 *
 * Ce qui EST exposé dans les blocks :
 *   - `firstName`    (prénom seul, courtoisie humaine)
 *   - `speciality`   (contexte métier — pas une donnée personnelle sensible)
 *   - `city`         (contexte géographique — pas de rue/CP)
 *   - `lastInboundBody` (dernier message du PS, tronqué à 300 chars)
 *   - `dashboardUrl` (le nom complet + coordonnées vivent derrière ce lien,
 *                     protégé par Clerk auth côté dashboard)
 *   - `conversationId` (opaque, non-PII — footer discret pour correlation
 *                       support/debug uniquement)
 *
 * ⚠️ Test sentinelle `format-handoff.test.ts` : passe un `lastName` /
 * `phone` / `email` / `hubspotId` via cast `as any` et vérifie que ces
 * valeurs N'APPARAISSENT PAS dans les blocks générés. Si quelqu'un ajoute
 * un jour un champ PII à la sortie, le test casse.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * DÉCISION D8 — ORPHELINS PING <!here>
 *
 * `isOrphan=true` → canal partagé, on ping `<!here>` (utilisateurs actifs
 * du canal). PAS de `<!channel>` (trop bruyant) ni de mention `@personne`
 * (le fallback orphelins est par définition non nominatif).
 *
 * `isOrphan=false` → DM direct au commercial, aucune mention (il n'y a
 * qu'un destinataire, le ping serait redondant).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 SECURITE — ECHAPPEMENT MRKDWN (fix HIGH security-reviewer PR-A)
 *
 * TOUT champ interpole dans un block `type: "mrkdwn"` et provenant d'une
 * source externe (SMS entrant, HubSpot/Lusha) DOIT passer par
 * `escapeSlackMrkdwn`. Sinon un PS malveillant peut poster `<url|texte>`
 * / `<@U...>` / `<!here>` dans un SMS et faire apparaitre un lien
 * phishing cliquable OU une mention active dans le DM/canal, poste par
 * le bot Medere (= fort trust visuel). Vecteur miroir sur `firstName`,
 * `speciality`, `city` qui viennent de HubSpot/Lusha, editables
 * manuellement par des humains.
 *
 * Champs couverts ici : `firstName`, `speciality`, `city`, `lastInboundBody`.
 * `conversationId` est opaque par construction, `dashboardUrl` passe par
 * `encodeURIComponent` dans son helper d'origine.
 */
import { escapeSlackMrkdwn } from "./escape-mrkdwn";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes — bornes I/O
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cap sur le corps du dernier message inbound inclus dans le block. 300
 * chars = tient sur ~5 lignes affichées Slack (mobile + desktop), suffisant
 * pour donner le contexte au commercial. Au-delà, on tronque avec `…` et
 * le commercial clique sur le lien pour voir le message complet.
 *
 * 🔒 SENTINEL — verrouillé par test `respecte le cap de 300 chars`.
 */
export const LAST_INBOUND_MAX_CHARS = 300;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input strictement typé. La liste EXHAUSTIVE des champs autorisés
 * empêche au compile-time l'ajout accidentel de PII (`lastName`, `phone`,
 * `email`, `hubspotId`) — cf. sentinelle runtime dans les tests.
 */
export interface HandoffInput {
  firstName: string;
  speciality: string;
  city: string;
  lastInboundBody: string;
  conversationId: string;
  isOrphan: boolean;
  dashboardUrl: string;
}

/**
 * Structure Block Kit générique. On n'importe pas `KnownBlock` de
 * `@slack/web-api` ici pour rester découplé du SDK (le format Block Kit
 * est du JSON, l'API accepte n'importe quelle forme conforme au schéma
 * public documenté).
 */
export type HandoffBlock = Record<string, unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Tronque `text` à `max` chars et ajoute `…` si effectivement tronqué. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

/**
 * Formate un texte en blockquote Slack : préfixe chaque ligne par `> `.
 * Slack mrkdwn traite `> ` en début de ligne comme un blockquote. Sans
 * cette transformation, une ligne 2/3/… du texte ne serait pas en
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
 * Construit les blocks Block Kit d'une notification hand-off.
 *
 * Sortie identique pour DM (`isOrphan=false`) et canal (`isOrphan=true`)
 * à 2 différences près :
 *   - Header : "🎯 Lead intéressé" vs "❓ Lead non attribué à traiter"
 *   - Contexte : ping `<!here>` uniquement en orphelins
 *
 * Structure :
 *   [0] header  — titre du hand-off
 *   [1] section — (optionnel `<!here>`) puis `*Firstname* — Speciality` +
 *                 `📍 City`
 *   [2] section — blockquote du dernier message PS (tronqué)
 *   [3] section — lien "Voir la conversation" (dashboardUrl)
 *   [4] context — footer discret `conv \`<id>\`` pour correlation debug
 */
export function buildHandoffBlocks(input: HandoffInput): HandoffBlock[] {
  const header = input.isOrphan ? "❓ Lead non attribué à traiter" : "🎯 Lead intéressé";
  // herePing est une CONSTANTE litterale, pas une entree externe —
  // volontairement NON echappee pour que Slack rende effectivement la
  // mention `<!here>` sur la branche orphelins (c'est le ping voulu D8).
  const herePing = input.isOrphan ? "<!here>\n" : "";

  // 🚨 ECHAPPEMENT MRKDWN — tous les champs externes passent par
  // escapeSlackMrkdwn AVANT interpolation (fix HIGH security-reviewer).
  // Troncature APRES echappement : un echappement sur un corps deja
  // tronque peut laisser une entite coupee en 2.
  const safeFirstName = escapeSlackMrkdwn(input.firstName);
  const safeSpeciality = escapeSlackMrkdwn(input.speciality);
  const safeCity = escapeSlackMrkdwn(input.city);
  const safeBody = escapeSlackMrkdwn(input.lastInboundBody);
  const truncatedBody = truncate(safeBody, LAST_INBOUND_MAX_CHARS);
  const blockquotedBody = toBlockquote(truncatedBody);

  return [
    {
      type: "header",
      text: { type: "plain_text", text: header, emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${herePing}*${safeFirstName}* — ${safeSpeciality}\n📍 ${safeCity}`,
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
        text: `<${input.dashboardUrl}|Voir la conversation>`,
      },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `conv \`${input.conversationId}\`` }],
    },
  ];
}
