/**
 * Prédicat de comptabilisation d'un message SORTANT au regard du plafond
 * L.34-5 CPCE (PR-OUTBOUNDKIND).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 RAISON D'ÊTRE — fermer un piège de typage, pas ajouter une abstraction
 *
 * `MessageSchema` applique `.default(DEFAULT_OUTBOUND_KIND)` : après parse,
 * la DONNÉE porte toujours une valeur. Mais `_parseMessageOrThrow` renvoie
 * `result.data as Message`, et `Message.outboundKind` est déclaré OPTIONNEL
 * (les docs legacy ne portent pas le champ, les inbound non plus). Le cast
 * efface donc la garantie au niveau du TYPE : côté lecteur,
 * `msg.outboundKind` est `MessageOutboundKind | undefined`.
 *
 * Un lecteur qui doit gérer ce `undefined` à la main a deux formes devant
 * lui, toutes deux compilables et d'apparence équivalente :
 *
 *   ✅  if (msg.outboundKind === "reply")        → legacy COMPTÉ   (fail-closed)
 *   ❌  if (msg.outboundKind !== "solicitation") → legacy EXCLU    (SOUS-COMPTAGE)
 *
 * La seconde efface silencieusement toute la base antérieure à
 * PR-OUTBOUNDKIND du comptage — c'est-à-dire une infraction L.34-5 CPCE
 * invisible en review et invisible en test si les fixtures portent toutes
 * le champ.
 *
 * Ce module supprime le choix : les consommateurs appellent
 * `countsAgainstCap()`, la forme dangereuse devient inécrivable.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ⚠️ PAS ENCORE BRANCHÉ SUR LE COMPTAGE
 *
 * PR-OUTBOUNDKIND pose la donnée et ce prédicat ; elle ne filtre RIEN.
 * `canSendMessage` compte encore TOUS les sortants. Le branchement est
 * l'objet de la PR suivante, qui devra passer compliance-auditor.
 */
import type { MessageOutboundKind } from "@/types/message";

/**
 * 🔒 Valeur retenue quand `outboundKind` est absent — FAIL-CLOSED.
 *
 * Un doc sans le champ (écrit avant PR-OUTBOUNDKIND, ou par un futur
 * chemin d'écriture qui aurait oublié de trancher) est traité comme une
 * **sollicitation**, donc COMPTÉ. Au pire on sur-compte et on bloque un
 * envoi qu'on aurait pu faire ; jamais l'inverse.
 *
 * ⚠️ Ne JAMAIS basculer cette valeur sur `"reply"` : tout doc legacy
 * sortirait du comptage → sous-comptage silencieux du plafond →
 * infraction. Sanction CNIL jusqu'à 20 M€ ou 4 % du CA mondial.
 *
 * **Source de vérité unique** : `MessageSchema` (`lib/firestore/messages.ts`)
 * consomme cette constante pour son `.default()`. Les deux ne peuvent donc
 * pas diverger. Sentinelle de test dans `messages.test.ts`.
 */
export const DEFAULT_OUTBOUND_KIND: MessageOutboundKind = "solicitation";

/**
 * Vrai si ce message sortant compte contre le plafond de sollicitations.
 *
 * Accepte une forme structurelle minimale (et non `Message`) pour rester
 * appelable depuis n'importe quelle projection — `OutboundMessageRecord`,
 * doc Firestore brut, fixture de test — sans coupler `lib/compliance/` à
 * la forme Firestore complète. Même principe que `SentMessageRecord` pour
 * `canSendMessage`.
 *
 * @param message  N'importe quel objet portant (ou non) `outboundKind`.
 *                 `undefined` → traité comme `DEFAULT_OUTBOUND_KIND`.
 *
 * @returns `true` si le message doit être comptabilisé (sollicitation ou
 *          nature inconnue), `false` uniquement pour une réponse avérée.
 */
export function countsAgainstCap(message: { outboundKind?: MessageOutboundKind }): boolean {
  return (message.outboundKind ?? DEFAULT_OUTBOUND_KIND) === "solicitation";
}
