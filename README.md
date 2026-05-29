# Médéré — Agent IA Prospection PS (Phase SMS)

> **Stack open-source, sécurisée, conforme RGPD/AI Act, prête pour la production**
> Pour démarrer le développement avec Claude Code. Lis ce document en entier avant de coder.

---

## 1. Vue d'ensemble

### Le projet en une phrase

Un agent IA hybride qui prospecte 26 000 professionnels de santé (PS) via SMS, qualifie l'intérêt, et hand-off les leads chauds aux commerciaux humains via Slack + HubSpot — avec une interface dashboard pour piloter le tout.

### Architecture macro

```
┌────────────────────────────────────────────────────────────────────┐
│                                                                    │
│   HubSpot CRM ◄──► Vercel App (Next.js 16) ◄──► Dashboard React    │
│        ▲              │                                            │
│        │              ├──► Lusha API (enrichissement)              │
│        │              ├──► Twilio Lookup (validation numéros)      │
│        │              ├──► OVH SMS API (envoi/réception)           │
│        │              ├──► Claude API (génération + classification)│
│        │              ├──► Inngest (jobs background + retries)     │
│        │              └──► Firebase Firestore (état conversations) │
│        │                                                           │
│        └──── Slack (notif hand-off → commerciaux)                  │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### Utilisateurs

- **Déthié** (admin) : pilote la campagne, ajuste les prompts, supervise les KPIs
- **Vanessa, Zacharie, Jeremy, Sophie, Sébastien, Mehveesh, Thomas, Kaoufer, Christopher** (commerciaux) : reçoivent les hand-offs, reprennent la conversation
- **Harry, Franck** (direction) : consultent le dashboard de performance

### Contraintes non négociables

1. **Conformité RGPD** : intérêt légitime documenté, opt-out facile (STOP), 3 messages max/30 jours
2. **Conformité AI Act** : annonce IA dans le premier message
3. **Zéro fuite secret** : aucun token en clair dans le repo, ni dans les logs
4. **Zéro erreur console** en production : tout est typé, validé, intercepté
5. **UX simple pour les commerciaux** : ils doivent comprendre l'interface en 30 secondes

---

## 2. Stack technique (versions précises)

| Couche | Outil | Version | Pourquoi |
|---|---|---|---|
| Runtime | Node.js | 20 LTS | Stable, supporté par tous les SDK |
| Langage | TypeScript | 5.4+ | Type safety, zéro runtime error |
| Framework | Next.js | 16 (App Router) | Frontend + API routes unifiés |
| UI | shadcn/ui + Tailwind v4 | dernière | Composants accessibles, design système |
| Tables | TanStack Table v8 | dernière | Tri/filtre/pagination côté serveur |
| Charts | Recharts 3 | dernière | KPIs dashboard |
| Forms | React Hook Form + Zod | dernière | Validation typée |
| Hébergement | Vercel | — | CI/CD natif Next.js |
| Base de données | Firebase Firestore | — | Temps réel, scalable |
| Auth dashboard | Clerk ou Firebase Auth | — | Multi-rôles, déjà éprouvé |
| LLM | Claude Sonnet 4.6 | `claude-sonnet-4-6` | Français natif, raisonnement, prix |
| SDK LLM | `@anthropic-ai/sdk` | dernière | Officiel TypeScript |
| SMS sortant/entrant | OVH SMS API | v1 | Souverain FR, prix compétitif |
| SDK OVH | `@ovhcloud/node-ovh` | dernière | Officiel |
| Validation numéros | Twilio Lookup v2 | — | Type ligne, carrier, validité |
| SDK Twilio | `twilio` | dernière | Officiel |
| Enrichissement | Lusha API v2 | — | Connecté déjà dans MCP |
| CRM | HubSpot API v3 | — | CRM en place chez Médéré |
| SDK HubSpot | `@hubspot/api-client` | dernière | Officiel TypeScript |
| Slack | Slack Web API + Webhooks | — | Notifs commerciaux |
| SDK Slack | `@slack/web-api` + `@slack/webhook` | dernière | Officiels |
| Jobs/queues | Inngest | dernière | Retries auto, sleep, fan-out |
| Logs/observabilité | Sentry + Vercel Logs | — | Erreurs et tracing |
| Tests | Vitest + Playwright | dernière | Unit + E2E |
| Security headers | Helmet (sur API routes) | dernière | OWASP defaults |
| Rate limiting | Upstash Redis + middleware | — | Anti-abus webhooks |
| Validation runtime | Zod | dernière | Schémas typés + parse |
| Git hooks | Husky + lint-staged | dernière | Pas de commit cassé |
| Lint | ESLint + Prettier | dernière | Cohérence |

---

## 3. Structure du repo

```
medere-prospection/
├── .claude/                          # Config Claude Code (versionnée)
│   ├── agents/                       # Subagents spécialisés
│   │   ├── security-reviewer.md
│   │   ├── prompt-engineer.md
│   │   └── compliance-auditor.md
│   └── settings.json                 # Permissions, modèles
├── CLAUDE.md                         # Instructions principales Claude Code
├── AGENTS.md                         # Lien symbolique vers CLAUDE.md
├── README.md                         # Ce fichier
├── .env.example                      # Variables d'env (sans secrets)
├── .env.local                        # Secrets locaux (gitignore)
├── .gitignore                        # node_modules, .env*, .next/, etc.
├── package.json
├── tsconfig.json
├── next.config.ts
├── tailwind.config.ts
├── components.json                   # shadcn/ui config
├── vitest.config.ts
├── playwright.config.ts
├── firestore.rules                   # Règles de sécurité Firestore
├── firebase.json
│
├── src/
│   ├── app/                          # Next.js App Router
│   │   ├── (dashboard)/              # Routes protégées dashboard
│   │   │   ├── layout.tsx            # Layout commercial avec sidebar
│   │   │   ├── page.tsx              # Vue d'ensemble (KPIs)
│   │   │   ├── conversations/
│   │   │   │   ├── page.tsx          # Liste des conversations actives
│   │   │   │   └── [id]/page.tsx     # Détail conversation + actions
│   │   │   ├── leads/
│   │   │   │   └── page.tsx          # Pipeline leads qualifiés
│   │   │   ├── campaigns/
│   │   │   │   └── page.tsx          # Pilotage envois
│   │   │   └── settings/
│   │   │       ├── prompts/page.tsx  # Édition prompts (admin)
│   │   │       └── team/page.tsx     # Gestion commerciaux
│   │   │
│   │   ├── api/                      # Routes API (Next.js)
│   │   │   ├── webhooks/
│   │   │   │   ├── ovh-sms/route.ts  # Réception SMS entrants
│   │   │   │   └── slack/route.ts    # Slash commands optionnels
│   │   │   ├── inngest/route.ts      # Endpoint Inngest
│   │   │   ├── conversations/
│   │   │   │   └── [id]/
│   │   │   │       ├── route.ts      # GET/PATCH conversation
│   │   │   │       └── handoff/route.ts  # POST hand-off manuel
│   │   │   └── kpis/route.ts         # GET stats dashboard
│   │   │
│   │   ├── layout.tsx                # Root layout
│   │   └── globals.css               # Tailwind base
│   │
│   ├── lib/                          # Logique métier (réutilisable)
│   │   ├── claude/
│   │   │   ├── client.ts             # Singleton client Anthropic
│   │   │   ├── prompts/
│   │   │   │   ├── first-sms.ts      # Prompt génération 1er SMS
│   │   │   │   ├── classify-intent.ts # Prompt classification
│   │   │   │   ├── reply.ts          # Prompt génération réponse
│   │   │   │   └── README.md         # Versionning des prompts
│   │   │   └── schemas.ts            # Zod schemas pour outputs LLM
│   │   ├── ovh/
│   │   │   ├── client.ts             # Wrapper @ovhcloud/node-ovh
│   │   │   ├── send-sms.ts           # Envoi SMS
│   │   │   └── parse-incoming.ts     # Parsing webhook entrant
│   │   ├── hubspot/
│   │   │   ├── client.ts             # Wrapper @hubspot/api-client
│   │   │   ├── contacts.ts           # CRUD contacts
│   │   │   └── deals.ts              # Création deals + association
│   │   ├── lusha/
│   │   │   ├── client.ts             # Wrapper fetch + headers
│   │   │   └── enrich.ts             # Enrichissement par téléphone
│   │   ├── twilio/
│   │   │   ├── client.ts
│   │   │   └── lookup.ts             # Validation numéros
│   │   ├── slack/
│   │   │   ├── client.ts
│   │   │   ├── notify-handoff.ts     # Message commercial
│   │   │   └── verify-signature.ts   # HMAC validation
│   │   ├── firestore/
│   │   │   ├── admin.ts              # firebase-admin singleton
│   │   │   ├── conversations.ts      # CRUD conversations
│   │   │   ├── contacts.ts           # CRUD contacts locaux
│   │   │   ├── messages.ts           # CRUD messages
│   │   │   └── audit-log.ts          # Log d'actions sensibles
│   │   ├── compliance/
│   │   │   ├── rgpd.ts               # Vérifs RGPD + opt-out
│   │   │   ├── bloctel.ts            # Vérif Bloctel (export CSV)
│   │   │   ├── rate-limits.ts        # 3 msg/30j par contact
│   │   │   └── hours.ts              # Plages 10-13 / 14-20h
│   │   ├── security/
│   │   │   ├── webhook-signatures.ts # HMAC pour tous webhooks
│   │   │   ├── env.ts                # Validation des env vars au boot
│   │   │   └── rate-limit.ts         # Upstash Redis rate limit
│   │   └── utils/
│   │       ├── logger.ts             # Logger structuré (pino)
│   │       ├── errors.ts             # Classes d'erreurs typées
│   │       └── phone.ts              # Normalisation E.164
│   │
│   ├── inngest/                      # Jobs background
│   │   ├── client.ts
│   │   ├── functions/
│   │   │   ├── enrich-contact.ts     # Pipeline enrichissement
│   │   │   ├── send-first-sms.ts     # Envoi 1er SMS
│   │   │   ├── process-reply.ts      # Traitement réponse entrante
│   │   │   ├── schedule-followup.ts  # Relance J+3, J+7
│   │   │   └── archive-stale.ts     # Archive contacts inactifs
│   │   └── index.ts
│   │
│   ├── components/                   # Composants React
│   │   ├── ui/                       # shadcn/ui copiés
│   │   ├── dashboard/
│   │   │   ├── kpi-card.tsx
│   │   │   ├── conversations-table.tsx
│   │   │   ├── pipeline-funnel.tsx
│   │   │   └── activity-feed.tsx
│   │   ├── conversation/
│   │   │   ├── message-thread.tsx
│   │   │   ├── handoff-button.tsx
│   │   │   ├── intent-badge.tsx
│   │   │   └── contact-info-card.tsx
│   │   └── layout/
│   │       ├── sidebar.tsx
│   │       └── header.tsx
│   │
│   ├── types/                        # Types TypeScript partagés
│   │   ├── conversation.ts
│   │   ├── contact.ts
│   │   ├── message.ts
│   │   └── api.ts
│   │
│   └── styles/                       # Tokens design
│       └── tokens.ts
│
├── tests/
│   ├── unit/                         # Tests Vitest
│   │   ├── claude/
│   │   ├── ovh/
│   │   └── compliance/
│   ├── integration/                  # Tests API
│   │   └── webhooks/
│   └── e2e/                          # Tests Playwright
│       └── dashboard/
│
└── scripts/                          # Scripts utilitaires
    ├── seed-firestore.ts             # Données de test
    ├── export-bloctel.ts             # Génère le fichier à envoyer
    └── migrate-contacts.ts           # Import 26k contacts HubSpot
