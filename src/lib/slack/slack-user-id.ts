/**
 * Validation du format Slack user ID (`U...` / `W...`) — fix LOW
 * security-reviewer PR-A.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi ce helper existe
 *
 * `conversation.handoff.assignedTo` est lu depuis Firestore puis passe
 * directement comme `channel` de `chat.postMessage`. Si un compromis de
 * l'Admin SDK OU un bug amont (ex: `setHandoff` qui ne regex-valide pas)
 * place une valeur arbitraire dans ce champ, le DM part vers n'importe
 * quel channel ID du workspace (y compris un canal public) — fuite PII
 * commercial. On ajoute une regex de format en 2 lignes de defense :
 *   1. a l'ECRITURE : `setHandoff` rejette tout format invalide avant
 *      write Firestore.
 *   2. AVANT L'ENVOI Slack : `sendHandoffNotification` et
 *      `sendInboundAfterHandoffNotification` rejettent une valeur
 *      invalide lue depuis un doc legacy (defense-in-depth pour les
 *      docs anterieurs a cette PR qui n'ont pas ete valides a l'ecriture).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi PAS au parse Zod de `ConversationHandoffSchema`
 *
 * Un doc legacy non-conforme (humain qui aurait tape un nom au lieu d'un
 * Slack ID avant cette PR) ferait throw `ValidationError` au premier
 * `parseConversationOrThrow` — tout le pipeline `process-reply` casserait
 * en cascade. On prefere valider aux POINTS D'EFFET (ecriture + envoi)
 * pour contenir la panne a l'operation concernee.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Format
 *
 *   - `U` prefixe pour les users standards (classique).
 *   - `W` prefixe pour les users Enterprise Grid (compatibilite).
 *   - Suivi d'au moins 8 caracteres `[A-Z0-9]` : les IDs Slack historiques
 *     font 9 chars au total (U + 8), les IDs modernes 11+. On tolere a
 *     partir de 9 chars pour matcher les docs les plus anciens.
 *   - Longueur haute non bornee : Slack n'a jamais garanti un maximum,
 *     les ID Enterprise Grid peuvent etre plus longs. Pas de limite
 *     stricte pour eviter de rejeter un futur format etendu.
 */

import { ValidationError } from "@/lib/utils/errors";

/**
 * Regex de format Slack user ID. Verrouillee par un test sentinelle.
 * Rejette les mentions `<@U...>` wrappees, les noms humains, les emails.
 */
export const SLACK_USER_ID_REGEX = /^[UW][A-Z0-9]{8,}$/;

/**
 * Verifie que `value` ressemble a un Slack user ID (`U...` / `W...`).
 * Throw `ValidationError` si non. Pas de contexte PII dans l'erreur :
 * on logge uniquement la longueur recue et le prefixe echappe.
 *
 * @param value          chaine candidate (typiquement
 *                       `conversation.handoff.assignedTo`).
 * @param operation      nom de l'operation pour le forensic (ex:
 *                       `"setHandoff"`, `"sendInboundAfterHandoff"`).
 * @throws ValidationError si `value` n'est pas un Slack user ID valide.
 */
export function assertSlackUserId(value: string, operation: string): void {
  if (!SLACK_USER_ID_REGEX.test(value)) {
    throw new ValidationError({
      message: `${operation}: invalid Slack user ID format`,
      // Pas la valeur brute dans le context — un humain qui aurait tape
      // un nom au lieu d'un ID fuite ici son nom. On expose uniquement
      // la longueur recue (sanity check) et le fait que la validation
      // a echoue.
      context: {
        operation,
        inputLength: value.length,
      },
    });
  }
}
