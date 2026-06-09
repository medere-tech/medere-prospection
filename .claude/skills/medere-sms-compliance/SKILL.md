---
name: medere-sms-compliance
description: Vérifie la conformité RGPD / AI Act / Bloctel / L.34-5 CPCE de tout envoi SMS dans le projet Médéré. À utiliser IMPÉRATIVEMENT avant l'envoi d'un SMS, lors de la création ou modification d'un endpoint qui envoie des SMS, d'une Inngest function qui appelle OVH, d'un prompt qui génère du contenu SMS, ou de toute logique liée aux consentements, opt-out, plafonds, et plages horaires. Trigger dès qu'apparaissent les mots "SMS", "OVH", "send-sms", "first-sms", "followup", "opt-out", "STOP", "Bloctel", "RGPD", "AI Act", "annonce IA", "consentement", "plage horaire".
allowed-tools: Read, Grep, Glob
---

# Médéré SMS Compliance — Règles non négociables

Cette skill est ta checklist juridique. Si tu génères du code qui envoie un SMS ou qui touche au consentement, tu DOIS valider chaque point ci-dessous avant de commit.

## Cadre légal applicable

| Texte | Échéance | Impact pour Médéré |
|---|---|---|
| RGPD | depuis mai 2018 | Intérêt légitime documenté en B2B, droit d'opposition, audit |
| L.34-5 CPCE | permanent | Règles spécifiques prospection électronique B2C |
| AI Act Article 50 | applicable 2 août 2026 | Annonce IA obligatoire en début d'interaction |
| Loi 30 juin 2025 | applicable 11 août 2026 | Bascule opt-in pour démarchage B2C |
| Bloctel | jusqu'au 11 août 2026 | Vérif obligatoire pour mobiles persos B2C |

## Les 9 règles non négociables

> **Note de structure** — Au sein de l'orchestrateur `preSendCheck`
> (`src/lib/compliance/pre-send-check.ts`), la règle ajoutée par GUARD-003
> (identification de l'annonceur "Médéré") est évaluée en **position 4**
> (après `stop_present`, avant `rate_limit`). La numérotation de cette skill
> suit l'organisation **par thème** (règles d'envoi 1-6 puis règles transverses
> 7-9), **pas l'ordre d'exécution** de l'orchestrateur. Pour la séquence
> exacte d'exécution, cf. le code example en fin de fichier (« Checklist
> avant chaque envoi »).

### Règle 1 — Annonce IA obligatoire dans le premier message

Tout premier SMS envoyé à un PS DOIT contenir une mention explicite de l'origine IA. Validation à effectuer côté code APRÈS la génération par Claude, AVANT l'envoi via OVH.

**Patterns acceptés** (regex insensible à la casse) :
- "assistant(e)? (virtuel(le)?|IA|intelligence artificielle)"
- "(je suis|c'est) Léa"
- "assistant(e)? automatisé(e)?"
- "agent (virtuel|IA)"

**Fichier de référence** : `src/lib/compliance/ai-disclosure.ts`

```typescript
const AI_DISCLOSURE_PATTERNS = [
  /assistant(e)?\s+(virtuel(le)?|IA|intelligence\s+artificielle)/i,
  /(je suis|c'est)\s+Léa/i,
  /assistant(e)?\s+automatisé(e)?/i,
  /agent\s+(virtuel|IA)/i,
];

export function hasAIDisclosure(message: string): boolean {
  return AI_DISCLOSURE_PATTERNS.some(p => p.test(message));
}
```

**Action si manquant** : refuser l'envoi, logger l'erreur, alerter via Slack `#alerts-tech`.

### Règle 2 — Opt-out "STOP" présent et fonctionnel

Tout SMS sortant DOIT contenir l'instruction "STOP" (en majuscules ou minuscules), idéalement en fin de message.

