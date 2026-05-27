# SECURITY-NOTES.md — Vulnérabilités acceptées

> Ce fichier documente les vulnérabilités connues laissées en l'état, avec leur
> justification. Toute entrée doit être datée et réévaluée régulièrement.
> Rappel CLAUDE.md : aucune vulnérabilité **critique** tolérée ; les modérées
> sont acceptables si documentées et sans impact sur notre cas d'usage.

## Acceptées

### postcss < 8.5.10 — XSS au stringify CSS (modéré)

- **Avis** : GHSA-qx2v-qp2m-jg93
- **Sévérité** : modérée
- **Chemin** : transitif via Next.js (`node_modules/next/node_modules/postcss`),
  remonte aussi via tous les paquets qui dépendent de Next (`@clerk/nextjs`,
  `@sentry/nextjs`, `inngest`, `nuqs`). *No fix available* côté npm.
- **Date** : 2026-05-27 (Phase 0)
- **Décision** : **acceptée, non corrigée**
- **Justification** :
  - Le « fix » proposé par `npm audit fix --force` rétrograderait Next.js à la
    v9.3.3 — breaking change destructeur, inacceptable.
  - Le vecteur (XSS via `</style>` non échappé dans la sortie stringify de
    PostCSS) ne concerne pas notre usage : nous écrivons nous-mêmes notre CSS,
    le build tourne en local et sur Vercel, jamais sur du CSS tiers non fiable.
- **Condition de réévaluation** : dès qu'une version de Next.js embarque
  `postcss >= 8.5.10`, relancer `npm audit` et retirer cette entrée.

### uuid < 11.1.1 — bounds check manquant sur buffer fourni (modéré)

- **Avis** : GHSA-w5hq-g745-h8pq
- **Sévérité** : modérée
- **Chemin** : transitif via `firebase-admin` → `@google-cloud/firestore`,
  `@google-cloud/storage`, `google-gax`, `gaxios`, `teeny-request`,
  `retry-request`.
- **Date** : 2026-05-27 (Phase 0)
- **Décision** : **acceptée, non corrigée**
- **Justification** :
  - Le « fix » de `npm audit fix --force` rétrograderait `firebase-admin` à la
    v10.3.0 — breaking change destructeur, inacceptable.
  - Le vecteur (absence de contrôle de bornes dans `uuid` v3/v5/v6 quand un
    buffer de sortie est fourni) ne s'applique pas à notre usage : le SDK Google
    Cloud génère des UUID sans buffer de sortie attaquant-contrôlé.
- **Condition de réévaluation** : dès que `firebase-admin` embarque
  `uuid >= 11.1.1`, relancer `npm audit` et retirer cette entrée.
