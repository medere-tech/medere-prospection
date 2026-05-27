---
name: medere-claude-prompts
description: Bonnes pratiques pour les prompts Claude utilisés dans la prospection SMS Médéré. Applique le style Gary Bencivenga (clarté, preuve, accroche, naturel) adapté à un contexte médical professionnel français. À utiliser lors de la création ou modification d'un prompt dans src/lib/claude/prompts/, lors de l'ajout d'une nouvelle version de prompt, ou lors de l'analyse d'une mauvaise sortie LLM. Trigger sur les mots "prompt", "first-sms", "classify-intent", "reply", "Claude Sonnet", "Anthropic", "génération SMS", "style Bencivenga", "ton de message".
allowed-tools: Read, Edit, Write, Grep, Glob
---

# Médéré Claude Prompts — Bonnes pratiques

Cette skill code les conventions de prompts du projet. Les commerciaux et les PS jugent l'IA sur la qualité de ses messages. Un prompt mal calibré = lead perdu + image dégradée.

## Philosophie : style Gary Bencivenga adapté

Gary Bencivenga est considéré comme le plus grand copywriter du 20e siècle. Ses 6 principes traduits en règles concrètes pour notre contexte SMS médical FR :

| Principe Bencivenga | Application Médéré SMS |
|---|---|
| **Clarté** | Compréhensible en 3 secondes par un médecin entre deux consultations |
| **Preuve > promesse** | Chiffres concrets (660€ indemnisation, 30 min de formation) plutôt que "incroyable formation" |
| **Empathie** | Parle au médecin occupé qui a 500 patients, pas à une "cible marketing" |
| **Naturel** | Ton conversationnel professionnel, pas robotique |
| **Un message, un objectif** | UNE seule question, UNE seule offre, UNE seule action |
| **Accroche qui arrête** | Le premier mot doit retenir l'attention (le prénom, généralement) |

## Règles d'écriture absolues

### Toujours

- **Vouvoiement** : les PS sont des professionnels, jamais de tutoiement
- **Annonce IA en intro** : "Bonjour Dr X, Léa, assistante IA de Médéré"
- **Personnalisation factuelle** : prénom + spécialité + ville si pertinent
- **Une seule question** par message
- **Opt-out STOP** en fin de message
- **Max 160 caractères** pour le SMS standard (au-delà = 2 SMS facturés)
- **Sources de chiffres** : ANDPC pour les indemnisations, durée officielle des formations
- **Français impeccable** : pas de fautes, pas d'anglicismes inutiles

### Jamais

