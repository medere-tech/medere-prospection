/**
 * Sanitize côté serveur : transforme les docs Firestore bruts en shapes
 * `types.ts` sans PII numéro (VUE-CONVERSATION PR1).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 INVARIANT — JAMAIS DE `e164`, `phone`, `externalReceiver` DANS LE PAYLOAD RSC
 *
 * Les fonctions ici sont utilisées par le server component de la page
 * détail conversation AVANT de passer les données au client. Elles
 * STRIPPENT activement les champs téléphone. Toute régression (ajout
 * involontaire) est détectée par la sentinelle
 * `tests/scripts/no-phone-in-payload.test.ts` qui sérialise la payload
 * complète et grep les patterns `+33\d{9}`, `0033`, FR national.
 */
import type { Timestamp } from "firebase-admin/firestore";

import { formatDateTimeParis } from "@/lib/utils/format-paris";
import type { AuditAction, AuditLog } from "@/types/audit-log";
import type { Contact } from "@/types/contact";
import type { Conversation } from "@/types/conversation";
import type { Message } from "@/types/message";

import type {
  ContactHeaderProps,
  ConversationDisplayIntent,
  ConversationDisplayStatus,
  HandoffDisplayProps,
  JournalEntryProps,
  MessageDisplayStatus,
  MessageProps,
} from "./types";

/** Convertit un Timestamp Firestore en ISO 8601 (ou null). */
function toIsoOrNull(ts: Timestamp | undefined | null): string | null {
  if (!ts) return null;
  try {
    return ts.toDate().toISOString();
  } catch {
    return null;
  }
}

/**
 * Sanitize un `Contact` → `ContactHeaderProps`. STRIPPE `phone.*` et
 * `email`. Garde uniquement identité + spécialité + ville + opt-out status.
 */
export function sanitizeContactForHeader(contact: Contact): ContactHeaderProps {
  const civ = typeof contact.civilite === "string" ? contact.civilite.trim() : "";
  const normalizedCiv: ContactHeaderProps["civilite"] =
    civ === "M." || civ === "Mme" || civ === "Dr" || civ === "Pr" ? civ : civ === "" ? null : "";
  return {
    contactId: contact.hubspotId,
    civilite: normalizedCiv,
    firstName: contact.firstName && contact.firstName.length > 0 ? contact.firstName : null,
    lastName: contact.lastName && contact.lastName.length > 0 ? contact.lastName : null,
    speciality: contact.speciality && contact.speciality.length > 0 ? contact.speciality : null,
    city: contact.city && contact.city.length > 0 ? contact.city : null,
    optedOut: Boolean(contact.consent?.optedOut),
    // PR3 tour 2b — 4 derniers chiffres uniquement (non PII par
    // construction, pattern miroir `ContactListItem.phoneLast4` posé en
    // PR3 tour 2a). Permet au composant `RevealPhoneAction` de l'en-tête
    // d'afficher `•• •• •• •• •• XX` avant tout clic audité.
    //
    // Fail-closed (PR3 tour 2b bis quinquies) : si le doc contact est
    // corrompu (`phone.e164` absent ou non-string), on retourne `null` —
    // jamais `"0000"` qui afficherait un faux masque et un bouton qui
    // échouerait ensuite côté serveur avec 500. `RevealPhoneAction` sait
    // rendre « Numéro indisponible » sans bouton quand `phoneLast4 === null`.
    phoneLast4: typeof contact.phone?.e164 === "string" ? contact.phone.e164.slice(-4) : null,
  };
}

/**
 * Sanitize un `Message` (shape complète lue par `listMessagesInConversation`)
 * → `MessageProps` pour la bulle. STRIPPE `externalReceiver` (et tout
 * autre champ hors shape de sortie — approche allow-list via construction
 * d'un objet littéral).
 */