**Validation envoi sortant** :
```typescript
export function hasOptOut(message: string): boolean {
  return /\bSTOP\b/i.test(message);
}
```

**Validation réception entrante** : tout SMS entrant contenant "STOP" (seul ou dans un message court) déclenche un opt-out IMMÉDIAT et bloque tout envoi futur au numéro.

```typescript
const OPT_OUT_KEYWORDS = ['STOP', 'STOPP', 'ARRET', 'DESINSCRIPTION', 'UNSUB'];

export function isOptOut(incomingMessage: string): boolean {
  const normalized = incomingMessage.trim().toUpperCase();
  if (normalized.length > 50) return false;  // Trop long = probable conversation
  return OPT_OUT_KEYWORDS.some(kw => normalized.includes(kw));
}
```

**Action sur opt-out** :
1. Marquer le contact `optedOut: true` + `optedOutAt: Timestamp.now()` dans Firestore
2. Ajouter à la blackliste (collection `blacklist`)
3. Logger dans `audit_log`
4. AUCUN message de confirmation envoyé (sauf si explicitement demandé)

### Règle 3 — Plafond strict 3 SMS par contact sur 30 jours

Ne JAMAIS envoyer plus de 3 SMS au même contact dans une fenêtre glissante de 30 jours (loi française fixe la limite à 4/30j, on garde une marge de sécurité).

```typescript
import { differenceInDays } from 'date-fns';

export function canSendMessage(
  outboundMessages: { sentAt: Date }[]
): { allowed: boolean; reason?: string } {
  const now = new Date();
  const last30Days = outboundMessages.filter(
    m => differenceInDays(now, m.sentAt) <= 30
  );
  
  if (last30Days.length >= 3) {
    return {
      allowed: false,
      reason: `Plafond atteint : ${last30Days.length} SMS envoyés sur les 30 derniers jours`,
    };
  }
  
  return { allowed: true };
}
```

**À enforcer dans** : `src/inngest/functions/send-first-sms.ts`, `src/inngest/functions/schedule-followup.ts`, et tout endpoint d'envoi.

### Règle 4 — Plages horaires strictes

Envoi autorisé UNIQUEMENT :
- **Lundi à vendredi** : 10h00 - 13h00 et 14h00 - 20h00 (heure de Paris)
- **Samedi** : 10h00 - 13h00 (heure de Paris)
- **JAMAIS** le dimanche
- **JAMAIS** les jours fériés français

```typescript
import { isWeekend, getDay, getHours } from 'date-fns';
import { utcToZonedTime } from 'date-fns-tz';

const FRENCH_HOLIDAYS_2026 = [
  '2026-01-01', '2026-04-06', '2026-05-01', '2026-05-08',
  '2026-05-14', '2026-05-25', '2026-07-14', '2026-08-15',
  '2026-11-01', '2026-11-11', '2026-12-25',
];

export function isAllowedSendTime(date: Date = new Date()): boolean {
  const paris = utcToZonedTime(date, 'Europe/Paris');
  const dayOfWeek = getDay(paris); // 0 = dimanche
  const hour = getHours(paris);
  const dateStr = paris.toISOString().slice(0, 10);
  
  if (FRENCH_HOLIDAYS_2026.includes(dateStr)) return false;
  if (dayOfWeek === 0) return false;  // dimanche
  
  if (dayOfWeek === 6) {
    return hour >= 10 && hour < 13;  // samedi 10h-13h
  }
  
  // lundi-vendredi
  return (hour >= 10 && hour < 13) || (hour >= 14 && hour < 20);
}
```

**Si hors plage** : reschedule via Inngest `step.sleepUntil()` jusqu'à la prochaine fenêtre autorisée.

### Règle 5 — Vérification Bloctel pour mobiles persos B2C

Avant tout envoi à un numéro segmenté `b2c_mobile_perso`, le contact DOIT avoir `bloctelChecked: true` ET `bloctelOptOut: false`.

