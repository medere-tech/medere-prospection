# Firestore Indexes — Médéré Prospection

## Pourquoi cette doc

Documenter les index composites Firestore versionnés dans
`firestore.indexes.json`, pour permettre à un futur dev de :

- Comprendre **pourquoi** ces index existent (quelle requête les utilise).
- Savoir comment les **déployer** sur un projet Firebase neuf (par exemple
  une branche de dev personnelle).
- Éviter l'erreur `Failed precondition: The query requires an index`
  rencontrée le 5 juin 2026 lors du test cloud S8.5.

> ⚠️ **Distinction critique** : un index peut être _versionné_ dans
> `firestore.indexes.json` sans être _déployé_ sur l'environnement cible.
> Le fichier est la source de vérité côté repo ; `firebase deploy` est ce
> qui pousse réellement l'index sur le projet Firebase. Une étape
> sans l'autre = erreur runtime.

## Index actuels

### 1. `messages` — `direction` ASC + `createdAt` DESC (scope COLLECTION)

**Requêtes qui en dépendent** :

- `listRecentOutbound(conversationId, days?, now?)`
  → `src/lib/firestore/messages.ts:630-653`
- `listRecentOutboundInTx(tx, conversationId, days?, now?)` (post-DEBT-001)
  → `src/lib/firestore/messages.ts:712-739`

**Caller indirect** : `sendOutboundWithLock`
(`src/lib/firestore/transactions.ts:378-464`) qui appelle
`listRecentOutboundInTx` dans une `withContactLock` — réutilise le même
index, pas d'index additionnel.

**Pattern de la query** :

```typescript
messagesSubcollectionRef(conversationId)
  .where("direction", "==", "outbound")
  .where("createdAt", ">=", fromTs)
  .orderBy("createdAt", "desc");
```

**Pourquoi cet index** : Firestore exige un index composite pour toute
requête combinant un `where` d'égalité (`direction == "outbound"`) ET un
`orderBy` sur un autre champ (`createdAt`). Sans cet index, Firestore
retourne `FAILED_PRECONDITION: The query requires an index, you can
create it here: <lien Firebase Console>`.

**Historique** :

- Index créé manuellement le 5 juin 2026 via Firebase Console pour
  débloquer le test cloud S8.5 (erreur précondition).
- Versionné dans le repo en S6.5, commit `76804f1` (_feat(firestore):
  sous-collection messages CRUD partiel + index composite_).
- Aligné avec la JSDoc de `listRecentOutbound` (`messages.ts:619-621`)
  qui documente explicitement l'index requis.

### 2. `messages` — `direction` ASC + `externalId` ASC (scope COLLECTION)

**Requêtes qui en dépendent** :

- `findInboundByExternalId(conversationId, externalId)`
  → `src/lib/firestore/messages.ts` (S9.1)

**Caller indirect** : pipeline Inngest `process-reply` (S9.2) qui appelle
`findInboundByExternalId` AVANT chaque `addInbound` pour détecter les
doublons webhook OVH (dédup idempotence).

**Pattern de la query** :

```typescript
messagesSubcollectionRef(conversationId)
  .where("direction", "==", "inbound")
  .where("externalId", "==", externalId)
  .limit(1);
```

**Pourquoi cet index** : Firestore exige un index composite pour toute
requête combinant 2 `where` d'égalité sur des champs différents
(`direction == "inbound"` ET `externalId == X`). Sans cet index, la query
throw `FAILED_PRECONDITION: The query requires an index`.

**Pourquoi pas un index single-field sur `externalId` seul** : la
sémantique de la dédup exige `direction == "inbound"` (un message
outbound qui partagerait un `externalId` ne doit JAMAIS matcher — cf.
test sentinelle `messages.test.ts` "EXCLUT les messages OUTBOUND"). Sans
le filtre direction, on aurait un faux positif dédup.

**Historique** :

- Index ajouté en S9.1 (pré-requis pipeline process-reply S9.2).
- Déploiement prévu APRÈS le merge S9.1 sur `main` via
  `npm run firebase:deploy:indexes` — pas pendant la branche pour éviter
  le drift avec d'autres branches en cours (DEBT-001-FOLLOWUP, etc.).

### 3. `conversations` — `contactId` ASC + `status` ASC (scope COLLECTION)

**Requêtes qui en dépendent** :

- `getActiveConversationByContactId(contactId)`
  → `src/lib/firestore/conversations.ts` (S9.2.1)