export function sanitizeMessageForBubble(
  msg: Message & { messageId: string },
  commercialName: string | null,
): MessageProps | null {
  // Defense-in-depth : les messages `duplicate` DOIVENT disparaître de
  // l'UI (filtrés en amont par `listMessagesInConversation`). Si un
  // document avec `status: "duplicate"` survit jusqu'ici (régression,
  // oubli d'un chemin de lecture), on retourne `null` → le caller
  // (`load-conversation-detail.ts`) filtre les `null` avant d'exposer
  // `messages[]` au client.
  //
  // 🔒 Pattern volontaire : la sanitize est LA source de vérité du
  // filtrage, pas la couche composant. Les tests sentinelle vérifient
  // qu'aucun body `duplicate` n'atteint le DOM rendu.
  if (msg.status === "duplicate") return null;

  const status: MessageDisplayStatus = msg.status as MessageDisplayStatus;

  const abandonReason =
    msg.abandonReason === "stale_pre_launch_test_cleanup" ? msg.abandonReason : undefined;

  // PR2c tour 2b bloc B — origine orphan (rattachement manuel admin).
  // Allow-list stricte sur le sous-objet : on NE copie QUE `phoneMatch`
  // (l'`orphanId` interne n'est jamais exposé au client). Validation
  // d'enum fermée.
  const attachedFromOrphan = (() => {
    const raw = msg.attachedFromOrphan;
    if (!raw || typeof raw !== "object") return undefined;
    const pm = raw.phoneMatch;
    if (pm !== "match" && pm !== "mismatch" && pm !== "not_computable") return undefined;
    return { phoneMatch: pm };
  })();

  return {
    messageId: msg.messageId,
    direction: msg.direction,
    status,
    body: msg.body,
    outboundKind: msg.outboundKind,
    generatedBy: msg.generatedBy,
    createdAtIso: toIsoOrNull(msg.createdAt as Timestamp | undefined) ?? "",
    sentAtIso: toIsoOrNull(msg.sentAt as Timestamp | undefined) ?? undefined,
    deliveredAtIso: toIsoOrNull(msg.deliveredAt as Timestamp | undefined) ?? undefined,
    receivedAtIso: toIsoOrNull(msg.receivedAt as Timestamp | undefined) ?? undefined,
    abandonedAtIso: toIsoOrNull(msg.abandonedAt as Timestamp | undefined) ?? undefined,
    abandonReason,
    intent: msg.intent,
    commercialName,
    ...(attachedFromOrphan !== undefined ? { attachedFromOrphan } : {}),
  };
}

/** Mapping statut conversation. Pass-through typé. */
export function sanitizeConversationStatus(conv: Conversation): ConversationDisplayStatus {
  return conv.status;
}

/** Mapping intent. Pass-through typé. */
export function sanitizeConversationIntent(conv: Conversation): ConversationDisplayIntent {
  return conv.intent;
}

/**
 * Sanitize le hand-off d'une conversation. Si pas de hand-off, retourne null.
 * Le `commercialName` doit être résolu séparément (Airtable) par le caller
 * et injecté ici.
 */
export function sanitizeHandoffForPanel(
  conv: Conversation,
  commercialName: string | null,
): HandoffDisplayProps | null {
  const h = conv.handoff;
  if (!h) return null;
  return {
    assignedToName: commercialName,
    assignedToSlackId: h.assignedTo,
    assignedAtIso: toIsoOrNull(h.assignedAt as Timestamp | undefined),
    contactedAtIso: null, // PR4 : `handoff.contactedAt`
    acceptedAtIso: toIsoOrNull(h.acceptedAt as Timestamp | undefined),
  };
}

/**
 * Table COMPLÈTE des libellés FR du journal — PR2b-2 round 3.
 *
 *   - Type `Record<AuditAction, …>` : TS exige qu'une entrée existe pour
 *     CHAQUE action du type (compile-time). L'ajout d'une nouvelle
 *     `AuditAction` sans libellé ici fait échouer le build.
 *   - Zéro PII en sortie — le `payload` audit est déjà scrubber-safe par
 *     construction (`detectPiiInPayload` runtime).
 *   - Un test sentinelle (`sanitize.test.ts`) interdit tout libellé qui
 *     ressemble à du snake_case (regex) → une future action ne pourra
 *     plus "fuiter" sous forme de code brut dans l'UI.
 */