```

---

## 4. CLAUDE.md (à placer à la racine du repo)

Le contenu complet du fichier CLAUDE.md est fourni en annexe (fichier séparé). Il sert de référence permanente à Claude Code pour le développement du projet. Il inclut :

- Le contexte du projet et ses contraintes
- Les commandes essentielles (npm scripts)
- Les conventions de code et de nommage
- Les règles de sécurité non négociables
- La liste des secrets et leur emplacement
- Les patterns de tests à suivre
- Les pièges connus à éviter

---

## 5. Skills Claude Code à créer

Skills propres au projet, à placer dans `.claude/skills/<nom-skill>/SKILL.md`. Elles seront chargées automatiquement par Claude Code quand le contexte correspond.

### Skill 1 : `medere-sms-compliance`

```yaml
---
name: medere-sms-compliance
description: Vérifie la conformité RGPD/AI Act/Bloctel de tout envoi SMS. À utiliser systématiquement avant l'envoi d'un SMS ou la création d'un endpoint qui envoie des SMS.
---
```

Contenu : checklist conformité (annonce IA, opt-out STOP, max 3 msg/30j, plages horaires, Bloctel pour mobiles persos), helpers pour vérifier chaque règle, références aux articles de loi.

### Skill 2 : `medere-claude-prompts`

```yaml
---
name: medere-claude-prompts
description: Bonnes pratiques pour les prompts Claude utilisés dans la prospection SMS. Style Gary Bencivenga (clarté, preuve, accroche). À utiliser quand on crée ou modifie un prompt LLM dans src/lib/claude/prompts/.
---
```

Contenu : style Bencivenga décliné en règles concrètes pour SMS médical, format XML pour les prompts, exemples de bons prompts, anti-patterns à éviter.

### Skill 3 : `medere-firestore-schema`

```yaml
---
name: medere-firestore-schema
description: Schéma Firestore du projet. À utiliser dès qu'on crée ou modifie une collection ou un document Firestore.
---
```

Contenu : structure exacte des collections (`contacts`, `conversations`, `messages`, `audit_log`), types TypeScript, règles de sécurité, exemples de requêtes.

### Skill 4 : `medere-ovh-sms`

```yaml
---
name: medere-ovh-sms
description: Spécifique à l'intégration OVHcloud SMS API. À utiliser pour tout travail sur l'envoi ou la réception de SMS via OVH.
---
```

Contenu : authentification OVH (appKey, appSecret, consumerKey), endpoints `/sms/{serviceName}/jobs`, gestion des erreurs, parsing des webhooks entrants, format E.164.

---

## 6. Subagents Claude Code recommandés

Les subagents sont des "spécialistes" que Claude Code invoque pour des tâches précises. À placer dans `.claude/agents/<nom>.md`.

### `security-reviewer.md`

```yaml
---
name: security-reviewer
description: Reviewer sécurité expert. À invoquer après chaque commit important, avant tout merge en main, et systématiquement sur les fichiers touchant aux webhooks, à l'authentification, aux env vars, ou à Firestore.
tools: Read, Grep, Glob, Bash
model: opus
---
```

Vérifie : OWASP Top 10, secrets en clair, validation des inputs, signature des webhooks, fuite d'erreurs vers le client, headers de sécurité, rate limiting.

### `prompt-engineer.md`

```yaml
---
name: prompt-engineer
description: Expert prompt engineering Claude. À invoquer pour créer ou réviser un prompt LLM, ou analyser une mauvaise réponse de Claude en production.
tools: Read, Edit, Write
model: sonnet
---
```

Applique : structure XML, examples (few-shot), output format strict, role prompting, chaînage de pensée si nécessaire, ton Bencivenga pour les sorties commerciales.

### `compliance-auditor.md`

```yaml
---
name: compliance-auditor
description: Audit RGPD / AI Act / Bloctel. À invoquer avant tout déploiement, et systématiquement sur tout code lié à l'envoi de messages, à la collecte de consentement, ou à la conservation des données.
tools: Read, Grep, Glob
model: opus
---
```

Vérifie : annonce IA dans messages, opt-out présent et fonctionnel, plafonds respectés, conservation données limitée à 3 ans, traçabilité des consentements, droit à l'effacement.

### `ux-reviewer.md`

```yaml
---
name: ux-reviewer
description: Reviewer UX pour le dashboard commercial. À invoquer pour réviser les composants React, vérifier l'accessibilité, et garantir que l'expérience est claire pour un commercial non-tech.
tools: Read, Glob, Grep
model: sonnet
---
```

Vérifie : accessibilité (a11y, ARIA, contrastes), parcours utilisateur (un commercial doit comprendre en 30 sec), responsive mobile (tablette pour Vanessa en déplacement), états de loading/erreur, empty states.

---

## 7. Variables d'environnement (.env.example)

```bash
# === Application ===
NODE_ENV=development
NEXT_PUBLIC_APP_URL=http://localhost:3000
APP_SECRET=                          # openssl rand -base64 32

