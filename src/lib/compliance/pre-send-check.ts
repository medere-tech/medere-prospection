/**
 * Orchestrateur des 10 règles compliance avant tout envoi SMS.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ORDRE STRICT DES RÈGLES (décision Déthié S5 + GUARD-003 règle 4
 * + PR-BARRIERE-2 règle 6)
 *
 *   1. `opted_out`                       — court-circuit immédiat si le PS a opté-out
 *   2. `ai_disclosure`                   — annonce IA dans le 1er SMS (AI Act art. 50)
 *   3. `stop_present`                    — STOP dans le SMS sortant (L.34-5 CPCE)
 *   4. `advertiser_identification`       — mention "Médéré" dans le SMS (L.34-5 al. 5 CPCE)
 *   5. `rate_limit`                      — LÉGAL : 4 SOLLICITATIONS / 30 jours.
 *                                          Ne bloque QUE les sollicitations.
 *   6. `reply_volume`                    — SÉCURITÉ : 10 RÉPONSES / 24 heures.
 *                                          Ne bloque QUE les réponses.
 *   7. `hours`                           — plages horaires L-V/sam, dimanche/fériés
 *   8. `bloctel`                         — vérif Bloctel si B2C mobile perso
 *   9. `legitimate_interest`             — intérêt légitime documenté (min 20 chars)
 *  10. `phone_validity`                  — téléphone valide + non VoIP
 *
 * Les règles 2, 3 et 4 ciblent toutes le **contenu du body** (regex O(1))
 * et sont groupées en début de chaîne ; les règles 5-10 ciblent le **contexte
 * d'envoi** (historique, dates, état contact — O(n)) et sont évaluées après.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * DEUX PLAFONDS INDÉPENDANTS, CONDITIONNÉS PAR `args.outboundKind`
 *
 * Les règles 5 et 6 sont MUTUELLEMENT EXCLUSIVES par construction : la 5
 * ne s'applique qu'aux `"solicitation"`, la 6 qu'aux `"reply"`. Un même
 * message ne peut donc jamais être refusé par les deux.
 *
 *   | Règle        | Sujet          | Fenêtre | Nature   | Sanction   |
 *   |--------------|----------------|---------|----------|------------|
 *   | rate_limit   | sollicitations | 30 j    | LÉGALE   | CNIL 20 M€ |
 *   | reply_volume | réponses       | 24 h    | SÉCURITÉ | réputation |
 *
 * Court-circuit : dès qu'une règle refuse, on s'arrête et on renvoie le
 * `ComplianceFailure` correspondant. Les règles suivantes ne sont PAS
 * évaluées (vérifié par tests d'injection de dépendances).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * GARANTIES DE STRUCTURE
 *
 *   - `humanReason` est une CONSTANTE par `code` (cf. `HUMAN_REASONS`).
 *     JAMAIS de template string avec valeurs runtime → aucune interpolation
 *     de `contact.firstName`, `contact.phone`, `message`, etc.
 *
 *   - `failure.context` est une DISCRIMINATED UNION FERMÉE : chaque variante
 *     de `ComplianceFailure` liste exactement les clés autorisées dans son
 *     `context`. TypeScript verrouille au compile-time qu'on ne peut pas
 *     ajouter `context.phone`, `context.firstName`, etc. par la suite.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * RESPONSABILITÉS DU CALLER (à respecter en S6+)
 *
 *   1. Transaction Firestore + verrou pessimiste : enrober l'appel à
 *      `preSendCheck` + l'envoi OVH dans une transaction qui lock le
 *      document `contacts/{id}`. Sans ça, deux Inngest jobs concurrents
 *      peuvent chacun valider `canSendMessage` (état 2/3) puis envoyer
 *      simultanément → 4 SMS effectifs. preSendCheck est PURE et NE
 *      gère PAS la concurrence.
 *
 *   2. Audit log de CHAQUE appel — `allowed` comme `blocked` — dans
 *      Firestore `audit_log/` (`action: "compliance_check"`, `result`,
 *      `code?`, `rule?`, `context?`). Sinon : blocage silencieux non
 *      tracé. preSendCheck NE log RIEN.
 *
 *   3. Filtrer `humanReason` côté API : c'est un texte **server-only**
 *      destiné à l'audit et au debug. NE JAMAIS le renvoyer au client
 *      directement (info disclosure mineur). Utiliser le `code` typé
 *      pour la réponse client, avec un mapping client-générique.
 *
 *   4. GUARD-001 — Long-form opt-out (> 50 chars) non détecté par
 *      `isOptOut` (S4). `preSendCheck` ne ferme PAS ce trou. Tant que
 *      S7 (classifier Claude d'intent) n'est pas livré, NE PAS déployer
 *      en prod. Cf. backlog Notion GUARD-001.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * INJECTION DE DÉPENDANCES (`deps`)
 *
 * Second argument optionnel. Permet aux tests de prouver le court-circuit
 * RÉEL via des spies `vi.fn()`. En usage normal, ne pas passer `deps` —
 * les implémentations réelles des règles S4 sont utilisées.
 */
