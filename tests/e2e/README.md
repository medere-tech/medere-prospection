# Harnais Playwright e2e — PR1.14

Suite lecture seule contre une préview Vercel branchée sur Firestore prod.
Zéro écriture (ni Firestore, ni Slack, ni OVH). Zéro artefact PII sur disque
(F-H1 compliance-auditor PR1.14.1 : `screenshot: "off"`, `video: "off"`,
`trace: "off"` dans `playwright.config.ts`).

---

## Pré-requis

Dans `.env.local` (jamais commité) :

```
CLERK_SECRET_KEY=sk_test_...
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
# Optionnel : domaine custom pour les emails test (défaut `example.com`)
E2E_EMAIL_DOMAIN=medere-e2e.test
```

Les clés Clerk vivent dans l'instance **test** (pas live). Le script setup
refuse `sk_live_` par défaut (H1 security-reviewer PR1.14 ; opt-in explicite
via `ALLOW_E2E_ON_LIVE_CLERK=1` uniquement sous supervision humaine).

---

## Comptes gérés

Trois comptes Clerk, tous avec suffixe local `+clerk_test` (mode test Clerk :
code OTP figé `424242`, aucune livraison email réelle) et
`publicMetadata.testAccount = true` :

| local-part | role | slackUserId | Usage |
|---|---|---|---|
| `e2e-commercial` | `commercial` | `UE2ECOMMERCIAL` | Non-titulaire → 403 sur conversation A (S3) |
| `e2e-commercial-owner` | `commercial` | `U05UVHGBURX` (Déthié) | Titulaire → vue complète sur A (S2) |
| `e2e-admin` | `admin` | — | Admin → bannière "Mode admin" sur A (S5) |

Le partage délibéré de `slackUserId=U05UVHGBURX` pour `e2e-commercial-owner`
permet de tester le cas "commercial titulaire" sur de **vraies conversations
de prod** sans écrire une seule ligne dans Firestore. L'authentification
reste distincte (userId Clerk différent, flag `testAccount` + `role: commercial`
qui limite les droits côté app). Cf. M2 security-reviewer PR1.14.1 et
`tests/e2e/fixtures.ts:7-18`.

**Garde-fou défense en profondeur** : `src/lib/auth/require-role.ts` refuse
toute session avec `publicMetadata.testAccount === true` quand
`VERCEL_ENV === "production"`. Les comptes test sont donc inoffensifs même
s'ils venaient à exister dans Clerk live par erreur.

---

## Setup (provisionne les 3 comptes)

Dry-run (lecture seule, zéro écriture Clerk) :

```powershell
npx tsx scripts/setup-e2e-clerk-users.mjs
```

Apply (crée ou met à jour les 3 comptes de façon idempotente) :

```powershell
npx tsx scripts/setup-e2e-clerk-users.mjs --apply
```

Au premier run : 3 lignes `[APPLY] CREATE …`. Au rejeu : 3 `[APPLY] NOOP …`.
Codes de sortie dans le header du script.

---

## Cleanup (supprime les 3 comptes)

Miroir strict du setup, mêmes garde-fous (whitelist local-part, FQDN,
refus `sk_live_` sauf opt-in), **plus** un garde-fou spécifique :
**refus de suppression si `publicMetadata.testAccount !== true`**. Exit
code `7` dans ce cas → signal clair qu'un compte prod a été trouvé par
inadvertance sous un email matchant la whitelist.

Dry-run :

```powershell
npx tsx scripts/cleanup-e2e-clerk-users.mjs
```

Apply :

```powershell
npx tsx scripts/cleanup-e2e-clerk-users.mjs --apply
```

---

## Lancement du harnais

Après avoir déployé la préview Vercel contenant les correctifs à tester :

```powershell
$env:E2E_BASE_URL = "https://<preview-url>.vercel.app"
$env:E2E_CONV_ID_FOR_ADMIN_NON_OWNER = "427963864300_hubspot-list-6081"
$env:E2E_CONV_ID_INEXISTANT = "inexistant-pr1-test"
# Si tu as mis un domaine custom au setup Clerk :
# $env:E2E_EMAIL_DOMAIN = "medere-e2e.test"
npx playwright test
```

Les 6 scénarios (S1-S6) tournent sur **chromium** uniquement
(Firefox/Webkit `test.skip` dans PR1.14). Durée totale ~3 min.

Pour debugger un flake localement :

```powershell
$env:PWDEBUG = "1"
npx playwright test tests/e2e/polling.spec.ts --headed
```

Jamais `PWDEBUG=1` en CI partagée (capture DOM + trace réseau → PII).

---

## Scénarios

| # | Fichier | Attendu |
|---|---|---|
| S1 | `conversation-detail.spec.ts` | `/<id>/anything-slug` → 308 vers `/<id>` canonique |
| S2 | `conversation-detail.spec.ts` | `e2e-commercial-owner` sur A : vue complète, pas de bannière admin, 0 numéro FR dans le DOM |
| S3 | `conversation-detail.spec.ts` | `e2e-commercial` sur A : 403, aucun contenu de conversation, 0 numéro |
| S4 | `conversation-detail.spec.ts` | `/<inexistant>` → 404 propre |
| S5 | `conversation-detail.spec.ts` | `e2e-admin` sur A : bannière "Mode admin" visible, 0 numéro |
| S6 | `polling.spec.ts` | Page A ouverte 95 s : ≤4 polls `/version`, 0 `/detail`, pause onglet caché 40 s |

Deux filets de sécurité anti-fuite PII fonctionnent en permanence
(`tests/e2e/fixtures.ts`) :

- `installApiPhoneSentinel(page)` — intercepte toute réponse
  `/api/admin/conversations/*` et throw si un pattern téléphone FR
  apparaît. Message d'erreur **ne rejoue PAS** le numéro détecté.
- `assertNoFrenchPhone(bodyText, context)` — vérifie l'absence de numéro
  FR dans le DOM lu via `page.locator("body").innerText()`.

---

## Rétention

Les comptes `e2e-*` restent en Clerk indéfiniment entre deux runs. Pour
une purge périodique (hygiène, rotation d'un slackUserId) : `cleanup`
puis `setup --apply`. Les emails et noms des comptes sont synthétiques
(aucune personne physique réelle derrière) ; seul `slackUserId=U05UVHGBURX`
constitue une donnée personnelle de Déthié stockée en `publicMetadata`
(intérêt légitime documenté — tests fonctionnels sans impact prod ;
cf. registre RGPD Art.30).