const ACTION_LABELS: Record<AuditAction, { label: string; kind: JournalEntryProps["kind"] }> = {
  // SMS OUTBOUND
  sms_sent: { label: "SMS envoyé", kind: "sms" },
  sms_failed: { label: "Échec d'envoi SMS", kind: "sms" },
  sms_provider_dispatched: { label: "SMS pris en charge par OVH", kind: "sms" },
  send_blocked: { label: "Envoi bloqué (compliance)", kind: "other" },
  // SMS INBOUND (S9.1 process-reply)
  sms_received: { label: "SMS reçu du contact", kind: "sms" },
  intent_classified: { label: "Intention classifiée", kind: "intent" },
  reply_generated: { label: "Réponse IA générée", kind: "sms" },
  reply_processed: { label: "Réponse traitée", kind: "sms" },
  reply_dropped: { label: "SMS entrant écarté (doublon)", kind: "other" },
  reply_draft_dropped: { label: "Brouillon de réponse écarté", kind: "sms" },
  long_form_opt_out_candidate: { label: "Signal d'opt-out long format", kind: "opt_out" },
  // CONVERSATION lifecycle
  opt_out: { label: "Opt-out du contact (STOP)", kind: "opt_out" },
  handoff: { label: "Hand-off vers un commercial", kind: "handoff" },
  handoff_accepted: { label: "Hand-off accepté", kind: "handoff" },
  handoff_unassigned: { label: "Hand-off orphelin (sans titulaire)", kind: "handoff" },
  inbound_relayed_to_human: { label: "SMS entrant relayé au commercial", kind: "handoff" },
  inbound_on_inactive_conversation: {
    label: "SMS entrant sur conversation inactive",
    kind: "other",
  },
  // PR3 — un libellé par méthode (`display | copy | call`) via résolution
  // par payload dans `labelForAction`. Le fallback générique « Numéro
  // consulté » reste si le payload est absent (docs legacy pré-PR3).
  contact_phone_accessed: { label: "Numéro consulté", kind: "override" },
  // CAMPAIGN / ADMIN
  manual_override: { label: "Intervention manuelle (admin)", kind: "override" },
  prompt_changed: { label: "Prompt IA modifié", kind: "other" },
  campaign_started: { label: "Campagne démarrée", kind: "other" },
  campaign_paused: { label: "Campagne en pause", kind: "other" },
  campaign_completed: { label: "Campagne terminée", kind: "other" },
  sms_send_initiated_by_admin: { label: "SMS déclenché par un admin", kind: "sms" },
  // DATA
  bloctel_imported: { label: "Bloctel importé", kind: "other" },
  contact_deleted: { label: "Contact supprimé", kind: "other" },
  contact_anonymized: { label: "Contact anonymisé", kind: "other" },
  contact_imported_from_hubspot: { label: "Contact importé depuis HubSpot", kind: "other" },
  contact_created: { label: "Contact créé", kind: "other" },
  contact_import_skipped: { label: "Import contact ignoré", kind: "other" },
  // AUTH
  login: { label: "Connexion", kind: "other" },
  role_changed: { label: "Rôle modifié", kind: "other" },
  // TRANSVERSE
  compliance_check: { label: "Contrôle compliance", kind: "other" },
  status_changed: { label: "Changement de statut", kind: "other" },
  // PR2a — dénormalisation liste `/admin/conversations`
  conversation_denorm_propagated: {
    label: "Résumé de conversation mis à jour",
    kind: "other",
  },
  backfill_conversation_list_fields: {
    label: "Rattrapage des champs de liste (admin)",
    kind: "other",
  },
  // PR2c tour 2a — transitions SMS orphelins
  orphan_attached_to_conversation: {
    label: "SMS orphelin rattaché à une conversation",
    kind: "other",
  },
  orphan_dismissed: { label: "SMS orphelin marqué traité", kind: "other" },
  orphan_reopened: { label: "SMS orphelin remis à traiter", kind: "other" },
};

/**
 * PR3 — table exhaustive des libellés `contact_phone_accessed` par méthode.
 * Trois valeurs, 100 % couvertes par l'enum fermé `ContactPhoneAccessMethod`
 * (`src/types/audit-log.ts:747-755`). Fallback générique « Numéro consulté »
 * (via `ACTION_LABELS`) si un doc legacy (pré-PR3) n'a pas de `method`.
 */
export const PHONE_ACCESSED_LABELS: Record<"display" | "copy" | "call", string> = {
  display: "Numéro affiché",
  copy: "Numéro copié",
  call: "Appel lancé",
};