import { differenceInDays } from "date-fns";

import type { Contact } from "@/types/contact";
import type { Conversation } from "@/types/conversation";
import type { MessageOutboundKind } from "@/types/message";

import { hasAdvertiserIdentification } from "./advertiser-identification";
import { hasAIDisclosure } from "./ai-disclosure";
import { BLOCTEL_REASONS, canSendB2C } from "./bloctel";
import { isAllowedSendTime, MAX_VERIFIED_HOLIDAYS_YEAR } from "./hours";
import { hasOptOut } from "./opt-out";
import { countsAgainstCap, countsAsReply } from "./outbound-kind";
import {
  canSendMessage,
  type ComplianceCheckResult,
  countSolicitationsInWindow,
  type OutboundMessageRecord,
  RATE_LIMIT_MAX_MESSAGES,
  RATE_LIMIT_WINDOW_DAYS,
} from "./rate-limits";
import {
  canSendReplyVolume,
  countReplyVolumeInWindow,
  REPLY_VOLUME_MAX,
  REPLY_VOLUME_WINDOW_HOURS,
} from "./reply-volume";

// ─────────────────────────────────────────────────────────────────────────────
// Énumérations typées
// ─────────────────────────────────────────────────────────────────────────────

export type ComplianceFailCode =
  | "opted_out"
  | "ai_disclosure_missing"
  | "stop_optout_missing"
  | "advertiser_identification_missing"
  | "rate_limit_exceeded"
  | "reply_volume_exceeded"
  | "outside_hours"
  | "saturday_out_of_range"
  | "sunday"
  | "holiday"
  | "holidays_not_verified"
  | "bloctel_not_checked"
  | "bloctel_opted_out"
  | "bloctel_check_expired"
  | "legitimate_interest_undocumented"
  | "phone_invalid"
  | "phone_voip";

export type ComplianceRule =
  | "opt_out"
  | "ai_disclosure"
  | "stop_present"
  | "advertiser_identification"
  | "rate_limit"
  | "reply_volume"
  | "hours"
  | "bloctel"
  | "legitimate_interest"
  | "phone_validity";

/**
 * `humanReason` figées par code, JAMAIS interpolées avec données runtime.
 * Garantie anti-PII : si tu ajoutes une variable d'instance ici, c'est un
 * bug. Mets-la dans `failure.context` à la place.
 */
