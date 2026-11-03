/**
 * Setup global Testing Library (PR2c tour 2b bloc C bis).
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Pourquoi `asyncUtilTimeout: 5000`
 *
 *   Testing Library défaut : `asyncUtilTimeout: 1000` pour `waitFor`,
 *   `findBy*`, et `waitForElementToBeRemoved`.
 *
 *   Contexte Médéré :
 *     - Machine Windows 8 Go RAM (poste Déthié).
 *     - Hook `.husky/pre-push` lance 50+ fichiers jsdom en parallèle
 *       (`maxWorkers: 2` + import React 19 + base-ui + firebase-admin
 *       → 10-20 s d'import scanné par Defender par worker, cf.
 *       `vitest.config.ts:62-116`).
 *     - Toutes les assertions UI tombent sur un `fetch` mocké : la
 *       propre latence du mock est négligeable, mais le pipeline
 *       `fetch → json → setState → re-render` traverse plusieurs
 *       microtasks + un paint React 19 — total mesuré jusqu'à ~1250 ms
 *       sur un run normal (cf. 10 runs orphan-inbounds-page-client).
 *     - 1 s de défaut Testing Library est juste la mauvaise valeur :
 *       insuffisant sous charge, mais pas assez généreux pour qu'un
 *       test VRAIMENT cassé mette longtemps à fail.
 *     - 5 s : couvre les pics observés (hook pre-push à 1755 ms,
 *       marge x3) tout en gardant un fail rapide pour les vrais bugs.
 *
 *   NB : ce réglage NE REMPLACE PAS le fix « déterministe » dans les
 *   tests individuels (attendre la promesse JSON du mock avant
 *   `findBy*`). Il est la ceinture ET les bretelles — si un test
 *   oublie l'attente explicite, le délai élargi évite un fail
 *   fantôme sous charge CI.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Portée
 *
 *   Enregistré via `setupFiles` dans `vitest.config.ts` → s'applique
 *   à TOUS les tests du run (`npm test`, pre-push). Testing Library
 *   ignore `configure()` dans les tests Node (zéro DOM, zéro waitFor).
 *   Les tests Firestore (`vitest.config.firestore.ts`) ont leur propre
 *   setup — ce fichier n'y est pas chargé, pas d'effet de bord.
 */
import { configure } from "@testing-library/react";

configure({
  asyncUtilTimeout: 5000,
});
