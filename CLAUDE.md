# CLAUDE.md — Médéré Prospection IA

> Ce fichier est chargé automatiquement par Claude Code à chaque session.
> Il doit rester concis et orienté action. Référence-toi au README.md pour le détail.

---

## Projet

**Agent IA hybride** qui prospecte 26k professionnels de santé via SMS, qualifie l'intérêt, et hand-off les leads chauds aux commerciaux via Slack + HubSpot.

**Owner** : Déthié (chef de projet IA Médéré)
**Sponsor** : Harry (direction)
**Phase actuelle** : MVP — 200 dentistes IDF, SMS uniquement

---

## Stack

- **Runtime** : Node.js 20 LTS
- **Framework** : Next.js 16 (App Router) + TypeScript strict
- **UI** : shadcn/ui + Tailwind v4 + TanStack Table v8 + Recharts 3
- **Auth dashboard** : Clerk (rôles : `admin`, `commercial`)
- **LLM** : Claude Sonnet 4.6 via `@anthropic-ai/sdk`
- **SMS** : OVHcloud SMS via `@ovhcloud/node-ovh`
- **Validation numéros** : Twilio Lookup v2
- **CRM** : HubSpot v3 via `@hubspot/api-client`
- **Enrichissement** : Lusha API v2
- **DB** : Firebase Firestore (Admin SDK côté serveur)
- **Jobs** : Inngest (background, retries, sleep)
- **Notif** : Slack Web API + signed webhooks
- **Logs** : Pino + Sentry
- **Rate limit** : Upstash Redis
- **Tests** : Vitest + Playwright

---

## Commandes essentielles

```bash
npm run dev              # Dev server (port 3000)
npm run build            # Build production
npm run start            # Start production build local
npm run lint             # ESLint + Prettier check
npm run lint:fix         # Auto-fix
npm run typecheck        # tsc --noEmit
npm test                 # Vitest unit + integration
npm run test:watch       # Vitest watch mode
npm run test:e2e         # Playwright
npm run test:coverage    # Couverture (vise >80%, 100% sur lib/compliance et lib/security)

# Firestore emulator pour tests
firebase emulators:start --only firestore

# Inngest local
npx inngest-cli@latest dev

# Déploiement
git push origin main     # → Vercel auto-deploy
```

---

## Structure du repo (essentiels)

```
src/
├── app/                          # Next.js App Router
│   ├── (dashboard)/              # Pages dashboard (Clerk-protected)
│   └── api/                      # Routes API (webhooks, REST)
├── lib/                          # Logique métier
│   ├── claude/prompts/           # Prompts versionnés
│   ├── ovh/                      # Wrapper OVH SMS
│   ├── hubspot/                  # Wrapper HubSpot
│   ├── lusha/                    # Wrapper Lusha
│   ├── twilio/                   # Wrapper Twilio Lookup
│   ├── slack/                    # Wrapper Slack + signature verify
│   ├── firestore/                # Admin SDK + collections
│   ├── compliance/               # RGPD, Bloctel, rate limits, hours
│   ├── security/                 # Env validation, HMAC, rate limit
│   └── utils/                    # Logger, errors, phone
├── inngest/functions/            # Jobs background
├── components/                   # React components
└── types/                        # Types TS partagés
```

---

## Conventions de code

### Nommage

- **Fichiers** : kebab-case (`send-sms.ts`, `verify-signature.ts`)
- **Composants React** : PascalCase (`ConversationsTable.tsx`)
- **Variables/fonctions** : camelCase
- **Types/Interfaces** : PascalCase, suffixés `Type` ou `Schema` si nécessaire
- **Constants** : UPPER_SNAKE_CASE
- **Routes API** : `/api/<resource>/<action>` en kebab-case

### TypeScript

- **`tsconfig.json` strict** : `"strict": true`, `"noUncheckedIndexedAccess": true`
- **Pas de `any`** — utiliser `unknown` et narrower
- **Pas de `// @ts-ignore`** — corriger ou créer un type
- **Tous les inputs externes** validés via Zod avant traitement
- **Tous les imports** triés par `eslint-plugin-import`

### Patterns React

- Server Components par défaut
- `"use client"` uniquement si nécessaire (interactivité)
- Pas d'état global type Redux — préférer URL state (nuqs) + React Query
- Forms : React Hook Form + Zod resolver

### Tests

