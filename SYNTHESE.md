# Synthèse de la recherche — Médéré Agent IA Prospection

> Document de récap après la phase de recherche approfondie.
> À lire avant d'ouvrir le README.md et le CLAUDE.md.

---

## Ce que la recherche a révélé

### Sur Claude Code

**Source : documentation officielle Anthropic + experts (slideshare, Anthropic engineering blog, Reddit r/ClaudeCode, guides GitHub).**

Les patterns qui fonctionnent vraiment :

1. **CLAUDE.md à la racine** : chargé automatiquement à chaque session, c'est LE fichier qui pilote Claude Code. Doit rester concis (sinon il bouffe du contexte) mais inclure : commandes, conventions, règles non négociables, pièges connus.
2. **Planning AVANT le code** : tous les experts s'accordent — "vibe coding" marche pour les MVPs jetables, pas pour la production. Toujours faire générer un plan d'abord, valider, coder ensuite.
3. **Skills** (`.claude/skills/<nom>/SKILL.md`) : modules d'expertise déclenchés automatiquement par le contexte. À créer pour les domaines récurrents (conformité, prompts, schémas).
4. **Subagents** (`.claude/agents/<nom>.md`) : spécialistes invocables à la demande pour review sécurité, prompt engineering, audit compliance.
5. **Gestion du contexte = la principale source d'échec** : `/clear` souvent, documentation à jour, prompts ciblés.

### Sur OVHcloud SMS

**Source : doc officielle OVH + repo `ovh/node-ovh` (officiel).**

- **Deux méthodes** : API REST (recommandée) ou HTTP2SMS (simple GET, vieille méthode)
- **Authentification** : `appKey` + `appSecret` + `consumerKey` scopé sur `/sms/*/jobs` uniquement (principe du moindre privilège)
- **SDK officiel** : `@ovhcloud/node-ovh` (Node.js)
- **Endpoint principal** : `POST /sms/{serviceName}/jobs` pour envoyer
- **Réception SMS** : configuration d'un callback URL dans l'espace client OVH, OVH POST les messages entrants
- **Prix** : ~0.035-0.045€/SMS sortant FR

### Sur les APIs externes

| API | SDK officiel | Auth | Doc |
|---|---|---|---|
| Anthropic Claude | `@anthropic-ai/sdk` | Bearer token | platform.claude.com/docs |
| HubSpot | `@hubspot/api-client` | Private App token ou OAuth | developers.hubspot.com |
| Lusha v2 | `fetch` natif | header `api_key` | docs.lusha.com |
| Twilio Lookup | `twilio` | Account SID + Auth Token | twilio.com/docs/lookup |
| Slack | `@slack/web-api` + `@slack/webhook` | Bot token `xoxb-` | docs.slack.dev |
| Firebase | `firebase-admin` | Service account JSON | firebase.google.com/docs |
| Inngest | `inngest` | Signing key | inngest.com/docs |

### Sur la sécurité (OWASP)

**Source : OWASP API Security Top 10 2023 + guides Node.js production.**

Les 10 risques majeurs et leur mitigation dans notre stack :

1. **BOLA (Broken Object Level Authorization)** → vérif rôle utilisateur sur chaque ressource
2. **Broken Authentication** → Clerk + tokens courte durée
3. **Broken Object Property Level Authorization** → Zod schema strict, pas d'attribut sensible exposé
4. **Unrestricted Resource Consumption** → rate limiting Upstash Redis
5. **Broken Function Level Authorization** → middleware role-check
6. **Unrestricted Access to Sensitive Business Flows** → audit log + détection anomalies
7. **Server Side Request Forgery (SSRF)** → validation URLs entrantes, allowlist
8. **Security Misconfiguration** → Helmet (headers) + CSP strict
9. **Improper Inventory Management** → doc API à jour, versionning
10. **Unsafe Consumption of APIs** → validation Zod des réponses des APIs tierces

### Sur l'UX commerciale

