/**
 * Résolution PURE de la cible d'une notification orphan — client-safe
 * (PR2c tour 2b bloc B, post security-reviewer).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi un module séparé
 *
 *   La fonction `resolveOrphanNotifyTarget` et son miroir UI
 *   `describeAttachNotifyTargetForUi` partagent la MÊME discipline de
 *   routage (acteur testAccount → test channel ; sinon DM titulaire si
 *   présent ; sinon canal orphelins). Les deux consomment la même
 *   fonction `resolveTargetKind` : impossible qu'elles divergent sans
 *   casser leurs tests sentinelle.
 *
 *   L'ancien emplacement (`notify-orphan-action.ts`) tirait
 *   `getSlackEnv` et était côté serveur uniquement. On déplace la
 *   logique pure ici pour qu'un composant client (`attach-dialog.tsx`)
 *   puisse l'importer sans tirer d'env serveur.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Sentinelle : si une 4e branche apparaît (ex. nouveau canal), les deux
 * fonctions doivent la gérer. Un test anti-drift lit l'enum
 * `OrphanNotifyTargetKind` ↔ les clés du label map.
 */

/**
 * Enum fermé des 4 branches possibles. Toute évolution doit mettre à
 * jour (a) `resolveTargetKind`, (b) `resolveOrphanNotifyTarget` dans
 * `notify-orphan-action.ts`, et (c) `describeAttachNotifyTargetForUi`
 * ci-dessous. Un test sentinelle vérifie la correspondance.
 */
export type OrphanNotifyTargetKind =
  | "test_channel"
  | "test_channel_missing"
  | "dm_titulaire"
  | "orphan_channel";

/**
 * Pure, sans aucune dépendance env — réutilisable côté client comme
 * côté serveur. Les callers serveur enrichissent avec les channelIds
 * (cf. `resolveOrphanNotifyTarget` dans `notify-orphan-action.ts`).
 */
export function resolveTargetKind(input: {
  readonly actorTestAccount: boolean;
  readonly assignedToSlackUserId: string | undefined;
  readonly testChannelConfigured: boolean;
}): OrphanNotifyTargetKind {
  if (input.actorTestAccount) {
    return input.testChannelConfigured ? "test_channel" : "test_channel_missing";
  }
  if (input.assignedToSlackUserId !== undefined && input.assignedToSlackUserId.length > 0) {
    return "dm_titulaire";
  }
  return "orphan_channel";
}

/**
 * Décrit la cible pour l'UI de confirmation d'`attach` (bloc B).
 *
 *   - `kind = "dm_titulaire"` → libellé nommant le commercial.
 *   - `kind = "orphan_channel"` → « le canal des SMS orphelins ».
 *   - `kind = "test_channel*"` → un admin réel ne verra jamais ce cas
 *     côté UI (son JWT testAccount est faux côté serveur), on renvoie
 *     quand même un label générique pour un éventuel compte test.
 *
 * ⚠ Sentinelle : si une branche est oubliée, TypeScript force une
 *    erreur grâce au `satisfies Record<OrphanNotifyTargetKind, …>`.
 */
export function describeAttachNotifyTargetForUi(input: {
  readonly actorTestAccount: boolean;
  readonly assignedToName: string | null;
  readonly assignedToSlackUserId: string | undefined;
}): string {
  const kind = resolveTargetKind({
    actorTestAccount: input.actorTestAccount,
    assignedToSlackUserId: input.assignedToSlackUserId,
    testChannelConfigured: true, // vue UI : on n'a pas accès à l'env
    // serveur ; côté UI on affiche la cible logique, pas la panne de
    // config testChannel (fail-closed serveur produit une erreur réelle
    // au moment de notifier).
  });

  const LABELS = {
    test_channel: "le canal de test",
    test_channel_missing: "le canal de test",
    dm_titulaire:
      input.assignedToName !== null && input.assignedToName.length > 0
        ? input.assignedToName
        : "le titulaire de la conversation",
    orphan_channel: "le canal des SMS orphelins",
  } as const satisfies Record<OrphanNotifyTargetKind, string>;

  return LABELS[kind];
}