- Vitest pour unit + integration
- Playwright pour E2E
- **100% de couverture sur `lib/compliance/` et `lib/security/`**
- **80%+ sur le reste de `lib/`**
- Composants UI : tests visuels Playwright si critiques

---

## Règles non négociables

### Sécurité

1. **Aucun secret en clair** dans le code, jamais. Tout dans `.env.local` (gitignore) ou Vercel env vars.
2. **Aucun secret en `NEXT_PUBLIC_*`** sauf s'il est réellement public.
3. **Tous les webhooks vérifient leur signature HMAC** en première ligne (Slack, OVH, Inngest).
4. **Tous les inputs externes** sont validés via Zod avant traitement.
5. **Erreurs jamais renvoyées au client** — log côté serveur, message générique côté client.
6. **Authentification requise** sur toutes les routes API sauf webhooks signés.
7. **Authorization vérifiée** sur chaque action (admin vs commercial).
8. **Rate limiting** sur tous les webhooks publics (Upstash Redis).
9. **Logs sans PII** — pas de téléphone, email, nom complet en clair dans les logs.

### Conformité RGPD / AI Act / Bloctel

1. **Annonce IA dans le premier SMS** ("Bonjour, Léa, assistante IA de Médéré").
2. **"STOP" présent dans chaque SMS** et fonctionnel.
3. **Plafond strict 3 SMS / 30 jours** par contact, enforced en code.
4. **Plages horaires** : 10h-13h / 14h-20h en semaine, jamais le dimanche, jamais les jours fériés.
5. **Vérification Bloctel** des numéros mobiles persos avant envoi.
6. **Audit log** de chaque envoi, hand-off, opt-out.
7. **Conservation max 3 ans** pour contacts inactifs.
8. **Documentation intérêt légitime** stockée par contact.

### Qualité

1. **Zéro erreur console** en production.
2. **Zéro warning TypeScript** dans le build.
3. **Lighthouse > 90** sur le dashboard.
4. **Aucune dépendance avec vulnérabilité critique** (`npm audit`).
5. **Pas de `console.log`** en production — utiliser le logger Pino.
6. **Pas de `eval` ni `Function()`**.
7. **Pas de `dangerouslySetInnerHTML`** sauf cas justifié avec sanitization.

---

## Workflow de développement