function labelForAction(
  action: string,
  payload?: Record<string, unknown>,
): { label: string; kind: JournalEntryProps["kind"] } {
  if (Object.prototype.hasOwnProperty.call(ACTION_LABELS, action) as boolean) {
    const base = ACTION_LABELS[action as AuditAction];
    // PR3 — spécialisation `contact_phone_accessed` par méthode. Fail-safe
    // au libellé générique si `method` manquant ou hors enum (docs legacy).
    if (action === "contact_phone_accessed" && payload !== undefined) {
      const m = payload.method;
      if (m === "display" || m === "copy" || m === "call") {
        return { label: PHONE_ACCESSED_LABELS[m], kind: base.kind };
      }
    }
    return base;
  }
  // Action inconnue au type TS (devrait être impossible — la whitelist Zod
  // `ACTIONS` de `audit-log.ts` + le type `AuditAction` sont en égalité
  // ensembliste via sentinelle anti-drift). Pas de leak de code brut.
  return { label: "Action enregistrée", kind: "other" };
}

/** Exposé pour tests — permet au sentinelle de parcourir toutes les ACTIONS. */
export const __labelForAction_FOR_TESTS = labelForAction;
export const __ACTION_LABELS_FOR_TESTS = ACTION_LABELS;

/**
 * Options pour `sanitizeAuditEntriesForJournal` (PR3 tour 2b).
 */
export interface SanitizeJournalOptions {
  /**
   * Map `actorId` Clerk → nom affichable (préfixé par `resolveAdminNamesBatch`).
   * Ne couvre que les `actorType === "human"` collectés en amont. Les autres
   * acteurs (`ai` / `system`) ont un libellé constant.
   */
  readonly actorNameByUserId: ReadonlyMap<string, string | null>;
  /**
   * `true` ssi le viewer courant est un compte test (claim JWT Clerk
   * `testAccount`). Quand `false`, on filtre les entrées dont le payload
   * audit porte `actorTestAccount === true` — un vrai utilisateur ne doit
   * pas voir les clics simulés par le harnais Playwright pollur le journal
   * d'une conversation réelle. Miroir du filtre fixtures orphelins
   * (`isTestFixture === true` masqué pour les comptes réels).
   */
  readonly viewerIsTestAccount: boolean;
}

/**
 * Sanitize une liste d'entrées `audit_log` en entrées de journal (shape
 * minimale `JournalEntryProps`). `timestampLabel` est pré-formaté en
 * Europe/Paris côté serveur pour éviter de passer les Timestamp au client.
 *
 * PR3 tour 2b — ajoute :
 *   - résolution serveur de `actorName` (Clerk) injectée via
 *     `options.actorNameByUserId` ;
 *   - filtre des entrées `actorTestAccount === true` pour les viewers
 *     non-testAccount.
 */
export function sanitizeAuditEntriesForJournal(
  entries: Array<AuditLog & { docId: string }>,
  options: SanitizeJournalOptions,
): JournalEntryProps[] {
  return entries
    .filter((e) => {
      // Filtre test-account : un compte réel ne voit pas les entrées
      // posées par un harnais Playwright. La sentinelle est le flag
      // `actorTestAccount` posé en payload par `revealContactPhone` (et
      // tout futur site d'écriture qui voudra adopter le même pattern).
      if (options.viewerIsTestAccount) return true;
      return e.payload?.actorTestAccount !== true;
    })
    .map((e) => {
      // PR3 — `payload` passé au résolveur pour spécialiser
      // `contact_phone_accessed` par méthode (`display`/`copy`/`call`).
      const { label, kind } = labelForAction(e.action, e.payload);
      return {
        docId: e.docId,
        timestampLabel: formatDateTimeParis(e.timestamp),
        label,
        kind,
        actorName: resolveActorName(e, options.actorNameByUserId),
      };
    });
}

/**
 * Résout le nom d'un acteur pour affichage dans le journal.
 *
 *   - `human` → map Clerk (prénom + nom résolu côté serveur). Si non
 *     résolvable (compte supprimé, erreur Clerk), on retourne `null` et
 *     l'UI tombera sur « — » (pas d'identifiant brut).
 *   - `ai`     → `"Léa"` (convention projet, cf. `medere-claude-prompts`).
 *   - `system` → `"Système"`.
 *
 * 🚨 Jamais d'identifiant Clerk/Slack/HubSpot brut — c'est la sentinelle
 * `assertNoTechnicalId` de l'e2e fixtures qui tombe sinon.
 */
function resolveActorName(
  entry: AuditLog & { docId: string },
  actorNameByUserId: ReadonlyMap<string, string | null>,
): string | null {
  if (entry.actorType === "ai") return "Léa";
  if (entry.actorType === "system") return "Système";
  // human
  const resolved = actorNameByUserId.get(entry.actorId);
  return resolved ?? null;
}