**Workflow Bloctel** :
1. Export mensuel des numéros B2C non vérifiés via `scripts/export-bloctel.ts`
2. Upload du fichier sur le portail Bloctel
3. Récupération du fichier filtré
4. Import retour : marquer chaque contact `bloctelChecked: true`, `bloctelOptOut: <true|false>`, `bloctelCheckedAt: Timestamp.now()`

**Important** : la vérification Bloctel a une durée de validité de 30 jours. Au-delà, il faut re-vérifier.

```typescript
import { differenceInDays } from 'date-fns';

export function canSendB2C(contact: Contact): { allowed: boolean; reason?: string } {
  if (contact.segment !== 'b2c_mobile_perso') {
    return { allowed: true };  // Pas concerné
  }
  
  if (!contact.bloctelChecked) {
    return { allowed: false, reason: 'Bloctel non vérifié' };
  }
  
  if (contact.bloctelOptOut) {
    return { allowed: false, reason: 'Inscrit Bloctel' };
  }
  
  const daysSinceCheck = differenceInDays(new Date(), contact.bloctelCheckedAt.toDate());
  if (daysSinceCheck > 30) {
    return { allowed: false, reason: 'Vérification Bloctel expirée (>30j)' };
  }
  
  return { allowed: true };
}
```

### Règle 6 — Documentation de l'intérêt légitime

Chaque contact DOIT avoir un champ `consent.legitimateInterest` rempli avec le texte qui documente pourquoi Médéré peut le contacter.

**Exemples valides** :
- "Ancien lead Médéré ayant téléchargé un livre blanc le [date]"
- "PS ayant participé au webinaire Médéré le [date]"
- "Contact issu de l'annuaire santé Ameli (données publiques RPPS)"
- "Contact achat conforme RGPD via [vendeur] le [date], opt-in attesté"

**Exemple INVALIDE** :
- "Contact base 26k"  (trop vague)
- "Prospect" (insuffisant)

Si le champ est vide ou trop vague, l'envoi DOIT être bloqué jusqu'à régularisation.

### Règle 7 — Conservation des données limitée

- **Contacts actifs** (en conversation ou récemment contactés) : illimité
- **Contacts opt-out** : conservation 3 ans pour preuve, puis suppression
- **Contacts inactifs** (jamais répondu) : conservation 3 ans max après dernier envoi, puis suppression
- **Messages** : 5 ans max
- **Audit logs** : 5 ans

**Job de purge** : `src/inngest/functions/archive-stale.ts` tourne 1x/jour et archive/supprime selon ces règles.

### Règle 8 — Audit log complet

Chaque action sensible DOIT être loggée dans la collection `audit_log` Firestore.

Actions à logger :
- `sms_sent` : envoi d'un SMS
- `sms_received` : réception d'un SMS
- `opt_out` : opt-out d'un contact
- `handoff` : hand-off vers commercial
- `manual_override` : intervention manuelle d'un admin
- `prompt_changed` : modification d'un prompt
- `bloctel_imported` : import du fichier Bloctel
- `contact_deleted` : suppression d'un contact (RGPD)

Format :
```typescript
await auditLog.create({
  actorId: 'system' | 'ai' | <slack_user_id>,
  action: 'sms_sent',
  targetType: 'message',
  targetId: messageId,
  payload: { /* contexte minimal, jamais de PII en clair */ },
  timestamp: Timestamp.now(),
});
```

### Règle 9 — Identification de l'annonceur "Médéré"

Tout SMS sortant DOIT contenir une mention reconnaissable de l'annonceur « Médéré » (le nom commercial sous lequel les communications sont émises). Validation à effectuer côté code APRÈS la génération par Claude, AVANT l'envoi via OVH.

**Fondement juridique principal** — article L.34-5 alinéa 5 du Code des postes et des communications électroniques (CPCE), version en vigueur depuis le **26 juillet 2020** (LOI n°2020-901 du 24 juillet 2020). Texte exact :