1. **Planning d'abord, code ensuite** : pour toute nouvelle feature, écrire d'abord un plan en commentaires ou markdown, puis coder.
2. **Tests AVANT ou EN MÊME TEMPS que le code** sur `lib/compliance/` et `lib/security/`.
3. **Subagent `security-reviewer`** invoqué sur tout fichier touchant aux webhooks, à l'auth, ou aux env vars.
4. **Subagent `compliance-auditor`** invoqué sur tout fichier dans `lib/compliance/` ou tout endpoint qui envoie un SMS.
5. **Subagent `prompt-engineer`** invoqué pour toute modification d'un prompt dans `lib/claude/prompts/`.
6. **Commits atomiques** avec messages clairs : `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.
7. **Pas de merge en main** sans review du subagent `security-reviewer`.
8. **Branch protection** : main protégé, tout passe par PR (préférable) ou commit direct avec lint+test en pre-commit hook.

---

## Skills Claude Code à utiliser

Skills propres au projet, placées dans `.claude/skills/<nom>/SKILL.md` :

- **`medere-sms-compliance`** — déclencher sur tout code qui envoie un SMS
- **`medere-claude-prompts`** — déclencher sur modification de prompt
- **`medere-firestore-schema`** — déclencher sur opération Firestore
- **`medere-ovh-sms`** — déclencher sur opération OVH SMS

Skills système (built-in) à utiliser :

- **`frontend-design`** — pour tous les composants React du dashboard

---

## Subagents Claude Code

Placés dans `.claude/agents/` :

- **`security-reviewer`** (model: opus) — review sécurité de tout commit critique
- **`prompt-engineer`** (model: sonnet) — création/révision de prompts
- **`compliance-auditor`** (model: opus) — audit RGPD/AI Act/Bloctel
- **`ux-reviewer`** (model: sonnet) — review UX du dashboard commercial

Pour invoquer : `"Use the <agent-name> subagent to review <X>"`.

---

## Variables d'environnement

Toutes définies dans `.env.example`. Au boot, validation stricte via `src/lib/security/env.ts` (Zod). Si manquant ou mal formé, l'app refuse de démarrer.

**Critiques (l'app meurt sans elles)** : `ANTHROPIC_API_KEY`, `OVH_*`, `HUBSPOT_ACCESS_TOKEN`, `FIREBASE_*`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `INNGEST_SIGNING_KEY`.

---

## Pièges connus

| Piège | Ce qu'il faut faire |
|---|---|
| Secret en `NEXT_PUBLIC_*` | NE JAMAIS — secrets uniquement côté serveur |
| Webhook sans vérif signature | `verifyXxxSignature()` en première ligne, sinon 401 |
| `fetch()` sans timeout | Toujours `AbortController` avec timeout 10s |
| Conversation Firestore infinie dans prompt | Limiter à N derniers messages (10-20) |
| Logger un téléphone en clair | Hash ou tronquer dans le logger |
| Envoyer SMS sans Inngest | TOUT envoi passe par une Inngest function (retry auto) |
| SMS un dimanche | `compliance/hours.ts` bloque, ne jamais bypass |
| 4ème SMS dans 30j | `compliance/rate-limits.ts` bloque, ne jamais bypass |
| Pas d'annonce IA dans 1er SMS | Validation post-génération obligatoire |
| Stocker données de santé | INTERDIT — uniquement coordonnées professionnelles |
| Husky v9 : `core.hooksPath = .husky/_` | Normal (wrappers générés). Ne PAS forcer `.husky` |
| Hooks Husky qui plantent via GitHub Desktop (Windows) | Voir BUG-001 ci-dessous. Jamais d'appel `npx`/`npm` dans un hook |

### BUG-001 — Hooks Husky cassés via GitHub Desktop sur Windows

> Réf. Notion : projet → **Backlog technique → BUG-001**. Résolu le 27 mai 2026.

**Symptôme** : les hooks (`pre-commit`, `pre-push`) plantent au commit/push via GitHub
Desktop sur Windows, alors qu'ils passent en PowerShell direct.

**Cause racine** : GitHub Desktop embarque un **MinGit** (`.../GitHubDesktop/app-x.y.z/resources/app/git/usr/bin`)
qui fournit `sh.exe` et `dash.exe` mais **PAS `bash.exe`**. Or les wrappers POSIX
`npm` et `npx` installés par Node (`C:\Program Files\nodejs\npx`) ont le shebang
`#!/usr/bin/env bash`. Sous GHD, `npx lint-staged` échoue donc avec
`/usr/bin/env: 'bash': No such file or directory` (exit 127) — même quand le PATH
contient bien Node. En PowerShell, `bash.exe` existe (Git for Windows complet), d'où
l'asymétrie. (Bonus : GHD ne charge pas le PATH système complet, donc Node manque
aussi au départ → double problème.)

**Solution** (dans `.husky/pre-commit` et `.husky/pre-push`) : ne JAMAIS appeler
`npm`/`npx` dans un hook. Appeler les binaires locaux directement depuis
`node_modules/.bin` (`lint-staged`, `tsc`, `vitest`), dont le shebang est `#!/bin/sh`
→ compatible avec le `sh`/`dash` de GHD. Le wrapper Husky `.husky/_/h` préfixe déjà
`node_modules/.bin` au PATH. On ajoute en tête de hook un bloc qui garantit que
`node.exe` est trouvable :

```sh
if ! command -v node >/dev/null 2>&1 && [ -d "/c/Program Files/nodejs" ]; then
  export PATH="/c/Program Files/nodejs:$PATH"
fi
```

**Pourquoi ça marche aussi sur Mac/Linux/CI** : le shebang `#!/bin/sh` est universel
(tout Unix a `/bin/sh`), donc les binaires `node_modules/.bin` s'exécutent partout sans
dépendre de bash. Le bloc PATH Windows est un **no-op sur Unix** : `command -v node`
y réussit toujours (Node est sur le PATH) ET `/c/Program Files/nodejs` n'existe pas,
donc la condition est doublement fausse → la ligne `export` n'est jamais atteinte.

**À ne pas faire** : ne pas tenter de réparer en routant via `npx.cmd`/`npm.cmd`
(`.cmd` non exécutable de façon fiable depuis `sh`), ni en modifiant `.husky/_/h`
(régénéré par Husky). Pour un correctif par-machine non partagé, `~/.config/husky/init.sh`
existe (sourcé par `h`) mais ne suffit pas seul : il règle le PATH, pas l'absence de bash.