export const HUMAN_REASONS: Record<ComplianceFailCode, string> = {
  opted_out: "Contact a explicitement opté-out",
  ai_disclosure_missing: "Annonce IA absente du premier SMS (AI Act art. 50)",
  stop_optout_missing: "Mot-clé STOP absent du SMS sortant (L.34-5 CPCE)",
  advertiser_identification_missing:
    'Identification de l\'annonceur "Médéré" absente du SMS (L.34-5 al. 5 CPCE)',
  // ⚠️ Littéral figé (invariant anti-PII `HUMAN_REASONS` : jamais de
  // template string). Sa cohérence avec `RATE_LIMIT_MAX_MESSAGES` /
  // `RATE_LIMIT_WINDOW_DAYS` est verrouillée par une sentinelle de test
  // dans `pre-send-check.test.ts` — si tu changes la constante sans le
  // texte, le test casse.
  rate_limit_exceeded: "Plafond 4 sollicitations sur 30 jours atteint",
  // Disjoncteur de SÉCURITÉ, pas le plafond légal — cf. `reply-volume.ts`.
  // Littéral figé (invariant anti-PII `HUMAN_REASONS`) ; cohérence avec
  // les constantes verrouillée par sentinelle dans `pre-send-check.test.ts`.
  reply_volume_exceeded: "Plafond 10 réponses sur 24 heures atteint (anti-emballement)",
  outside_hours: "Hors plage L-V 10-13h / 14-20h (Europe/Paris)",
  saturday_out_of_range: "Hors plage samedi 10-13h (Europe/Paris)",
  sunday: "Envoi interdit le dimanche",
  holiday: "Envoi interdit les jours fériés FR",
  holidays_not_verified: "Liste des jours fériés non vérifiée pour cette année (fail-safe)",
  bloctel_not_checked: "Vérification Bloctel manquante ou incohérente",
  bloctel_opted_out: "Numéro inscrit sur la liste Bloctel",
  bloctel_check_expired: "Vérification Bloctel expirée (>30 jours)",
  legitimate_interest_undocumented: "Intérêt légitime non documenté (min 20 caractères)",
  phone_invalid: "Numéro de téléphone invalide",
  phone_voip: "Numéro VoIP refusé (carrier non identifié)",
};

// ─────────────────────────────────────────────────────────────────────────────
// Discriminated union FERMÉE — `failure.context` typé par variante
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Une variante par `code`. Chaque variante liste explicitement les clés
 * autorisées dans son `context`. Type-level lock anti-PII : impossible
 * d'ajouter `context.phone` ou `context.firstName` sans modifier l'union.
 */
export type ComplianceFailure =
  | {
      code: "opted_out";
      rule: "opt_out";
      humanReason: string;
      context: Record<string, never>;
    }
  | {
      code: "ai_disclosure_missing";
      rule: "ai_disclosure";
      humanReason: string;
      context: Record<string, never>;
    }
  | {
      code: "stop_optout_missing";
      rule: "stop_present";
      humanReason: string;
      context: Record<string, never>;
    }
  | {
      code: "advertiser_identification_missing";
      rule: "advertiser_identification";
      humanReason: string;
      context: Record<string, never>;
    }
  | {
      code: "rate_limit_exceeded";
      rule: "rate_limit";
      humanReason: string;
      /**
       * `solicitationCount` = ce qui compte contre le plafond.
       * `totalOutboundCount` = tous les sortants de la fenêtre, réponses
       * comprises. L'écart est la preuve L.34-5 (cf. site de construction).
       */
      context: {
        solicitationCount: number;
        totalOutboundCount: number;
        maxAllowed: number;
        windowDays: number;
      };
    }
  | {
      code: "reply_volume_exceeded";
      rule: "reply_volume";
      humanReason: string;
      /**
       * `replyCount` = réponses dans la fenêtre 24 h (ce qui déclenche le
       * disjoncteur). `totalOutboundCount` = tous les sortants de cette
       * même fenêtre. L'écart documente l'ampleur de l'emballement.
       * 4 entiers, aucune PII possible.
       */
      context: {
        replyCount: number;
        totalOutboundCount: number;
        maxAllowed: number;
        windowHours: number;
      };
    }
  | {
      code: "outside_hours";
      rule: "hours";
      humanReason: string;
      context: { hour: number; minute: number; weekday: number };
    }
  | {
      code: "saturday_out_of_range";
      rule: "hours";
      humanReason: string;
      context: { hour: number; minute: number };
    }
  | {
      code: "sunday";
      rule: "hours";
      humanReason: string;
      context: Record<string, never>;
    }
  | {
      code: "holiday";
      rule: "hours";
      humanReason: string;
      context: { isoDate: string };
    }
  | {
      code: "holidays_not_verified";
      rule: "hours";
      humanReason: string;
      context: { year: number; maxVerified: number };
    }
  | {
      code: "bloctel_not_checked";
      rule: "bloctel";
      humanReason: string;
      context: Record<string, never>;
    }
  | {
      code: "bloctel_opted_out";
      rule: "bloctel";
      humanReason: string;
      context: Record<string, never>;
    }
  | {
      code: "bloctel_check_expired";
      rule: "bloctel";
      humanReason: string;
      context: { daysSinceCheck: number };
    }
  | {
      code: "legitimate_interest_undocumented";
      rule: "legitimate_interest";
      humanReason: string;
      context: { documentedLength: number; minLength: number };
    }
  | {
      code: "phone_invalid";
      rule: "phone_validity";
      humanReason: string;
      context: Record<string, never>;
    }
  | {
      code: "phone_voip";
      rule: "phone_validity";
      humanReason: string;
      context: Record<string, never>;
    };

