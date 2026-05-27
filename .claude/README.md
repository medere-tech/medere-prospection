# `.claude/` — Configuration Claude Code du projet Médéré

Ce dossier contient toute la configuration Claude Code spécifique au projet : skills, subagents, settings. Il est **versionné dans Git** pour que toute personne qui clone le repo et lance `claude` bénéficie de la même configuration.

## Structure

```
.claude/
├── README.md                              # Ce fichier
├── skills/                                # Modules d'expertise auto-déclenchés
│   ├── medere-sms-compliance/
│   │   └── SKILL.md
│   ├── medere-claude-prompts/
│   │   └── SKILL.md
│   ├── medere-firestore-schema/
│   │   └── SKILL.md
│   └── medere-ovh-sms/
│       └── SKILL.md
└── agents/                                # Subagents spécialisés invocables
    ├── security-reviewer.md
    ├── prompt-engineer.md
    ├── compliance-auditor.md
    └── ux-reviewer.md
```

## Comment ça fonctionne

### Skills (`.claude/skills/`)

Les skills sont des **modules d'expertise** que Claude Code charge automatiquement en fonction du contexte. Quand le contexte de la conversation matche la `description` de la skill (fuzzy matching), Claude charge le contenu complet de `SKILL.md` et l'utilise comme référence.

**Skills du projet** :

| Skill | Trigger automatique sur | Rôle |
|---|---|---|
| `medere-sms-compliance` | Code touchant SMS, opt-out, RGPD, AI Act, Bloctel | Vérifier conformité légale |
| `medere-claude-prompts` | Création/modification de prompts LLM | Bonnes pratiques style Bencivenga + XML structuré |
| `medere-firestore-schema` | Opérations Firestore (collections, queries) | Source de vérité du schéma |
| `medere-ovh-sms` | Code OVH SMS (envoi, webhook, parsing) | Intégration officielle OVH |

**Token cost** : ~100 tokens pour la description (toujours en contexte), puis ~3-5k tokens quand chargée. Donc seul ce qui est pertinent à la tâche en cours est en mémoire.

### Subagents (`.claude/agents/`)

Les subagents sont des **spécialistes invocables** qui tournent dans leur propre contexte isolé. Tu peux demander à Claude : *"Use the `security-reviewer` subagent to review this file"* et il spawne une instance dédiée qui fait le job et te ramène un rapport.

**Subagents du projet** :

| Subagent | Model | Quand l'invoquer |
|---|---|---|
| `security-reviewer` | opus | Avant tout merge en main, après modif des webhooks/auth/env/firestore |
| `prompt-engineer` | sonnet | Création/révision de prompt LLM, debug mauvaise sortie |
| `compliance-auditor` | opus | Avant déploiement prod, après modif de `lib/compliance/` |
| `ux-reviewer` | sonnet | Après création/modif de composants React dashboard |

**Comment invoquer** :

```
> Use the security-reviewer subagent to review src/app/api/webhooks/ovh-sms/route.ts
> Use the compliance-auditor to audit the full project before we deploy
> Use the prompt-engineer to improve the first-sms prompt — taux de réponse trop bas
> Use the ux-reviewer on src/app/(dashboard)/conversations/[id]/page.tsx
```

Tu peux aussi laisser Claude décider lui-même quand invoquer un subagent en se basant sur la `description`.

## Premier prompt à donner à Claude Code

Après avoir cloné le repo et lancé `claude` dans le dossier, copie-colle ce prompt :

```
Lis intégralement les fichiers suivants dans cet ordre :
1. CLAUDE.md
2. README.md
3. SYNTHESE.md
4. .claude/README.md (ce fichier)
5. La structure du dossier src/ (s'il existe)

Liste-moi en 5 lignes ce que tu as compris du projet.
Liste-moi les skills disponibles dans .claude/skills/ et explique-moi en 1 ligne chacune.
Liste-moi les subagents disponibles dans .claude/agents/ et leur usage.

Ne code rien. Confirme juste que tu es prêt.
```

À partir de là, tu peux attaquer la roadmap d'implémentation (Phase 0 → Phase 7 dans le README).

## Comment modifier ou ajouter une skill / un subagent

### Ajouter une skill

1. Créer le dossier : `mkdir -p .claude/skills/<nom-skill>`
2. Créer le fichier `SKILL.md` avec frontmatter YAML obligatoire :
   ```yaml
   ---
   name: nom-skill
   description: Description précise et orientée trigger. Mots-clés qui doivent matcher le contexte.
   allowed-tools: Read, Edit, Write, Grep, Glob  # optionnel
   disable-model-invocation: false               # optionnel, true = uniquement manuel
   ---
   
   # Contenu en markdown
   ```
3. Commit + push. Claude Code la chargera automatiquement à la prochaine session.

**Conseil** : la `description` est CRITIQUE. C'est elle qui détermine si la skill se déclenche. Sois précis sur les triggers (mots-clés, contextes). Lead avec un verbe d'action ("Vérifie...", "Génère...", "Audit...").

### Ajouter un subagent

1. Créer le fichier : `.claude/agents/<nom-agent>.md`
2. Frontmatter :
   ```yaml
   ---
   name: nom-agent
   description: Quand utiliser ce subagent
   tools: Read, Grep, Glob, Bash  # optionnel, omettre = hérite de tous les tools
   model: opus | sonnet | haiku   # optionnel
   ---
   
   System prompt du subagent en markdown
   ```
3. Commit + push.

### Modifier une skill ou subagent existant

Édite simplement le fichier `.md` correspondant. Pas besoin de redémarrer Claude Code, les fichiers sont lus à chaque session.

## Bonnes pratiques

- **Garder les SKILL.md sous 5000 tokens** (sinon coût élevé en contexte). Si trop long, externaliser en `references/<topic>.md` et lier depuis SKILL.md.
- **Tester la description** : si une skill ne se déclenche jamais, sa `description` est probablement trop vague.
- **Versionner les changements importants** : si tu modifies une skill critique (compliance, security), commit séparément avec un message clair.
- **Ne pas dupliquer le contenu du CLAUDE.md** : le CLAUDE.md est chargé à chaque session, les skills en complément. Mets dans CLAUDE.md ce qui est UNIVERSEL au projet, dans les skills ce qui est SPÉCIFIQUE à un domaine.

## Référence Anthropic

- [Claude Code Skills docs](https://code.claude.com/docs/en/skills)
- [Subagents docs](https://code.claude.com/docs/en/sub-agents)
- [Skill frontmatter reference](https://code.claude.com/docs/en/skills#available-metadata-fields)

---

Owner : Déthié | Projet : Médéré Agent IA Prospection