### BUG-004 — Firestore emulator zombie après SIGINT (Windows)

> Réf. Notion : projet → **Backlog technique → BUG-004**. Découvert le 29 mai 2026.
> **Sévérité** : 🟡 Moyenne (workaround `npm run emulator:kill` ou taskkill manuel).

**Symptôme** : après un `npm run test:firestore` réussi (exit 0), un process
`java.exe` reste `LISTENING` sur le port 8085 pendant 30s à plusieurs minutes.
Tout run enchaîné fail avec `Could not start Firestore Emulator, port taken`.

**Cause** : `firebase emulators:exec` envoie SIGINT à firebase-tools, qui reporte
« exited upon SIGINT », mais le JVM enfant n'est pas tué dans le même processus
group sur Windows (différence comportementale vs Unix où SIGINT propage au PGID
complet, donc le bug ne se reproduit pas sur Mac/Linux/CI).

**Workaround** : `npm run emulator:kill` (verbose, identifie le PID avant kill).
Sur Mac/Linux le script est un no-op + message explicatif.

**Pourquoi pas de fix auto en `pretest:firestore`** : un kill silent au démarrage
de chaque test pourrait masquer des bugs où plusieurs emulators tournent en
parallèle pour des raisons légitimes (multi-projets, dev long-running). On
préfère faire surface le problème explicitement.

**À ne pas faire** : pas de `pretest:firestore: emulator:kill` automatique, pas
de retry loop interne au test runner, pas de timeout fallback sur le port.
Quand le port est pris : on lit le message d'erreur, on lance `emulator:kill`,
on relance.

---

## Modèles Claude à utiliser

- **`claude-sonnet-4-6`** — par défaut pour toutes les tâches IA (génération SMS, classification, réponses)
- **`claude-haiku-4-5`** — si besoin de réduire les coûts sur des tâches simples (classification seule)
- **`claude-opus-4-7`** — si besoin de qualité maximale sur des cas complexes (rare)

Toujours utiliser le SDK officiel `@anthropic-ai/sdk` avec streaming pour les réponses longues.

---

## Style de prompts (Gary Bencivenga adapté)

Pour les prompts qui génèrent du contenu commercial (SMS, emails) :

- **Clarté** : compréhensible en 3 secondes
- **Preuve > promesse** : chiffres, faits concrets
- **Empathie** : parle à un humain occupé
- **Naturel** : ton conversationnel professionnel
- **Une idée par message**, pas de dispersion
- **Vouvoiement obligatoire** pour les PS
- **Pas d'émojis**, pas de superlatifs vides
- **Annonce IA en intro** + **opt-out STOP en fin**

Structure XML des prompts (Anthropic best practice) :

```xml
<contexte>...</contexte>
<destinataire>...</destinataire>
<offre>...</offre>
<instructions>...</instructions>
<format_de_sortie>...</format_de_sortie>
```

---

## Personnes du projet (à mentionner en notif Slack hand-off)

| Slack ID | Personne | Rôle | Hand-off pour |
|---|---|---|---|
| `U05UVHGBURX` | Déthié | Admin/Tech | Bugs, anomalies |
| `U01DPF08TQV` | Harry | Direction | KPIs, alertes business |
| `U08ESGDGMTN` | Franck | Marketing | Suggestions amélioration |
| — | Vanessa Rabba | Commerciale dentaire | **Leads dentistes** |
| — | Zacharie | Commercial | Leads médecins/IDE |
| — | Jordan | Directeur commercial | Escalations |

(Les IDs Slack manquants sont à récupérer via `users.list` API.)

---

## Tone à adopter avec Déthié

- Direct, honnête, fiable
- Tutoiement
- Pas de langue de bois
- Si tu rates quelque chose, tu le reconnais
- Si tu n'es pas sûr, tu le dis et tu cherches
- Tu ne fabriques jamais d'information

---

## Si quelque chose est ambigu

1. Lis le README.md détaillé à la racine du projet
2. Consulte la skill correspondante dans `.claude/skills/`
3. Pose UNE question à Déthié avant de coder dans le doute
4. N'invente JAMAIS un comportement de l'API tierce — vérifie la doc

---

Dernière mise à jour : 27 mai 2026
