/**
 * Echappement defensif des champs libres interpoles dans un block Slack
 * `type: "mrkdwn"` (PR-A fix security-reviewer HIGH).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi ce helper existe
 *
 * Slack mrkdwn parse les sequences :
 *   - `<url|texte visible>`  → lien cliquable avec texte masque
 *   - `<@U0XXXX>`            → mention d'un user, declenche notification
 *   - `<!here>` / `<!channel>` / `<!subteam^S...>` → mentions "broadcast"
 *   - `<#C0XXXX>`            → mention d'un channel
 *
 * Si un attaquant envoie par SMS `<https://phishing.site|URGENT: Valider
 * Medere>` et qu'on interpole ce body brut dans un block mrkdwn, le DM
 * du commercial titulaire affiche un lien phishing cliquable, poste par
 * le bot Medere (= fort trust visuel). Idem pour `<@U...>` qui permet
 * de pinger un autre user, ou `<!here>` qui spamme un canal entier
 * depuis un simple SMS entrant.
 *
 * Vecteur miroir : `firstName` / `city` viennent de HubSpot/Lusha,
 * editables manuellement par des humains et importes en Firestore. Un
 * champ `firstName = "<@U0XXXX>"` sur une fiche HubSpot suffit.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Ordre des remplacements — & EN PREMIER
 *
 * `&` doit etre echappe en TOUT PREMIER :
 *   - Sans cela, `&lt;` → `&amp;lt;` apres passage du `<` → `&lt;` puis `&`
 *     → `&amp;` ferait un double-echappement.
 *   - En respectant cet ordre, `&lt;` reste `&lt;` et `<` devient `&lt;`.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Perimetre de ce helper
 *
 *   - IN  : chaine attendue dans un block Slack `type: "mrkdwn"`.
 *   - OUT : meme chaine, avec `&`, `<`, `>` echappes en entites HTML.
 *   - Les autres caracteres mrkdwn (`*`, `_`, `~`, backtick) sont LAISSES :
 *     ils peuvent occasionner un rendu italic/bold inattendu mais ne sont
 *     PAS un vecteur de phishing. Pas sur-echapper = preserver la
 *     lisibilite d'un SMS humain qui contiendrait un *mot*.
 *
 * A appliquer SYSTEMATIQUEMENT sur tout champ venant de l'exterieur avant
 * interpolation dans un `text: "..."` d'un block `mrkdwn`.
 */
export function escapeSlackMrkdwn(input: string): string {
  // Ordre critique : & doit etre echappe EN PREMIER (cf. JSDoc).
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