**Caller indirect** : pipeline Inngest `process-reply` (S9.2.x) — step 2
`resolve-conversation` qui résout `contactId → conversationId` à partir
de l'event inbound (qui ne contient pas la `campaignId`).

**Pattern de la query** :

```typescript
getAdminDb()
  .collection("conversations")
  .where("contactId", "==", contactId)
  .where("status", "in", ["active", "awaiting_reply", "in_dialogue", "qualified"])
  .limit(2);
```

**Pourquoi cet index** : Firestore exige un index composite pour une
requête combinant une `where` d'égalité (`contactId`) ET un `where IN`
sur un autre champ (`status`). Sans cet index, la query throw
`FAILED_PRECONDITION`.

**Pourquoi pas un index single-field sur `contactId` seul** : le filtre
sur `status` est essentiel pour la sémantique du resolve — on cherche
UNIQUEMENT les conversations actives (cf. Q1 brief Déthié S9.2.0). Sans
ce filtre, on récupérerait aussi des conversations `closed`,
`opted_out`, `handed_off`, `blocked` qui ne doivent pas re-rentrer dans
le pipeline IA.

**Historique** :

- Index ajouté en S9.2.1 (pré-requis step 2 du pipeline process-reply).
- Déploiement prévu APRÈS le merge S9.2 sur `main` via
  `npm run firebase:deploy:indexes` — politique cohérente avec Index 2
  (éviter le drift cross-branch durant le sprint).

## Déploiement

### Première installation sur un projet Firebase neuf

```bash
# 1. Authentification Firebase (interactif, ouvre un navigateur)
firebase login

# 2. Sélection du projet cible
firebase use <project-id>     # ex: medere-prospection-prod

# 3. Déploiement des index (peut prendre 5-15 min côté Firebase)
npm run firebase:deploy:indexes
```

### Après modification de `firestore.indexes.json`

```bash
# Déploie uniquement la diff des index — ne touche pas aux rules.
npm run firebase:deploy:indexes
```

Vérifier ensuite le statut **Enabled** dans la Firebase Console
(_Firestore → Indexes_). Tant qu'un index est en _Building_, les requêtes
qui l'utilisent retournent `FAILED_PRECONDITION` — attendre la fin du build.

### Pour info — script associé

Le script npm est défini dans `package.json` :

```json
"firebase:deploy:indexes": "firebase deploy --only firestore:indexes"
```

Pour déployer aussi les rules : `firebase deploy --only firestore` (cible
les 2 ressources). Pas de script npm dédié — la commande directe suffit.

## Anti-patterns à éviter

❌ **NE PAS** créer un index uniquement via la Firebase Console sans le
versionner dans `firestore.indexes.json`. Conséquences :

- Le dev local rencontre l'erreur sur l'emulator Firestore (port `8085`).
- Une réinstallation du projet Firebase écrasera l'index manuel sans le
  savoir.
- Pas de trace dans `git` de la raison de l'existence de l'index → dette
  documentaire qui resurgit au prochain audit.

❌ **NE PAS** déployer en prod sans vérifier le statut _Enabled_ —
Firestore retourne `FAILED_PRECONDITION` tant que l'index est en
_Building_ (peut durer 15 min sur grosses collections).

❌ **NE PAS** ajouter d'index spéculatif. Chaque index a un coût en
écriture (chaque doc ajouté à `messages` doit propager dans tous les
index actifs). On ajoute UN index quand UNE query du code prod en a
besoin, pas avant.

## Tester localement (emulator)

L'emulator Firestore (port `8085`, configuré dans `firebase.json`) :

- **Charge automatiquement** `firestore.indexes.json` au démarrage —
  pas besoin de `firebase deploy` pour tester localement.
- Commande : `npm run emulator:firestore` (cf. `package.json`).
- Si un test échoue avec `FAILED_PRECONDITION` localement, c'est que la
  query du code utilise un index NON déclaré dans
  `firestore.indexes.json` → ajouter l'index ET vérifier qu'il est listé
  ici dans cette doc avant le commit.

## Références

- Spec officielle Firebase CLI :
  <https://firebase.google.com/docs/firestore/query-data/indexing>
- Schéma `firestore.indexes.json` : racine du repo.
- Configuration Firebase locale : `firebase.json` (racine du repo).
- Skill Claude Code : `.claude/skills/medere-firestore-schema/SKILL.md`.