export type PreSendCheckResult = { ok: true } | { ok: false; failure: ComplianceFailure };

// ─────────────────────────────────────────────────────────────────────────────
// Arguments et dépendances
// ─────────────────────────────────────────────────────────────────────────────

export interface PreSendCheckArgs {
  /** Contact destinataire (lu en amont par caller, ex: Firestore). */
  contact: Contact;
  /** Message SORTANT à envoyer. */
  message: string;
  /** Conversation ; seul `messageCount` est lu (0 = premier SMS). */
  conversation: Pick<Conversation, "messageCount">;
  /**
   * Historique des messages SORTANTS du contact, déjà filtré sur 30j si
   * possible (mais `canSendMessage` re-filtre par sécurité). Le typage
   * `OutboundMessageRecord[]` (S4) verrouille au compile-time qu'on ne
   * passe pas d'inbound.
   */
  recentOutboundMessages: OutboundMessageRecord[];
  /**
   * 🔒 REQUIS — nature du message qu'on s'apprête à envoyer.
   *
   * `preSendCheck` avait jusqu'ici le CORPS du message (`message`) mais
   * jamais sa NATURE. Il ne pouvait donc pas appliquer une règle « qui ne
   * concerne que les réponses ». Deux règles en dépendent désormais :
   *
   *   - règle 5 `rate_limit`   — ne bloque QUE les sollicitations
   *   - règle 6 `reply_volume` — ne bloque QUE les réponses
   *
   * Volontairement NON optionnel et sans défaut : c'est le caller qui
   * sait s'il envoie une sollicitation (1er SMS, relance) ou une réponse.
   * Un défaut implicite ferait qu'un futur chemin d'envoi hériterait
   * silencieusement d'un régime de plafond qu'il n'a pas choisi.
   *
   * Cf. `MessageOutboundKind` pour la sémantique complète.
   */
  outboundKind: MessageOutboundKind;
  /** Référence temporelle (défaut `new Date()`). Injection tests. */
  now?: Date;
}

/**
 * Injection optionnelle des dépendances pour tests court-circuit. En
 * production, ne pas fournir — les vraies implémentations S4 sont utilisées.
 *
 * @internal Public uniquement pour le testing — ne pas utiliser ailleurs.
 */
export interface PreSendCheckDeps {
  hasAIDisclosure?: (message: string) => boolean;
  hasOptOut?: (message: string) => boolean;
  hasAdvertiserIdentification?: (message: string) => boolean;
  canSendMessage?: (msgs: OutboundMessageRecord[], now?: Date) => ComplianceCheckResult;
  canSendReplyVolume?: (msgs: OutboundMessageRecord[], now?: Date) => ComplianceCheckResult;
  isAllowedSendTime?: (date?: Date) => ComplianceCheckResult;
  canSendB2C?: (contact: Contact, now?: Date) => ComplianceCheckResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers internes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mini-extracteur de l'heure de Paris depuis un `Date`. Duplique la
 * timezone conversion de `hours.ts` (PAS la business logic) pour
 * fournir un `context` typé aux failures liées aux heures, sans devoir
 * exporter `toParisTime` depuis S4.
 */
function parisTime(date: Date): {
  isoDate: string;
  year: number;
  weekday: number;
  hour: number;
  minute: number;
} {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string): string => {
    const v = parts.find((p) => p.type === type)?.value;
    /* v8 ignore start */
    if (v === undefined) {
      throw new Error(`Intl part missing: ${type}`);
    }
    /* v8 ignore stop */
    return v;
  };
  const year = Number.parseInt(get("year"), 10);
  const month = Number.parseInt(get("month"), 10);
  const day = Number.parseInt(get("day"), 10);
  const hour = Number.parseInt(get("hour"), 10);
  const minute = Number.parseInt(get("minute"), 10);
  const local = new Date(year, month - 1, day);
  return {
    isoDate: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    year,
    weekday: local.getDay(),
    hour,
    minute,
  };
}

