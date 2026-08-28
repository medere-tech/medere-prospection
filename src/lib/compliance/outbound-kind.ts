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
 * 🚨 BRANCHÉ SUR LE COMPTAGE DEPUIS PR-FILTRE-SOLLICITATION
 *
 * Ce prédicat n'est plus inerte : `canSendMessage` l'utilise, via
 * `countSolicitationsInWindow`, pour décider quels sortants comptent
 * contre le plafond de 4 sollicitations / 30 jours.
 *
 * Concrètement, **changer une ligne de ce fichier change ce que le
 * système considère comme légal**. Toute modification passe par
 * compliance-auditor.
 *
 * Consommateurs actuels (les seuls autorisés à décider) :
 *   - `countSolicitationsInWindow` (`lib/compliance/rate-limits.ts`) —
 *     lui-même appelé par `canSendMessage` (la décision) ET par
 *     `preSendCheck` (le contexte d'audit opposable).
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

/**
 * Vrai si ce message sortant est une RÉPONSE avérée — donc s'il compte
 * contre le plafond de VOLUME `lib/compliance/reply-volume.ts`
 * (10 réponses / 24h, disjoncteur de sécurité).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 STRICT COMPLÉMENT DE `countsAgainstCap` — c'est délibéré
 *
 * Défini comme la négation exacte, et non par un test `=== "reply"` écrit
 * à la main, pour que `outboundKind` reste interprété en UN SEUL endroit.
 * Les deux plafonds partitionnent donc rigoureusement les sortants : tout
 * message compte soit contre le plafond légal, soit contre le plafond de
 * volume, jamais les deux, jamais aucun.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ⚠️ POLARITÉ INVERSÉE PAR RAPPORT AU PLAFOND LÉGAL — et c'est correct
 *
 * Un doc LEGACY (sans `outboundKind`) est traité par `countsAgainstCap`
 * comme une sollicitation ; il n'est donc PAS une réponse ici, et ne
 * compte PAS contre le plafond de volume.
 *
 * Pour le plafond LÉGAL, le fail-safe est de SUR-compter (bloquer un
 * envoi de trop plutôt que d'en laisser passer un). Pour ce plafond-ci,
 * c'est l'inverse : sur-bloquer ferait TAIRE un PS en conversation
 * réelle — le même dommage silencieux qu'un faux positif AUTO_REPLY. Le
 * défaut penche donc vers « ne pas bloquer ».
 *
 * En pratique la question est vide : la fenêtre est de 24 HEURES, or les
 * docs legacy sont antérieurs à PR-OUTBOUNDKIND (#42) et donc vieux de
 * plusieurs semaines. Ils ne peuvent structurellement pas y entrer.
 *
 * @param message  N'importe quel objet portant (ou non) `outboundKind`.
 * @returns `true` UNIQUEMENT pour une réponse avérée (`"reply"` explicite).
 */
export function countsAsReply(message: { outboundKind?: MessageOutboundKind }): boolean {
  return !countsAgainstCap(message);
}

/**
 * 🔒 SENTINELLE D'EXHAUSTIVITÉ — ajouter une valeur à `MessageOutboundKind`
 * fait échouer la COMPILATION ici.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * POURQUOI CETTE SENTINELLE EXISTE
 *
 * Les deux plafonds partitionnent les sortants via `countsAgainstCap` /
 * `countsAsReply`, qui sont des BOOLÉENS. Cette partition n'est exhaustive
 * que tant que l'enum a exactement 2 valeurs. Avec une 3e — `"followup"`,
 * `"reactivation"`… — la valeur :
 *
 *   - ne serait PAS une sollicitation → règle 5 ne s'applique pas,
 *     et elle ne compterait pas contre le plafond légal ;
 *   - SERAIT une réponse au sens de `countsAsReply` (complément strict),
 *     donc bornée à 10/24h — un régime probablement faux pour une relance.
 *
 * Autrement dit : une 3e nature hériterait silencieusement du régime des
 * réponses, alors qu'une relance est juridiquement une SOLLICITATION et
 * doit compter contre le plafond L.34-5. C'est la reproduction exacte du
 * MAJEUR-1 de PR-OUTBOUNDKIND, un cran plus haut dans la pile.
 *
 * Cette table force donc le développeur qui étend l'enum à trancher
 * explicitement le régime de plafond de la nouvelle valeur, et à
 * revisiter les règles 5 et 6 de `pre-send-check.ts` — au lieu de
 * découvrir le trou six mois plus tard.
 *
 * ⚠️ Ne PAS « réparer » un échec de compilation ici en ajoutant
 * mécaniquement une entrée : le passage par compliance-auditor est
 * obligatoire (les deux plafonds sont concernés).
 */
const OUTBOUND_KIND_CAP_REGIME: Record<MessageOutboundKind, "legal_cap" | "volume_cap"> = {
  solicitation: "legal_cap",
  reply: "volume_cap",
};

/** @internal Exposé pour la sentinelle de cardinalité (`outbound-kind.test.ts`). */
export const __OUTBOUND_KIND_CAP_REGIME_FOR_TESTS = OUTBOUND_KIND_CAP_REGIME;