> « Il est également interdit de dissimuler l'identité de la personne pour le compte de laquelle la communication est émise et de mentionner un objet sans rapport avec la prestation ou le service proposé. »

**Doctrine consolidée** — CNIL, fiche « La prospection commerciale par SMS-MMS » :

> « Chaque message électronique doit obligatoirement préciser l'identité de l'annonceur. »

**Précédent** — sanction CNIL **SOLOCAL MARKETING SERVICES** du 15 mai 2025, amende de **900 000 €**, prononcée notamment pour démarchage SMS sans consentement valide et défaut d'identification claire de l'annonceur. La CNIL impose désormais aux routeurs/annonceurs un dispositif d'audit autonome de la traçabilité du consentement ET de l'identification.

**Contexte politique (PAS le fondement)** — la loi n° 2025-594 du 30 juin 2025 contre toutes les fraudes aux aides publiques (article 13) bascule le démarchage téléphonique VOIX B2C vers l'opt-in au 11 août 2026 et supprime Bloctel. Elle modifie L.223-1 du Code de la consommation, **PAS L.34-5 CPCE** — elle n'est donc PAS le fondement de cette règle. Elle motive seulement le timing de la mise en conformité Médéré anticipée (deadline interne 1er juillet 2026).

**Champ d'application** : B2C **ET** B2B. En B2B, l'intérêt légitime remplace l'opt-in préalable, mais l'identification de l'annonceur reste obligatoire dans chaque SMS sortant (la loi ne dispense personne d'identifier l'émetteur).