# === Anthropic Claude ===
ANTHROPIC_API_KEY=                   # https://console.anthropic.com/

# === OVHcloud SMS ===
OVH_ENDPOINT=ovh-eu
OVH_APP_KEY=                         # https://api.ovh.com/createApp/
OVH_APP_SECRET=
OVH_CONSUMER_KEY=                    # Restreint à POST /sms/*/jobs
OVH_SMS_SERVICE_NAME=                # ex: sms-ab12345-1
OVH_SMS_SENDER=Medere                # Sender ID (max 11 chars)
OVH_WEBHOOK_SECRET=                  # Pour signer les webhooks entrants

# === Twilio (Lookup uniquement) ===
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=

# === HubSpot ===
HUBSPOT_ACCESS_TOKEN=                # Private App access token
HUBSPOT_PORTAL_ID=

# === Lusha ===
LUSHA_API_KEY=

# === Slack ===
SLACK_BOT_TOKEN=                     # xoxb-...
SLACK_SIGNING_SECRET=                # Pour vérifier les webhooks
SLACK_HANDOFF_CHANNEL_ID=            # Canal #leads-chauds
SLACK_USER_IDS=                      # JSON: { "dentaire": "U..." }

# === Firebase Admin ===
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=                # Avec \n échappés

# === Inngest ===
INNGEST_EVENT_KEY=
INNGEST_SIGNING_KEY=

# === Sentry ===
SENTRY_DSN=
NEXT_PUBLIC_SENTRY_DSN=

# === Upstash Redis (rate limiting) ===
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# === Auth dashboard (Clerk) ===
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
```

**Règle absolue** : aucun secret ne porte le préfixe `NEXT_PUBLIC_` sauf s'il est réellement public (ex: Clerk publishable key, Sentry DSN). Les `NEXT_PUBLIC_*` sont inlinés dans le bundle JS client et lisibles par n'importe qui.

---

## 8. Setup pas à pas

### Prérequis

- Node.js 20 LTS installé (`node --version`)
- npm 10+ ou pnpm
- Comptes créés sur : Anthropic, OVHcloud (avec crédits SMS), HubSpot (Private App), Lusha, Slack (workspace + bot app), Firebase, Vercel, Inngest, Sentry, Upstash, Clerk
- Claude Code installé localement

### Installation

```bash
# 1. Créer le projet
npx create-next-app@latest medere-prospection --typescript --tailwind --app --no-src-dir false

# Quand demandé :
# - TypeScript : Yes
# - ESLint : Yes
# - Tailwind : Yes
# - src/ directory : Yes
# - App Router : Yes
# - Import alias : @/*

cd medere-prospection

# 2. Installer les dépendances métier
npm install \
  @anthropic-ai/sdk \
  @hubspot/api-client \
  @ovhcloud/node-ovh \
  twilio \
  firebase-admin \
  inngest \
  @slack/web-api \
  @slack/webhook \
  @upstash/ratelimit @upstash/redis \
  zod \
  pino pino-pretty \
  @sentry/nextjs \
  date-fns \
  libphonenumber-js

# 3. Installer les dépendances UI
npm install \
  @tanstack/react-table \
  @tanstack/react-query \
  recharts \
  react-hook-form @hookform/resolvers \
  lucide-react \
  cmdk

# 4. Installer les dépendances dev
npm install -D \
  vitest @vitest/ui \
  @playwright/test \
  @types/node \
  husky lint-staged \
  prettier eslint-config-prettier

# 5. Initialiser shadcn/ui
npx shadcn@latest init
npx shadcn@latest add button card table dialog form input badge command popover dropdown-menu sheet sonner skeleton

# 6. Initialiser Clerk
npx @clerk/nextjs@latest

# 7. Initialiser Firebase
npm install -g firebase-tools
firebase login
firebase init firestore

# 8. Initialiser Husky
npx husky init
echo "npm run lint && npm test" > .husky/pre-commit

