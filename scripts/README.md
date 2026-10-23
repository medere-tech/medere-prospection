# `scripts/` — scripts d'exploitation et de vérification

Scripts opérationnels one-shot ou récurrents (dry-run par défaut quand ils
touchent Firestore).

---

## Checklist : lancer AVANT tout commit qui change `firestore.indexes.json` OU touche les routes `/api/admin/conversations*`

Les tests emulator (`npm run test:firestore`) ne vérifient PAS les composite
indexes — l'emulator exécute toute requête, même sans index. Seul un run
contre la **vraie base** fait tomber un `FAILED_PRECONDITION`. Donc après
chaque changement d'index ou de query dans la liste conversation, dans
l'ordre :

```bash
# 1. Déployer les indexes à partir de la source de vérité (firestore.indexes.json)
npm run firebase:deploy:indexes

# 2. Attendre la fin de la construction (console Firebase → Firestore → Indexes).
#    Les indexes composites complexes peuvent prendre plusieurs minutes.

# 3. Prouver que chaque forme de requête émise par les 3 routes trouve bien
#    son index en prod. Lecture seule stricte. Code de sortie non nul si
#    une seule forme échoue.
npx tsx scripts/check-conversation-list-indexes.mjs
```

Si une forme échoue :
- La sortie affiche l'URL de création d'index Firebase (à titre informatif).
- MAIS la source de vérité reste `firestore.indexes.json` : patcher le
  fichier avec le composite déduit de la requête (égalités d'abord, puis
  `contactNameSearch asc` si recherche, puis `lastMessageAt desc`), puis
  redéployer. Jamais cliquer sur le lien console.
- Relancer le script.

---

## Scripts disponibles

| Script | Objet | Lecture seule ? |
|---|---|---|
| `check-conversation-list-indexes.mjs` | Vérifie que chaque forme de requête des routes `/api/admin/conversations[/counts\|/version]` et les lookups `contactId+status` legacy trouve un composite index en prod (lance toutes les variantes role×tab×campagne×recherche×cursor). | ✅ oui (limit 1, agrégations) |
| `backfill-conversation-list-fields.mjs` | Backfill PR2a : pose `contactDisplayName`, `contactNameSearch`, `contactSpecialty`, `contactCity`, `lastMessagePreview`, `lastHumanOutboundAt` sur les conversations antérieures. Dry-run par défaut, `--apply` + confirmation stdin pour écrire. | ✅ par défaut |

Les scripts `diag-*`, `explore-*`, `test-*` sont des helpers one-shot
jetables (jamais commités).