/** Calcule les jours écoulés depuis `bloctelCheckedAt` (Timestamp ou Date).
 *  Le filet `!bloctelCheckedAt → -1` est défensif : il n'est jamais
 *  emprunté par le chemin normal (on n'arrive ici que via la classification
 *  "expired" qui implique `bloctelCheckedAt` présent). Ignoré du coverage. */
function bloctelDaysSinceCheck(contact: Contact, now: Date): number {
  /* v8 ignore next */
  if (!contact.bloctelCheckedAt) return -1;
  const dt =
    contact.bloctelCheckedAt instanceof Date
      ? contact.bloctelCheckedAt
      : contact.bloctelCheckedAt.toDate();
  return differenceInDays(now, dt);
}

/**
 * Classifie une failure de `isAllowedSendTime` en code typé + context.
 * Fait du `startsWith` sur les prefixes de `hours.ts`. Si tu modifies
 * `hours.ts`, mets à jour ces prefixes + leurs tests.
 */
function classifyHoursFailure(
  reason: string,
  now: Date,
): Extract<
  ComplianceFailure,
  {
    rule: "hours";
  }
> {
  const paris = parisTime(now);

  if (reason.startsWith("holidays_not_verified_after_")) {
    return {
      code: "holidays_not_verified",
      rule: "hours",
      humanReason: HUMAN_REASONS.holidays_not_verified,
      context: { year: paris.year, maxVerified: MAX_VERIFIED_HOLIDAYS_YEAR },
    };
  }
  if (reason.startsWith("Jour férié FR")) {
    return {
      code: "holiday",
      rule: "hours",
      humanReason: HUMAN_REASONS.holiday,
      context: { isoDate: paris.isoDate },
    };
  }
  if (reason.startsWith("Dimanche")) {
    return {
      code: "sunday",
      rule: "hours",
      humanReason: HUMAN_REASONS.sunday,
      context: {},
    };
  }
  if (reason.startsWith("Samedi")) {
    return {
      code: "saturday_out_of_range",
      rule: "hours",
      humanReason: HUMAN_REASONS.saturday_out_of_range,
      context: { hour: paris.hour, minute: paris.minute },
    };
  }
  // Défaut : L-V hors plage.
  return {
    code: "outside_hours",
    rule: "hours",
    humanReason: HUMAN_REASONS.outside_hours,
    context: { hour: paris.hour, minute: paris.minute, weekday: paris.weekday },
  };
}