# 9. Copier les fichiers de config
# Place les fichiers CLAUDE.md, .env.example, firestore.rules à la racine

# 10. Lancer en dev
cp .env.example .env.local
# Remplir tous les secrets dans .env.local
npm run dev
```

### Démarrage avec Claude Code

```bash
cd medere-prospection
claude  # Ouvre Claude Code dans le projet
```

Premier prompt à donner à Claude Code après l'ouverture :

```
Lis le CLAUDE.md, le README.md, et fais un tour du repo.
Confirme que tu as compris le projet et propose la première étape concrète
selon la roadmap d'implémentation. Ne code rien encore.
```

### Firestore emulator local (Phase 1 — S6)

Toute la suite `lib/firestore/` se teste contre l'**emulator Firestore réel** (port 8085), pas contre un mock. Cela couvre vraiment les Timestamps, transactions, FieldValue et règles de sécurité — un mock raterait ces invariants.

**Prérequis** :

- **Java 17+** sur le PATH (`java -version`). Firebase emulator est un JAR.
- **`firebase-tools`** en devDependency (déjà dans `package.json`, installé via `npm install`). Pas d'install globale nécessaire.
- **Port 8085 libre** (cf. check ci-dessous).

**Vérifier que le port 8085 est libre** :

```bash
# Windows (PowerShell ou Git Bash)
netstat -ano | findstr :8085

# Mac/Linux
lsof -i :8085
```

Si le port est occupé : modifier `firebase.json` (`emulators.firestore.port`) ET `FIRESTORE_EMULATOR_HOST` dans `.env.local` en cohérence.

**Cache Firebase — IMPORTANT sur Windows avec home accentué** :

Si ton home utilisateur contient un caractère non-ASCII (ex: `C:\Users\Déthié\`), Firebase casse le téléchargement du JAR emulator. Le script `scripts/setup-firebase-cache.mjs` (appelé automatiquement par `npm run test:firestore` et `npm run emulator:firestore`) détecte le cas et exige de définir `FIREBASE_CACHE_DIR` vers un path ASCII pur.

```powershell
# PowerShell — persistant pour l'utilisateur
[Environment]::SetEnvironmentVariable("FIREBASE_CACHE_DIR","C:/firebase-cache","User")
# Ouvrir un nouveau terminal pour que la variable soit prise en compte.
```

```bash
# Git Bash / WSL — session courante
export FIREBASE_CACHE_DIR=C:/firebase-cache
```

Le script crée le dossier automatiquement (mkdir recursive). Si tu n'as pas d'accent dans ton home (CI, Mac, Linux), tu peux ignorer cette variable.

**Firewall Windows** :

Au premier `npm run emulator:firestore`, Windows demande d'autoriser Java et Node sur le réseau privé. Accepter une fois. Pas applicable en CI.

**Commandes utiles** :

```bash
# Vérification pré-flight du cache uniquement (rapide)
npm run emulator:check

# Démarrer l'emulator en interactif (Ctrl+C pour stop)
npm run emulator:firestore

# Lancer les tests Firestore (start emulator → run tests → stop)
npm run test:firestore