**Source : guides enterprise UX 2026 (Tenet, FuseLabCreative, UITop, AdminLTE).**

- **Information density** > white space pour les outils internes (commerciaux veulent tout voir d'un coup)
- **Workflow-driven** : chaque écran = une action principale
- **Empty states soignés** : "Aucun lead chaud" doit suggérer une action
- **Command palette Cmd+K** : indispensable en 2026 pour la nav rapide
- **Mobile responsive** : Vanessa peut être en déplacement
- **Stack moderne** : Next.js 16 + shadcn/ui + TanStack Table v8 + Recharts 3 = standard 2026

### Sur le cadre légal (rappel)

| Échéance | Texte | Impact |
|---|---|---|
| **2 août 2026** | AI Act Article 50 | Annonce IA obligatoire en début de chaque interaction |
| **11 août 2026** | Loi 30 juin 2025 | Bascule opt-in pour démarchage B2C, fin de Bloctel |
| **Permanent** | RGPD + L.34-5 CPCE | Intérêt légitime en B2B, droit d'opposition, audit |

Pour Médéré : **B2B (lignes de cabinet PS) reste autorisé sur intérêt légitime**. Mobiles persos = zone grise traitée comme B2C → opt-in à terme.

---

## Ce qu'on a décidé

### Architecture

**Open-source self-hosted sur Vercel + Firebase**, pas de SaaS payant type Bland/Vapi/Retell/Synthflow.

Raisons :
- Contrôle total sur la stack
- Conformité (données en EU, OVH souverain pour SMS)
- Pas de marge SaaS (Vapi prend ~0.20€/min en plus)
- Capitalisation : on développe un asset Médéré
- Évolutivité : on peut switcher chaque brique indépendamment

### Stratégie phasée

1. **Phase 1 (MVP)** : SMS conversationnel sur 200 dentistes IDF
2. **Phase 2** : Bascule WhatsApp pour les contacts engagés
3. **Phase 3** : Hand-off humain dès intent positif détecté

### Stack technique finale

```
Frontend  : Next.js 16 + shadcn/ui + TanStack Table + Recharts
Backend   : Next.js API routes + Inngest (jobs)
LLM       : Claude Sonnet 4.6 via @anthropic-ai/sdk
SMS       : OVHcloud SMS API (souverain FR)
Validation: Twilio Lookup v2
Enrichis. : Lusha v2
CRM       : HubSpot API v3
DB        : Firebase Firestore (Admin SDK)
Notif     : Slack Web API
Auth      : Clerk
Logs      : Pino + Sentry
Rate limit: Upstash Redis
Tests     : Vitest + Playwright
```

---

## Les livrables prêts

Tu as maintenant trois fichiers prêts à l'emploi :

### 1. `README.md` (long, exhaustif)

Document de référence technique complet. À placer à la racine du repo une fois créé. Contient :
- Vue d'ensemble et architecture
- Stack technique avec versions
- Structure complète du repo
- Schéma Firestore détaillé
- 3 prompts Claude calibrés (style Bencivenga)
- Checklist sécurité complète (OWASP + RGPD + AI Act)
- Roadmap d'implémentation en 8 phases
- Pièges connus avec mitigations
- Ressources et liens utiles

### 2. `CLAUDE.md` (court, opérationnel)

Fichier chargé automatiquement par Claude Code à chaque session. À placer à la racine du repo. Contient :
- Stack et commandes essentielles
- Conventions de code
- Règles non négociables (sécurité + compliance)
- Liste des skills et subagents à utiliser
- Pièges connus
- Ton à adopter (tutoiement, direct, honnête)

### 3. Cette synthèse (SYNTHESE.md)

Le présent document. Récap exécutif de la recherche.

---

## Plan d'action concret

### Étape 1 — Récupérer les fichiers (maintenant)

Télécharge les 3 fichiers (README.md, CLAUDE.md, SYNTHESE.md) que je viens de créer.

### Étape 2 — Préparer les comptes externes

Avant d'ouvrir Claude Code, crée les comptes (ou récupère les credentials) :

- [ ] **Anthropic API** : déjà fait pour Médéré ? Sinon : console.anthropic.com → créer une clé
- [ ] **OVHcloud SMS** : ovhcloud.com/fr/sms — créer un compte SMS + acheter 500 crédits pour le MVP
- [ ] **Twilio** : pour le Lookup uniquement (compte gratuit suffit)
- [ ] **HubSpot Private App** : Settings → Integrations → Private Apps → scopes : `crm.objects.contacts.read/write`, `crm.objects.deals.read/write`, `crm.objects.contacts.write`
- [ ] **Lusha** : déjà connecté via MCP Claude, à confirmer l'API key
- [ ] **Slack** : créer une app sur api.slack.com/apps → Bot scopes : `chat:write`, `users:read`, `incoming-webhook`
- [ ] **Firebase** : créer projet → Firestore → générer une clé de service account
- [ ] **Vercel** : compte créé (probablement déjà)
- [ ] **Inngest** : créer compte sur inngest.com → récupérer signing key
- [ ] **Sentry** : créer projet Next.js → récupérer DSN
- [ ] **Upstash** : créer une instance Redis (free tier suffit)
- [ ] **Clerk** : créer une application → récupérer publishable + secret keys

### Étape 3 — Validation finale avec Harry

Avant le premier commit, valider les 5 questions ouvertes :

1. Segment confirmé : **200 dentistes IDF** ?
2. Offre à pousser : **formation DPC spécifique** ou catalogue ?
3. Hand-off : **Vanessa Rabba** confirmée + SLA défini ?
4. Origine des 26k contacts : **documenter pour RGPD** ?
5. Budget : **500€ MVP validé** + enveloppe scale ?

### Étape 4 — Premier prompt Claude Code

Une fois le projet créé, ouvre Claude Code dans le dossier et copie-colle ce prompt initial :

```
Lis intégralement CLAUDE.md, README.md, SYNTHESE.md, .env.example et la structure
du dossier src/. Fais-moi un résumé en 10 lignes de ce que tu as compris du projet.
Puis liste les 5 premières actions concrètes à faire selon la roadmap Phase 0.
Ne code rien encore.
```

À partir de là, suit la roadmap d'implémentation phase par phase. Chaque phase = une session Claude Code dédiée.

---

## Ma recommandation finale

Tu as une stack solide, conforme, et professionnelle. Trois conseils avant de te lancer :

**1. Ne saute aucune étape de la phase 1 (Foundation).** Le module `lib/security/` et `lib/compliance/` sont la colonne vertébrale juridique du projet. Si tu les bâcles, tu prends un risque CNIL et un risque AI Act à 6 chiffres.

**2. Teste sur 5 contacts internes Médéré avant de toucher les 200 réels.** Vanessa, Harry, Franck, Justine, toi-même. Si l'IA dit n'importe quoi sur ces 5 personnes, tu corriges avant de griller la base de PS.

**3. N'attends pas la perfection pour livrer la phase 1.** L'objectif du MVP est d'apprendre, pas d'être parfait. Si tu obtiens 8% de réponse sur les 200 contacts, tu as gagné. Si tu obtiens 4 RDV qualifiés, tu as gagné. Tu itères ensuite.

---

## Quand tu seras prêt pour la suite

Je peux te générer en plus :

- **Le contenu détaillé de chaque skill** (`.claude/skills/<nom>/SKILL.md`) avec les checklists et helpers
- **Le contenu détaillé de chaque subagent** (`.claude/agents/<nom>.md`) avec leur expertise
- **Le code de démarrage** des modules critiques (env validation, webhook OVH, prompts Claude)
- **Les templates Slack** pour les notifs hand-off
- **Le brief Harry** version PowerPoint (avec le skill pptx)

Dis-moi ce dont tu as besoin en premier.

---

Owner : Déthié | Date : 27 mai 2026 | Version 1.0