**Pattern de détection** (regex insensible à la casse, tolérant les variantes d'accent en GSM-7) :

```typescript
/** 🔒 SENTINEL GUARD-003 — modification interdite sans (a) Déthié,
 *  (b) compliance-auditor, (c) update Notion GUARD-003. */
export const ADVERTISER_PATTERN: RegExp = /m[ée]d[ée]r[ée]/i;

export function hasAdvertiserIdentification(message: string): boolean {
  return ADVERTISER_PATTERN.test(message);
}
```

Variantes **acceptées** : `Médéré`, `Medere`, `MEDERE`, `médéré`, `Médere`, `MédéRé` — toutes combinaisons {é,e}³ × casse libre.

Variantes **rejetées** (anti-typosquatting) : `Mederro`, `Medera`, `Médéro`, `Médecin`, `Modere`, `Méduse`.

**Fichier de référence** : `src/lib/compliance/advertiser-identification.ts`

**Tests sentinelles** (12 tests dans `advertiser-identification.test.ts`) :

| describe | Nombre | Exemples |
|---|---|---|
| `ADVERTISER_PATTERN — sentinelle GUARD-003` | 1 | `verrouille la source exacte du pattern (anti-drift)` — assert `source === "m[ée]d[ée]r[ée]"` + flag `"i"`. Modification du pattern → build cassé. |
| `variantes acceptées` | 4 | `forme canonique 'Médéré' → true`, `forme sans accent 'Medere' (strip GSM-7) → true` |
| `positions dans le body` | 2 | `mention en fin de message → true`, `mention en début de message → true` (loi n'impose pas de position) |
| `anti-typosquatting` | 3 | `rejette 'Mederro' → false`, `rejette 'Medera' → false`, `rejette 'Médéro' → false` |
| `robustesse linguistique` | 2 | `rejette 'Médecin' (mot du lexique médical) → false`, `rejette un body vide → false` |

**Position dans `preSendCheck`** : évaluée en **position 4** (après `stop_present`, avant `rate_limit`). Court-circuit immédiat si la mention est absente — les règles 5-9 (rate_limit, hours, bloctel, legitimate_interest, phone_validity) ne sont PAS évaluées.

**Sanctions** — article L.34-5 alinéa 8 CPCE :
- Personne physique : jusqu'à **75 000 €**
- Personne morale : jusqu'à **375 000 €**
- Cumul RGPD possible : jusqu'à **20 M€ ou 4 % du CA mondial** (CNIL).

**Action si manquant** : refuser l'envoi, logger l'erreur dans `audit_log` avec `action: 'compliance_check'`, `result: 'blocked'`, `code: 'advertiser_identification_missing'`, `rule: 'advertiser_identification'`, `context: {}`. Retourner au caller (Inngest function) qui décidera de regénérer le message via Claude ou de remonter l'erreur Slack.

## Checklist avant chaque envoi

Avant qu'une fonction n'appelle OVH pour envoyer un SMS, ces 9 vérifications passent obligatoirement :

```typescript
// src/lib/compliance/pre-send-check.ts (résumé pédagogique — voir le fichier
// source pour la JSDoc complète et les variantes typées de ComplianceFailure).
// Orchestrateur des 9 règles compliance — fonction PURE, court-circuit immédiat
// dès qu'une règle refuse. L'audit log est posé INCONDITIONNELLEMENT par le
// wrapper preSendCheckWithAudit (cf. src/lib/compliance/pre-send-check-with-audit.ts).

export type PreSendCheckResult =
  | { ok: true }
  | { ok: false; failure: ComplianceFailure };

export function preSendCheck(
  args: PreSendCheckArgs,
  deps: PreSendCheckDeps = {},
): PreSendCheckResult {
  // Injection optionnelle des règles (tests) — fallback impl prod en production.
  const _hasAI = deps.hasAIDisclosure ?? hasAIDisclosure;
  const _hasOpt = deps.hasOptOut ?? hasOptOut;
  const _hasAdvertiser = deps.hasAdvertiserIdentification ?? hasAdvertiserIdentification;
  const _rate = deps.canSendMessage ?? canSendMessage;
  const _hours = deps.isAllowedSendTime ?? isAllowedSendTime;
  const _bloctel = deps.canSendB2C ?? canSendB2C;
  const now = args.now ?? new Date();

  // ── 1. Opt-out — court-circuit immédiat si le PS a opté-out ──────────
  if (args.contact.consent.optedOut) {
    return { ok: false, failure: { code: "opted_out", rule: "opt_out", humanReason: HUMAN_REASONS.opted_out, context: {} } };
  }

  // ── 2. AI disclosure dans le 1er SMS (AI Act art. 50) ────────────────
  if (args.conversation.messageCount === 0 && !_hasAI(args.message)) {
    return { ok: false, failure: { code: "ai_disclosure_missing", rule: "ai_disclosure", humanReason: HUMAN_REASONS.ai_disclosure_missing, context: {} } };
  }

  // ── 3. STOP dans le SMS sortant (L.34-5 CPCE — TOUS les SMS) ─────────
  if (!_hasOpt(args.message)) {
    return { ok: false, failure: { code: "stop_optout_missing", rule: "stop_present", humanReason: HUMAN_REASONS.stop_optout_missing, context: {} } };
  }

  // ── 4. Identification annonceur "Médéré" (L.34-5 al. 5 CPCE — GUARD-003) ──
  if (!_hasAdvertiser(args.message)) {
    return { ok: false, failure: { code: "advertiser_identification_missing", rule: "advertiser_identification", humanReason: HUMAN_REASONS.advertiser_identification_missing, context: {} } };
  }

  // ── 5. Rate-limit 3 / 30 jours ───────────────────────────────────────
  if (!_rate(args.recentOutboundMessages, now).allowed) {
    return { ok: false, failure: { code: "rate_limit_exceeded", rule: "rate_limit", humanReason: HUMAN_REASONS.rate_limit_exceeded, context: { count: args.recentOutboundMessages.length, maxAllowed: 3, windowDays: 30 } } };
  }

  // ── 6. Plages horaires (Europe/Paris, L-V 10-13h / 14-20h, sam 10-13h) ──
  // Sous-codes typés selon reason : outside_hours / saturday_out_of_range
  // / sunday / holiday / holidays_not_verified (cf. classifyHoursFailure).
  const hoursResult = _hours(now);
  if (!hoursResult.allowed) {
    return { ok: false, failure: classifyHoursFailure(hoursResult.reason ?? "", now) };
  }

  // ── 7. Bloctel (segment b2c_mobile_perso uniquement) ─────────────────
  // Sous-codes : bloctel_not_checked / bloctel_opted_out / bloctel_check_expired.
  const bloctelResult = _bloctel(args.contact, now);
  if (!bloctelResult.allowed) {
    return { ok: false, failure: classifyBloctelFailure(bloctelResult.reason ?? "", args.contact, now) };
  }

  // ── 8. Intérêt légitime documenté (≥ 20 chars, inclusif) ─────────────
  const li = args.contact.consent.legitimateInterest;
  if (li.length < 20) {
    return { ok: false, failure: { code: "legitimate_interest_undocumented", rule: "legitimate_interest", humanReason: HUMAN_REASONS.legitimate_interest_undocumented, context: { documentedLength: li.length, minLength: 20 } } };
  }

  // ── 9. Téléphone valide + non VoIP ───────────────────────────────────
  if (!args.contact.phone.valid) {
    return { ok: false, failure: { code: "phone_invalid", rule: "phone_validity", humanReason: HUMAN_REASONS.phone_invalid, context: {} } };
  }
  if (args.contact.phone.type === "voip") {
    return { ok: false, failure: { code: "phone_voip", rule: "phone_validity", humanReason: HUMAN_REASONS.phone_voip, context: {} } };
  }

  return { ok: true };
}
```

**Si une vérification échoue** :
1. Logger dans `audit_log` avec `action: 'compliance_check'`, `payload: { result: 'blocked', code: failure.code, rule: failure.rule, context: failure.context }` (typé sans PII grâce à la discriminated union FERMÉE — cf. `pre-send-check-with-audit.ts`)
2. Passer le statut conversation à `blocked` avec `failure.code` + `failure.humanReason` (constante figée par `HUMAN_REASONS`, jamais d'interpolation runtime)
3. NE PAS envoyer le SMS
4. NE PAS retenter automatiquement (sauf si la failure est temporelle — `outside_hours` / `saturday_out_of_range` / `sunday` / `holiday` → reschedule via Inngest `step.sleepUntil()`, cf. `classifyHoursFailure`)

## Tests obligatoires

Le module `src/lib/compliance/` DOIT avoir **100% de couverture** (Vitest). Aucune ligne non testée. Chaque règle ci-dessus a son fichier de test dédié dans `tests/unit/compliance/`.

Exemple de test critique à toujours présent :

```typescript
describe('preSendCheck', () => {
  it('refuse l\'envoi si pas d\'annonce IA dans le 1er SMS', async () => {
    const result = await preSendCheck(
      mockContact(),
      'Bonjour Dr X, formation DPC gratuite. STOP pour arrêter.',
      mockConversation({ messageCount: 0 })
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('AI disclosure');
  });
});
```

## En cas de doute

1. NE PAS bypass la règle. La règle existe pour une raison juridique.
2. Demander à Déthié (Slack DM).
3. Si urgent : consulter la doc CNIL en ligne (lien dans le README).
4. Si très urgent : bloquer l'envoi par sécurité, on régularisera ensuite.

**Rappel** : sanctions financières en cas de violation :
- Jusqu'à 75 000 € (personne physique) / 375 000 € (personne morale) pour démarchage abusif
- Jusqu'à 20 M€ ou 4% du CA mondial (CNIL/RGPD)
- Jusqu'à 15 M€ ou 3% du CA mondial (AI Act)

Médéré ne survivrait pas à une de ces sanctions. La conformité n'est pas négociable.