- ❌ Émojis (impro pour un contexte médical pro)
- ❌ Superlatifs vides ("incroyable", "révolutionnaire", "exceptionnel")
- ❌ Promesses non vérifiables ("vous allez doubler votre clientèle")
- ❌ Urgence artificielle ("plus que 24h !", "dernière chance")
- ❌ MAJUSCULES intempestives (jamais plus d'un mot en majuscules dans un SMS)
- ❌ Points d'exclamation multiples ("!!!")
- ❌ Anglicismes ("DPC training", "online" → préférer "e-learning")
- ❌ Tutoiement
- ❌ Diminutifs du prénom non confirmés ("Bonjour Cathy" si le prénom est Catherine)
- ❌ Conseil médical ("traitez vos patients avec X")
- ❌ Mensonges, même "véniels" ("votre confrère le Dr Y a déjà suivi" si pas vrai)

## Structure XML obligatoire des prompts

Tous les prompts dans `src/lib/claude/prompts/` suivent cette structure (best practice Anthropic) :

```xml
<role>
[Qui est Claude dans ce contexte : "Tu es Léa, assistante IA de Médéré"]
</role>

<contexte>
[Contexte business : Médéré, DPC, ANDPC, etc.]
</contexte>

<destinataire>
[Données dynamiques sur le PS]
</destinataire>

<historique_conversation>
[Optionnel : messages précédents si applicable]
</historique_conversation>

<offre>
[Description de la formation/offre à pousser]
</offre>

<instructions>
[Étapes à suivre, contraintes, ce qu'il faut faire]
</instructions>

<contraintes>
[Ce qu'il NE FAUT PAS faire — souvent plus important que les instructions]
</contraintes>

<format_de_sortie>
[Format exact attendu, ex: balises XML, JSON strict]
</format_de_sortie>

<exemples>
[2-3 exemples de bonnes sorties — few-shot prompting]
</exemples>
```

## Modèle de prompt — Génération du premier SMS

```typescript
// src/lib/claude/prompts/first-sms.ts

export const FIRST_SMS_PROMPT_V1 = {
  version: '1.0.0',
  model: 'claude-sonnet-4-6',
  temperature: 0.7,  // Un peu de créativité pour varier les formulations
  maxTokens: 300,
  
  build: (params: FirstSmsParams) => `
<role>
Tu es Léa, l'assistante IA de Médéré, organisme de formation médicale et dentaire certifié DPC. Tu rédiges un premier SMS de prise de contact avec un professionnel de santé.
</role>

<contexte>
Médéré est un organisme de formation DPC (Développement Professionnel Continu) reconnu par l'ANDPC.
- Formations en e-learning, classes virtuelles Zoom, ou présentiel à Paris
- Prise en charge ANDPC : formations gratuites pour les PS éligibles
- Indemnisation possible jusqu'à 660€/an
- Public : médecins généralistes, chirurgiens-dentistes, IDE
</contexte>

<destinataire>
Civilité : ${params.civilite ?? 'Dr'}
Prénom : ${params.firstName}
Nom : ${params.lastName}
Spécialité : ${params.speciality}
Ville : ${params.city}
</destinataire>

<offre>
${params.offerDescription}
</offre>

<instructions>
Rédige un SMS court (MAX 160 caractères, ce qui correspond à 1 SMS standard) qui :
1. Salue avec "Bonjour Dr [Nom]" (vouvoiement obligatoire)
2. T'identifie comme IA : "Léa, assistante IA de Médéré" (obligation légale AI Act)
3. Présente UNE valeur concrète et chiffrée (pas "incroyable formation", mais "formation de 7h indemnisée 660€")
4. Pose UNE question simple qui invite à répondre par OUI, par une question, ou par STOP
5. Termine par "STOP pour ne plus recevoir" (opt-out RGPD)

Style à respecter :
- Vouvoiement obligatoire
- Naturel, comme un message professionnel court
- Pas d'émojis, pas de superlatifs, pas de point d'exclamation
- Si tu mentions un chiffre, qu'il soit exact et sourcé
</instructions>

<contraintes>
- INTERDIT : émojis, superlatifs ("incroyable", "exceptionnel"), urgence artificielle, anglicismes
- INTERDIT : tutoiement
- INTERDIT : conseil médical ou recommandation thérapeutique
- INTERDIT : mensonge ou promesse non vérifiable
- INTERDIT : MAJUSCULES (sauf "STOP")
- INTERDIT : dépasser 160 caractères
</contraintes>

<format_de_sortie>
Réponds STRICTEMENT dans ce format XML, sans markdown :

<sms>
[Le texte exact du SMS, exactement comme il sera envoyé. Compte les caractères : doit être ≤ 160.]
</sms>

<character_count>
[Le nombre exact de caractères du SMS]
</character_count>

<reasoning>
[En 1-2 phrases : pourquoi cette formulation a été choisie pour ce PS spécifique]
</reasoning>
</format_de_sortie>

<exemples>
Exemple 1 (cible : Dr Martin Dupuis, chirurgien-dentiste à Lyon, formation parodontie) :
<sms>
Bonjour Dr Dupuis, Léa, assistante IA de Médéré. Formation parodontie 100% prise en charge ANDPC + 220€ indemnisés. Intéressé ? STOP pour arrêter.
</sms>
<character_count>153</character_count>
<reasoning>Mention chiffrée concrète (220€), question fermée simple, opt-out clair. Pas d'urgence artificielle.</reasoning>

Exemple 2 (cible : Dr Sophie Levy, médecin généraliste à Paris, formation troubles du sommeil enfant) :
<sms>
Bonjour Dr Levy, Léa, assistante IA Médéré. Formation "Troubles du sommeil enfant" en e-learning 7h, gratuite ANDPC. Vous souhaitez le programme ? STOP.
</sms>
<character_count>156</character_count>
<reasoning>Titre exact de la formation cité, durée précisée, question d'engagement faible (envoyer le programme), opt-out concis.</reasoning>
</exemples>
`.trim(),
};
```

## Modèle de prompt — Classification d'intent

```typescript
// src/lib/claude/prompts/classify-intent.ts

export const CLASSIFY_INTENT_PROMPT_V1 = {
  version: '1.0.0',
  model: 'claude-sonnet-4-6',
  temperature: 0,  // Déterministe pour la classification
  maxTokens: 200,
  
  build: (params: ClassifyParams) => `
<role>
Tu es un classifieur d'intent expert pour des conversations SMS commerciales en français.
</role>

<contexte>
Médéré, organisme de formation DPC, prospecte des professionnels de santé.
Le PS a reçu un premier SMS et vient de répondre. Tu dois classifier sa réponse.
</contexte>

<historique>
${params.history.map(m => `[${m.direction}] ${m.body}`).join('\n')}
</historique>

<derniere_reponse_ps>
${params.lastReply}
</derniere_reponse_ps>

<instructions>
Classifie la dernière réponse du PS dans EXACTEMENT une de ces 4 catégories :

- **INTERESSE** : le PS exprime un intérêt clair
  Signaux : questions sur la formation, "oui", "ok envoyez", "comment ça marche", demande d'infos, demande à être rappelé

- **NEUTRE** : réponse ambiguë ou hors-sujet
  Signaux : "?", question hors-sujet, simple accusé de réception, "je vais voir"

- **OBJECTION** : doute, réserve ou refus poli SANS opt-out explicite
  Signaux : "c'est cher ?", "je n'ai pas le temps", "pas maintenant", "déjà inscrit ailleurs", "je préfère par email"

- **STOP** : demande d'arrêt explicite ou hostilité
  Signaux : "STOP" (seul ou dans phrase courte), "ne plus me contacter", "désinscription", insultes, ton hostile
</instructions>

<contraintes>
- En cas de doute entre INTERESSE et NEUTRE → choisir NEUTRE (plus prudent)
- En cas de doute entre STOP et OBJECTION → choisir STOP (par précaution juridique)
- "STOP" en majuscules ou seul → TOUJOURS STOP, sans exception
- Une insulte ou un ton clairement hostile → TOUJOURS STOP
- "Non merci" → OBJECTION (refus poli sans opt-out explicite)
- "Désolé pas intéressé" → OBJECTION
- "Arrêtez de me contacter" → STOP
</contraintes>

<format_de_sortie>
Réponds STRICTEMENT en JSON valide, sans markdown, sans backticks :

{
  "intent": "INTERESSE" | "NEUTRE" | "OBJECTION" | "STOP",
  "confidence": <nombre entre 0 et 1, ex: 0.95>,
  "reasoning": "<1 phrase d'explication factuelle>",
  "suggestedAction": "handoff" | "send_reply" | "wait" | "blacklist"
}
</format_de_sortie>

<exemples>
Réponse PS : "Oui ça m'intéresse, comment faire ?"
{"intent": "INTERESSE", "confidence": 0.98, "reasoning": "Confirmation explicite + demande d'info active", "suggestedAction": "handoff"}

Réponse PS : "STOP"
{"intent": "STOP", "confidence": 1.0, "reasoning": "Opt-out explicite", "suggestedAction": "blacklist"}

Réponse PS : "C'est combien ?"
{"intent": "INTERESSE", "confidence": 0.75, "reasoning": "Question sur le prix indique engagement initial", "suggestedAction": "send_reply"}

Réponse PS : "Je préfère pas merci"
{"intent": "OBJECTION", "confidence": 0.85, "reasoning": "Refus poli sans demande d'opt-out formelle", "suggestedAction": "wait"}

Réponse PS : "Foutez moi la paix"
{"intent": "STOP", "confidence": 0.95, "reasoning": "Hostilité claire", "suggestedAction": "blacklist"}
</exemples>
`.trim(),
};
```

## Versioning des prompts

Chaque prompt a un numéro de version (semver : major.minor.patch). À chaque modification :

1. **Patch (1.0.0 → 1.0.1)** : correction mineure (typo, reformulation)
2. **Minor (1.0.0 → 1.1.0)** : ajout d'une instruction, nouveau few-shot
3. **Major (1.0.0 → 2.0.0)** : refonte significative, changement de structure

Chaque message envoyé stocke en Firestore la `aiPromptVersion` utilisée. En cas de problème, on peut tracer.

**Pour modifier un prompt en production** :
1. Créer la nouvelle version dans `prompts.ts`
2. NE PAS supprimer l'ancienne
3. A/B test : router 10% du trafic vers la nouvelle version pendant 48h
4. Comparer taux de réponse, intent positif, opt-out
5. Si meilleur → basculer 100% sur la nouvelle version
6. Si pire → rollback et analyser

## Validation post-génération

Après que Claude a généré un SMS, AVANT envoi, on valide :

```typescript
// src/lib/claude/validators.ts
export function validateGeneratedSms(
  sms: string,
  isFirstMessage: boolean
): { valid: true } | { valid: false; reasons: string[] } {
  const reasons: string[] = [];
  
  if (sms.length > 160) reasons.push(`Trop long : ${sms.length} chars`);
  if (sms.length < 50) reasons.push(`Trop court : ${sms.length} chars (probable erreur de génération)`);
  
  if (isFirstMessage && !hasAIDisclosure(sms)) {
    reasons.push('Annonce IA manquante dans le 1er SMS');
  }
  
  if (!hasOptOut(sms)) {
    reasons.push('Opt-out STOP manquant');
  }
  
  if (/!{2,}/.test(sms)) reasons.push('Points d\'exclamation multiples');
  if (/[\u{1F300}-\u{1FAFF}]/u.test(sms)) reasons.push('Émoji détecté');
  if (/\b(incroyable|exceptionnel|révolutionnaire|magique)\b/i.test(sms)) {
    reasons.push('Superlatif vide détecté');
  }
  if (/\btu(\s|t|m|l)/i.test(sms)) reasons.push('Tutoiement détecté');
  
  return reasons.length > 0 ? { valid: false, reasons } : { valid: true };
}
```

**Si la validation échoue** :
1. Logger l'échec avec le prompt + sortie générée
2. Re-générer 1 fois maximum avec un prompt enrichi : "Ta dernière sortie a échoué pour ces raisons : [reasons]. Régénère."
3. Si échec persiste après 1 retry, alerter via Slack et NE PAS envoyer

## Anti-patterns à proscrire

### ❌ Prompt trop vague
```
Génère un SMS pour vendre une formation à un médecin.
```

### ✅ Prompt structuré
```xml
<role>...</role>
<destinataire>...</destinataire>
<instructions>...</instructions>
<contraintes>...</contraintes>
<exemples>...</exemples>
```

### ❌ Pas d'exemples (zero-shot)
Pour les tâches commerciales sensibles, toujours fournir 2-3 exemples de bonne sortie (few-shot prompting).

### ❌ Format de sortie ambigu
"Donne-moi le SMS et une explication" → la sortie sera difficile à parser.

### ✅ Format strict
```xml
<sms>...</sms>
<reasoning>...</reasoning>
```
ou JSON strict avec schema Zod côté code pour parser.

### ❌ Mélange instructions et contexte
Tout en un seul bloc texte → Claude se perd.

### ✅ Sections XML séparées
Une section = une fonction = un nom de balise clair.

## Tests à écrire pour chaque prompt

```typescript
// tests/unit/claude/prompts/first-sms.test.ts
describe('FIRST_SMS_PROMPT_V1', () => {
  it('produit un SMS conforme pour un dentiste', async () => {
    const output = await runPrompt(FIRST_SMS_PROMPT_V1, mockDentistContact());
    
    expect(output.sms).toBeDefined();
    expect(output.sms.length).toBeLessThanOrEqual(160);
    expect(hasAIDisclosure(output.sms)).toBe(true);
    expect(hasOptOut(output.sms)).toBe(true);
    expect(output.sms).toContain('Dupuis');  // Nom personnalisé
    expect(output.sms).not.toMatch(/incroyable|exceptionnel/i);
  });
});
```

## En cas de mauvaise sortie en production

1. Récupérer le `aiPromptVersion` utilisé depuis le `messages` Firestore
2. Récupérer les variables passées au prompt (stockées dans `payload`)
3. Re-jouer en local avec le même prompt + variables
4. Identifier la cause :
   - Prompt trop vague ? → ajouter une contrainte explicite
   - Pas d'exemple pertinent ? → ajouter un few-shot
   - Mauvaise température ? → réduire (0 pour déterministe, 0.7 pour créatif)
   - Modèle inadapté ? → tester Opus pour ce cas
5. Créer une nouvelle version mineure ou patch
6. A/B tester

## Référence : prompts disponibles

| Prompt | Fichier | Modèle | Temp | Usage |
|---|---|---|---|---|
| `FIRST_SMS_PROMPT` | `first-sms.ts` | Sonnet 4.6 | 0.7 | Génération 1er SMS |
| `CLASSIFY_INTENT_PROMPT` | `classify-intent.ts` | Sonnet 4.6 | 0 | Classification réponse |
| `REPLY_PROMPT` | `reply.ts` | Sonnet 4.6 | 0.5 | Réponse aux objections/questions |
| `FOLLOWUP_PROMPT` | `followup.ts` | Sonnet 4.6 | 0.7 | Relance J+3, J+7 (angle différent) |
| `HANDOFF_SUMMARY_PROMPT` | `handoff-summary.ts` | Sonnet 4.6 | 0.3 | Résumé pour commercial |

Chaque fichier exporte UNE constante avec frontmatter `version`, `model`, `temperature`, `maxTokens`, et une fonction `build(params)` qui retourne le prompt complet.