# Workaround BUG-004 : tuer un emulator zombie qui tient encore le port
# 8085 après un run précédent (verbose, identifie le PID avant de killer).
npm run emulator:kill
```

#### Emulator zombie après crash (Windows uniquement) — BUG-004

Sur Windows, après un `npm run test:firestore` (même réussi), le process
`java.exe` du Firestore emulator peut rester en `LISTENING` sur le port 8085
**plusieurs minutes** après le SIGINT envoyé par `firebase emulators:exec`.
`firebase-tools` reporte « exited upon SIGINT » mais le JVM n'est pas tué
dans le même groupe de processus que le parent (différence comportementale
Windows vs Unix, où SIGINT propage au PGID complet).

**Symptôme** : ton run suivant fail avec :

```
! firestore: Port 8085 is not open on 127.0.0.1, could not start Firestore Emulator.
Error: Could not start Firestore Emulator, port taken.
```

**Workaround** :

```bash
npm run emulator:kill   # identifie le PID + taskkill /F (verbose)
# puis relance ton test
npm run test:firestore
```

Le script est verbeux par design : il affiche exactement quel PID est
ciblé. Il NE tourne PAS en `pretest:firestore` automatiquement — un kill
silent au démarrage de chaque run pourrait masquer des emulators
légitimes (multi-projets, sessions de dev long-running).

Sur Mac/Linux/CI : le script affiche un message « rien à faire » et exit 0,
puisque le bug ne se reproduit pas (SIGINT propage correctement au PGID).

---

## 9. Schéma Firestore

### Collection : `contacts`

Document ID = `hubspot_contact_id`

```typescript
{
  hubspotId: string;              // Source de vérité
  firstName: string;
  lastName: string;
  speciality: string;              // 'dentiste' | 'generaliste' | 'ide' | 'autre'
  city: string;
  postalCode: string;
  phone: {
    e164: string;                  // +33612345678
    type: 'mobile' | 'landline' | 'voip' | 'unknown';
    valid: boolean;
    lookupAt: Timestamp;
  };
  email?: string;
  segment: 'b2b_cabinet' | 'b2c_mobile_perso' | 'unknown';
  bloctelChecked: boolean;
  bloctelOptOut: boolean;
  consent: {
    legitimateInterest: string;    // texte documentant l'intérêt légitime
    optedOut: boolean;
    optedOutAt?: Timestamp;
    optedOutReason?: string;
  };
  enrichment: {
    source: 'lusha' | 'hubspot' | 'manual';
    enrichedAt: Timestamp;
    raw?: object;                  // Données brutes Lusha
  };
  status: 'pending' | 'enriched' | 'ready' | 'in_conversation' |
          'qualified' | 'opted_out' | 'archived';
  campaignId: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

### Collection : `conversations`

Document ID = `<contactId>_<campaignId>`

```typescript
{
  contactId: string;
  campaignId: string;
  channel: 'sms' | 'whatsapp';
  status: 'active' | 'awaiting_reply' | 'qualified' |
          'handed_off' | 'closed' | 'opted_out';
  intent: 'unknown' | 'INTERESSE' | 'NEUTRE' | 'OBJECTION' | 'STOP';
  messageCount: number;
  lastMessageAt: Timestamp;
  lastIntentChangeAt: Timestamp;
  handoff?: {
    assignedTo: string;            // Slack user ID
    assignedAt: Timestamp;
    acceptedAt?: Timestamp;
    dealId?: string;               // HubSpot deal ID créé
  };
  nextActionAt?: Timestamp;        // pour les relances
  nextActionType?: 'followup_3d' | 'followup_7d' | 'none';
  summary?: string;                // Résumé pour le commercial
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

### Collection : `messages`

Sous-collection de `conversations` : `conversations/{convId}/messages/{messageId}`

```typescript
{
  direction: 'outbound' | 'inbound';
  body: string;
  status: 'queued' | 'sent' | 'delivered' | 'failed' | 'received';
  channel: 'sms' | 'whatsapp';
  externalId?: string;             // ID OVH ou Twilio
  generatedBy: 'ai' | 'human' | 'system';
  aiModel?: string;                // ex: 'claude-sonnet-4-6'
  aiPromptVersion?: string;        // ex: 'first-sms-v1.2'
  intent?: 'INTERESSE' | 'NEUTRE' | 'OBJECTION' | 'STOP';
  intentConfidence?: number;       // 0..1
  cost?: number;                   // en centimes EUR
  sentAt?: Timestamp;
  receivedAt?: Timestamp;
  error?: string;
}
```

### Collection : `audit_log`

```typescript
{
  actorId: string;                 // user Slack ou 'system' ou 'ai'
  action: string;                  // 'sms_sent' | 'handoff' | 'opt_out' | etc.
  targetType: 'contact' | 'conversation' | 'message';
  targetId: string;
  payload: object;                 // contexte
  ipAddress?: string;
  userAgent?: string;
  timestamp: Timestamp;
}
```

### Collection : `prompts`

Versionning des prompts en base (modifiables sans redéploiement)

```typescript
{
  id: string;                      // ex: 'first-sms', 'classify-intent'
  version: string;                 // ex: '1.2.0'
  active: boolean;
  template: string;                // template avec variables {{firstName}}, etc.
  modelId: string;                 // claude-sonnet-4-6
  temperature: number;
  maxTokens: number;
  createdBy: string;
  createdAt: Timestamp;
}
```

### `firestore.rules`

```javascript
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {

    // Helper : utilisateur authentifié avec un rôle
    function hasRole(role) {
      return request.auth != null &&
             request.auth.token.role == role;
    }

    function isAdmin() {
      return hasRole('admin');
    }

    function isCommercial() {
      return hasRole('commercial') || hasRole('admin');
    }

    // Contacts : lecture pour commerciaux, écriture admin uniquement
    match /contacts/{contactId} {
      allow read: if isCommercial();
      allow write: if isAdmin();
    }

    // Conversations : lecture commerciaux, update si attribué
    match /conversations/{convId} {
      allow read: if isCommercial();
      allow update: if isCommercial() &&
                    (isAdmin() ||
                     resource.data.handoff.assignedTo == request.auth.uid);
      allow create, delete: if isAdmin();

      match /messages/{messageId} {
        allow read: if isCommercial();
        allow create: if isCommercial();
        allow update, delete: if isAdmin();
      }
    }

    // Audit log : lecture admin uniquement, write append-only via Admin SDK
    match /audit_log/{logId} {
      allow read: if isAdmin();
      allow write: if false;   // Seul l'Admin SDK peut écrire (bypass rules)
    }

    // Prompts : lecture commerciaux, écriture admin
    match /prompts/{promptId} {
      allow read: if isCommercial();
      allow write: if isAdmin();
    }

    // Deny by default
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

**Note importante** : le backend (API routes Next.js) utilise l'Admin SDK Firebase, qui bypass les règles. Ces règles ne protègent que les accès directs depuis le navigateur. Toute la logique métier critique doit être dans les API routes.

---

## 10. Prompts Claude (style Gary Bencivenga)

### `first-sms.ts` — Génération du premier SMS

```typescript
export const FIRST_SMS_PROMPT_V1 = `Tu es Léa, l'assistante IA de Médéré, organisme de formation médicale et dentaire certifié DPC (Développement Professionnel Continu).

<contexte>
Médéré propose des formations DPC en e-learning, classes virtuelles et présentiel à Paris pour les professionnels de santé. Les formations sont prises en charge par l'ANDPC (gratuites pour les PS éligibles), avec une indemnisation pouvant atteindre 660€/an.
</contexte>

<destinataire>
Prénom : {{firstName}}
Spécialité : {{speciality}}
Ville : {{city}}
</destinataire>

<offre>
{{offerDescription}}
</offre>

<instructions>
Rédige un SMS court (max 160 caractères) qui :
1. Identifie-toi clairement comme IA (obligation légale AI Act).
2. Personnalise avec le prénom du PS et sa spécialité.
3. Présente UNE valeur concrète, chiffrée si possible.
4. Pose UNE question simple qui invite à répondre OUI ou STOP.
5. Inclut "STOP" comme opt-out.

Style à respecter (inspiré Gary Bencivenga) :
- Clarté avant tout : compréhensible en 3 secondes
- Preuve plutôt que promesse (chiffres, faits concrets)
- Empathie : parle à un humain occupé, pas à une cible marketing
- Naturel : comme un message professionnel court
- Pas de superlatifs vides ("révolutionnaire", "incroyable")
- Pas d'émojis
- Tutoiement INTERDIT (vouvoiement obligatoire pour les PS)

Format de sortie attendu :
<sms>
[le texte du SMS, exactement comme il doit être envoyé]
</sms>

<reasoning>
[en 1-2 phrases, explique tes choix de formulation]
</reasoning>
</instructions>`;
```

### `classify-intent.ts` — Classification d'une réponse PS

```typescript
export const CLASSIFY_INTENT_PROMPT_V1 = `Tu es un classifieur d'intent pour des conversations SMS commerciales.

<contexte>
Médéré, organisme de formation DPC, prospecte des professionnels de santé.
Le PS a reçu un premier SMS et vient de répondre.
</contexte>

<conversation>
{{conversationHistory}}
</conversation>

<derniere_reponse_ps>
{{lastReply}}
</derniere_reponse_ps>

<instructions>
Classifie la dernière réponse du PS dans EXACTEMENT une de ces 4 catégories :

- INTERESSE : le PS exprime un intérêt clair (questions, demande d'infos, "oui", "ok", "comment ?", etc.)
- NEUTRE : réponse ambiguë, question hors-sujet, ou simple accusé de réception
- OBJECTION : le PS exprime un doute, une réserve, une objection sans refuser ("c'est cher ?", "je n'ai pas le temps", "pas maintenant", etc.)
- STOP : le PS demande l'arrêt explicite ("STOP", "ne plus me contacter", "je refuse", "désinscription", insultes, etc.)

RÈGLES STRICTES :
- En cas de doute entre INTERESSE et NEUTRE, choisis NEUTRE.
- En cas de doute entre STOP et OBJECTION, choisis STOP (par précaution).
- "STOP" en majuscules ou seul = TOUJOURS STOP, sans exception.
- Une insulte ou un ton hostile = STOP.

Format de sortie attendu (JSON strict, sans markdown) :
{
  "intent": "INTERESSE" | "NEUTRE" | "OBJECTION" | "STOP",
  "confidence": <nombre entre 0 et 1>,
  "reasoning": "<1 phrase d'explication>",
  "suggestedAction": "<action recommandée>"
}
</instructions>`;
```

### `reply.ts` — Génération d'une réponse à une objection ou question neutre

```typescript
export const REPLY_PROMPT_V1 = `Tu es Léa, assistante IA de Médéré. Tu réponds à un professionnel de santé qui a répondu à ton premier SMS.

<contexte_medere>
Médéré : organisme de formation DPC certifié.
Formations : e-learning, classes virtuelles Zoom, présentiel Paris.
Cible : médecins, dentistes, IDE.
Prise en charge ANDPC : gratuit pour les PS éligibles + indemnisation jusqu'à 660€/an.
</contexte_medere>

<historique>
{{conversationHistory}}
</historique>

<derniere_reponse_ps>
{{lastReply}}
</derniere_reponse_ps>

<intent_detecte>
{{intent}}
</intent_detecte>

<instructions>
Rédige une réponse SMS qui :
1. Réponds factuellement à la question ou à l'objection.
2. Si pertinent, propose un transfert vers un conseiller humain ("Souhaitez-vous que Vanessa, notre conseillère dentaire, vous appelle ?").
3. Reste sous 160 caractères.
4. Vouvoiement obligatoire.
5. Inclus "STOP" pour opt-out (en fin de message).
6. Ne mens jamais. Si tu ne sais pas, dis "Notre équipe vous précisera cela par téléphone".

Style :
- Direct, factuel, chiffré quand possible
- Empathique sans être obséquieux
- Pas de superlatifs
- Pas d'émojis

Format de sortie :
<sms>
[texte exact à envoyer]
</sms>

<should_handoff>
true | false
</should_handoff>

<handoff_reason>
[si true, raison du hand-off en 1 phrase]
</handoff_reason>`;
```

### Versionning des prompts

Tous les prompts ont un numéro de version (`v1`, `v2`...). Chaque message stocké en Firestore référence la version de prompt utilisée. Pour modifier un prompt, on crée une nouvelle version, on A/B teste, et on bascule progressivement.

---

## 11. Sécurité — Checklist non négociable

### Au niveau code

- [ ] **Secrets** : aucun secret dans le code, uniquement dans `.env.local` (gitignore) ou Vercel env vars
- [ ] **Validation** : tout input utilisateur ou webhook validé via Zod avant traitement
- [ ] **Signatures webhooks** : tous les webhooks (Slack, OVH, Inngest) vérifient leur signature HMAC
- [ ] **Erreurs** : jamais de stack trace renvoyée au client, log côté serveur uniquement
- [ ] **Authentification** : toutes les routes API protégées sauf webhooks signés
- [ ] **Authorization** : vérif du rôle utilisateur sur chaque action (admin vs commercial)
- [ ] **Rate limiting** : limite par IP sur tous les webhooks (Upstash Redis)
- [ ] **CORS** : restriction stricte à `NEXT_PUBLIC_APP_URL`
- [ ] **Helmet** : headers de sécurité activés sur les API routes
- [ ] **CSP** : Content-Security-Policy stricte côté Next.js
- [ ] **HTTPS** : enforced via Vercel
- [ ] **Dépendances** : `npm audit` clean, dépendances à jour
- [ ] **Pas de `eval` ni `Function()`** : interdit absolument
- [ ] **Pas de `dangerouslySetInnerHTML`** : sauf cas exceptionnel avec sanitization
- [ ] **Logs** : pas de PII (téléphone, email) en clair dans les logs

### Au niveau infrastructure

- [ ] **Firestore rules** : strictes, deny by default, testées via emulator
- [ ] **Vercel deployment protection** : preview deployments protégés
- [ ] **Slack tokens** : restreint aux scopes nécessaires, IP allowlist si possible
- [ ] **OVH consumer key** : restreint à `POST /sms/*/jobs` uniquement
- [ ] **HubSpot Private App** : scopes minimaux
- [ ] **Sentry** : configuré avec PII scrubbing
- [ ] **Rotation des secrets** : tous les 90 jours minimum

### Au niveau RGPD/AI Act

- [ ] **Annonce IA** : présente dans tous les premiers messages
- [ ] **Opt-out** : "STOP" présent et fonctionnel à 100%
- [ ] **Blackliste opt-out** : vérifiée avant chaque envoi
- [ ] **Plafond messages** : 3 max / 30j par contact, enforced en code
- [ ] **Plages horaires** : 10h-13h / 14h-20h en semaine, jamais le dimanche
- [ ] **Conservation** : 3 ans max pour les contacts inactifs, purge auto
- [ ] **Bloctel** : check mensuel des numéros B2C
- [ ] **Audit log** : chaque envoi, hand-off, opt-out tracé
- [ ] **Droit à l'effacement** : endpoint de suppression fonctionnel
- [ ] **Documentation intérêt légitime** : texte stocké par contact

### Vérification HMAC d'un webhook (exemple)

```typescript
// src/lib/security/webhook-signatures.ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  signature: string,
  rawBody: string
): boolean {
  // 1. Reject if timestamp > 5 min old (replay protection)
  const fiveMinAgo = Math.floor(Date.now() / 1000) - 300;
  if (parseInt(timestamp, 10) < fiveMinAgo) return false;

  // 2. Compute expected signature
  const baseString = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac('sha256', signingSecret)
    .update(baseString)
    .digest('hex')}`;

  // 3. Constant-time comparison
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

### Validation d'env au boot

```typescript
// src/lib/security/env.ts
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']),
  ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-'),
  OVH_APP_KEY: z.string().min(1),
  OVH_APP_SECRET: z.string().min(1),
  OVH_CONSUMER_KEY: z.string().min(1),
  OVH_SMS_SERVICE_NAME: z.string().min(1),
  HUBSPOT_ACCESS_TOKEN: z.string().startsWith('pat-'),
  LUSHA_API_KEY: z.string().min(1),
  SLACK_BOT_TOKEN: z.string().startsWith('xoxb-'),
  SLACK_SIGNING_SECRET: z.string().min(1),
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_CLIENT_EMAIL: z.string().email(),
  FIREBASE_PRIVATE_KEY: z.string().includes('PRIVATE KEY'),
  INNGEST_SIGNING_KEY: z.string().min(1),
  SENTRY_DSN: z.string().url(),
  UPSTASH_REDIS_REST_URL: z.string().url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
});

export const env = envSchema.parse(process.env);
// Si l'env est mal configurée, l'app refuse de démarrer.
```

---

## 12. Tests

### Stratégie

| Type | Outil | Couverture |
|---|---|---|
| Unit | Vitest | Logique métier pure (helpers, parsers, classifiers) |
| Integration | Vitest + MSW | API routes (mocks de Claude, OVH, HubSpot...) |
| E2E | Playwright | Parcours dashboard commercial complet |

### Cibles de couverture

- `lib/compliance/` : **100%** (c'est ce qui te sauve juridiquement)
- `lib/security/` : **100%**
- `lib/claude/`, `lib/ovh/`, etc. : **80%+**
- Composants UI : pas obligatoire, mais tests visuels via Playwright

### Exemple de test critique

```typescript
// tests/unit/compliance/rate-limits.test.ts
import { describe, it, expect } from 'vitest';
import { canSendMessage } from '@/lib/compliance/rate-limits';

describe('Rate limits compliance', () => {
  it('refuse l\'envoi si 3 SMS déjà envoyés sur 30 jours', () => {
    const messages = [
      { sentAt: daysAgo(5) },
      { sentAt: daysAgo(15) },
      { sentAt: daysAgo(25) },
    ];
    expect(canSendMessage(messages)).toBe(false);
  });

  it('autorise l\'envoi si le 3ème message date d\'il y a > 30 jours', () => {
    const messages = [
      { sentAt: daysAgo(31) },
      { sentAt: daysAgo(20) },
      { sentAt: daysAgo(10) },
    ];
    expect(canSendMessage(messages)).toBe(true);
  });
});
```

---

## 13. Dashboard commercial — Principes UX

### Personas

| Persona | Besoins principaux | Contraintes |
|---|---|---|
| Vanessa (commerciale dentaire) | Voir ses leads chauds, reprendre la conversation rapidement | Souvent en mobilité, tablette |
| Zacharie (commercial) | Pipeline de leads, suivi conversion | Bureau, multi-écrans |
| Déthié (admin) | KPIs globaux, ajustement prompts | Bureau, expert tech |
| Harry (direction) | Tableau de bord global, ROI | Mobile + desktop |

### Pages principales

1. **Vue d'ensemble** (`/`) — KPIs du jour : envois, réponses, leads chauds, conversion
2. **Conversations actives** (`/conversations`) — table filtrée par status/intent
3. **Détail conversation** (`/conversations/[id]`) — thread complet + bouton "Reprendre"
4. **Leads qualifiés** (`/leads`) — vue pipeline (kanban : nouveaux / en cours / clôturés)
5. **Campagnes** (`/campaigns`) — pilotage des envois en cours
6. **Settings** (`/settings/*`) — admin only

### Principes design (cf. skill frontend-design)

- **Information density** : enterprise UX = data accessible en un coup d'œil, pas de white space inutile
- **Workflow-driven** : chaque écran centré sur UNE action principale
- **Empty states soignés** : "Aucun lead chaud aujourd'hui — voici les leads tièdes à relancer"
- **Loading states clairs** : skeleton screens, pas de spinners infinis
- **Erreurs explicites** : "Échec d'envoi du SMS : numéro invalide" (pas "Error 500")
- **Mobile-friendly** : Vanessa doit pouvoir hand-off depuis sa tablette
- **Accessibilité** : tab navigation, ARIA labels, contrastes WCAG AA minimum
- **Command palette** : Cmd+K pour navigation rapide (cmdk)

### Composants critiques

#### `<ConversationsTable>`
- TanStack Table v8 server-side
- Colonnes : Contact, Ville, Spécialité, Statut, Intent (badge coloré), Dernier message, Actions
- Tri, filtres, pagination
- Click → détail

#### `<MessageThread>`
- Affiche le thread chronologique
- Bulles différenciées (IA vs humain vs PS)
- Tag "généré par IA" sur chaque message IA
- Bouton "Reprendre la main" → mode édition manuelle

#### `<HandoffButton>`
- Visible dès qu'intent = INTERESSE
- Click → crée deal HubSpot + notif Slack au commercial assigné + lock conversation
- Confirmation modale

#### `<KpiCard>`
- Métrique principale en gros
- Évolution vs J-1 ou semaine précédente
- Sparkline 7 derniers jours

#### `<ActivityFeed>`
- Stream temps réel des événements (envois, réponses, hand-offs)
- Filtrage par type
- Click → détail

---

## 14. Roadmap d'implémentation pour Claude Code

L'ordre dans lequel Claude Code doit construire le projet. Une étape = une session Claude Code dédiée.

### Phase 0 — Setup (1 session)

- [ ] Création repo + Next.js init
- [ ] Installation dépendances
- [ ] Setup shadcn/ui + Clerk
- [ ] Création de tous les fichiers `.claude/` (CLAUDE.md, skills, subagents)
- [ ] Setup ESLint + Prettier + Husky
- [ ] Création `.env.example`
- [ ] Premier commit

### Phase 1 — Foundation (2 sessions)

- [ ] Schemas Firestore + règles de sécurité + emulator setup
- [ ] Wrappers clients (Anthropic, OVH, HubSpot, Lusha, Slack, Firebase Admin)
- [ ] Module `lib/security/` complet (env validation, webhook signatures, rate limit)
- [ ] Module `lib/compliance/` complet avec 100% de tests
- [ ] Logger structuré (pino)
- [ ] Setup Sentry

### Phase 2 — Pipeline de données (2 sessions)

- [ ] Script `migrate-contacts.ts` : import 200 contacts test depuis HubSpot
- [ ] Inngest function `enrich-contact` : Lusha + Twilio Lookup
- [ ] Segmentation B2B/B2C automatique
- [ ] Export Bloctel pour mobiles persos
- [ ] Dashboard de monitoring de l'enrichissement

### Phase 3 — Premier envoi SMS (2 sessions)

- [ ] Prompts Claude (first-sms, classify-intent, reply) versionnés
- [ ] Module `lib/claude/` avec tests
- [ ] Module `lib/ovh/` avec tests (envoi + parse webhook)
- [ ] Inngest function `send-first-sms`
- [ ] Endpoint webhook `/api/webhooks/ovh-sms`
- [ ] Inngest function `process-reply` (classification + réponse ou hand-off)
- [ ] Test end-to-end sur 5 contacts internes

### Phase 4 — Hand-off (1 session)

- [ ] Module `lib/slack/` avec tests
- [ ] Création deal HubSpot + association contact
- [ ] Inngest function `handoff-to-commercial`
- [ ] Notification Slack avec transcript + bouton "J'ai contacté"
- [ ] Audit log de chaque hand-off

### Phase 5 — Dashboard commercial (3 sessions)

- [ ] Layout + auth Clerk + rôles
- [ ] Page Vue d'ensemble avec KPI cards
- [ ] Page Conversations avec TanStack Table
- [ ] Page Détail conversation avec thread
- [ ] Page Leads (kanban)
- [ ] Page Campaigns (pilotage envois)
- [ ] Settings (édition prompts pour admin)
- [ ] Tests Playwright des parcours principaux

### Phase 6 — Relances et industrialisation (1 session)

- [ ] Inngest function `schedule-followup` (J+3, J+7)
- [ ] Inngest function `archive-stale` (purge auto)
- [ ] Dashboard alertes/anomalies
- [ ] Documentation utilisateur (vidéo Loom ou page Notion)

### Phase 7 — Hardening et déploiement prod (1 session)

- [ ] Audit complet via subagent `security-reviewer`
- [ ] Audit compliance via subagent `compliance-auditor`
- [ ] Tests de charge sur les webhooks
- [ ] Setup monitoring Sentry + alertes Slack
- [ ] Documentation runbook (que faire si X tombe ?)
- [ ] Déploiement Vercel production
- [ ] Test sur 50 contacts réels en pré-prod

### Phase 8 — Scale et WhatsApp (futur)

À traiter dans un sprint séparé, hors MVP.

---

## 15. Pièges connus à éviter

### Pièges techniques

| Piège | Conséquence | Solution |
|---|---|---|
| Mettre un secret en `NEXT_PUBLIC_*` | Token leaké dans le bundle JS client | Ne JAMAIS préfixer un secret par `NEXT_PUBLIC_` |
| Oublier de vérifier la signature d'un webhook | N'importe qui peut spammer ton endpoint | Toujours `verifyXxxSignature()` en première ligne |
| Envoyer un SMS sans passer par Inngest | Pas de retry, perte du SMS si OVH down | Toujours via Inngest function |
| Faire confiance à l'input utilisateur | Injection, XSS, échec validation | `z.parse()` systématique |
| Ne pas tester les Firestore rules | Trou de sécurité silencieux | `firebase emulators:exec` avec tests |
| Logger un numéro de téléphone en clair | Fuite de données personnelles dans Sentry | Hash ou tronquer dans le logger |
| Utiliser `fetch()` sans timeout | Connexion bloquée si l'API tierce ne répond pas | `AbortController` avec timeout 10s |
| Stocker une conversation infinie | Coût LLM explose, latence augmente | Limiter à N derniers messages dans le prompt |
| Pas de `try/catch` dans les jobs Inngest | Exception silencieuse | `step.run()` à chaque action critique |

### Pièges métier

| Piège | Conséquence | Solution |
|---|---|---|
| Envoyer un SMS un dimanche | Sanction CNIL | `compliance/hours.ts` enforced |
| Envoyer un 4ème SMS dans les 30j | Sanction CNIL | `compliance/rate-limits.ts` enforced |
| Ne pas faire l'annonce IA dans le 1er SMS | Sanction AI Act | Prompt enforced + validation post-génération |
| Hand-off vers un commercial absent | Lead refroidit | Routage avec statut commercial (dispo/absent) |
| Stocker des données de santé | Catégorie spéciale RGPD | Ne JAMAIS stocker autre chose que les coordonnées pro |
| Spammer le hand-off Slack | Commerciaux ignorent les notifs | Une notif par lead, max 1/min |
| Réutiliser un prompt entre langues | Sortie de mauvaise qualité | Un prompt par langue (FR uniquement pour MVP) |

---

## 16. Ressources et liens utiles

### Documentation officielle

- **Claude API** : https://docs.claude.com
- **Anthropic SDK TypeScript** : https://platform.claude.com/docs/en/api/sdks/typescript
- **Claude Code best practices** : https://code.claude.com/docs/en/best-practices
- **Claude Code plugins/skills** : https://code.claude.com/docs/en/plugins
- **Prompt engineering** : https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
- **OVH SMS docs** : https://help.ovhcloud.com/csm/fr-documentation-web-cloud-messaging-sms
- **OVH API console** : https://eu.api.ovh.com/console/?section=%2Fsms&branch=v1
- **HubSpot API v3** : https://developers.hubspot.com
- **Lusha API** : https://docs.lusha.com
- **Twilio Lookup v2** : https://www.twilio.com/docs/lookup/v2-api
- **Slack security** : https://docs.slack.dev/security/
- **Firestore rules** : https://firebase.google.com/docs/firestore/security/get-started
- **Inngest** : https://www.inngest.com/docs
- **Vercel deployment** : https://vercel.com/docs
- **shadcn/ui** : https://ui.shadcn.com
- **OWASP Top 10 API** : https://owasp.org/API-Security/

### Documentation réglementaire

- **CNIL prospection B2B** : https://www.cnil.fr
- **AI Act Article 50** : https://artificialintelligenceact.eu
- **Bloctel** : https://www.bloctel.gouv.fr/
- **Loi 30 juin 2025 (démarchage)** : https://www.legifrance.gouv.fr

### Communautés et apprentissage

- **Claude Code skills marketplace** : https://github.com/anthropics/skills
- **Awesome Claude Code subagents** : https://github.com/VoltAgent/awesome-claude-code-subagents
- **Discord Anthropic** : https://discord.gg/anthropic

---

## 17. Premiers prompts à donner à Claude Code

Une fois le repo cloné et `claude` lancé dans le dossier, dans l'ordre :

### Prompt 1 — Découverte

```
Lis intégralement CLAUDE.md, README.md, .env.example et la structure du dossier src/.
Fais-moi un résumé en 10 lignes de ce que tu as compris du projet.
Puis liste les 5 premières actions concrètes à faire selon la roadmap Phase 0.
Ne code rien encore.
```

### Prompt 2 — Setup initial

```
Phase 0 — Setup. Crée tous les fichiers manquants :
- .gitignore complet
- tsconfig.json strict
- next.config.ts avec headers de sécurité (Helmet équivalent Next.js)
- tailwind.config.ts
- vitest.config.ts
- playwright.config.ts
- prettier config
- husky pre-commit

Utilise le subagent code-reviewer pour valider chaque fichier après création.
Commit à la fin avec un message clair.
```

### Prompt 3 — Foundation

```
Phase 1 — Foundation. Commence par implémenter src/lib/security/env.ts avec Zod.
L'app doit refuser de démarrer si une env var critique est manquante ou mal formée.
Écris les tests Vitest correspondants (100% de couverture exigée).
```

… et ainsi de suite, en suivant la roadmap pas à pas.

---

## 18. Critères de réussite du projet

### Critères techniques

- ✅ Zéro erreur console en production
- ✅ 100% de couverture sur `lib/compliance/` et `lib/security/`
- ✅ Lighthouse Score > 90 sur le dashboard
- ✅ Temps de réponse webhook < 500ms (sinon Inngest queue + ack immédiat)
- ✅ Aucune fuite de secret détectée par `npm audit` ou Snyk
- ✅ Audit OWASP Top 10 passé via subagent `security-reviewer`

### Critères business (MVP)

- ✅ 200 contacts traités sur 4 semaines
- ✅ Taux de délivrance SMS > 95%
- ✅ Taux de réponse > 8%
- ✅ Au minimum 4 RDV qualifiés convertis par les commerciaux
- ✅ Coût total MVP < 500€

### Critères UX

- ✅ Un commercial comprend l'interface en moins de 30 secondes
- ✅ Hand-off accessible en 1 clic depuis la conversation
- ✅ Mobile responsive (testé sur iPad)
- ✅ Accessibilité WCAG AA

---

Document de référence — Médéré Agent IA Prospection v1.0
Owner : Déthié
Dernière mise à jour : 27 mai 2026
