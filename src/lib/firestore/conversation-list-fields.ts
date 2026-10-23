/**
 * Helpers purs pour calculer les champs dénormalisés d'une conversation
 * utilisés par la liste `/admin/conversations` (PR2a).
 *
 * Toutes les fonctions sont PURES (zéro I/O Firestore). Elles sont
 * appelées DANS les transactions existantes des points d'écriture
 * (`createConversation`, `_bumpConversationCountersTx`,
 * `updateContactStatus` propagation) pour poser les champs atomiquement.
 */
import { scrubPiiFromText } from "@/lib/utils/pii-scrubber";
import type { Contact } from "@/types/contact";
import type { ConversationLastMessagePreview, MessageAuthorKind } from "@/types/conversation";

/**
 * Longueur max du texte stocké dans `conversation.lastMessagePreview.text`.
 * Choix : 140 (une ligne SMS) suffit pour un aperçu UI, limite la taille
 * du doc Firestore, et borne le risque PII (phrase complète coupée).
 */
export const LAST_MESSAGE_PREVIEW_MAX_LENGTH = 140;

/**
 * Scrubbe tout numéro FR / email + tronque à
 * `LAST_MESSAGE_PREVIEW_MAX_LENGTH`. Jamais de PII dans le résultat.
 *
 * Source unique de regex PII : `src/lib/utils/pii-scrubber.ts` (partagé
 * avec `logger.ts`). On n'ajoute PAS une regex maison ici — chaque nouveau
 * format de numéro doit être patché à cet endroit unique pour que logs,
 * previews et sentinelles de sortie bougent ensemble.
 *
 * Appelée par les points d'écriture (`addInbound`, `addOutbound`,
 * `send-reply`, `backfill`) et jamais pour "nettoyer" une lecture : la
 * défense en sortie côté API passe par la sentinelle
 * `containsFrenchPhoneNumber` sur la payload entière.
 */
export function sanitizeLastMessageText(text: string): string {
  // Scrub PII avant tout : si le body portait un numéro collé à du texte,
  // il devient `[PHONE]` et sort du compte de longueur « payload lisible ».
  let out = scrubPiiFromText(text);
  // Normalise les whitespaces (SMS multi-lignes → une ligne lisible).
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > LAST_MESSAGE_PREVIEW_MAX_LENGTH) {
    return out.slice(0, LAST_MESSAGE_PREVIEW_MAX_LENGTH - 1).trimEnd() + "…";
  }
  return out;
}

/**
 * Nom normalisé pour recherche préfixe (query PR2b) : accents retirés,
 * lower, trim, whitespaces collapsés. `"Dr Déthié  Faye"` → `"dr dethie faye"`.
 */
export function normalizeContactNameSearch(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** `${civilite ?? ""} ${firstName} ${lastName}` propre. */
export function computeContactDisplayName(contact: {
  civilite?: string;
  firstName: string;
  lastName: string;
}): string {
  const parts = [contact.civilite, contact.firstName, contact.lastName].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Shape des champs contact dénormalisés sur `conversation`. Factorise les
 * 4 champs qui proviennent de `Contact` et qui doivent être cohérents
 * (changement d'un champ contact → MAJ coordonnée des 3 autres via la
 * propagation).
 */
export interface ConversationContactSnapshot {
  contactDisplayName: string;
  contactNameSearch: string;
  contactSpecialty: string;
  contactCity: string;
}

/**
 * Dérive le snapshot complet depuis un `Contact` validé. Utilisé par
 * `createConversation` ET par la propagation `updateContactStatus`.
 */
export function buildContactSnapshot(contact: Contact): ConversationContactSnapshot {
  const displayName = computeContactDisplayName(contact);
  return {
    contactDisplayName: displayName,
    contactNameSearch: normalizeContactNameSearch(`${contact.firstName} ${contact.lastName}`),
    contactSpecialty: contact.speciality,
    contactCity: contact.city,
  };
}

/**
 * Construit l'objet `lastMessagePreview` à poser sur la conversation.
 * `authorKind` doit être choisi par le caller selon la source du message :
 *   - inbound SMS entrant → `"contact"`
 *   - outbound généré par Claude → `"ai"`
 *   - outbound envoyé par un commercial (send-reply) → `"human"`
 */
export function buildLastMessagePreview(input: {
  direction: "inbound" | "outbound";
  authorKind: MessageAuthorKind;
  text: string;
  at: ConversationLastMessagePreview["at"];
}): ConversationLastMessagePreview {
  return {
    direction: input.direction,
    authorKind: input.authorKind,
    text: sanitizeLastMessageText(input.text),
    at: input.at,
  };
}