/** Classifie une failure de `canSendB2C` (S5) en code typé + context. */
function classifyBloctelFailure(
  reason: string,
  contact: Contact,
  now: Date,
): Extract<ComplianceFailure, { rule: "bloctel" }> {
  if (reason === BLOCTEL_REASONS.notChecked || reason === BLOCTEL_REASONS.missingTimestamp) {
    return {
      code: "bloctel_not_checked",
      rule: "bloctel",
      humanReason: HUMAN_REASONS.bloctel_not_checked,
      context: {},
    };
  }
  if (reason === BLOCTEL_REASONS.optedOut) {
    return {
      code: "bloctel_opted_out",
      rule: "bloctel",
      humanReason: HUMAN_REASONS.bloctel_opted_out,
      context: {},
    };
  }
  // Default : expired
  return {
    code: "bloctel_check_expired",
    rule: "bloctel",
    humanReason: HUMAN_REASONS.bloctel_check_expired,
    context: { daysSinceCheck: bloctelDaysSinceCheck(contact, now) },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrateur principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vérifie les 9 règles compliance avant tout envoi. Renvoie soit `{ ok: true }`
 * (autorisé), soit `{ ok: false, failure }` avec une `ComplianceFailure`
 * typée (code, rule, humanReason constante, context structuré sans PII).
 *
 * Cf. JSDoc en tête de fichier pour les invariants et responsabilités caller.
 */
export function preSendCheck(
  args: PreSendCheckArgs,
  deps: PreSendCheckDeps = {},
): PreSendCheckResult {
  const _hasAI = deps.hasAIDisclosure ?? hasAIDisclosure;
  const _hasOpt = deps.hasOptOut ?? hasOptOut;
  const _hasAdvertiser = deps.hasAdvertiserIdentification ?? hasAdvertiserIdentification;
  const _rate = deps.canSendMessage ?? canSendMessage;
  const _replyVolume = deps.canSendReplyVolume ?? canSendReplyVolume;
  const _hours = deps.isAllowedSendTime ?? isAllowedSendTime;
  const _bloctel = deps.canSendB2C ?? canSendB2C;
  const now = args.now ?? new Date();

  // ── 1. Opt-out — court-circuit immédiat ────────────────────────────────
  if (args.contact.consent.optedOut) {
    return {
      ok: false,
      failure: {
        code: "opted_out",
        rule: "opt_out",
        humanReason: HUMAN_REASONS.opted_out,
        context: {},
      },
    };
  }

  // ── 2. AI disclosure dans le premier SMS ───────────────────────────────
  if (args.conversation.messageCount === 0 && !_hasAI(args.message)) {
    return {
      ok: false,
      failure: {
        code: "ai_disclosure_missing",
        rule: "ai_disclosure",
        humanReason: HUMAN_REASONS.ai_disclosure_missing,
        context: {},
      },
    };
  }

  // ── 3. STOP dans le SMS sortant (TOUS les SMS) ─────────────────────────
  if (!_hasOpt(args.message)) {
    return {
      ok: false,
      failure: {
        code: "stop_optout_missing",
        rule: "stop_present",
        humanReason: HUMAN_REASONS.stop_optout_missing,
        context: {},
      },
    };
  }

  // ── 4. Identification annonceur "Médéré" (L.34-5 al. 5 CPCE) ───────────
  if (!_hasAdvertiser(args.message)) {
    return {
      ok: false,
      failure: {
        code: "advertiser_identification_missing",
        rule: "advertiser_identification",
        humanReason: HUMAN_REASONS.advertiser_identification_missing,
        context: {},
      },
    };
  }

  // ── 5. Rate-limit LÉGAL — 4 sollicitations / 30 jours ──────────────────
  //
  // 🔒 NE BLOQUE QUE LES SOLLICITATIONS (PR-BARRIERE-2, décision d).
  //
  // Avant : `canSendMessage` comptait les sollicitations passées et
  // refusait TOUT envoi au-delà de 4 — y compris une RÉPONSE. Un PS ayant
  // reçu 4 sollicitations puis écrivant se voyait donc refuser la réponse,
  // ce qui contredisait la promesse de PR-FILTRE-SOLLICITATION (« une
  // conversation engagée peut avoir 10+ réponses sans bloquer ») : elle
  // n'était vraie que tant que le quota de sollicitations n'était pas
  // saturé.
  //
  // L.34-5 CPCE encadre la PROSPECTION. Refuser de répondre à quelqu'un
  // qui nous écrit n'est requis par aucun texte — c'était un effet de bord
  // d'un compteur aveugle au message sortant. Le volume des réponses est
  // désormais encadré par la règle 6, qui est faite pour ça.
  //
  // Le comptage lui-même est INCHANGÉ (`canSendMessage` n'est pas touché,
  // ses tests non plus) : seule l'APPLICATION du verdict est conditionnée.
  const rateResult = _rate(args.recentOutboundMessages, now);
  if (countsAgainstCap({ outboundKind: args.outboundKind }) && !rateResult.allowed) {
    return {
      ok: false,
      failure: {
        code: "rate_limit_exceeded",
        rule: "rate_limit",
        humanReason: HUMAN_REASONS.rate_limit_exceeded,
        // 🔒 PREUVE L.34-5 CPCE — l'écart entre les deux compteurs EST
        // l'argument opposable à un contrôle : « 4 sollicitations sur 14
        // messages sortants ». Sans `totalOutboundCount`, un auditeur
        // externe ne peut pas distinguer un plafond respecté d'un
        // sous-comptage. Calculé par `countSolicitationsInWindow`, la
        // MÊME fonction que celle qui a pris la décision — pas de
        // recalcul divergent possible.
        // Aucun champ PII : 4 entiers.
        context: {
          ...countSolicitationsInWindow(args.recentOutboundMessages, now),
          maxAllowed: RATE_LIMIT_MAX_MESSAGES,
          windowDays: RATE_LIMIT_WINDOW_DAYS,
        },
      },
    };
  }

  // ── 6. Volume de réponses — 10 / 24h (DISJONCTEUR, pas légal) ──────────
  //
  // 🔒 NE BLOQUE QUE LES RÉPONSES. Une sollicitation n'est JAMAIS refusée
  // par ce plafond, même sur un contact en plein emballement — les deux
  // régimes sont indépendants (cf. `reply-volume.ts`).
  //
  // Placée APRÈS la règle 5 : si les deux pouvaient tirer, c'est la règle
  // LÉGALE qui doit être reportée dans l'audit. En pratique elles sont
  // mutuellement exclusives depuis la décision (d) — l'une ne s'applique
  // qu'aux sollicitations, l'autre qu'aux réponses — mais l'ordre encode
  // la priorité pour quiconque modifierait ces conditions plus tard.
  const replyVolumeResult = _replyVolume(args.recentOutboundMessages, now);
  if (countsAsReply({ outboundKind: args.outboundKind }) && !replyVolumeResult.allowed) {
    return {
      ok: false,
      failure: {
        code: "reply_volume_exceeded",
        rule: "reply_volume",
        humanReason: HUMAN_REASONS.reply_volume_exceeded,
        // Calculé par `countReplyVolumeInWindow`, la MÊME fonction que
        // celle qui a pris la décision — pas de recalcul divergent.
        // Aucun champ PII : 4 entiers.
        context: {
          ...countReplyVolumeInWindow(args.recentOutboundMessages, now),
          maxAllowed: REPLY_VOLUME_MAX,
          windowHours: REPLY_VOLUME_WINDOW_HOURS,
        },
      },
    };
  }

  // ── 7. Plages horaires ─────────────────────────────────────────────────
  const hoursResult = _hours(now);
  if (!hoursResult.allowed) {
    return {
      ok: false,
      failure: classifyHoursFailure(hoursResult.reason ?? "", now),
    };
  }

  // ── 7. Bloctel ─────────────────────────────────────────────────────────
  const bloctelResult = _bloctel(args.contact, now);
  if (!bloctelResult.allowed) {
    return {
      ok: false,
      failure: classifyBloctelFailure(bloctelResult.reason ?? "", args.contact, now),
    };
  }

  // ── 8. Intérêt légitime documenté (min 20 chars, inclusif) ─────────────
  // `legitimateInterest` est typé `string` (S1) → toujours présent. Pas de
  // garde `?? 0` qui serait inatteignable.
  const li = args.contact.consent.legitimateInterest;
  if (li.length < 20) {
    return {
      ok: false,
      failure: {
        code: "legitimate_interest_undocumented",
        rule: "legitimate_interest",
        humanReason: HUMAN_REASONS.legitimate_interest_undocumented,
        context: { documentedLength: li.length, minLength: 20 },
      },
    };
  }

  // ── 9. Téléphone valide + non VoIP ─────────────────────────────────────
  if (!args.contact.phone.valid) {
    return {
      ok: false,
      failure: {
        code: "phone_invalid",
        rule: "phone_validity",
        humanReason: HUMAN_REASONS.phone_invalid,
        context: {},
      },
    };
  }
  if (args.contact.phone.type === "voip") {
    return {
      ok: false,
      failure: {
        code: "phone_voip",
        rule: "phone_validity",
        humanReason: HUMAN_REASONS.phone_voip,
        context: {},
      },
    };
  }

  return { ok: true };
}
