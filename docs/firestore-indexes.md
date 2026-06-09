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
