/**
 * Table de libellés FR EXHAUSTIVE pour `/admin/orphan-inbounds`
 * (PR2c tour 2b bloc B).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * SOURCE UNIQUE
 *
 *   Toutes les pièces UI (table, cartes mobile, tiroir, dialogs, sidebar,
 *   tests) importent les libellés depuis CE fichier. Aucun identifiant,
 *   numéro de code technique ou slug ne doit jamais atteindre le DOM —
 *   un test sentinelle (`orphan-labels.test.ts`) vérifie qu'aucune valeur
 *   ne ressemble à du snake_case.
 *
 *   Le type `Record<K, …>` force TypeScript à exiger une entrée par
 *   variante de chaque enum : impossible d'ajouter une raison / un état /
 *   un motif de classement sans mettre à jour les 2 tables (label +
 *   description quand applicable).
 */
import type { OrphanInboundClientView } from "@/lib/firestore/orphan-inbounds-sanitize";

/** Alias pour éviter les répétitions. */
export type OrphanReason = OrphanInboundClientView["reason"];
export type OrphanState = OrphanInboundClientView["processingState"];
export type OrphanDismissReason = NonNullable<OrphanInboundClientView["dismissal"]>["reason"];
export type OrphanPhoneMatch = NonNullable<OrphanInboundClientView["attachment"]>["phoneMatch"];

/** Libellé court — colonne « Motif » et chip dans le tiroir. */
export const ORPHAN_REASON_LABELS: Record<OrphanReason, string> = {
  no_conversation: "Pas de conversation",
  unknown_contact: "Médecin inconnu",
  parse_failed: "SMS illisible",
  enqueue_failed: "File d'attente en panne",
};

/** Phrase d'explication — affichée en dessous du libellé dans la table
 * et dans le tiroir. Rédigée pour un commercial, pas un ingénieur. */
export const ORPHAN_REASON_EXPLANATIONS: Record<OrphanReason, string> = {
  no_conversation: "Ce médecin a répondu alors qu'aucune conversation active ne lui correspondait.",
  unknown_contact: "Ce numéro n'a pas pu être relié à un médecin de la base.",
  parse_failed: "Le SMS reçu n'a pas pu être lu correctement par le système.",
  enqueue_failed: "Le SMS a bien été reçu mais n'a pas pu être traité par Léa à ce moment.",
};

/** Libellé de l'onglet — SOURCE UNIQUE partagée avec la barre d'onglets. */
export const ORPHAN_TAB_LABELS: Record<OrphanState | "all", string> = {
  pending: "À traiter",
  attached: "Rattachés",
  dismissed: "Classés sans suite",
  all: "Tous",
};

/** État affiché dans la colonne « État » de la table et dans le tiroir. */
export const ORPHAN_STATE_LABELS: Record<OrphanState, string> = {
  pending: "À traiter",
  attached: "Rattaché",
  dismissed: "Classé sans suite",
};

/** Motif de classement — étiquette courte dans les listes. */
export const ORPHAN_DISMISS_LABELS: Record<OrphanDismissReason, string> = {
  unrelated_or_spam: "Hors sujet ou spam",
  already_handled_elsewhere: "Déjà traité ailleurs",
  sender_not_identifiable: "Expéditeur non identifiable",
};

/** Motif de classement — phrase longue affichée dans le dialog de choix. */
export const ORPHAN_DISMISS_EXPLANATIONS: Record<OrphanDismissReason, string> = {
  unrelated_or_spam:
    "Le SMS n'a aucun rapport avec notre démarche (démarchage, erreur, numéro douteux).",
  already_handled_elsewhere: "Un collègue ou un autre canal a déjà pris en charge ce médecin.",
  sender_not_identifiable:
    "Impossible de dire qui a envoyé ce SMS (texte trop court, aucun indice).",
};

/** Résultat de comparaison du numéro de l'orphan avec celui du contact
 * rattaché. Jamais le hash brut. */
export const ORPHAN_PHONE_MATCH_LABELS: Record<OrphanPhoneMatch, string> = {
  match: "Numéro identique",
  mismatch: "Numéro différent",
  not_computable: "Numéro non comparable",
};

/** Phrase d'explication pour chaque phoneMatch — accrochée sous le badge
 * dans l'historique du tiroir. */
export const ORPHAN_PHONE_MATCH_EXPLANATIONS: Record<OrphanPhoneMatch, string> = {
  match: "Le SMS provient bien du numéro connu de ce médecin.",
  mismatch:
    "Le SMS provient d'un numéro différent de celui enregistré pour ce médecin — par exemple s'il nous a écrit depuis son portable personnel.",
  not_computable: "Le numéro de l'orphelin n'a pas pu être comparé (texte brut, numéro absent).",
};

/** Libellé lisible pour un auteur Clerk introuvable (compte supprimé,
 * erreur API). Les audits serveur conservent toujours l'identifiant
 * précis — c'est juste la vue utilisateur qui a besoin d'une étiquette. */
export const ORPHAN_UNKNOWN_ADMIN_LABEL = "Admin inconnu";

/** Libellé pour un expéditeur dont le médecin n'a pas pu être résolu. */
export const UNKNOWN_SENDER_LABEL = "Expéditeur non identifié";

/** Toasts FR exposés comme table pour que les tests sentinelle vérifient
 * leur présence au complet. */
export const ORPHAN_TOASTS = {
  attachSuccess: "SMS rattaché à la conversation.",
  attachError: "Impossible de rattacher ce SMS. Vérifiez puis réessayez.",
  dismissSuccess: "SMS classé sans suite.",
  dismissError: "Impossible de classer ce SMS. Réessayez.",
  reopenSuccess: "SMS remis à traiter.",
  reopenError: "Impossible de remettre ce SMS à traiter. Réessayez.",
} as const satisfies Record<string, string>;
