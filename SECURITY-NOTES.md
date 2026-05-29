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

### tar < 7.5.1 — path traversal au moment de l'extraction (élevée)

- **Avis** : famille `node-tar` — hardlink path traversal, symlink poisoning,
  hardlink target escape via symlink chain, drive-relative linkpath
  (Windows/macOS), race condition sur reservations Unicode (APFS).
- **Sévérité** : élevée (`high`)
- **Chemin** : transitif via `firebase-tools` (ajout S6.0) —
  `firebase-tools → tar@6.2.1`. Confirmé par `npm audit --json` :
  `isDirect=false`, dep parent direct = `firebase-tools`.
- **Date** : 2026-05-29 (S6.0 Phase 1, ajout du toolchain emulator)
- **Décision** : **acceptée, non corrigée**
- **Justification** :
  - `firebase-tools` est **strictement un outil dev/CI**, jamais embarqué
    dans le bundle Next.js de production. Vérifications :
    - Listé en `devDependencies` dans `package.json`, pas en `dependencies`.
    - Aucun import depuis `src/` (audit : `firebase-tools` n'est pas
      résolvable côté runtime).
    - Le build `next build` ne le tree-shake même pas — il n'y entre jamais.
  - Le vecteur d'attaque (extraction d'une archive `.tar` malveillante
    fournie par un tiers) ne s'applique pas : `firebase-tools` extrait
    uniquement le JAR de l'emulator Firestore depuis le serveur Google
    officiel sur HTTPS pinné. Pas d'archive utilisateur en entrée.
  - Le « fix » proposé par `npm audit fix --force` impose un upgrade
    semver-majeur `firebase-tools v14 → v15`, à évaluer hors S6 sur sa
    propre branche (pas dans le périmètre Phase 1).
- **Condition de réévaluation** : (a) si on commence à passer une archive
  utilisateur à `firebase-tools` (jamais prévu), réévaluer **immédiatement** ;
  (b) si `firebase-tools` publie une `v14.x` qui bump `tar >= 7.5.1`, retirer
  cette entrée sans attendre la v15 ; (c) sinon, dossier d'upgrade
  `firebase-tools` à ouvrir lors du hardening Phase 2.

### gaxios — uuid bounds check manquant (élevée, via firebase-tools)

- **Avis** : GHSA-w5hq-g745-h8pq (même CVE que l'entrée `uuid` ci-dessus,
  mais réinjectée via une autre chaîne)
- **Sévérité** : élevée (`high`) dans cette chaîne (Google Cloud regroupé)
- **Chemin** : transitif via `firebase-tools` →
  `gaxios → uuid`. Confirmé par `npm audit --json` au moment de l'ajout
  `firebase-tools` (S6.0).
- **Date** : 2026-05-29 (S6.0 Phase 1)
- **Décision** : **acceptée, non corrigée**
- **Justification** :
  - Même argument que `tar` ci-dessus : `firebase-tools` est dev/CI only,
    jamais bundled prod. `gaxios` est utilisé par le CLI Firebase pour
    parler aux APIs Google, pas par notre runtime applicatif.
  - Le vecteur (absence de bounds check `uuid` quand buffer fourni) ne
    s'applique pas : `firebase-tools` ne passe pas de buffer attaquant-
    contrôlé à `uuid`.
- **Condition de réévaluation** : alignée avec l'entrée `tar` ci-dessus —
  un bump `firebase-tools` qui résout les deux chaînes en une fois est
  préférable à deux upgrades séparés.
